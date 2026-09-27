/**
 * Which storage side each session op touches, DERIVED (a hand list would go
 * stale and make the ratchet rules consuming it quietly wrong). Upstream's
 * halves come from their runtime key sets; the fork's from the SOURCE of
 * `forkOps`, classified by which handle identifiers each entry references.
 * An op touching both sides counts as inbound.
 *
 * Parsed with the TypeScript compiler, and anything unresolvable THROWS: a
 * dropped entry silently leaves both rules' reach (fail-open), unlike an
 * ambiguous parsed entry, which fails closed into `inbound`. Completeness is
 * asserted against the real composed key set.
 *
 * Build/test-time only: importing this from production would put the
 * `typescript` devDependency in the host process.
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

const OUTBOUND_HANDLES = ['readableOutbound', 'writableOutbound', 'readOutbound'];
const INBOUND_HANDLES = ['inbound'];

/** A fork op is a write exactly when it references `writableOutbound`. */
const FORK_WRITABLE_HANDLE = 'writableOutbound';
const UPSTREAM_WRITABLE_HANDLE = 'writable';

export interface OpSides {
  inbound: Set<string>;
  outbound: Set<string>;
}

interface OpEntry {
  key: string;
  expr: ts.Node;
}

function fail(message: string): never {
  throw new Error(`op-sides: ${message}`);
}

function parse(filePath: string): ts.SourceFile {
  return ts.createSourceFile(filePath, fs.readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true);
}

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

/** Only the function's OWN returns: descent stops at nested function-like nodes. */
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

/** Anything not statically knowable throws. */
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

/** `chain` is the cycle guard and the path a failure message names. */
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
 * Understands a call to a function declared in this file and a reference to a
 * local object literal; anything else throws rather than contributing nothing.
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
 * Identifiers REFERENCED: property names and keys are labels, and strings and
 * comments contain none.
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

function forkOpEntries(): OpEntry[] {
  const sf = parse(INDEX_PATH);
  return literalEntries(sf, returnedLiteral(sf, 'forkOps'), ['forkOps']);
}

/** The parsed key set must equal the real composed session's (built from stub handles, no DB touched). */
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
  assertNoDuplicateKeys(entries);
}

/**
 * The runtime keeps only the LAST duplicate property, so the map would describe
 * a definition that does not run.
 */
function assertNoDuplicateKeys(entries: readonly OpEntry[]): void {
  const duplicates = entries.map((e) => e.key).filter((k, i, all) => all.indexOf(k) !== i);
  if (duplicates.length > 0) {
    fail(`the composition contributes [${[...new Set(duplicates)].join(', ')}] more than once — which spread wins?`);
  }
}

/** `inbound` includes both-sides ops: "could this be done without inbound.db" is no for them. */
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
    // Unknown counts as inbound: this map only ever proves an action needed
    // NOTHING from inbound.db, and that must fail closed.
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

/**
 * Every op that MUTATES outbound.db, from BOTH halves: fork entries referencing
 * `writableOutbound`, upstream entries referencing `writable` (upstream's
 * `deleteOrphanProcessingClaims` is a host-reachable write too). Parsed, and
 * cross-checked against the runtime key set.
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

/** Drives the real derivation over hand-written source, to pin the parser's grammar coverage. */
export function _classifyCompositionForTesting(source: string, fnName: string): OpSides {
  const sf = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
  const entries = literalEntries(sf, returnedLiteral(sf, fnName), [fnName]);
  assertNoDuplicateKeys(entries);
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
