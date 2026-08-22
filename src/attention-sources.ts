/**
 * Attention sources — trunk's seam for "work that is blocked on a human".
 *
 * DESIGN.md §5 says `unassigned` is "a work item with no session at all", and
 * §2 says such an item "appears in the *same* queue as live threads, never in
 * a separate inbox". §5 also records that the state is unreachable today and
 * that it "becomes reachable when the release-board/findings join in §10
 * lands". This module is that join.
 *
 * ## The shape of the seam
 *
 * Trunk ships a generic READER. An install declares the BINDING, as JSON on
 * its own `workgroups.attention_sources` row (migration 057):
 *
 * ```json
 * [{ "kind": "release-board", "root": "releases", "channel_key": "slack:C0EXAMPLE1" }]
 * ```
 *
 * `kind` selects one of the providers registered in {@link PROVIDERS}; the
 * rest is that provider's binding. Nothing install-specific appears in this
 * file or in any provider, which is not merely tidy: this fork's trunk is
 * public and `scripts/check-public-boundary.ts` rejects install identifiers in
 * source, so a hardcoded channel id cannot land at all.
 *
 * ## Three failure rules, and why they differ
 *
 * An empty feed reads as "nothing is blocked on a human". That is the one lie
 * this whole feature exists to prevent, so every way of producing an empty
 * feed is logged and none of them is silent.
 *
 *  - **Absent declaration** — normal, and the state of every workgroup in a
 *    fresh install. Emits nothing, logs at debug. Not an error.
 *  - **Malformed declaration** — FAILS CLOSED for the whole workgroup, warns.
 *    Never a partial list: half a feed is indistinguishable from a healthy
 *    short one, and an operator who mistypes one entry must not silently lose
 *    the others' items while believing they are still watching.
 *  - **Unknown `kind`** — skipped with a warning, the rest of the list is
 *    still read. A trunk that has not shipped a provider yet, or an install
 *    that pinned an older trunk, is a version skew, not a broken declaration;
 *    throwing would take down a feed that is otherwise entirely readable.
 *
 * ## Staleness is marked, never hidden
 *
 * {@link AttentionRead.asOf} rides out alongside the items and is `null`
 * whenever nothing could be read. That keeps "there is no board" and "the
 * board says nothing is blocked" separately nameable all the way to the UI.
 * There is deliberately NO suppression threshold anywhere in this path: a
 * stale feed showing real work with a visible age is strictly better than an
 * empty one, because an empty one is indistinguishable from healthy.
 */
import path from 'path';

import { getDb } from './db/connection.js';
import { log } from './log.js';
import { readReleaseBoardSource } from './dashboard/api/board-attention.js';

/**
 * Every {@link AttentionItem.id} starts with this.
 *
 * It is a DEDUPE KEY, never a thread id. A thread id is parsed for its channel
 * (`threadChannelKey`, DESIGN.md §3.2) and an item id run through that parser
 * would mint one fake sidebar channel per item — precisely the "per-row
 * bucket" §3.2 forbids. The prefix exists so that gate can be written once, as
 * a shape check, rather than relying on every caller to remember.
 */
export const ATTENTION_ITEM_PREFIX = 'board:';

/** True for an id minted by an attention source — see {@link ATTENTION_ITEM_PREFIX}. */
export function isAttentionItemId(id: string): boolean {
  return id.startsWith(ATTENTION_ITEM_PREFIX);
}

/** One entry of a workgroup's `attention_sources` JSON array. */
export interface AttentionSourceDecl {
  /** Selects a provider from {@link PROVIDERS}. Unknown kinds are skipped, never fatal. */
  kind: string;
  /**
   * The source's directory, RELATIVE to `groups/<workgroupId>/`.
   *
   * Relative and `..`-free by validation. The workgroup's own folder is the
   * data-pool boundary (CLAUDE.md); a declaration is operator-written config,
   * but a boundary that is only honoured by convention is not a boundary.
   */
  root: string;
  /**
   * Where this source's items live, as a console channel key
   * (`<platform>:<channel>`, the shape `threadChannelKey` resolves to).
   *
   * One key for the whole source. A release board is one board in one room;
   * binding per source rather than per item is what lets the whole binding sit
   * in the declaration instead of a name→id map in trunk source.
   */
  channel_key: string;
}

/**
 * One ownerless work item.
 *
 * The field names mirror `deriveThreadState`'s inputs on purpose. This is NOT
 * a `ThreadSummary` and must not become one: producers state facts, and
 * exactly one function (`deriveThreadState`) turns facts into a state. A
 * producer that set `state` directly would be inventing its own lane
 * semantics beside §5's.
 */
export interface AttentionItem {
  /**
   * Dedupe key ONLY — see {@link ATTENTION_ITEM_PREFIX}.
   *
   * A PROVIDER returns its own natural id here (a PR id, a finding id).
   * {@link readAttentionItems} is what stamps the prefix on, so no provider can
   * forget to and every provider gets the never-a-thread-id guarantee for free.
   */
  id: string;
  channel_key: string;
  title: string;
  /** Where a human goes to act, or null. Never invented. */
  url: string | null;
  workgroupId: string;
  claimState: 'parked' | null;
  /** Satisfies `WAITING_ON_NOTE` whenever a human is actually owed something. */
  claimNote: string | null;
  claimOwner: string | null;
  participants: [];
  sessionCount: 0;
  /** ISO-8601 UTC — when the item started waiting. */
  since: string;
  /** What a human has to do, in the source's own words. */
  nextAction: string;
  /**
   * Which declared source produced this item, and when that source last
   * regenerated. Both are stamped by {@link readAttentionItems} from the
   * declaration and the provider's own {@link AttentionRead.asOf}, so a
   * provider cannot mislabel its own provenance and a row is self-describing
   * once it leaves here.
   *
   * `sourceAsOf` is null when the source could not be read at all — which,
   * combined with an item existing, cannot happen; it is null-able because the
   * provider contract is, and collapsing it to a string here would be the
   * first place this path invented a timestamp.
   */
  sourceKind: string;
  sourceAsOf: string | null;
}

/**
 * What a PROVIDER returns. The seam stamps {@link ATTENTION_ITEM_PREFIX} onto
 * the id and fills {@link AttentionItem.sourceKind}/`sourceAsOf` from the
 * declaration, so a provider states only what it actually knows.
 */
export type ProvidedAttentionItem = Omit<AttentionItem, 'sourceKind' | 'sourceAsOf'>;

export interface ProviderRead {
  /**
   * When the source last regenerated, ISO-8601 UTC — or null when NOTHING
   * could be read. "No board" and "board says nothing is blocked" are
   * different facts and stay different all the way to the row.
   */
  asOf: string | null;
  items: ProvidedAttentionItem[];
}

/** What the seam returns: the same read, with every item stamped. */
export interface AttentionRead extends Omit<ProviderRead, 'items'> {
  items: AttentionItem[];
}

/** Test seams. Both default to the live roots. */
export interface AttentionSourceEnv {
  /** Holds `<workgroupId>/<decl.root>`; defaults to `GROUPS_DIR`. */
  groupsRoot?: string;
  /** Passed through to `readClaims`; defaults to its own base dir. */
  claimsRoot?: string;
}

export type AttentionProvider = (
  decl: AttentionSourceDecl,
  workgroupId: string,
  now: number,
  env: AttentionSourceEnv,
) => ProviderRead;

/**
 * The registry. One entry per source kind trunk knows how to read.
 *
 * Adding a kind is adding a provider here plus a declaration in the install's
 * DB — never a branch in a caller and never an identifier in trunk source.
 */
const PROVIDERS: Record<string, AttentionProvider> = {
  'release-board': readReleaseBoardSource,
};

const EMPTY: AttentionRead = { asOf: null, items: [] };

function isSafeRelativeRoot(value: string): boolean {
  if (!value || path.isAbsolute(value)) return false;
  const normalized = path.normalize(value);
  return normalized !== '..' && !normalized.startsWith(`..${path.sep}`) && !path.isAbsolute(normalized);
}

/**
 * Validate one workgroup's raw column value.
 *
 * Returns the declarations on success, `[]` when nothing is declared, and
 * `null` when the value is malformed — the fail-closed signal. Never a partial
 * list; see this file's header on why.
 */
export function parseAttentionSources(raw: string | null | undefined): AttentionSourceDecl[] | null {
  if (raw === null || raw === undefined || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const out: AttentionSourceDecl[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const { kind, root, channel_key: channelKey } = entry as Record<string, unknown>;
    if (typeof kind !== 'string' || kind.trim() === '') return null;
    if (typeof root !== 'string' || !isSafeRelativeRoot(root)) return null;
    // `<platform>:<channel>` — the shape `threadChannelKey` resolves to. A key
    // with no platform segment would land the items in a bucket no sidebar
    // entry can ever match, which is a silent disappearance, not an error.
    if (typeof channelKey !== 'string' || !/^[a-z0-9-]+:.+$/i.test(channelKey)) return null;
    out.push({ kind, root, channel_key: channelKey });
  }
  return out;
}

/** One workgroup's declarations, straight off the row. `null` = malformed. */
export function readAttentionSourceDecls(workgroupId: string): AttentionSourceDecl[] | null {
  let row: { attention_sources: string | null } | undefined;
  try {
    row = getDb().prepare(`SELECT attention_sources FROM workgroups WHERE id = ?`).get(workgroupId) as
      | { attention_sources: string | null }
      | undefined;
  } catch (err) {
    log.warn('Attention sources: workgroup lookup failed, emitting nothing', { workgroupId, err });
    return null;
  }
  return parseAttentionSources(row?.attention_sources);
}

/* ─── Memo ─────────────────────────────────────────────────────────────────── */

/**
 * How long a workgroup's read is reused.
 *
 * **This TTL must stay far below the 4–6 hour claim TTL horizon**, and well
 * below the source's own ~30-minute regeneration cadence. The asymmetry is the
 * reason for the number, not the IO saving:
 *
 *  - A slightly-stale memo can briefly suppress a board item behind a claim
 *    that has since expired. Safe — the worst outcome is one duplicate row
 *    avoided for one minute.
 *  - The inverse — a memo old enough to have missed a claim being TAKEN —
 *    shows the same PR twice under two identities, once as a claimed thread
 *    and once as an ownerless board row, which is exactly what the dedupe in
 *    `deriveBoardAttentionItems` exists to prevent.
 *
 * One minute is ~1/30th of the source cadence and ~1/250th of the claim
 * horizon, so freshness stays bounded by the watcher rather than by this cache
 * while the thread list — polled continuously by SWR from every open dashboard
 * — stops re-reading a JSON file, a directory of JSONL and the claims dir on
 * every single poll.
 */
export const ATTENTION_MEMO_TTL_MS = 60_000;

const memo = new Map<string, { at: number; read: AttentionRead }>();

/** Vitest keeps module state across files in a worker — tests must reset it. */
export function clearAttentionMemo(): void {
  memo.clear();
}

/**
 * Every declared source's items for one workgroup, merged.
 *
 * Pure function of (files on disk, `now`) — `now` feeds only claim liveness —
 * so memoizing it is safe. See {@link ATTENTION_MEMO_TTL_MS}.
 *
 * `asOf` across several sources is the OLDEST non-null one: the feed is only
 * as fresh as its stalest contributor, and reporting the freshest would let a
 * healthy source vouch for a dead one.
 */
export function readAttentionItems(workgroupId: string, now: number, env: AttentionSourceEnv = {}): AttentionRead {
  const key = `${workgroupId} ${env.groupsRoot ?? ''} ${env.claimsRoot ?? ''}`;
  const cached = memo.get(key);
  if (cached && now - cached.at < ATTENTION_MEMO_TTL_MS && now >= cached.at) return cached.read;

  const read = computeAttentionItems(workgroupId, now, env);
  memo.set(key, { at: now, read });
  return read;
}

function computeAttentionItems(workgroupId: string, now: number, env: AttentionSourceEnv): AttentionRead {
  const decls = readAttentionSourceDecls(workgroupId);
  if (decls === null) {
    log.warn('Attention sources: malformed declaration, emitting nothing for this workgroup', { workgroupId });
    return EMPTY;
  }
  if (decls.length === 0) {
    log.debug('Attention sources: none declared', { workgroupId });
    return EMPTY;
  }

  let asOf: string | null = null;
  const items: AttentionItem[] = [];
  const seen = new Set<string>();
  for (const decl of decls) {
    const provider = PROVIDERS[decl.kind];
    if (!provider) {
      // Version skew, not a broken declaration — the rest of the list is still
      // read. See this file's header.
      log.warn('Attention sources: unknown kind, ignoring this source', { workgroupId, kind: decl.kind });
      continue;
    }
    let read: ProviderRead;
    try {
      read = provider(decl, workgroupId, now, env);
    } catch (err) {
      // A provider is not allowed to take the whole feed down, but it must
      // never fail quietly either.
      log.warn('Attention sources: provider threw, emitting nothing for this source', {
        workgroupId,
        kind: decl.kind,
        err,
      });
      continue;
    }
    for (const item of read.items) {
      // The prefix is stamped HERE, not in the provider — see AttentionItem.id.
      // Deduped on the stamped id because two sources in one workgroup can
      // legitimately name the same PR, and two rows sharing a thread_id is a
      // rendering bug (React keys) on top of a duplicate. First source wins,
      // in declaration order, so the operator's ordering is the tiebreak.
      const id = `${ATTENTION_ITEM_PREFIX}${item.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({ ...item, id, sourceKind: decl.kind, sourceAsOf: read.asOf });
    }
    if (read.asOf !== null && (asOf === null || read.asOf < asOf)) asOf = read.asOf;
  }
  return { asOf, items };
}

/**
 * The workgroups a set of agent groups belongs to.
 *
 * The console's scope ceiling is a set of AGENT GROUPS; an attention source is
 * declared on a WORKGROUP. This is the only bridge between them, and it is a
 * pure narrowing — an item is visible exactly when the caller can already see
 * at least one sibling of the workgroup that declared it.
 */
export function workgroupIdsForAgentGroups(agentGroupIds: string[]): string[] {
  if (agentGroupIds.length === 0) return [];
  try {
    return (
      getDb()
        .prepare(
          `SELECT DISTINCT workgroup_id FROM agent_groups
            WHERE workgroup_id IS NOT NULL AND id IN (${agentGroupIds.map(() => '?').join(', ')})`,
        )
        .all(...agentGroupIds) as { workgroup_id: string }[]
    ).map((r) => r.workgroup_id);
  } catch (err) {
    log.warn('Attention sources: workgroup lookup for agent groups failed', { err });
    return [];
  }
}

/** Every workgroup that has declared anything at all — the `no_filter` caller's set. */
export function workgroupIdsWithAttentionSources(): string[] {
  try {
    return (
      getDb().prepare(`SELECT id FROM workgroups WHERE attention_sources IS NOT NULL`).all() as { id: string }[]
    ).map((r) => r.id);
  } catch (err) {
    log.warn('Attention sources: workgroup scan failed', { err });
    return [];
  }
}
