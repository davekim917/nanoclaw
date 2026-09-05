/**
 * Invariant in a primitive (plan §4.2): a workgroup mount change goes only
 * through a quiescence door.
 *
 * `reconcileWorkgroupMemory` and `reconcileWorkgroupSharedDirs` repoint a
 * group's local `memory` at a container-absolute symlink target that resolves
 * only inside a container spawned with the workgroup bind mount. A container
 * that outlives the cutover ends up with a dangling /workspace/agent/memory,
 * so the two may run only from behind:
 *
 *  - the BOOT door, `quiesceWorkgroupsForBootMountChange`, whose stop set
 *    comes from the container runtime by label, or
 *  - the RUNTIME door, `quiesceAgentGroupsForRepositoryMounts` /
 *    `quiesceSessionsForRepositoryMounts`, whose stop set comes from the
 *    in-process registry (empty at boot, which is why there are two).
 *
 * Two halves, matching the ratchets seam 2 and seam 3 use: the caller FILE set
 * may shrink and never grow, and the boot caller is reached only after the
 * boot door's await.
 */
import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const SCAN_ROOTS = ['src', 'scripts', 'setup'] as const;

const RECONCILERS = ['reconcileWorkgroupMemory', 'reconcileWorkgroupSharedDirs'] as const;

/**
 * Not callers, and excluded from the scan: the module that defines both, and
 * this file plus the two suites that name them in assertions or matchers.
 */
const NOT_CALLERS: readonly string[] = [
  'src/modules/workgroup/shared-dirs.ts',
  'src/modules/workgroup/shared-dirs.test.ts',
  'src/modules/workgroup/shared-dirs.wouldchange.test.ts',
  'src/main.memory-startup-order.test.ts',
  'src/boot-quiescence-order.test.ts',
  'src/workgroup-reconcile-doors.test.ts',
];

/**
 * Every non-test file that reaches either reconciler.
 *
 * `src/main.ts` is the boot continuation, behind `quiesceWorkgroupsForBootMountChange`.
 * `src/container-runner.ts` is the pre-spawn membership check for the one
 * workgroup a container is about to be spawned into, and it refuses the spawn
 * on `migration-required` rather than cutting over under a live container.
 *
 * This list may LOSE entries. Adding one fails: a new caller is a new way for a
 * mount cutover to run outside a door, and it needs the plan's argument in the
 * PR that adds it, not a silent edit here.
 */
const PINNED_CALLERS: readonly string[] = ['src/container-runner.ts', 'src/main.ts'];

/** Comments stripped, so a mention in a doc block is not a call. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`])\/\/[^\n]*/g, (_m, lead: string) => lead);
}

function scanFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push(path.relative(REPO_ROOT, full));
    }
  };
  for (const root of SCAN_ROOTS) walk(path.join(REPO_ROOT, root));
  return out.sort();
}

/**
 * Calls made directly by `main()`, in source order, prefixed with `await ` when
 * awaited. Recursive: the shared-FS consolidation sits inside an `if` and a
 * `try`, and a call hidden in a nested block is still a call.
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
      calls.push(`${ts.isAwaitExpression(node.parent) ? 'await ' : ''}${node.expression.text}`);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(main.body, visit);
  return calls;
}

describe('workgroup reconcile doors', () => {
  it('scans a tree that actually contains the seam', () => {
    // Guards the scanner: a broken walk would report an empty caller set and
    // pass the shrink assertion below while checking nothing.
    const files = scanFiles();
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain('src/modules/workgroup/shared-dirs.ts');
    expect(files).toContain('src/main.ts');
  });

  it('reconcileWorkgroupMemory and reconcileWorkgroupSharedDirs have exactly the pinned callers', () => {
    const callers = scanFiles()
      .filter((file) => !NOT_CALLERS.includes(file) && !file.endsWith('.test.ts'))
      .filter((file) => {
        const source = stripComments(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
        return RECONCILERS.some((name) => source.includes(name));
      });

    // Shrink-or-equal: every caller found must be pinned. Removing a pinned
    // entry that no longer exists is the direction of travel and needs no
    // ceremony beyond deleting the line.
    expect(callers.filter((file) => !PINNED_CALLERS.includes(file))).toEqual([]);
    expect(callers).toEqual(PINNED_CALLERS.filter((file) => callers.includes(file)));
  });

  it('the boot caller is reached only after a quiescence door', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'main.ts'), 'utf8');
    const calls = bootCallOrder(source);
    const door = calls.indexOf('await quiesceWorkgroupsForBootMountChange');

    expect(door).toBeGreaterThan(-1);
    // Nothing that reaches a reconciler may appear before the door resolves.
    // `runWorkgroupMemoryStartupGate` is main's entry to reconcileWorkgroupMemory.
    const gated = ['reconcileWorkgroupSharedDirs', 'reconcileWorkgroupMemory', 'runWorkgroupMemoryStartupGate'];
    const early = calls.slice(0, door).filter((call) => gated.includes(call.replace('await ', '')));
    expect(early).toEqual([]);
    expect(calls.slice(door).some((call) => call === 'runWorkgroupMemoryStartupGate')).toBe(true);
    expect(calls.slice(door).some((call) => call === 'reconcileWorkgroupSharedDirs')).toBe(true);
  });

  it('reads a reconciler call hoisted above the door as a violation', () => {
    // Negative control for the guard above, over a synthetic main().
    const hoisted = `export async function main(): Promise<void> {
      if (FLAG) { reconcileWorkgroupSharedDirs(db, {}); }
      await quiesceWorkgroupsForBootMountChange([]);
    }`;
    const calls = bootCallOrder(hoisted);
    const door = calls.indexOf('await quiesceWorkgroupsForBootMountChange');

    expect(calls.slice(0, door)).toContain('reconcileWorkgroupSharedDirs');
  });
});
