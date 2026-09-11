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
 *   1. a receiver typed `DbDriver` appears only in `src/db/central-lease.ts`;
 *   2. a receiver typed better-sqlite3 `Database` appears only in the pinned
 *      files below.
 *
 * (1) opened up in PR 6a, which landed the lease itself: `centralTransaction`
 * acquires a fork-level lease before it calls `DbDriver.transaction`, so a
 * synchronous central block can no longer land inside an open `BEGIN
 * IMMEDIATE` — it waits for the lease instead. Every OTHER file is still
 * forbidden to call `DbDriver.transaction`, because going around the lease is
 * exactly the hazard the lease removes. PR 6 moves the eleven central sites
 * from a raw receiver onto `centralTransaction`, which is when list (2) starts
 * shrinking.
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
 * The only fork file allowed to call `DbDriver.transaction` (plan §4.4).
 *
 * It is also the POSITIVE fixture for the driver-receiver half of the resolver:
 * the test below asserts the call is still found there, so a resolver that
 * silently stopped classifying driver receivers fails instead of reporting an
 * empty offender list.
 */
export const DRIVER_TRANSACTION_FILES: readonly string[] = ['src/db/central-lease.ts'];

/**
 * The CENTRAL-DB (`data/v2.db`) raw transaction sites that remain after PR 6.
 *
 * The plan's ten `db.transaction(() => …)()` closures moved onto
 * `centralTransaction` (which is the ONLY caller of `DbDriver.transaction`),
 * so they no longer have a raw `.transaction(` receiver. What is left is the
 * migration runner: it runs at boot with no concurrent central-DB activity,
 * stays synchronous on the raw handle (plan §4.3 amendment), and is the one
 * central file still allowed a raw `db.transaction`.
 */
export const CENTRAL_DB_RAW_TRANSACTION_FILES: readonly string[] = ['src/db/migrations/index.ts'];

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

  it('opens a driver transaction only inside the central lease', () => {
    const offenders = inScope
      .filter((c) => c.kind === 'db-driver' && !DRIVER_TRANSACTION_FILES.includes(c.file))
      .map((c) => `${c.file}:${c.line}`);
    expect(
      offenders,
      'DbDriver.transaction() belongs to src/db/central-lease.ts alone. Calling it directly skips the ' +
        'fork lease, and a synchronous central block can then land inside the open BEGIN IMMEDIATE and ' +
        'roll back with it. Use centralTransaction(). See plan §4.1 / §4.4 / risk R4.',
    ).toEqual([]);
  });

  it('still finds the driver-receiver call it allows, so the rule is not vacuous', () => {
    const inLease = inScope.filter((c) => c.file === 'src/db/central-lease.ts');
    expect(inLease.map((c) => c.kind)).toEqual(['db-driver']);
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
    for (const list of [
      CENTRAL_DB_RAW_TRANSACTION_FILES,
      OTHER_SQLITE_RAW_TRANSACTION_FILES,
      DRIVER_TRANSACTION_FILES,
    ]) {
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

/**
 * A `centralTransaction`/`DbDriver.transaction` closure may await ONLY DB work
 * (plan §4.4): the driver runs each statement synchronously on the shared
 * handle, so an await into a NON-DB subsystem inside the open `BEGIN
 * IMMEDIATE` would fire from a suspended continuation — after a rollback, or
 * joining a transaction it knows nothing about. The forbidden subsystems are
 * exactly the ones §4.4 names: the mailbox/session layer, the container
 * runner, a channel adapter, `fetch`/network, and the lease itself
 * (`centralTransaction`/`withCentralSync`, which would deadlock). Awaiting an
 * async DB-leaf helper (`getProviderHealth`, `insertTaskAtomic`, …) is fine —
 * those issue only driver statements, and a purity check that refused them
 * would forbid the very shape the plan uses.
 *
 * The check resolves the DECLARATION FILE of every awaited callee inside a
 * `centralTransaction` closure with the TypeScript checker, and flags one whose
 * declaration is in a denylisted module (or a `fetch`/global with no local
 * declaration, or a nested `DbDriver.transaction`). Text cannot tell
 * `await getDb().run(...)` from `await writeSessionMessage(...)`.
 *
 * Two fixtures prove it is not vacuous: `db-only-closure.ts` awaits only DB
 * work and must pass; `impure-closure.ts` awaits `fetch` and a nested
 * `getDb().transaction` and must be flagged.
 */
const FORBIDDEN_AWAIT_DECL = [
  '/src/session-manager.ts',
  '/src/container-runner.ts',
  '/src/delivery.ts',
  '/src/channels/',
  '/src/modules/mailbox/',
  '/src/db/central-lease.ts',
] as const;

interface AwaitClassification {
  file: string;
  line: number;
  callee: string;
  forbidden: boolean;
}

function awaitedCalleesInCentralTransactions(rootFiles: string[]): AwaitClassification[] {
  const program = ts.createProgram(rootFiles, compilerOptions());
  const checker = program.getTypeChecker();
  const rootSet = new Set(rootFiles.map((f) => path.resolve(f)));
  const results: AwaitClassification[] = [];

  const receiverIsDbDriver = (call: ts.CallExpression): boolean => {
    if (!ts.isPropertyAccessExpression(call.expression)) return false;
    const type = checker.getTypeAtLocation(call.expression.expression);
    const check = (t: ts.Type): boolean => {
      const sym = t.getSymbol() ?? t.aliasSymbol;
      const decl = sym?.declarations?.[0];
      return (
        sym?.getName() === 'DbDriver' &&
        (decl?.getSourceFile().fileName.split(path.sep).join('/').endsWith('/src/db/driver.ts') ?? false)
      );
    };
    return type.isUnion() ? type.types.some(check) : check(type);
  };

  const classify = (call: ts.CallExpression): { callee: string; forbidden: boolean } => {
    // A nested driver transaction bypasses the fork lease — always forbidden.
    if (
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === 'transaction' &&
      receiverIsDbDriver(call)
    ) {
      return { callee: 'DbDriver.transaction', forbidden: true };
    }
    const target = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
    const sym = checker.getSymbolAtLocation(target);
    const name = ts.isIdentifier(target) ? target.text : checker.typeToString(checker.getTypeAtLocation(target));
    const decls = sym?.declarations ?? [];
    if (decls.length === 0) {
      // No local declaration (a global like `fetch`) — forbidden unless it is a
      // driver method (whose symbol resolves into src/db/driver.ts, handled above).
      return { callee: name, forbidden: name === 'fetch' };
    }
    const declFile = decls[0].getSourceFile().fileName.split(path.sep).join('/');
    const forbidden = FORBIDDEN_AWAIT_DECL.some((frag) => declFile.includes(frag));
    return { callee: name, forbidden };
  };

  for (const sourceFile of program.getSourceFiles()) {
    if (!rootSet.has(path.resolve(sourceFile.fileName))) continue;
    const rel = toRel(sourceFile.fileName);
    let depth = 0;
    const visit = (node: ts.Node): void => {
      let pushed = false;
      if (
        ts.isCallExpression(node) &&
        ((ts.isIdentifier(node.expression) && node.expression.text === 'centralTransaction') ||
          (ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'transaction' &&
            receiverIsDbDriver(node)))
      ) {
        const closure = node.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
        if (closure) {
          depth += 1;
          pushed = true;
        }
      }
      if (depth > 0 && ts.isAwaitExpression(node) && ts.isCallExpression(node.expression)) {
        const { callee, forbidden } = classify(node.expression);
        results.push({
          file: rel,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          callee,
          forbidden,
        });
      }
      ts.forEachChild(node, visit);
      if (pushed) depth -= 1;
    };
    ts.forEachChild(sourceFile, visit);
  }
  return results;
}

describe('centralTransaction closures await only DB work', () => {
  it('flags a fixture that awaits fetch or a nested driver transaction', () => {
    const impure = path.join(SRC_ROOT, 'db', 'transaction-fixtures', 'impure-closure.ts');
    const dbOnly = path.join(SRC_ROOT, 'db', 'transaction-fixtures', 'db-only-closure.ts');
    const impureAwaits = awaitedCalleesInCentralTransactions([impure]);
    const dbOnlyAwaits = awaitedCalleesInCentralTransactions([dbOnly]);
    // Non-vacuous: the resolver actually finds awaits in both fixtures.
    expect(impureAwaits.length).toBeGreaterThan(0);
    expect(dbOnlyAwaits.length).toBeGreaterThan(0);
    expect(impureAwaits.some((a) => a.forbidden)).toBe(true);
    expect(dbOnlyAwaits.every((a) => !a.forbidden)).toBe(true);
  });

  // This builds a full ts.Program over transactionCallFiles() (dozens of files, full
  // type checking) inside the test body, not at collection time like the `every
  // .transaction( receiver` describe block above. Comfortably fast normally, but
  // `--coverage`'s V8 instrumentation overhead applies to every statement executed
  // process-wide — including this one, even though transaction-closures.test.ts
  // itself matches no risk:high glob — and pushed it past the 5000ms default in CI
  // (PR #662). No explicit per-test timeout here: vitest.config.ts's
  // COVERAGE_TIMEOUT_MULTIPLIER scales the GLOBAL default under --coverage instead
  // (a fixed per-test override would ignore that scaling and need updating by hand
  // every time the multiplier does).
  it('no production centralTransaction closure awaits a forbidden subsystem', () => {
    const offenders = awaitedCalleesInCentralTransactions(transactionCallFiles())
      // `src/db/drivers/**` and `src/db/testing/**` ARE the driver and its
      // upstream conformance contract, whose job is to drive nested
      // `DbDriver.transaction`; both are byte-identical ports pinned elsewhere.
      .filter((a) => a.forbidden && !isExcluded(a.file))
      .map((a) => `${a.file}:${a.line} awaits ${a.callee}`);
    expect(
      offenders,
      'a centralTransaction closure awaits a mailbox/container/adapter/network/lease call. The driver runs ' +
        'each statement synchronously on the shared handle, so that await inside the open BEGIN IMMEDIATE fires ' +
        'from a suspended continuation — after a rollback, or joining an unrelated transaction. Move the effect ' +
        'after the transaction resolves. See plan §4.4.',
    ).toEqual([]);
  });
});

/**
 * A callee reached from inside a `centralTransaction` closure must not open a
 * `centralTransaction` of its own.
 *
 * The lease is deliberately not re-entrant: `assertLeaseNotHeld` throws
 * `CentralLeaseReentrancyError` rather than deadlocking. That makes nesting a
 * loud failure at the call — but only for callers that let it out. The shape
 * that shipped as a P1 on #505 was `centralTransaction(async () => { await
 * createMessagingGroupAgent(row); })`, where the callee is an ordinary exported
 * writer that opens its own transaction: correct alone, correct for every
 * caller outside a transaction, fatal here. The throw landed in the caller's
 * existing "could not auto-wire" catch and every eligible channel fell through
 * to the approval gate, so workspace-trust auto-wire would have been silently
 * dead on main. Nothing in the type system says which functions carry a lease.
 *
 * The check above cannot see it. It classifies an awaited callee by its
 * DECLARATION FILE, which for the offender is a perfectly ordinary DB module,
 * and it only scans files whose text contains `.transaction(` — which
 * `centralTransaction` callers usually do not.
 *
 * So this one selects files by `centralTransaction(`, and for every call inside
 * such a closure resolves the callee's declaration and looks for a
 * `centralTransaction` call in ITS body. One hop, deliberately: a full call
 * graph would be far more machinery for a shape that has always been one
 * import-and-call away. The fix is to split the callee — a lease-free inner
 * function holding the statements, called by both the exported wrapper and the
 * caller that already holds the lease (`createMessagingGroupAgentInTransaction`
 * is that split).
 */

/**
 * Callees allowed to open a transaction despite being reachable from inside
 * one, each with the reason it is safe. EMPTY on purpose today: the fix for
 * #505 was to split the writer rather than to except it, and
 * `createMessagingGroupAgentInTransaction` needs no entry because it opens no
 * lease. An entry belongs here only when the nesting call is provably
 * unreachable while the lease is held — not when it merely looks unlikely.
 */
const NESTED_TRANSACTION_EXCEPTIONS: ReadonlyArray<{ callee: string; reason: string }> = [];

interface NestingCall {
  file: string;
  line: number;
  callee: string;
  declaredIn: string;
}

/** Every src/ file that calls `centralTransaction`, tests included. */
function centralTransactionFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        /centralTransaction\s*\(/.test(fs.readFileSync(full, 'utf8'))
      ) {
        out.push(full);
      }
    }
  };
  walk(SRC_ROOT);
  return out.sort();
}

/** Does this declaration's body call `centralTransaction`? */
function bodyOpensCentralTransaction(declaration: ts.Declaration): boolean {
  const body = ts.isVariableDeclaration(declaration) ? declaration.initializer : declaration;
  if (!body) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'centralTransaction'
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return found;
}

function nestingCallsInCentralTransactions(rootFiles: string[]): NestingCall[] {
  const program = ts.createProgram(rootFiles, compilerOptions());
  const checker = program.getTypeChecker();
  const rootSet = new Set(rootFiles.map((f) => path.resolve(f)));
  const results: NestingCall[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (!rootSet.has(path.resolve(sourceFile.fileName))) continue;
    const rel = toRel(sourceFile.fileName);
    let depth = 0;
    const visit = (node: ts.Node): void => {
      let pushed = false;
      const opensBlock =
        ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'centralTransaction';
      if (opensBlock) {
        const closure = (node as ts.CallExpression).arguments.find(
          (a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a),
        );
        if (closure) {
          depth += 1;
          pushed = true;
        }
      }
      // Skip the block-opening call itself: it is the lease, not a nested one.
      if (depth > 0 && !opensBlock && ts.isCallExpression(node)) {
        const target = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
        if (ts.isIdentifier(target)) {
          // Resolve through the import: `getSymbolAtLocation` on an imported
          // name yields the ALIAS, whose only declaration is the
          // `ImportSpecifier` in THIS file. Following it is the difference
          // between reading the callee's body and reading the import line —
          // and every call this rule exists to catch is an imported one.
          let symbol = checker.getSymbolAtLocation(target);
          if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
          const declaration = symbol?.declarations?.[0];
          if (declaration && bodyOpensCentralTransaction(declaration)) {
            results.push({
              file: rel,
              line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
              callee: target.text,
              declaredIn: toRel(declaration.getSourceFile().fileName),
            });
          }
        }
      }
      ts.forEachChild(node, visit);
      if (pushed) depth -= 1;
    };
    ts.forEachChild(sourceFile, visit);
  }
  return results;
}

describe('nothing called from inside a centralTransaction opens another one', () => {
  const fixtureDir = path.join(SRC_ROOT, 'db', 'transaction-fixtures');

  it('flags the nesting fixture and clears the participating one', () => {
    const found = nestingCallsInCentralTransactions([path.join(fixtureDir, 'nesting-callee.ts')]);
    // Non-vacuous: exactly the one offending call, and nothing else in a file
    // that also holds a correct closure calling a lease-free leaf.
    expect(found.map((c) => c.callee)).toEqual(['opensItsOwnTransaction']);
  });

  // Same reason as the sibling test above (`no production centralTransaction closure
  // awaits a forbidden subsystem`): a full ts.Program over centralTransactionFiles()
  // built inside the test body, slow enough under `--coverage`'s V8 instrumentation
  // overhead to miss the default timeout in CI (PR #662). No explicit per-test
  // timeout — vitest.config.ts's COVERAGE_TIMEOUT_MULTIPLIER scales the global
  // default instead; see that sibling test's comment for why.
  it('no production centralTransaction closure calls a callee that opens its own', () => {
    const offenders = nestingCallsInCentralTransactions(centralTransactionFiles())
      .filter((c) => !isExcluded(c.file))
      .filter((c) => !NESTED_TRANSACTION_EXCEPTIONS.some((e) => e.callee === c.callee))
      .map((c) => `${c.file}:${c.line} calls ${c.callee}() (declared in ${c.declaredIn}), which opens its own`);
    expect(
      offenders,
      'a centralTransaction closure calls a function that opens a centralTransaction of its own. The lease ' +
        'is not re-entrant, so this throws CentralLeaseReentrancyError at run time — and if the call site has ' +
        'a catch, the feature dies silently instead. Split the callee: a lease-free inner function holding the ' +
        'statements, called by both the exported wrapper and this caller (see ' +
        'createMessagingGroupAgentInTransaction). Except it here only if the nesting call is provably ' +
        'unreachable while the lease is held.',
    ).toEqual([]);
  });

  it('lists real, unique exceptions with a reason each', () => {
    const callees = NESTED_TRANSACTION_EXCEPTIONS.map((e) => e.callee);
    expect(new Set(callees).size).toBe(callees.length);
    expect(NESTED_TRANSACTION_EXCEPTIONS.filter((e) => e.reason.trim() === '')).toEqual([]);
  });

  it('scans the files the other checks miss, so the rule is not vacuous', () => {
    const files = centralTransactionFiles().map(toRel);
    // `src/router.ts` holds the auto-wire that shipped the P1 and contains no
    // `.transaction(` text at all, so the receiver-based file selection above
    // never looks at it. If this stops being true the two selections have
    // converged and this check's separate walk can go.
    expect(files).toContain('src/router.ts');
    expect(transactionCallFiles().map(toRel)).not.toContain('src/router.ts');
    expect(files.length).toBeGreaterThan(10);
  });
});
