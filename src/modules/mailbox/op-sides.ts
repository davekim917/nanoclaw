/**
 * Which side of a session's storage each op touches — inbound.db or outbound.db.
 *
 * DERIVED, not hand-listed. A hand list is a second source of truth that goes
 * stale the first time someone adds an op and forgets it, and a stale map here
 * would make the ratchet rule that consumes it (src/mailbox-seam-ratchet.ts)
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
 *    classified by the handle identifiers its value expression mentions:
 *    `inbound` for the inbound handle, `readableOutbound`/`writableOutbound`/
 *    `readOutbound` for the outbound ones. An op that touches both is INBOUND
 *    for this map's purpose — see `outboundOnlyOps`.
 *
 * The one thing this file must never become is a place to record intent. It
 * records what the composition does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { wrapSqliteInbound, wrapSqliteOutbound } from '../../mailbox/sqlite/index.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(MODULE_DIR, 'index.ts');
const UPSTREAM_SQLITE_PATH = path.join(MODULE_DIR, '..', '..', 'mailbox', 'sqlite', 'index.ts');

/** Handle identifiers `forkOps` binds its ops to, by side. */
const OUTBOUND_HANDLES = ['readableOutbound', 'writableOutbound', 'readOutbound'];
const INBOUND_HANDLES = ['inbound'];

export interface OpSides {
  inbound: Set<string>;
  outbound: Set<string>;
}

/**
 * Blank out comments, leaving everything else at its original offset.
 *
 * Load-bearing, not tidiness. `splitEntries` cuts on top-level commas and
 * `objectLiteralBody` counts braces, and BOTH are fooled by prose: one comma
 * in a doc comment between two entries makes the splitter start the next chunk
 * mid-sentence, the `key:` regex fails to match, and that op is dropped from
 * the map entirely. A dropped op is not a loud failure — `computeOpSides`
 * fails closed to "inbound", so the outbound-only ratchet rule silently stops
 * covering it. That is exactly what happened when PR 6's `outboundPresent`
 * comment landed above `readDoneProposal` in `composeOutboundOps`: the rule's
 * own string fixture went red while a real-tree scan stayed green.
 *
 * Characters are replaced with spaces rather than removed so brace and comma
 * positions elsewhere are untouched. String and template literals are tracked
 * so a `//` inside one is never mistaken for a comment.
 */
function blankComments(source: string): string {
  const out = source.split('');
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      while (i < stop) {
        if (source[i] !== '\n') out[i] = ' ';
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Split the top-level `key: value` entries of one object literal. */
function splitEntries(body: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      const chunk = body.slice(start, i);
      const m = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(chunk);
      if (m) out.push({ key: m[1], value: chunk.slice(m[0].length) });
      start = i + 1;
    }
  }
  const tail = body.slice(start);
  const m = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(tail);
  if (m) out.push({ key: m[1], value: tail.slice(m[0].length) });
  return out;
}

/** The object literal a named function returns, as source text. */
function objectLiteralBody(rawSource: string, fnName: string): string {
  const source = blankComments(rawSource);
  const fnAt = source.search(new RegExp(`function\\s+${fnName}\\s*\\(`));
  if (fnAt === -1) throw new Error(`op-sides: ${fnName} not found — the composition moved`);
  const returnAt = source.indexOf('return {', fnAt);
  if (returnAt === -1) throw new Error(`op-sides: ${fnName} has no object literal to read`);
  let depth = 0;
  const open = source.indexOf('{', returnAt);
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`op-sides: ${fnName} object literal never closes`);
}

/**
 * Object literals that `forkOps` SPREADS into its own, and which therefore
 * carry ops just as much as its literal entries do.
 *
 * PR 4's round 8 moved the outbound half into `composeOutboundOps` so the
 * outbound-keyed funnel could share it. Reading only `forkOps` after that
 * silently classified every one of those ops as inbound (the fail-closed
 * default), which quietly narrowed both ratchet rules instead of breaking
 * them — so the spread list is asserted below rather than assumed.
 */
const COMPOSED_INTO_FORK_OPS = ['composeOutboundOps'];

/** Every op entry `forkOps` contributes, its spreads included. */
function forkOpEntries(source: string): Array<{ key: string; value: string }> {
  const body = objectLiteralBody(source, 'forkOps');
  const entries = splitEntries(body);
  for (const m of body.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (!COMPOSED_INTO_FORK_OPS.includes(m[1])) {
      throw new Error(
        `op-sides: forkOps spreads ${m[1]}(), which this module does not read — its ops would be ` +
          'classified inbound by default and the ratchet rules would silently stop covering them. ' +
          'Add it to COMPOSED_INTO_FORK_OPS.',
      );
    }
  }
  for (const fn of COMPOSED_INTO_FORK_OPS) entries.push(...splitEntries(objectLiteralBody(source, fn)));
  return entries;
}

const mentions = (text: string, names: string[]): boolean => names.some((n) => new RegExp(`\\b${n}\\b`).test(text));

/**
 * Every session op, split by the storage it touches.
 *
 * `inbound` includes ops that touch BOTH sides: the question every caller of
 * this map asks is "could this have been done without inbound.db", and for a
 * both-sides op the answer is no.
 */
export function computeOpSides(): OpSides {
  const stub = {} as never;
  const inbound = new Set(Object.keys(wrapSqliteInbound(stub)));
  const outbound = new Set(
    Object.keys(
      wrapSqliteOutbound(
        () => stub,
        () => stub,
      ),
    ),
  );

  const source = fs.readFileSync(INDEX_PATH, 'utf8');
  for (const { key, value } of forkOpEntries(source)) {
    const touchesOutbound = mentions(value, OUTBOUND_HANDLES);
    const touchesInbound = mentions(value, INBOUND_HANDLES);
    // Both, or neither-and-therefore-unknown, count as inbound: this map is
    // only ever used to prove an action needed NOTHING from inbound.db, and
    // that claim must fail closed.
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

/** The handle a fork op must use to be a write: `writableOutbound`, nothing else. */
const FORK_WRITABLE_HANDLE = /\bwritableOutbound\b/;
/** Upstream's outbound half takes its writer from `writable()`; reads use `readable()`. */
const UPSTREAM_WRITABLE_HANDLE = /\bwritable\s*\(/;

/**
 * Every session op that MUTATES `outbound.db`.
 *
 * Derived the same way and for the same reason as `computeOpSides` — a hand
 * list would go stale the first time an op is added. Both halves of the
 * composition are read, not just the fork's:
 *
 *  - the fork's, from `forkOps`: an entry is a write exactly when it uses the
 *    `writableOutbound` handle (the read handles are `readableOutbound` and
 *    the `readOutbound` degrade-to-empty helper);
 *  - upstream's, from `wrapSqliteOutbound`: an entry is a write exactly when
 *    it takes `writable()`. `composeNanoclawSession` spreads that half onto
 *    the same session object, so `deleteOrphanProcessingClaims` is as much a
 *    host-reachable outbound write as `writeOutboundDirect` is, and a set that
 *    listed only the fork's would have a hole where the sweep's orphan-claim
 *    clear sits.
 *
 * Upstream's half is parsed rather than probed for the same reason the fork's
 * is: read-vs-write is a property of the body, and there is no runtime signal
 * for it short of invoking the op. The parse is cross-checked against the
 * runtime key set below, so a literal this hand-rolled splitter mis-slices
 * fails loudly instead of silently shrinking the rule's reach.
 */
export function outboundWriteOps(): Set<string> {
  const writes = new Set<string>();

  const forkSource = fs.readFileSync(INDEX_PATH, 'utf8');
  for (const { key, value } of forkOpEntries(forkSource)) {
    if (FORK_WRITABLE_HANDLE.test(value)) writes.add(key);
  }

  const upstreamSource = fs.readFileSync(UPSTREAM_SQLITE_PATH, 'utf8');
  const upstreamEntries = splitEntries(objectLiteralBody(upstreamSource, 'wrapSqliteOutbound'));
  const stub = {} as never;
  const runtimeKeys = Object.keys(
    wrapSqliteOutbound(
      () => stub,
      () => stub,
    ),
  ).sort();
  const parsedKeys = upstreamEntries.map((e) => e.key).sort();
  if (parsedKeys.join(',') !== runtimeKeys.join(',')) {
    throw new Error(
      `op-sides: the wrapSqliteOutbound literal parsed as [${parsedKeys.join(', ')}] but the composed ` +
        `half has [${runtimeKeys.join(', ')}] — the parse drifted and the write set cannot be trusted`,
    );
  }
  for (const { key, value } of upstreamEntries) {
    if (UPSTREAM_WRITABLE_HANDLE.test(value)) writes.add(key);
  }

  if (writes.size === 0) throw new Error('op-sides: no outbound writes found — the derivation broke');
  return writes;
}
