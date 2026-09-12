/**
 * Gate: nothing hand-builds `<session>/inbound.db` except the module that owns
 * the layout.
 *
 * WHY A GREP-SHAPED GATE AND NOT PER-SCRIPT TESTS. #749's first pass fixed the
 * open sites it knew about and missed four operator scripts. Those four were
 * not wrong logic — they were four places nobody grepped. A per-script test
 * asserts that one call site produces one string; it goes green the moment
 * someone adds a fifth script, and it would not have caught the original four.
 * The failure mode is re-introducing the CONSTRUCTION, so that is what this
 * fails on.
 *
 * WHAT IS ACTUALLY UNSAFE. `<session>/inbound.db` is a hard link to the live
 * inode, so building the path is harmless and READING through it is correct.
 * What is unsafe is a read-WRITE open through that name: SQLite journals beside
 * the database it opened, and the session directory is bind-mounted read-write
 * into the container, so the journal lands somewhere a container can write —
 * which is the whole of #749. A static rule cannot see open modes reliably, so
 * this gate fails on the construction and each allowlisted site carries the
 * reason it is safe. The direction of travel is `resolveInboundDbPath`.
 *
 * The list only ever SHRINKS. A new entry means a new hand-built legacy path,
 * which is the thing this exists to stop; a rename is one removal plus one
 * addition, and the addition fails.
 */
import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const SCAN_ROOTS = ['src', 'scripts', 'setup'] as const;

/**
 * Files allowed to hand-build a path ending in the `inbound.db` literal, each
 * with the reason it is safe. Verified site by site, not assumed.
 */
export const LEGACY_INBOUND_PATH_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  ['src/modules/mailbox/host-inbound.ts', 'defines the layout: both the host-owned path and the legacy hard link'],
  ['src/session-manager.ts', 'statSync only — never opened'],
  ['src/session-close-expiry.ts', 'existsSync only — never opened'],
  [
    'src/dashboard/api/scheduled-shared.ts',
    'sessionInboundPathFor builds and containment-checks the path; its callers read through readSessionInbound',
  ],
  ['src/modules/sweep-scheduled-move/index.ts', 'existsSync only — never opened'],
  ['scripts/list-scheduled-tasks.ts', 'existsSync, then a { readonly: true } open'],
  ['scripts/verify-workgroup-memory-runtime.ts', '{ readonly: true, fileMustExist: true } open'],
  ['scripts/inventory-tasks-by-provider.ts', '{ readonly: true } open'],
  ['scripts/lookback.ts', '{ readonly: true } opens'],
  ['scripts/fleet-drift.ts', '{ readonly: true } open'],
  ['scripts/restore-session-mtimes.ts', 'statSync and realpath containment only — never opened'],
  ['scripts/_audit_scan_tasks.ts', '{ readonly: true, fileMustExist: true } open'],
  [
    'scripts/backfill-task-routing-platform-id.ts',
    '{ readonly: true, fileMustExist: true } open; its read-write open is the CENTRAL db',
  ],
  [
    'scripts/adopt-host-inbound-provenance.ts',
    'builds the HOST-OWNED `.host/inbound.db` path, which is the protected one',
  ],
]);

function listRuntimeTs(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listRuntimeTs(full, out);
    // Test fixtures build session paths constantly and never run against a live
    // data directory, so they are out of scope — the same line the raw-handle
    // ratchets draw.
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** Line numbers where this file joins/resolves a path against the `inbound.db` literal. */
function handBuiltInboundPaths(file: string): number[] {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];

  const isPathJoinOrResolve = (expr: ts.LeftHandSideExpression): boolean =>
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === 'path' &&
    (expr.name.text === 'join' || expr.name.text === 'resolve');

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      isPathJoinOrResolve(node.expression) &&
      node.arguments.some((arg) => ts.isStringLiteral(arg) && arg.text === 'inbound.db')
    ) {
      lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

function scan(): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const root of SCAN_ROOTS) {
    for (const file of listRuntimeTs(path.join(REPO_ROOT, root))) {
      const lines = handBuiltInboundPaths(file);
      if (lines.length > 0) found.set(path.relative(REPO_ROOT, file), lines);
    }
  }
  return found;
}

describe('nothing hand-builds the legacy inbound.db path (#749)', () => {
  it('every file joining the `inbound.db` literal is allowlisted with a reason', () => {
    const unexpected = [...scan().entries()]
      .filter(([file]) => !LEGACY_INBOUND_PATH_ALLOWLIST.has(file))
      .map(([file, lines]) => `${file}:${lines.join(',')}`);

    expect(
      unexpected,
      'a new hand-built `<session>/inbound.db` path. A read-only open or an existsSync through that name is ' +
        'correct (it is a hard link to the live inode), but a read-WRITE open journals into the ' +
        'container-writable session directory (#749). Use resolveInboundDbPath — or, if this site is genuinely ' +
        'read-only, add it to LEGACY_INBOUND_PATH_ALLOWLIST with the reason.',
    ).toEqual([]);
  });

  it('the allowlist only shrinks — no entry outlives the construction it excuses', () => {
    const found = scan();
    const stale = [...LEGACY_INBOUND_PATH_ALLOWLIST.keys()].filter((file) => !found.has(file));

    expect(stale, 'these files no longer hand-build the path; drop them from the allowlist').toEqual([]);
  });
});
