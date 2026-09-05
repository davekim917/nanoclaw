/**
 * P3 — adoption precedes every wake source (seam 4 series E, plan §4.3.4 and
 * §7.E "Ordering and safety", property 2) — as an invariant in a primitive.
 *
 * `adoptRunningSessions()` registers the containers a previous host left
 * running. Until it has, those containers are alive and UNTRACKED, and any
 * wake would start a second container beside one (P2 fences that at the claim,
 * but the ordering is the layer that keeps P2 from ever being asked). The
 * order is read out of `main()` rather than traced through a live call, for
 * the reason src/boot-quiescence-order.test.ts and src/onecli-preflight.test.ts
 * give: `main()` opens the central DB, the dashboard and every channel adapter,
 * and a run stubbed far enough to be safe would no longer be the boot this
 * asserts about.
 */
import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Every function call made directly by `main()`, in source order, prefixed
 * with `await ` when the call is awaited. Recursive, so a call inside a `try`
 * or an `if` counts.
 */
function bootCallOrder(source: string): string[] {
  const sourceFile = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
  const main = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'main',
  );
  expect(main?.body, 'main() is no longer a top-level function declaration').toBeDefined();

  const calls: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const awaited = ts.isAwaitExpression(node.parent);
      calls.push(`${awaited ? 'await ' : ''}${node.expression.text}`);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(main!.body!, visit);
  return calls;
}

function mainSource(): string {
  return fs.readFileSync(path.join(import.meta.dirname, 'main.ts'), 'utf8');
}

const ADOPT = 'await adoptRunningSessions';
/** D1's scoped boot door; until it lands, the fleet-wide stop inside the memory gate is the door. */
const QUIESCE = 'await quiesceWorkgroupsForBootMountChange';
const MEMORY_GATE = 'runWorkgroupMemoryStartupGate';
const FENCE_RECOVERY = 'await releaseOrphanedRepoIngressFencesAtStartup';
/** Everything that can issue a wake once started. */
const WAKE_SOURCES = [
  'startDashboard',
  'await initChannelAdapters',
  'await startHostModules',
  'startActiveDeliveryPoll',
  'startSweepDeliveryPoll',
  'startHostSweep',
  'await startCliServer',
];

function indexOfCall(calls: string[], call: string): number {
  const index = calls.indexOf(call);
  expect(index, `main() no longer calls ${call}`).toBeGreaterThan(-1);
  return index;
}

describe('adoption order (P3)', () => {
  const calls = bootCallOrder(mainSource());

  it('adoptRunningSessions resolves before any wake source starts', () => {
    const adopt = indexOfCall(calls, ADOPT);
    // Awaited, not fire-and-forget: the registry must be complete when the
    // first wake source starts, not merely requested.
    expect(calls.filter((call) => call.endsWith('adoptRunningSessions'))).toEqual([ADOPT]);
    for (const source of WAKE_SOURCES) {
      expect(indexOfCall(calls, source), `${source} starts before adoption resolves`).toBeGreaterThan(adopt);
    }
  });

  it('adoption runs after the boot quiescence door and before the orphaned-fence recovery', () => {
    const adopt = indexOfCall(calls, ADOPT);
    // The door: D1's scoped quiescence once it is in the tree, and until then
    // the memory startup gate whose fleet-wide stop it replaces. Adoption sits
    // after whichever is present so it only ever sees containers the door
    // chose to leave running.
    const door = calls.includes(QUIESCE) ? indexOfCall(calls, QUIESCE) : indexOfCall(calls, MEMORY_GATE);
    expect(adopt).toBeGreaterThan(door);
    // §4.3.6: the recovery's premise — "a fresh process holds no mount claims,
    // so every active fence is orphaned" — must still be true when it runs, so
    // adoption (which registers containers but takes no claims) goes first,
    // and the recovery is the one that releases what adoption only counted.
    expect(indexOfCall(calls, FENCE_RECOVERY)).toBeGreaterThan(adopt);
  });

  it('nothing in main() calls wakeContainer before adoption resolves', () => {
    const adopt = indexOfCall(calls, ADOPT);
    const wakes = calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => /\bwakeContainer$/.test(call) && !call.includes('adoptRunningSessions'));
    expect(wakes.filter(({ index }) => index < adopt).map(({ call }) => call)).toEqual([]);
    // And the module does not import the wake path at all: every wake in the
    // boot sequence goes through a source the case above already orders.
    const source = mainSource();
    expect(/import[^;]*\bwakeContainer\b[^;]*from\s+'\.\/container-runner\.js'/.test(source)).toBe(false);
  });
});
