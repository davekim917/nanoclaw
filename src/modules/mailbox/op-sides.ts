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

/** Handle identifiers `forkOps` binds its ops to, by side. */
const OUTBOUND_HANDLES = ['readableOutbound', 'writableOutbound', 'readOutbound'];
const INBOUND_HANDLES = ['inbound'];

export interface OpSides {
  inbound: Set<string>;
  outbound: Set<string>;
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

/** The object literal `forkOps` returns, as source text. */
function forkOpsBody(source: string): string {
  const fnAt = source.indexOf('function forkOps(');
  if (fnAt === -1) throw new Error('op-sides: forkOps not found — the composition moved');
  const returnAt = source.indexOf('return {', fnAt);
  if (returnAt === -1) throw new Error('op-sides: forkOps has no object literal to read');
  let depth = 0;
  const open = source.indexOf('{', returnAt);
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error('op-sides: forkOps object literal never closes');
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
  for (const { key, value } of splitEntries(forkOpsBody(source))) {
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
