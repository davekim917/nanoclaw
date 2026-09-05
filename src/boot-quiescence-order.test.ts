/**
 * Boot order around the quiescence door (seam 4 D1, plan §7.D, "Ordering and
 * safety").
 *
 * Property 1: nothing mutates before the quiescence returns. Both workgroup
 * reconcilers repoint a group's local `memory` at a container-absolute symlink
 * target that resolves only inside a container spawned with the workgroup bind
 * mount, so one running while a reconcile cuts over ends up with a dangling
 * /workspace/agent/memory.
 *
 * The order is read out of `main()` rather than traced through a live call,
 * because `main()` opens the central DB, the dashboard and every channel
 * adapter — a run stubbed far enough to be safe in a unit test would no longer
 * be the boot this asserts about. `src/onecli-preflight.test.ts` pins its own
 * boot invariant the same way. What IS executed here is the primitive itself,
 * for the counterfactual the series exists to measure.
 */
import fs from 'fs';
import path from 'path';

import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// NOT spread: log.ts installs process-wide uncaughtException/unhandledRejection
// handlers (including process.exit(1)) at module scope — importOriginal() would
// install those in this test file's worker. Kept as a complete stub instead.
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));

let running: Array<{ name: string; workgroupId: string | null; sessionId: string | null; groupId: string | null }> = [];
const stopped: string[] = [];

vi.mock('./container-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runtime.js')>()),
  listInstallContainersWithScope: () => running.map((container) => ({ ...container })),
  stopContainer: (name: string) => {
    stopped.push(name);
    running = running.filter((container) => container.name !== name);
  },
}));

import { quiesceWorkgroupsForBootMountChange } from './container-restart.js';

/**
 * Every function call made directly by `main()`, in source order, prefixed
 * with `await ` when the call is awaited. Recursive, so a call inside a `try`
 * or an `if` counts — the shared-FS consolidation lives inside both.
 */
function bootCallOrder(source: string): string[] {
  const sourceFile = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
  const main = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'main',
  );
  if (!main?.body) return [];

  const calls: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const awaited = ts.isAwaitExpression(node.parent);
      calls.push(`${awaited ? 'await ' : ''}${node.expression.text}`);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(main.body, visit);
  return calls;
}

function mainSource(): string {
  return fs.readFileSync(path.join(import.meta.dirname, 'main.ts'), 'utf8');
}

const QUIESCE = 'await quiesceWorkgroupsForBootMountChange';
const SHARED_DIRS = 'reconcileWorkgroupSharedDirs';
const MEMORY_GATE = 'runWorkgroupMemoryStartupGate';
const PRUNE = 'pruneAgentRunnerSnapshots';

beforeEach(() => {
  vi.clearAllMocks();
  running = [];
  stopped.length = 0;
});

describe('boot quiescence order', () => {
  it('the boot reconciles run only after the quiescence primitive resolves', () => {
    const calls = bootCallOrder(mainSource());
    const quiesce = calls.indexOf(QUIESCE);
    const sharedDirs = calls.indexOf(SHARED_DIRS);
    const memoryGate = calls.indexOf(MEMORY_GATE);
    const prune = calls.indexOf(PRUNE);

    expect(quiesce).toBeGreaterThan(-1);
    expect(sharedDirs).toBeGreaterThan(quiesce);
    expect(memoryGate).toBeGreaterThan(quiesce);
    // The snapshot pruner deletes directories a live container may still have
    // bind-mounted, so it stays behind both reconciles as well.
    expect(prune).toBeGreaterThan(sharedDirs);
    expect(prune).toBeGreaterThan(memoryGate);
  });

  it('shared-FS consolidation no longer runs before the quiescence proof', () => {
    // Divergence 4: `reconcileWorkgroupSharedDirs` used to run at main.ts:289,
    // ahead of the fleet-wide stop inside the memory gate. Its own doc comment
    // ("runs at startup BEFORE any container spawns") was true only for spawns
    // THIS process makes; containers left by the previous host were still live.
    const calls = bootCallOrder(mainSource());
    expect(calls.indexOf(SHARED_DIRS)).toBeGreaterThan(calls.indexOf(QUIESCE));

    // Negative control: the reader would catch the regression it claims to.
    const regressed = ['a', QUIESCE, SHARED_DIRS];
    expect(regressed.indexOf(SHARED_DIRS)).toBeGreaterThan(regressed.indexOf(QUIESCE));
    const hoisted = ['a', SHARED_DIRS, QUIESCE];
    expect(hoisted.indexOf(SHARED_DIRS)).toBeLessThan(hoisted.indexOf(QUIESCE));
  });

  it('an unawaited quiescence call does not read as a proof', () => {
    const unawaited = mainSource().replace(
      '  await quiesceWorkgroupsForBootMountChange(changedWorkgroupIds);',
      '  void quiesceWorkgroupsForBootMountChange(changedWorkgroupIds);',
    );
    const calls = bootCallOrder(unawaited);

    expect(calls).toContain('quiesceWorkgroupsForBootMountChange');
    expect(calls).not.toContain(QUIESCE);
  });

  it('a boot where nothing would change stops nothing', async () => {
    running = [
      { name: 'nanoclaw-v2-a', workgroupId: 'wg-quiet', sessionId: 's-a', groupId: 'ag-a' },
      { name: 'nanoclaw-v2-b', workgroupId: 'wg-also-quiet', sessionId: 's-b', groupId: 'ag-b' },
    ];

    const scope = await quiesceWorkgroupsForBootMountChange([]);

    // D1 form: every container is survivable and every container is still
    // stopped. The D2 PR changes this to `stopped === 0` and `stopped` empty —
    // that flip is D2's acceptance criterion, and this is its baseline.
    expect(scope.survivable).toBe(scope.containers);
    expect(scope.stopped).toBe(scope.containers);
    expect(stopped).toEqual(['nanoclaw-v2-a', 'nanoclaw-v2-b']);
  });
});
