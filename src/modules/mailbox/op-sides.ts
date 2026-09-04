/**
 * Which side of a session's storage each op touches — inbound.db or outbound.db.
 *
 * DERIVED, not hand-listed. A hand list is a second source of truth that goes
 * stale the first time someone adds an op and forgets it, and a stale map here
 * would make the ratchet rules that consume it (src/mailbox-seam-ratchet.ts)
 * quietly wrong rather than loudly wrong.
 *
 * Two derivations, matching how `composeNanoclawSession` is actually built:
 *
 *  - Upstream's halves are read at RUNTIME. `wrapSqliteInbound` and
 *    `wrapSqliteOutbound` return plain objects of closures, so their key sets
 *    are exactly their op names — no parsing, and they cannot drift.
 *  - The fork's half is read from the SOURCE of `forkOps`, because those ops
 *    are bound to whichever handle their body uses and there is no runtime
 *    signal for that short of invoking them (which writes). Each entry is
 *    classified by the handle identifiers its value expression REFERENCES:
 *    `inbound` for the inbound handle, `readableOutbound`/`writableOutbound`/
 *    `readOutbound` for the outbound ones. An op that touches both is INBOUND
 *    for this map's purpose — see `outboundOnlyOps`.
 *
 * ## Why the compiler, and not a scanner
 *
 * This file used to split the object literal on top-level commas and test for
 * handle names with a word-boundary regex. That is an undocumented subset of
 * the TypeScript grammar, and it lost coverage twice:
 *
 *  - a doc comment's prose comma split an entry mid-sentence, the `key:` regex
 *    failed on the next chunk, and `readDoneProposal` vanished from the map;
 *  - and by construction a comma inside a string, a computed or shorthand key,
 *    a method-syntax op, or a spread it did not recognise would each do the
 *    same thing.
 *
 * A dropped entry is NOT the documented fail-closed case. Fail-closed applies
 * to a PARSED entry whose handles are ambiguous: it lands in `inbound`, and
 * the outbound-only rule then refuses to call the action outbound-only. An
 * entry that is never parsed at all is absent from BOTH sets, and both rules
 * filter unknown ops out before deciding — so the op silently leaves their
 * reach while every test stays green. Less strict, not more.
 *
 * So the literal is parsed with the TypeScript compiler API, and anything this
 * module cannot resolve — a computed key that is not a literal, a shorthand
 * whose binding is not in this file, an unrecognised spread, an accessor —
 * THROWS. Loud beats closed here: the two rules can only be trusted if the map
 * is complete, and a throw at derivation time is the one failure mode that
 * cannot be mistaken for a clean scan.
 *
 * Completeness is also asserted rather than assumed: the parsed fork keys plus
 * upstream's two runtime key sets must equal the key set `composeNanoclawSession`
 * actually produces. Upstream already had that parity check; the fork half is
 * the one that had none, and is the half a scanner could silently shrink.
 *
 * ## Reachability
 *
 * Build-time/test-time only. Nothing on the host's runtime path imports this
 * module — `mailbox-seam-ratchet.ts` names it in a comment, and the ratchet
 * test is its only importer — which is what makes the `typescript` devDependency
 * import below safe. Importing this from production code would put a compiler
 * in the host process and break an install without dev dependencies.
 *
 * The one thing this file must never become is a place to record intent. It
 * records what the composition does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { wrapSqliteInbound, wrapSqliteOutbound } from '../../mailbox/sqlite/index.js';

import { composeNanoclawSession } from './index.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(MODULE_DIR, 'index.ts');
const UPSTREAM_SQLITE_PATH = path.join(MODULE_DIR, '..', '..', 'mailbox', 'sqlite', 'index.ts');

/** Handle identifiers `forkOps` binds its ops to, by side. */
const OUTBOUND_HANDLES = ['readableOutbound', 'writableOutbound', 'readOutbound'];
const INBOUND_HANDLES = ['inbound'];

/** The handle a fork op must reference to be a write: `writableOutbound`, nothing else. */
const FORK_WRITABLE_HANDLE = 'writableOutbound';
/** Upstream's outbound half takes its writer from `writable()`; reads use `readable()`. */
const UPSTREAM_WRITABLE_HANDLE = 'writable';

export interface OpSides {
  inbound: Set<string>;
  outbound: Set<string>;
}

/** One op of a composition: its name, and the expression that implements it. */
interface OpEntry {
  key: string;
  /** The value expression (or method declaration) — what the classifier reads. */
  expr: ts.Node;
}

function fail(message: string): never {
  throw new Error(`op-sides: ${message}`);
}

function parse(filePath: string): ts.SourceFile {
  return ts.createSourceFile(filePath, fs.readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true);
}

/** The top-level function declaration named `fnName`. */
function functionNamed(sf: ts.SourceFile, fnName: string): ts.FunctionDeclaration {
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === fnName) {
      if (found) fail(`${fnName} is declared more than once — which one composes the session?`);
      found = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found ?? fail(`${fnName} not found in ${path.basename(sf.fileName)} — the composition moved`);
}

/**
 * The object literal a named function returns.
 *
 * Only the function's OWN returns count: `forkOps` is full of nested arrow
 * functions that return things, and the old text search for `return {` could
 * match one of those. Descending is stopped at every nested function-like
 * node, so what comes back is the composition itself or nothing.
 */
function returnedLiteral(sf: ts.SourceFile, fnName: string): ts.ObjectLiteralExpression {
  const fn = functionNamed(sf, fnName);
  const literals: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) {
      let expr: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
      if (ts.isObjectLiteralExpression(expr)) literals.push(expr);
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  if (literals.length === 0) fail(`${fnName} returns no object literal — the composition moved`);
  if (literals.length > 1) fail(`${fnName} returns ${literals.length} object literals; this module reads exactly one`);
  return literals[0]!;
}

/** A property key, as a plain string. Anything not statically knowable throws. */
function propertyKey(name: ts.PropertyName, where: string): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const inner = name.expression;
    if (ts.isStringLiteralLike(inner) || ts.isNumericLiteral(inner)) return inner.text;
    fail(
      `${where} has a computed key this module cannot evaluate (${inner.getText()}). An op whose name is not ` +
        'statically knowable cannot be classified, and an unclassified op leaves both ratchet rules silently.',
    );
  }
  fail(`${where} has an unsupported key form (${ts.SyntaxKind[name.kind]})`);
}

/** The initializer of a top-level `const`/`let` in this file, for a shorthand or a spread. */
function bindingInitializer(sf: ts.SourceFile, name: string): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      found ??= node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * Every op entry a composition contributes, its spreads followed.
 *
 * `chain` is both a cycle guard and the message a failure carries, so a broken
 * spread names the path that reached it rather than just the leaf.
 */
function literalEntries(sf: ts.SourceFile, literal: ts.ObjectLiteralExpression, chain: readonly string[]): OpEntry[] {
  const where = chain.join(' → ');
  const out: OpEntry[] = [];
  for (const prop of literal.properties) {
    if (ts.isPropertyAssignment(prop)) {
      out.push({ key: propertyKey(prop.name, where), expr: prop.initializer });
      continue;
    }
    if (ts.isMethodDeclaration(prop)) {
      out.push({ key: propertyKey(prop.name, where), expr: prop });
      continue;
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      const name = prop.name.text;
      const init = bindingInitializer(sf, name);
      if (!init) {
        fail(
          `${where} uses shorthand \`${name}\`, whose binding is not a variable declaration in ` +
            `${path.basename(sf.fileName)}. This module classifies an op from the expression that implements it, ` +
            'and it cannot follow that name out of this file.',
        );
      }
      out.push({ key: name, expr: init });
      continue;
    }
    if (ts.isSpreadAssignment(prop)) {
      out.push(...spreadEntries(sf, prop.expression, chain));
      continue;
    }
    fail(`${where} contains an unsupported member (${ts.SyntaxKind[prop.kind]}) — accessors are not classified`);
  }
  return out;
}

/**
 * The entries a `...spread` contributes.
 *
 * Two shapes are understood, and both are the shapes the composition actually
 * uses: a call to a function declared in this file (`...composeOutboundOps(…)`,
 * which is how PR 4's outbound half is shared with the outbound-keyed funnel),
 * and a reference to a local object literal. Everything else throws rather
 * than contributing nothing — a spread whose ops are missing is exactly the
 * silent narrowing this module exists to prevent.
 */
function spreadEntries(sf: ts.SourceFile, expr: ts.Expression, chain: readonly string[]): OpEntry[] {
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    const name = expr.expression.text;
    if (chain.includes(name)) fail(`spread cycle: ${[...chain, name].join(' → ')}`);
    return literalEntries(sf, returnedLiteral(sf, name), [...chain, name]);
  }
  if (ts.isIdentifier(expr)) {
    const name = expr.text;
    if (chain.includes(name)) fail(`spread cycle: ${[...chain, name].join(' → ')}`);
    const init = bindingInitializer(sf, name);
    if (init && ts.isObjectLiteralExpression(init)) return literalEntries(sf, init, [...chain, name]);
    if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression)) {
      return spreadEntries(sf, init, [...chain, name]);
    }
    fail(
      `${chain.join(' → ')} spreads \`${name}\`, which this module cannot resolve to an object literal in ` +
        `${path.basename(sf.fileName)}. Its ops would be missing from the map and both ratchet rules would ` +
        'silently stop covering them.',
    );
  }
  fail(
    `${chain.join(' → ')} contains a spread this module does not understand (${ts.SyntaxKind[expr.kind]}). ` +
      'Only a call to a function declared in this file, or a local object literal, can be followed.',
  );
}

/**
 * Every identifier an expression REFERENCES.
 *
 * Property names (`x.inbound`) and object keys are skipped: they are labels,
 * not uses of a handle. Strings, templates and comments contain no
 * identifiers at all, which is the whole reason this replaced a regex — a
 * doc comment mentioning `writableOutbound`, or a SQL string containing the
 * word, used to classify an op as a write.
 */
function referencedIdentifiers(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) {
      const parent = n.parent as ts.Node | undefined;
      const isLabel =
        parent !== undefined &&
        ((ts.isPropertyAccessExpression(parent) && parent.name === n) ||
          (ts.isPropertyAssignment(parent) && parent.name === n) ||
          (ts.isMethodDeclaration(parent) && parent.name === n) ||
          (ts.isQualifiedName(parent) && parent.right === n));
      if (!isLabel) names.add(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return names;
}

/** Upstream's two halves, as the runtime key sets they really are. */
function upstreamKeys(): { inbound: string[]; outbound: string[] } {
  const stub = {} as never;
  return {
    inbound: Object.keys(wrapSqliteInbound(stub)),
    outbound: Object.keys(
      wrapSqliteOutbound(
        () => stub,
        () => stub,
      ),
    ),
  };
}

/** Every op `forkOps` contributes, spreads followed. */
function forkOpEntries(): OpEntry[] {
  const sf = parse(INDEX_PATH);
  return literalEntries(sf, returnedLiteral(sf, 'forkOps'), ['forkOps']);
}

/**
 * The parsed map must name every op the session really has, and no others.
 *
 * `composeNanoclawSession` builds an object of closures and touches no
 * database until one is called, so its key set is available here from stub
 * handles. That set is ground truth. Comparing against it turns "the parser
 * quietly missed something" — the failure mode this module has actually
 * suffered — into a thrown error at the first consumer.
 */
function assertComplete(entries: readonly OpEntry[]): void {
  const stub = {} as never;
  const actual = new Set(
    Object.keys(
      composeNanoclawSession(
        stub,
        () => stub,
        () => stub,
        true,
      ),
    ),
  );
  const upstream = upstreamKeys();
  const derived = new Set([...upstream.inbound, ...upstream.outbound, ...entries.map((e) => e.key)]);
  const missing = [...actual].filter((k) => !derived.has(k)).sort();
  const extra = [...derived].filter((k) => !actual.has(k)).sort();
  if (missing.length > 0 || extra.length > 0) {
    fail(
      `the derived op map does not match the composed session. Missing from the map: [${missing.join(', ')}]. ` +
        `In the map but not on the session: [${extra.join(', ')}]. Both ratchet rules filter unknown ops out ` +
        'before deciding, so a map with a hole reports a clean tree for the wrong reason.',
    );
  }
  const duplicates = entries.map((e) => e.key).filter((k, i, all) => all.indexOf(k) !== i);
  if (duplicates.length > 0) {
    fail(`forkOps contributes [${[...new Set(duplicates)].join(', ')}] more than once — which spread wins?`);
  }
}

/**
 * Every session op, split by the storage it touches.
 *
 * `inbound` includes ops that touch BOTH sides: the question every caller of
 * this map asks is "could this have been done without inbound.db", and for a
 * both-sides op the answer is no.
 */
export function computeOpSides(): OpSides {
  const upstream = upstreamKeys();
  const inbound = new Set(upstream.inbound);
  const outbound = new Set(upstream.outbound);

  const entries = forkOpEntries();
  assertComplete(entries);

  for (const { key, expr } of entries) {
    const referenced = referencedIdentifiers(expr);
    const touchesOutbound = OUTBOUND_HANDLES.some((h) => referenced.has(h));
    const touchesInbound = INBOUND_HANDLES.some((h) => referenced.has(h));
    // Both, or neither-and-therefore-unknown, count as inbound: this map is
    // only ever used to prove an action needed NOTHING from inbound.db, and
    // that claim must fail closed. Unlike a MISSING entry, which fails open,
    // this branch is reached only for an op the parser did see.
    if (touchesOutbound && !touchesInbound) {
      outbound.add(key);
      inbound.delete(key);
    } else {
      inbound.add(key);
      outbound.delete(key);
    }
  }
  return { inbound, outbound };
}

/** Ops that provably touch outbound.db and nothing else. */
export function outboundOnlyOps(): Set<string> {
  return computeOpSides().outbound;
}

/* ─── Outbound WRITES ─────────────────────────────────────────────────────── */

/**
 * Every session op that MUTATES `outbound.db`.
 *
 * Derived the same way and for the same reason as `computeOpSides` — a hand
 * list would go stale the first time an op is added. Both halves of the
 * composition are read, not just the fork's:
 *
 *  - the fork's, from `forkOps`: an entry is a write exactly when it references
 *    the `writableOutbound` handle (the read handles are `readableOutbound` and
 *    the `readOutbound` degrade-to-empty helper);
 *  - upstream's, from `wrapSqliteOutbound`: an entry is a write exactly when
 *    it references `writable`. `composeNanoclawSession` spreads that half onto
 *    the same session object, so `deleteOrphanProcessingClaims` is as much a
 *    host-reachable outbound write as `writeOutboundDirect` is, and a set that
 *    listed only the fork's would have a hole where the sweep's orphan-claim
 *    clear sits.
 *
 * Upstream's half is parsed rather than probed for the same reason the fork's
 * is: read-vs-write is a property of the body, and there is no runtime signal
 * for it short of invoking the op. The parse is cross-checked against the
 * runtime key set below, so a literal this module mis-reads fails loudly
 * instead of silently shrinking the rule's reach.
 */
export function outboundWriteOps(): Set<string> {
  const writes = new Set<string>();

  const forkEntries = forkOpEntries();
  assertComplete(forkEntries);
  for (const { key, expr } of forkEntries) {
    if (referencedIdentifiers(expr).has(FORK_WRITABLE_HANDLE)) writes.add(key);
  }

  const upstreamSf = parse(UPSTREAM_SQLITE_PATH);
  const upstreamEntries = literalEntries(upstreamSf, returnedLiteral(upstreamSf, 'wrapSqliteOutbound'), [
    'wrapSqliteOutbound',
  ]);
  const runtimeKeys = upstreamKeys().outbound.slice().sort();
  const parsedKeys = upstreamEntries.map((e) => e.key).sort();
  if (parsedKeys.join(',') !== runtimeKeys.join(',')) {
    fail(
      `the wrapSqliteOutbound literal parsed as [${parsedKeys.join(', ')}] but the composed half has ` +
        `[${runtimeKeys.join(', ')}] — the parse drifted and the write set cannot be trusted`,
    );
  }
  for (const { key, expr } of upstreamEntries) {
    if (referencedIdentifiers(expr).has(UPSTREAM_WRITABLE_HANDLE)) writes.add(key);
  }

  if (writes.size === 0) fail('no outbound writes found — the derivation broke');
  return writes;
}

/* ─── Test seam ───────────────────────────────────────────────────────────── */

/**
 * Classify one composition from SOURCE TEXT, for the fixtures that pin this
 * parser's grammar coverage.
 *
 * Exported so a test can drive the exact code path the real derivation uses
 * over a hand-written literal — a comma inside a string, a computed key, a
 * nested spread — without needing that shape to exist in the real barrel
 * first. Every one of those was a silent-omission class before this module
 * used the compiler.
 */
export function _classifyCompositionForTesting(source: string, fnName: string): OpSides {
  const sf = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
  const entries = literalEntries(sf, returnedLiteral(sf, fnName), [fnName]);
  const inbound = new Set<string>();
  const outbound = new Set<string>();
  for (const { key, expr } of entries) {
    const referenced = referencedIdentifiers(expr);
    if (OUTBOUND_HANDLES.some((h) => referenced.has(h)) && !INBOUND_HANDLES.some((h) => referenced.has(h))) {
      outbound.add(key);
    } else {
      inbound.add(key);
    }
  }
  return { inbound, outbound };
}
