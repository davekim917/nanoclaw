/**
 * Seam 3 tripwire (PR 6, Codex round 1 on #460, plan risk R4): no runtime raw
 * statement executes outside the central lease.
 *
 * `centralTransaction` opens an async `BEGIN IMMEDIATE` that yields between
 * driver calls. A raw statement issued anywhere in that window bypasses the
 * driver's `activeTransaction` gate and silently joins the open transaction —
 * rolling back with it, or dying on "cannot start a transaction within a
 * transaction". The lease (`src/db/central-lease.ts`) makes that impossible
 * for code that reaches the connection through `withRawDb`, which only works
 * inside `withCentralSync`. This test pins the other half: nothing reaches
 * the connection any other way.
 *
 * Rule: every `getRawDb(` call in a runtime `src/` file is lexically inside a
 * `withRawDb(` callback that is itself inside a `withCentralSync(` callback —
 * except the files enumerated below, each with the reason it may hold the
 * bare handle. `src/db/raw-db-ratchet.test.ts` keeps pinning the FILE set
 * that names the handle at all; this test pins the CALL sites.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Files allowed to call `getRawDb()` outside a lease block. Fixed by design,
 * and the list only ever shrinks.
 */
export const BARE_RAW_HANDLE_FILES: ReadonlyMap<string, string> = new Map([
  ['src/db/connection.ts', 'defines getRawDb'],
  ['src/db/central-lease.ts', 'withRawDb is the sanctioned wrapper around it'],
  ['src/db/migrations/019-mnemon-ingest-db.ts', 'sqliteOnly migration; runs inside the synchronous runner at boot'],
  ['src/host-lifecycle-seam-manifest.ts', 'names the identifier in the upstream-owned manifest'],
  ['src/main.ts', 'the boot-time migration runner call and the reconcilers it hands the same handle'],
  [
    'src/storage-manager.ts',
    'the storage report and the reclaim executors run only in the storage maintenance worker thread ' +
      '(`storage-maintenance-worker-thread.ts`, its own connection via initDb — no host lease exists to join); ' +
      'the one host-side entry point, finishInterruptedSessionArchivals, takes the lease',
  ],
  [
    'src/worktree-cleanup.ts',
    'only reachable from scripts/storage-gc.ts, a standalone process with its own connection',
  ],
  ['src/db/transaction-fixtures/raw-receiver.ts', 'positive fixture for the receiver-aware transaction test'],
  ['src/test-fixtures/raw-db-fake.ts', 'test fixture'],
]);

function listRuntimeTs(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listRuntimeTs(full, out);
    else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    )
      out.push(full);
  }
  return out.sort();
}

function calleeName(node: ts.CallExpression): string {
  const e = node.expression;
  return ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : '';
}

/** Is `node` lexically inside the callback argument of a call to `name`? */
function insideCallbackOf(node: ts.Node, name: string): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isCallExpression(cur) && calleeName(cur) === name) {
      // Inside the call's ARGUMENTS (the callback), not merely inside the callee expression.
      return cur.arguments.some((arg) => arg.pos <= node.pos && node.end <= arg.end);
    }
  }
  return false;
}

interface Offender {
  file: string;
  line: number;
  why: string;
}

function scan(): { offenders: Offender[]; leased: number; files: number } {
  const offenders: Offender[] = [];
  let leased = 0;
  const files = listRuntimeTs(path.join(REPO_ROOT, 'src'));
  for (const full of files) {
    const rel = path.relative(REPO_ROOT, full).split(path.sep).join('/');
    const text = fs.readFileSync(full, 'utf8');
    if (!text.includes('getRawDb')) continue;
    if (BARE_RAW_HANDLE_FILES.has(rel)) continue;
    const sf = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && calleeName(node) === 'getRawDb') {
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if (!insideCallbackOf(node, 'withRawDb')) offenders.push({ file: rel, line, why: 'not inside withRawDb()' });
        else if (!insideCallbackOf(node, 'withCentralSync'))
          offenders.push({ file: rel, line, why: 'withRawDb() outside withCentralSync()' });
        else leased += 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { offenders, leased, files: files.length };
}

describe('no runtime raw statement executes outside the central lease', () => {
  it('scans a tree that contains the seam', () => {
    const { files } = scan();
    expect(files).toBeGreaterThan(400);
  });

  it('every getRawDb() call outside the enumerated files sits inside withCentralSync(() => withRawDb(…))', () => {
    const { offenders } = scan();
    expect(
      offenders.map((o) => `${o.file}:${o.line} ${o.why}`),
      'a raw statement can execute outside the central lease and join an open driver transaction (plan R4). ' +
        'Wrap it as withCentralSync(() => withRawDb((db) => …)), or reach the row through getDb() and await.',
    ).toEqual([]);
  });

  it('the bare-handle allowlist names only files that exist and still name the handle', () => {
    for (const rel of BARE_RAW_HANDLE_FILES.keys()) {
      const full = path.join(REPO_ROOT, rel);
      expect(fs.existsSync(full), `${rel} is allowlisted but missing — delete its row`).toBe(true);
      expect(
        fs.readFileSync(full, 'utf8').includes('getRawDb'),
        `${rel} no longer names getRawDb — delete its row (the list only shrinks)`,
      ).toBe(true);
    }
  });

  it('is not vacuous: the resolver classifies a leased call as leased', () => {
    const src = `
      import { withCentralSync, withRawDb } from './central-lease.js';
      import { getRawDb } from './connection.js';
      export async function ok() { return withCentralSync(() => withRawDb(() => getRawDb())); }
      export function bare() { return getRawDb(); }
      export function halfway() { return withRawDb(() => getRawDb()); }
    `;
    const sf = ts.createSourceFile('fixture.ts', src, ts.ScriptTarget.Latest, true);
    const found: Array<[string, boolean, boolean]> = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && calleeName(node) === 'getRawDb') {
        let fn: ts.Node | undefined = node;
        while (fn && !ts.isFunctionDeclaration(fn)) fn = fn.parent;
        found.push([
          (fn as ts.FunctionDeclaration).name!.text,
          insideCallbackOf(node, 'withRawDb'),
          insideCallbackOf(node, 'withCentralSync'),
        ]);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(found).toEqual([
      ['ok', true, true],
      ['bare', false, false],
      ['halfway', true, false],
    ]);
  });
});
