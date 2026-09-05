/**
 * The mount-change door invariant (convergence seam 4 —
 * docs/specs/upstream-restart-survival-seam/plan.md §4.2).
 *
 * `reconcileWorkgroupMemory` and `reconcileWorkgroupSharedDirs` rewrite a
 * group's `memory` path into a CONTAINER-ABSOLUTE symlink and move shared trees
 * out from under `/workspace/agent/<name>`. A container spawned before that
 * cutover ends up with a dangling mount target, so both may run only from
 * inside a quiescence door:
 *
 *   - the BOOT door, `quiesceWorkgroupsForBootMountChange`, whose stop set
 *     comes from the container runtime by label;
 *   - the RUNTIME door, `quiesceSessionsForRepositoryMounts`, whose stop set
 *     comes from the in-process registry (empty at boot — divergence 2, which
 *     is why there are two doors and not one);
 *
 * or from the spawn path, which reconciles one workgroup for a container that
 * does not exist yet.
 *
 * Both cases are STATIC. They read the source with the TypeScript parser rather
 * than a grep, so a call inside a comment or a string cannot satisfy them and a
 * renamed local cannot hide one. The caller set is a ratchet: it may shrink,
 * never grow. Growing it means a new door, and a new door needs its own proof.
 */
import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

const RECONCILERS = ['reconcileWorkgroupMemory', 'reconcileWorkgroupSharedDirs'] as const;
const BOOT_DOOR = 'quiesceWorkgroupsForBootMountChange';

/**
 * Every call site allowed to enter a reconciler, as `file::function`.
 *
 * SHRINK-OR-EQUAL. `runBootMountQuiescence` is the boot continuation: it awaits
 * the boot door before either call (asserted below). `spawnContainer` is the
 * spawn path — one workgroup, for a container that has not started, ahead of
 * the mount set being fixed. The declaring module is excluded: its own internal
 * calls are the implementation.
 */
const PINNED_CALLERS: readonly string[] = [
  'src/main.ts::runBootMountQuiescence',
  'src/container-runner.ts::spawnContainer',
];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
    }
  };
  walk(SRC_ROOT);
  return out.sort();
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
}

/** Nearest named function/method enclosing a node, or `<module>`. */
function enclosingFunction(node: ts.Node): string {
  for (let cursor: ts.Node | undefined = node.parent; cursor; cursor = cursor.parent) {
    if (ts.isFunctionDeclaration(cursor) || ts.isMethodDeclaration(cursor)) {
      return cursor.name ? cursor.name.getText() : '<anonymous>';
    }
    if (
      (ts.isFunctionExpression(cursor) || ts.isArrowFunction(cursor)) &&
      ts.isVariableDeclaration(cursor.parent) &&
      ts.isIdentifier(cursor.parent.name)
    ) {
      return cursor.parent.name.text;
    }
  }
  return '<module>';
}

/**
 * Identifiers named in a call POSITION — the callee itself, including the
 * `(a ?? b)(…)` default-injection shape the boot block uses. A reference that
 * only passes the function as a value (a `deps` default, a re-export) is not a
 * call and does not open a door.
 */
function calledIdentifiers(node: ts.CallExpression): string[] {
  const names: string[] = [];
  const collect = (expr: ts.Expression): void => {
    const inner = ts.isParenthesizedExpression(expr) ? expr.expression : expr;
    if (ts.isIdentifier(inner)) names.push(inner.text);
    else if (ts.isPropertyAccessExpression(inner)) names.push(inner.name.text);
    else if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      collect(inner.left);
      collect(inner.right);
    }
  };
  collect(node.expression);
  return names;
}

interface CallSite {
  file: string;
  fn: string;
  callee: string;
  pos: number;
}

function callSites(file: string, wanted: readonly string[]): CallSite[] {
  const source = parse(file);
  const rel = path.relative(REPO_ROOT, file);
  const found: CallSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      for (const name of calledIdentifiers(node)) {
        if (wanted.includes(name)) {
          found.push({ file: rel, fn: enclosingFunction(node), callee: name, pos: node.getStart(source) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('workgroup reconcile doors', () => {
  it('reconcileWorkgroupMemory and reconcileWorkgroupSharedDirs have exactly the pinned callers', () => {
    const declaring = path.join(SRC_ROOT, 'modules', 'workgroup', 'shared-dirs.ts');
    const callers = new Set<string>();
    for (const file of sourceFiles()) {
      if (file === declaring) continue;
      for (const site of callSites(file, RECONCILERS)) callers.add(`${site.file}::${site.fn}`);
    }

    // Shrink-or-equal: a caller may disappear (D2 and E both remove work from
    // this path), but a NEW one is a new door and fails here.
    const unpinned = [...callers].sort().filter((caller) => !PINNED_CALLERS.includes(caller));
    expect(unpinned).toEqual([]);
    // Not vacuous: the resolver must still see the boot caller it is guarding.
    expect([...callers]).toContain('src/main.ts::runBootMountQuiescence');
  });

  it('the boot caller is reached only after a quiescence door', () => {
    const mainFile = path.join(SRC_ROOT, 'main.ts');
    const reconcileSites = callSites(mainFile, RECONCILERS);
    const doorSites = callSites(mainFile, [BOOT_DOOR]);

    expect(reconcileSites.length).toBeGreaterThan(0);
    expect(doorSites.length).toBe(1);

    // `main()` itself no longer reconciles anything; the block moved into the
    // boot continuation, and that is where the door lives too.
    expect(reconcileSites.filter((site) => site.fn === 'main')).toEqual([]);

    for (const site of reconcileSites) {
      const door = doorSites.find((entry) => entry.fn === site.fn);
      expect(door, `${site.callee} in ${site.fn}() is not preceded by a ${BOOT_DOOR} call`).toBeDefined();
      expect(door!.pos).toBeLessThan(site.pos);
    }

    // …and the door is awaited, not fired and forgotten: the reconciles below
    // it must observe a resolved proof, not a pending promise.
    const source = parse(mainFile);
    const doorNode = (() => {
      let hit: ts.CallExpression | null = null;
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && calledIdentifiers(node).includes(BOOT_DOOR)) hit = node;
        ts.forEachChild(node, visit);
      };
      visit(source);
      return hit as ts.CallExpression | null;
    })();
    expect(doorNode).not.toBeNull();
    let awaited = false;
    for (let cursor: ts.Node | undefined = doorNode!.parent; cursor; cursor = cursor.parent) {
      if (ts.isAwaitExpression(cursor)) {
        awaited = true;
        break;
      }
      if (ts.isFunctionLike(cursor)) break;
    }
    expect(awaited).toBe(true);
  });
});
