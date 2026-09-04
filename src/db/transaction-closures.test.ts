/**
 * Receiver-aware tripwire over every `.transaction(` call in `src/`.
 *
 * Seam 3 lets raw better-sqlite3 statements and async `DbDriver` statements
 * share ONE connection while the fork converts leaf-by-leaf (PRs 1-5). That
 * coexistence is safe for exactly one reason: the fork opens zero DRIVER
 * transactions. A driver transaction yields at every `await`, and a raw
 * statement running in an interleaved continuation would execute inside the
 * open `BEGIN IMMEDIATE` — joining a transaction it knows nothing about and
 * rolling back with it — or throw "cannot start a transaction within a
 * transaction". A synchronous `db.transaction(() => …)()` closure cannot be
 * interleaved by anything, which is why every fork transaction stays raw until
 * PR 6 lands the central lease (plan §4.1, risk R4).
 *
 * So this file asserts two things about the CALL RECEIVER, resolved with the
 * TypeScript checker rather than by text — `db`, `raw`, `conn` and `driver` are
 * all just names, and a grep cannot tell which handle any of them holds:
 *
 *   1. a receiver typed `DbDriver` is forbidden anywhere in src/;
 *   2. a receiver typed better-sqlite3 `Database` appears only in the pinned
 *      files below.
 *
 * PR 6 flips (1) in the same commit that converts all ten central sites onto
 * `centralTransaction`.
 *
 * Both positive fixtures live in src/db/transaction-fixtures/ and are analyzed
 * by the same resolver, so a resolver that silently stopped seeing either shape
 * fails instead of passing vacuously.
 *
 * See docs/specs/upstream-async-central-db-seam/plan.md §4.4 and §8.4.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

/**
 * Upstream-owned, excluded by design.
 *
 * `src/db/drivers/**` IS the driver (its `SqliteDriver` receiver is the
 * implementation), and `src/db/testing/driver-conformance.ts` is upstream's
 * conformance contract, whose whole job is to drive `DbDriver.transaction`.
 * Both are byte-identical ports pinned by src/host-lifecycle-seam.test.ts, so
 * editing them is already a failure — they need no rule here.
 */
const EXCLUDED_DIRS = ['src/db/drivers/', 'src/db/testing/', 'src/db/transaction-fixtures/'] as const;

/**
 * The ten CENTRAL-DB (`data/v2.db`) raw transaction sites. These are the ones
 * PR 6 converts to `centralTransaction`, and the list plan §3 names.
 */
export const CENTRAL_DB_RAW_TRANSACTION_FILES: readonly string[] = [
  'src/cli/crud.ts',
  'src/cli/resources/groups.ts',
  'src/cli/resources/wirings.ts',
  'src/container-runner.ts',
  'src/db/messaging-groups.ts',
  'src/db/migrations/index.ts',
  'src/db/provider-health.ts',
  'src/db/scheduled-tasks.ts',
  'src/db/sessions.ts',
  'src/db/usage.ts',
  'src/modules/orchestrator-dispatch/dispatch.ts',
];

/**
 * Raw transactions on a better-sqlite3 handle that is NOT the central DB —
 * session mailboxes (inbound.db/outbound.db), the per-agent archive
 * projections, and the mnemon ingest database. The receiver type is identical,
 * so the checker cannot separate them from the central sites; the split is
 * recorded here instead of pretending one list means one database.
 *
 * Seam 3 does not touch these: `DbDriver` is the CENTRAL database boundary, and
 * upstream says so explicitly ("Session mailboxes deliberately do not use this
 * interface", src/db/driver.ts). They are pinned only so a new raw transaction
 * cannot appear anywhere without a reviewer seeing it.
 */
export const OTHER_SQLITE_RAW_TRANSACTION_FILES: readonly string[] = [
  'src/db/migrations/019-mnemon-ingest-db.ts',
  'src/db/migrations/021-mnemon-recall-feedback.ts',
  'src/db/migrations/022-mnemon-daemon-state.ts',
  'src/db/migrations/023-mnemon-recall-fact-content.ts',
  'src/db/per-agent-projections.ts',
  'src/mailbox/sqlite/index.ts',
  'src/mailbox/sqlite/session-db.ts',
  'src/mailbox/sqlite/tasks.ts',
  'src/modules/mailbox/ops/admission.ts',
  'src/modules/mailbox/ops/continuation.ts',
  'src/modules/mailbox/ops/fence.ts',
  'src/modules/mailbox/ops/ingress.ts',
  'src/modules/mailbox/ops/session-state.ts',
  'src/modules/mailbox/ops/sweep.ts',
  'src/modules/mailbox/ops/tasks.ts',
  'src/modules/mailbox/schema.ts',
];

const PINNED_RAW_FILES = [...CENTRAL_DB_RAW_TRANSACTION_FILES, ...OTHER_SQLITE_RAW_TRANSACTION_FILES];

type ReceiverKind = 'raw-sqlite' | 'db-driver' | 'other';

interface TransactionCall {
  file: string;
  line: number;
  kind: ReceiverKind;
  typeName: string;
}

function toRel(absolute: string): string {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
}

/** Every src/ file whose text contains a `.transaction(` call, tests included. */
function transactionCallFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        /\.transaction\s*\(/.test(fs.readFileSync(full, 'utf8'))
      ) {
        out.push(full);
      }
    }
  };
  walk(SRC_ROOT);
  return out.sort();
}

function compilerOptions(): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(path.join(REPO_ROOT, 'tsconfig.json'), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, ' '));
    },
  } as ts.ParseConfigFileHost);
  if (!parsed) throw new Error('tsconfig.json could not be parsed');
  return { ...parsed.options, noEmit: true, skipLibCheck: true };
}

/**
 * Resolve the receiver type of every `.transaction(` call in `rootFiles`.
 *
 * Classification is by the type's DECLARATION SITE, not its printed name: a
 * fork type could be called `Database` too, and better-sqlite3's is only
 * `Database` because of how the package declares it.
 */
function analyzeTransactionReceivers(rootFiles: string[]): TransactionCall[] {
  const program = ts.createProgram(rootFiles, compilerOptions());
  const checker = program.getTypeChecker();
  const results: TransactionCall[] = [];
  const rootSet = new Set(rootFiles.map((f) => path.resolve(f)));

  for (const sourceFile of program.getSourceFiles()) {
    if (!rootSet.has(path.resolve(sourceFile.fileName))) continue;
    const rel = toRel(sourceFile.fileName);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'transaction'
      ) {
        const type = checker.getTypeAtLocation(node.expression.expression);
        const symbol = type.getSymbol() ?? type.aliasSymbol;
        const declaration = symbol?.declarations?.[0];
        const declaredIn = declaration ? declaration.getSourceFile().fileName.split(path.sep).join('/') : '';
        const name = symbol?.getName() ?? checker.typeToString(type);
        let kind: ReceiverKind = 'other';
        if (name === 'Database' && /\/better-sqlite3\//.test(declaredIn)) kind = 'raw-sqlite';
        else if (name === 'DbDriver' && declaredIn.endsWith('/src/db/driver.ts')) kind = 'db-driver';
        results.push({
          file: rel,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          kind,
          typeName: checker.typeToString(type),
        });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }
  return results;
}

function isExcluded(rel: string): boolean {
  return EXCLUDED_DIRS.some((dir) => rel.startsWith(dir));
}

describe('every .transaction( receiver in src/', () => {
  const files = transactionCallFiles();
  const calls = analyzeTransactionReceivers(files);
  const inScope = calls.filter((c) => !isExcluded(c.file));

  it('resolves the receivers it claims to resolve', () => {
    // Without this, a resolver that classified everything as 'other' would pass
    // both assertions below while checking nothing.
    expect(inScope.length).toBeGreaterThan(20);
    expect(inScope.filter((c) => c.kind === 'other')).toEqual([]);
  });

  it('opens NO driver transaction anywhere', () => {
    const offenders = inScope.filter((c) => c.kind === 'db-driver').map((c) => `${c.file}:${c.line}`);
    expect(
      offenders,
      'DbDriver.transaction() is forbidden until seam-3 PR 6 lands src/db/central-lease.ts: while raw ' +
        'and driver statements share one connection, an open driver transaction yields at every await ' +
        'and a raw statement can execute inside it. See plan §4.1 / risk R4.',
    ).toEqual([]);
  });

  it('keeps raw better-sqlite3 transactions inside the pinned file set', () => {
    const rawFiles = [...new Set(inScope.filter((c) => c.kind === 'raw-sqlite').map((c) => c.file))].sort();
    const nonTest = rawFiles.filter((f) => !f.endsWith('.test.ts'));
    const added = nonTest.filter((f) => !PINNED_RAW_FILES.includes(f));
    expect(
      added,
      'a new file opens a raw synchronous SQLite transaction. If it is on the CENTRAL database it has to ' +
        'be reviewed against the raw/driver coexistence rule and added to CENTRAL_DB_RAW_TRANSACTION_FILES; ' +
        'if it is a session mailbox or another SQLite file, add it to OTHER_SQLITE_RAW_TRANSACTION_FILES.',
    ).toEqual([]);
    const removed = PINNED_RAW_FILES.filter((f) => !nonTest.includes(f));
    expect(removed, 'these pinned files no longer open a raw transaction — drop them from the list').toEqual([]);
  });

  it('pins real, unique, sorted paths', () => {
    for (const list of [CENTRAL_DB_RAW_TRANSACTION_FILES, OTHER_SQLITE_RAW_TRANSACTION_FILES]) {
      expect(list).toEqual([...list].sort());
      expect(new Set(list).size).toBe(list.length);
      expect(list.filter((f) => !fs.existsSync(path.join(REPO_ROOT, f)))).toEqual([]);
    }
  });
});

describe('the receiver resolver sees both shapes', () => {
  const fixtures = ['raw-receiver.ts', 'driver-receiver.ts'].map((f) =>
    path.join(SRC_ROOT, 'db', 'transaction-fixtures', f),
  );
  const calls = analyzeTransactionReceivers(fixtures);

  it('classifies a better-sqlite3 receiver as raw', () => {
    const raw = calls.filter((c) => c.file === 'src/db/transaction-fixtures/raw-receiver.ts');
    expect(raw.map((c) => c.kind)).toEqual(['raw-sqlite']);
  });

  it('classifies a DbDriver receiver as a driver transaction', () => {
    const driver = calls.filter((c) => c.file === 'src/db/transaction-fixtures/driver-receiver.ts');
    expect(driver.map((c) => c.kind)).toEqual(['db-driver']);
  });
});
