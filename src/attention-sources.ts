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
 * ## Failure rules, and why they differ
 *
 * An empty feed reads as "nothing is blocked on a human". That is the one lie
 * this whole feature exists to prevent, so **no config error may ever reduce
 * the feed to silence** — see the invariant stated at
 * {@link parseAttentionSources}, which is where it is enforced.
 *
 *  - **Absent declaration** — normal, and the state of every workgroup in a
 *    fresh install. Emits nothing, logs at debug. Not an error.
 *  - **Malformed declaration** — disables THAT DECLARATION only, warns, and
 *    emits a `misconfigured:` work item naming it. One operator typo must not
 *    take down the three sibling sources that parsed perfectly; subtracting
 *    real work to signal a bad field is disproportionate, and an empty queue
 *    is exactly the lie the queue exists to prevent.
 *  - **Malformed `refresh_hours` specifically** — the source keeps emitting
 *    its rows, with NO staleness claim. A cadence is a display marker; it can
 *    only ever gate the marker. See {@link AttentionSourceDefect}.
 *  - **Unknown `kind`** — skipped with a warning, the rest of the list is
 *    still read. A trunk that has not shipped a provider yet, or an install
 *    that pinned an older trunk, is a version skew, not a broken declaration;
 *    throwing would take down a feed that is otherwise entirely readable.
 *
 * ## Staleness is PER SOURCE, marked, never hidden
 *
 * There is no feed-level freshness value, and there deliberately is not one
 * again. An aggregate that took the OLDEST contributor's `asOf` used to ride
 * out beside the items, and it read like a fact about the feed: one generator
 * that had stopped running dragged the whole read back a week, so a board
 * regenerated ninety minutes ago reported as seven days old and no reader
 * could tell WHICH source had died. "Everything is stale" is the same lie as
 * "nothing is blocked" — it is just wearing the honest signal's clothes.
 *
 * So freshness attaches to the ROWS. Every item carries its own
 * {@link AttentionItem.sourceKind}/`sourceAsOf`/`sourceStale`, stamped here so
 * a provider cannot mislabel its own provenance, and `sourceStale` is a claim
 * about that one source and nothing else.
 *
 * There is still NO suppression threshold anywhere in this path: a stale feed
 * showing real work with a visible age is strictly better than an empty one,
 * because an empty one is indistinguishable from healthy. `refresh_hours`
 * changes what a row is LABELLED, never whether it is emitted.
 *
 * ## A source that stopped generating — or was never readable — is itself work
 *
 * DESIGN.md §12: *"the thing that notices silence cannot be the thing that
 * went silent."* A generator that stopped running is work that stopped, and a
 * human should know — which is exactly what this lane is for. So when a source
 * declares a cadence and has missed it, {@link readAttentionItems} emits ONE
 * synthetic item saying so, from the SEAM rather than from any provider: a
 * provider cannot forget to, and a provider whose own code is broken is
 * covered by the same rule that covers a healthy one.
 *
 * A MISCONFIGURED declaration is the same argument one step earlier. A provider
 * that could not be constructed has no hook to report from at all, so the seam
 * reports for it: one `misconfigured:` item per malformed declaration, saying
 * which workgroup, which declaration, which field, and what it costs. Same
 * rules as the stale notice — declaration-derived id, `board:`-stamped so it
 * can never be read as a thread id, and a `waiting on` note so it lands in
 * `needs_you` rather than in a backlog nobody reads.
 */
import path from 'path';

import { withCentralSync, withRawDb } from './db/central-lease.js';
import { log } from './log.js';
import { readReleaseBoardSource } from './dashboard/api/board-attention.js';
import {
  readBranchCiSource,
  readDefectRegisterSource,
  readOpenQuestionsSource,
} from './dashboard/api/desk-attention.js';

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

/**
 * The provider's own natural id, with the stamp taken back off.
 *
 * Anything that PERSISTS an item — `observatory_item_assignments`, migration
 * 058 — stores this, never the stamped form: the prefix is a rendering
 * concern, and a table keyed on it would break the moment a second producer
 * stamped a different one. Idempotent, so a caller holding either form is
 * safe.
 */
export function stripAttentionItemPrefix(id: string): string {
  return isAttentionItemId(id) ? id.slice(ATTENTION_ITEM_PREFIX.length) : id;
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
  /**
   * One file under {@link root}, RELATIVE to it — for the providers whose
   * source is a single generated file rather than a directory of them.
   *
   * Validated with the same relative-and-`..`-free rule as `root`, in the same
   * place, so there is exactly one path-shape check in this seam rather than
   * one per provider. Optional: `release-board` reads fixed filenames under its
   * root and declares none. A provider that REQUIRES it validates its presence
   * itself and emits nothing (loudly) when it is missing.
   */
  file?: string;
  /**
   * A branch label — for providers whose item is about one branch.
   *
   * Optional for the same reason `file` is. Kept to the shape a git ref
   * actually has so it cannot smuggle a path segment into a key or a title.
   */
  branch?: string;
  /**
   * How often this source is EXPECTED to regenerate, in hours. Positive and
   * finite by validation.
   *
   * The declaration is the only place this can honestly live. Trunk knows how
   * to READ a defect register; only the install knows whether the task behind
   * it runs every six hours or every week, and a number trunk picked would be
   * a guess presented as a threshold.
   *
   * **Absent means NO STALENESS CLAIM IS MADE** — not "fresh", not "stale".
   * An undeclared cadence is nobody having said what the cadence is, and
   * DESIGN.md §12 is explicit that *"undeclared must never read as
   * independent"*: an omitted field means nobody checked. Defaulting it would
   * either invent a deadline every source is suddenly late for, or vouch for a
   * generator that died months ago. See {@link sourceStaleness}.
   */
  refresh_hours?: number;
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
  /**
   * Has THIS ROW'S source missed its declared cadence?
   *
   * `null` is a third value and it is load-bearing: it means no claim was made,
   * because the source declared no `refresh_hours` or its `sourceAsOf` could
   * not be read. Absence of a cadence is not evidence of freshness, and a
   * source whose age is unknown is unknown rather than stale — collapsing
   * either into `false` is how "we never checked" starts rendering as good
   * news (DESIGN.md §12).
   *
   * Computed once, HERE, from this source's own `asOf` — never from an
   * aggregate over the feed, which is the bug this field exists to end.
   */
  sourceStale: boolean | null;
}

/**
 * What a PROVIDER returns. The seam stamps {@link ATTENTION_ITEM_PREFIX} onto
 * the id and fills {@link AttentionItem.sourceKind}/`sourceAsOf` from the
 * declaration, so a provider states only what it actually knows.
 */
export type ProvidedAttentionItem = Omit<AttentionItem, 'sourceKind' | 'sourceAsOf' | 'sourceStale'>;

export interface ProviderRead {
  /**
   * When the source last regenerated, ISO-8601 UTC — or null when NOTHING
   * could be read. "No board" and "board says nothing is blocked" are
   * different facts and stay different all the way to the row.
   */
  asOf: string | null;
  items: ProvidedAttentionItem[];
}

/**
 * What the seam returns: every declared source's items, each stamped.
 *
 * Deliberately items and NOTHING ELSE. There is no feed-level `asOf` here and
 * must not be one again — see this file's header. Freshness is a property of a
 * SOURCE, and every item already carries its own.
 */
export interface AttentionRead {
  items: AttentionItem[];
}

/** Test seams. Both default to the live roots. */
export interface AttentionSourceEnv {
  /** Holds `<workgroupId>/<decl.root>`; defaults to `GROUPS_DIR`. */
  groupsRoot?: string;
  /** Passed through to `readClaims`; defaults to its own base dir. */
  claimsRoot?: string;
  /** Holds `workgroups/<workgroupId>/<decl.root>`; defaults to `DATA_DIR`. */
  dataRoot?: string;
}

type AttentionProvider = (
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
  'defect-register': readDefectRegisterSource,
  'open-questions': readOpenQuestionsSource,
  'branch-ci': readBranchCiSource,
};

const EMPTY: AttentionRead = { items: [] };

function isSafeRelativeRoot(value: string): boolean {
  if (!value || path.isAbsolute(value)) return false;
  const normalized = path.normalize(value);
  return normalized !== '..' && !normalized.startsWith(`..${path.sep}`) && !path.isAbsolute(normalized);
}

/** `<platform>:<channel>` — the shape `threadChannelKey` resolves to. */
const CHANNEL_KEY_SHAPE = /^[a-z0-9-]+:.+$/i;

/** A git ref name, kept to that shape so it cannot smuggle a path segment into a key. */
const BRANCH_SHAPE = /^[\w./-]+$/;

/**
 * One declaration that could not be used, and what it costs.
 *
 * Every field is derived from the declaration alone — no clock, no provider
 * read — so the same broken config yields byte-identical defects on every poll
 * and the item minted from one keeps a stable identity (see
 * {@link misconfiguredSourceItem}).
 *
 * The identity fields are captured INDEPENDENTLY of which check failed: a
 * declaration whose `root` is unusable may still have named a perfectly good
 * `kind` and `channel_key`, and naming the broken source to its operator is
 * worth more than reporting fields in a tidy order.
 */
interface AttentionSourceDefect {
  /**
   * Position in the declared array — `-1` when the COLUMN itself is unreadable
   * (not JSON, not an array), so there are no positions at all.
   *
   * Used for identity ONLY when nothing else identifies the declaration. A
   * declaration with no usable `kind` has no other handle, and "position 2"
   * is still an error an operator can find; the alternative is letting it
   * vanish, which is the one outcome forbidden here.
   */
  index: number;
  /** The declaration's own fields, when they parsed as strings. `null` when not. */
  kind: string | null;
  root: string | null;
  file: string | null;
  channelKey: string | null;
  /** Which field is at fault — `refresh_hours`, `root`, `channel_key`, … */
  field: string;
  /** What is wrong with it, in words an operator can act on. */
  problem: string;
  /**
   * Does this defect stop the source being READ?
   *
   * The distinction requirement 2 of this seam turns on. A bad `root`, `file`,
   * `kind` or `channel_key` means there is no readable source and no route for
   * its rows — emitting nothing for it is correct. A bad `refresh_hours` means
   * only that a DISPLAY MARKER cannot be computed; the generated file is still
   * right there, its rows are still real blocked work, and gating them on a
   * cadence typo would delete work to punish a label.
   */
  disablesSource: boolean;
}

/**
 * What {@link parseAttentionSources} returns: the declarations that are usable,
 * plus a record of each one that is not.
 *
 * Both halves, always — never one or the other. That shape IS the invariant.
 */
export interface AttentionSourceParse {
  decls: AttentionSourceDecl[];
  defects: AttentionSourceDefect[];
}

/**
 * Validate one workgroup's raw column value.
 *
 * ## THE INVARIANT: no config error may ever reduce the feed to silence.
 *
 * There are THREE states here, not two, and collapsing them is the bug this
 * function was rewritten to end:
 *
 *  1. **Healthy** — declarations parsed, items flow.
 *  2. **Explicitly not declared** — an absent or empty column. Emits nothing,
 *     claims nothing. The normal state of a fresh install.
 *  3. **Misconfigured and SAYING SO** — the good declarations still emit their
 *     items, and each bad one emits a work item naming itself.
 *
 * This used to return `null` for the whole workgroup the moment ANY single
 * entry failed ANY check — including `refresh_hours`, a display-only cadence
 * hint. One character (`"6h"` for `6`) therefore deleted every real row the
 * workgroup had: ready-but-unshipped PRs, decisions waiting on a person,
 * standing questions. The operator saw an empty queue, which reads as "nothing
 * is blocked on a human" — the exact lie this whole feature exists to prevent,
 * reachable from a typo.
 *
 * The old justification was sound and is PRESERVED: degrading a malformed
 * value to "no claim" would be indistinguishable from an operator deliberately
 * declaring no cadence, so a bad value must never go quiet. The answer is to
 * make it LOUD, not to make the feed EMPTY — so it returns a defect that
 * becomes its own visible, human-owed work item, and subtracts nothing.
 *
 * Failure is therefore PER SOURCE and never per workgroup: one bad entry
 * disables that entry, and its three healthy siblings keep working.
 */
export function parseAttentionSources(raw: string | null | undefined): AttentionSourceParse {
  if (raw === null || raw === undefined || raw.trim() === '') return { decls: [], defects: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { decls: [], defects: [columnDefect('the value is not valid JSON')] };
  }
  if (!Array.isArray(parsed)) {
    return { decls: [], defects: [columnDefect('the value must be a JSON array of declarations')] };
  }

  const decls: AttentionSourceDecl[] = [];
  const defects: AttentionSourceDefect[] = [];
  parsed.forEach((entry, index) => {
    const { decl, defect } = parseOneDecl(entry, index);
    if (decl) decls.push(decl);
    if (defect) defects.push(defect);
  });
  return { decls, defects };
}

/** The whole column is unreadable — there are no positions to blame, so `index` is -1. */
function columnDefect(problem: string): AttentionSourceDefect {
  return {
    index: -1,
    kind: null,
    root: null,
    file: null,
    channelKey: null,
    field: 'attention_sources',
    problem,
    disablesSource: true,
  };
}

/**
 * One entry, validated. At most one defect per declaration — the FIRST
 * unusable field, so an operator gets one row to fix rather than a pile
 * restating the same broken entry.
 */
function parseOneDecl(
  entry: unknown,
  index: number,
): { decl: AttentionSourceDecl | null; defect: AttentionSourceDefect | null } {
  const rec =
    typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
  // Captured up front, independent of which check fails below, so a defect can
  // still NAME the source it is about.
  const kind = typeof rec?.kind === 'string' && rec.kind.trim() !== '' ? rec.kind : null;
  const root = typeof rec?.root === 'string' ? rec.root : null;
  const file = typeof rec?.file === 'string' ? rec.file : null;
  const channelKey =
    typeof rec?.channel_key === 'string' && CHANNEL_KEY_SHAPE.test(rec.channel_key) ? rec.channel_key : null;
  const bad = (
    field: string,
    problem: string,
    disablesSource: boolean,
  ): { decl: null; defect: AttentionSourceDefect } => ({
    decl: null,
    defect: { index, kind, root, file, channelKey, field, problem, disablesSource },
  });

  // Everything below this line is SOURCE-FATAL: without it there is nothing to
  // read, or nowhere to route what is read. Emitting no items for the source is
  // then the honest outcome — and the defect above is what keeps it audible.
  if (rec === null) return bad('declaration', 'a declaration must be a JSON object', true);
  if (kind === null) return bad('kind', '`kind` must be a non-empty string naming a source kind', true);
  if (root === null || !isSafeRelativeRoot(root)) {
    return bad('root', '`root` must be a relative path inside the workgroup folder, with no `..`', true);
  }
  // A key with no platform segment would land the items in a bucket no sidebar
  // entry can ever match, which is a silent disappearance, not an error.
  if (channelKey === null) return bad('channel_key', '`channel_key` must look like `<platform>:<channel>`', true);
  // The optional per-provider fields. ABSENT is fine — most kinds do not take
  // them. PRESENT-AND-WRONG points the provider at bytes that are not there.
  if (rec.file !== undefined && (file === null || !isSafeRelativeRoot(file))) {
    return bad('file', '`file` must be a relative path under `root`, with no `..`', true);
  }
  if (rec.branch !== undefined && (typeof rec.branch !== 'string' || !BRANCH_SHAPE.test(rec.branch))) {
    return bad('branch', '`branch` must be a git ref name', true);
  }

  const decl: AttentionSourceDecl = {
    kind,
    root,
    channel_key: channelKey,
    ...(rec.file === undefined ? {} : { file: file! }),
    ...(rec.branch === undefined ? {} : { branch: rec.branch as string }),
  };

  // `refresh_hours` is the ONE field that is not source-fatal, because it does
  // not name any bytes: it gates a display marker and nothing else. So a bad
  // value keeps the declaration — the source emits its rows exactly as before,
  // with NO staleness claim (`refresh_hours` stays absent, so
  // `sourceStaleness` returns `null`; unknown, not fresh) — and reports itself
  // through the defect. Zero, negative, NaN and Infinity are all rejected: a
  // cadence has to name a real interval for `now - asOf > interval` to mean
  // anything.
  const refreshHours = rec.refresh_hours;
  if (refreshHours === undefined) return { decl, defect: null };
  if (typeof refreshHours !== 'number' || !Number.isFinite(refreshHours) || refreshHours <= 0) {
    return {
      decl,
      defect: {
        index,
        kind,
        root,
        file,
        channelKey,
        field: 'refresh_hours',
        problem: '`refresh_hours` must be a positive, finite number of hours',
        disablesSource: false,
      },
    };
  }
  decl.refresh_hours = refreshHours;
  return { decl, defect: null };
}

/**
 * One workgroup's declarations, straight off the row.
 *
 * A DB read that throws returns the empty parse rather than a defect: that is
 * an infrastructure failure, not a config error, the operator cannot fix it by
 * editing a declaration, and a console whose central DB is unreadable has
 * larger problems than this feed. It still warns.
 */
async function readAttentionSourceDecls(workgroupId: string): Promise<AttentionSourceParse> {
  let row: { attention_sources: string | null } | undefined;
  try {
    row = await withCentralSync(
      () =>
        withRawDb(
          (db) =>
            db.prepare(`SELECT attention_sources FROM workgroups WHERE id = ?`).get(workgroupId) as
              | { attention_sources: string | null }
              | undefined,
        ),
      'attention source decls',
    );
  } catch (err) {
    log.warn('Attention sources: workgroup lookup failed, emitting nothing', { workgroupId, err });
    return { decls: [], defects: [] };
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
 * Pure function of (files on disk, `now`) — `now` feeds claim liveness and the
 * per-source staleness test — so memoizing it is safe. See
 * {@link ATTENTION_MEMO_TTL_MS}, which is two orders of magnitude below any
 * plausible `refresh_hours`, so the memo can never be what makes a source look
 * fresh.
 */
export async function readAttentionItems(
  workgroupId: string,
  now: number,
  env: AttentionSourceEnv = {},
): Promise<AttentionRead> {
  const key = `${workgroupId} ${env.groupsRoot ?? ''} ${env.claimsRoot ?? ''}`;
  const cached = memo.get(key);
  if (cached && now - cached.at < ATTENTION_MEMO_TTL_MS && now >= cached.at) return cached.read;

  const read = await computeAttentionItems(workgroupId, now, env);
  memo.set(key, { at: now, read });
  return read;
}

async function computeAttentionItems(
  workgroupId: string,
  now: number,
  env: AttentionSourceEnv,
): Promise<AttentionRead> {
  const { decls, defects } = await readAttentionSourceDecls(workgroupId);
  if (decls.length === 0 && defects.length === 0) {
    log.debug('Attention sources: none declared', { workgroupId });
    return EMPTY;
  }

  const items: AttentionItem[] = [];
  const seen = new Set<string>();
  /** Stamp the prefix, dedupe on it, and record provenance. See {@link AttentionItem.id}. */
  const emit = (
    item: ProvidedAttentionItem,
    sourceKind: string,
    sourceAsOf: string | null,
    stale: boolean | null,
  ): void => {
    const id = `${ATTENTION_ITEM_PREFIX}${item.id}`;
    if (seen.has(id)) return;
    seen.add(id);
    items.push({ ...item, id, sourceKind, sourceAsOf, sourceStale: stale });
  };

  // Config errors LEAD. One row per malformed declaration, minted here because
  // a provider that could not be constructed has no hook to report from. They
  // carry no `asOf` and no staleness claim: the seam knows the declaration is
  // broken, it does not know anything about the bytes behind it.
  for (const defect of defects) {
    log.warn('Attention sources: malformed declaration, reporting it as a work item', { workgroupId, ...defect });
    emit(misconfiguredSourceItem(defect, workgroupId), defect.kind ?? MISCONFIGURED_SOURCE_KIND, null, null);
  }

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
    // ONE staleness verdict per source, computed once from THIS source's own
    // `asOf`, then stamped onto every row it produced. Nothing downstream
    // recomputes it and nothing aggregates it.
    const stale = sourceStaleness(read.asOf, decl.refresh_hours, now);

    // Deduped on the stamped id because two sources in one workgroup can
    // legitimately name the same PR, and two rows sharing a thread_id is a
    // rendering bug (React keys) on top of a duplicate. First source wins, in
    // declaration order, so the operator's ordering is the tiebreak.
    const push = (item: ProvidedAttentionItem): void => emit(item, decl.kind, read.asOf, stale);

    for (const item of read.items) push(item);
    // EXACTLY ONE per stale source, regardless of how many rows it emitted —
    // and it is emitted even when it emitted none, which is the case that
    // matters most: a generator that stopped is at its most invisible when its
    // last output happened to be empty.
    if (stale === true) push(staleSourceItem(decl, read.asOf!, now, workgroupId));
  }
  return { items };
}

/* ─── Per-source freshness ─────────────────────────────────────────────────── */

const HOUR_MS = 3_600_000;

/**
 * Has one source missed its declared cadence? `null` when no claim can honestly
 * be made.
 *
 * The three answers are three different facts and this codebase has been bitten
 * repeatedly by two of them being collapsed into one:
 *
 *  - `true`  — a cadence was declared and the source is past it.
 *  - `false` — a cadence was declared and the source is inside it.
 *  - `null`  — NOBODY SAID. No `refresh_hours`, or an `asOf` that could not be
 *    read. Absence of a cadence is not evidence of freshness; an unknown age is
 *    not an old one. Returning `false` for either would turn "we never checked"
 *    into good news, which §12 forbids in as many words.
 *
 * An unparseable `asOf` lands in `null` rather than `true` for the same reason.
 * A provider should never produce one (each validates ISO-8601 UTC before
 * returning it), but "the timestamp is gibberish" is a fact about our parser,
 * not evidence the generator stopped.
 */
export function sourceStaleness(
  sourceAsOf: string | null,
  refreshHours: number | undefined,
  now: number,
): boolean | null {
  if (refreshHours === undefined || sourceAsOf === null) return null;
  const at = Date.parse(sourceAsOf);
  if (!Number.isFinite(at)) return null;
  return now - at > refreshHours * HOUR_MS;
}

/**
 * A stale source, as a work item — the self-reporting half of this seam.
 *
 * Emitted by {@link computeAttentionItems} and by nothing else. A provider
 * could not do this job even if every provider remembered to: the case that
 * most needs reporting is the source that emitted nothing at all, and a
 * provider reporting on its own silence is the actor DESIGN.md §12 names as
 * *"structurally incapable of it"*.
 *
 * The id is derived only from the declaration — never from position in the
 * list, never from a clock — so the row keeps one identity across polls and an
 * `observatory_item_assignments` reservation on it stays matched. `stale:` is
 * its own namespace beside the providers' (`defect:`, `question:`,
 * `branch-ci:`), and the seam stamps {@link ATTENTION_ITEM_PREFIX} on top like
 * every other id, so `threadChannelKey` refuses it as a thread id and it can
 * never mint a sidebar channel.
 *
 * Two declarations identical in kind, root, file AND branch collapse to one
 * notice through the seam's normal dedupe. That is the right outcome: they are
 * watching the same bytes, and two rows about one dead generator is noise.
 */
function staleSourceItem(
  decl: AttentionSourceDecl,
  sourceAsOf: string,
  now: number,
  workgroupId: string,
): ProvidedAttentionItem {
  const label = describeSource(decl);
  const overdue = formatHours((now - Date.parse(sourceAsOf)) / HOUR_MS);
  const expected = formatHours(decl.refresh_hours!);
  return {
    // Every field that distinguishes one declaration from another, so two
    // sources of the same kind cannot collapse into one notice.
    id: `stale:${[decl.kind, decl.root, decl.file, decl.branch].filter(Boolean).join(':')}`,
    channel_key: decl.channel_key,
    title: `${label} has stopped regenerating`,
    // The seam knows a generator stopped; it does not know where that
    // generator lives or how it is triggered. Never invented (§12).
    url: null,
    workgroupId,
    claimState: 'parked',
    // `waiting on` verbatim is what routes this into `needs_you`
    // (`WAITING_ON_NOTE` in `threads.ts`) — the whole point of the item.
    claimNote: `waiting on a human: ${label} last regenerated ${overdue} ago, expected every ${expected}`,
    claimOwner: null,
    participants: [],
    sessionCount: 0,
    // When it actually went stale — not `now`. The age-fair cap
    // (`cappedByAge`) keeps the OLDEST rows, so stamping the read time would
    // make a generator that died a month ago the first row dropped.
    since: sourceAsOf,
    nextAction: `Find out why the ${label} source stopped regenerating`,
  };
}

/** The declaration in one readable phrase — kind, plus the file when it names one. */
function describeSource(decl: AttentionSourceDecl): string {
  return decl.file ? `${decl.kind} (${decl.file})` : decl.kind;
}

/* ─── Misconfiguration, as a work item ─────────────────────────────────────── */

/**
 * `sourceKind` for a notice about a declaration too broken to name its own kind.
 *
 * A row's `sourceKind` is stamped on the wire and rendered; it cannot be null,
 * and inventing a plausible provider name would be worse than admitting the
 * declaration never named one.
 */
const MISCONFIGURED_SOURCE_KIND = 'attention-source';

/**
 * Where a notice lands when the declaration's own `channel_key` is unusable.
 *
 * Must equal `UNKNOWN_CHANNEL_KEY` in `src/dashboard/api/threads.ts`, which
 * cannot be imported here — threads.ts imports THIS module, and a cycle in the
 * seam is worse than a duplicated four-character literal. Pinned equal by
 * `src/attention-sources.test.ts`.
 */
const UNROUTED_CHANNEL_KEY = 'unknown';

/**
 * `since` for a misconfiguration notice — a SENTINEL, not a measurement.
 *
 * There is no "when it broke" timestamp anywhere in this path: a declaration is
 * config text with no mtime the seam can see, and the fact is "this has been
 * wrong since somebody typed it", which nothing records. `since` is not
 * nullable, so some value has to go here, and the two candidates fail
 * differently:
 *
 *  - `now` is a PLAUSIBLE LIE. It re-dates itself on every poll, so the row
 *    reads as freshly arrived forever — and `cappedByAge` keeps the OLDEST
 *    rows, so a perpetually-new row is the FIRST one dropped when the cap
 *    bites. A misconfiguration that hides itself under a cap is the failure
 *    this item exists to prevent, wearing the fix's clothes.
 *  - The epoch is IMPLAUSIBLE ON ITS FACE. It renders as an absurd age no
 *    reader can mistake for a measurement, and it sorts oldest, so the cap can
 *    never cut it. §12 forbids inventing a number that could pass for real; it
 *    does not forbid a sentinel that obviously cannot.
 *
 * The real timing information an operator needs is in `claimNote`, which says
 * what is broken and what it costs — not on a time axis that has no honest
 * value to put on it.
 */
const MISCONFIGURED_SINCE = '1970-01-01T00:00:00.000Z';

/**
 * A declaration that could not be used, as a work item — the other half of this
 * seam's self-reporting, beside {@link staleSourceItem}.
 *
 * Minted by {@link computeAttentionItems} and by nothing else. Unlike a stale
 * source there is no provider to ask: a declaration whose `kind` or `root` is
 * unusable never produced a provider at all, so the seam is the only actor with
 * a hook to report from — the same argument DESIGN.md §12 makes about silence,
 * one step earlier in the chain.
 *
 * The id is derived only from the declaration — never from a clock — so the row
 * keeps one identity across polls and an `observatory_item_assignments`
 * reservation on it stays matched. `misconfigured:` is its own namespace beside
 * `stale:` and the providers' (`defect:`, `question:`, `branch-ci:`), and the
 * seam stamps {@link ATTENTION_ITEM_PREFIX} on top like every other id, so
 * `threadChannelKey` refuses it and it can never mint a sidebar channel.
 */
function misconfiguredSourceItem(defect: AttentionSourceDefect, workgroupId: string): ProvidedAttentionItem {
  const label = describeDefect(defect);
  // A bad cadence costs a marker; anything else costs the source's rows. Saying
  // which is the difference between "go fix a label" and "you are blind here".
  const cost = defect.disablesSource
    ? 'that source is emitting no items at all'
    : 'its items are still listed, but carry no staleness marker';
  return {
    // Every field that distinguishes one declaration from another, plus the
    // field at fault, so two broken sources cannot collapse into one notice.
    // Position is the fallback ONLY when the declaration named nothing at all:
    // an unnameable error is still an error the operator must see.
    id: `misconfigured:${
      [defect.kind, defect.root, defect.file].filter(Boolean).join(':') ||
      (defect.index < 0 ? 'declaration' : `#${defect.index}`)
    }:${defect.field}`,
    // Its siblings' room when the declaration named one, so the notice sits
    // where the missing work would have. `unknown` when it did not — nobody is
    // wired to nowhere, and pretending otherwise would offer a dead affordance.
    channel_key: defect.channelKey ?? UNROUTED_CHANNEL_KEY,
    title: `${label} is misconfigured`,
    // The seam knows the declaration is wrong; it does not know where the
    // operator edits it. Never invented (§12).
    url: null,
    workgroupId,
    claimState: 'parked',
    // `waiting on` verbatim is what routes this into `needs_you`
    // (`WAITING_ON_NOTE` in `threads.ts`) — the whole point of the item.
    claimNote:
      `waiting on a human: workgroup ${workgroupId} declares ${label} with an unusable \`${defect.field}\` — ` +
      `${defect.problem}. Right now ${cost}, and staleness is not being checked for it`,
    claimOwner: null,
    participants: [],
    sessionCount: 0,
    since: MISCONFIGURED_SINCE,
    nextAction: `Fix \`${defect.field}\` in workgroup ${workgroupId}'s attention_sources declaration`,
  };
}

/** The broken declaration in one readable phrase, using whatever of it parsed. */
function describeDefect(defect: AttentionSourceDefect): string {
  if (defect.kind === null) {
    return defect.index < 0 ? 'its attention_sources value' : `attention source declaration #${defect.index}`;
  }
  return defect.file ? `attention source ${defect.kind} (${defect.file})` : `attention source ${defect.kind}`;
}

/** `36` → `1d 12h`, `6` → `6h`. Whole units only; this is a headline, not a metric. */
function formatHours(hours: number): string {
  const total = Math.max(0, Math.round(hours));
  const days = Math.floor(total / 24);
  const rest = total % 24;
  if (days === 0) return `${total}h`;
  return rest === 0 ? `${days}d` : `${days}d ${rest}h`;
}

/**
 * The workgroups a set of agent groups belongs to.
 *
 * The console's scope ceiling is a set of AGENT GROUPS; an attention source is
 * declared on a WORKGROUP. This is the only bridge between them, and it is a
 * pure narrowing — an item is visible exactly when the caller can already see
 * at least one sibling of the workgroup that declared it.
 */
export async function workgroupIdsForAgentGroups(agentGroupIds: string[]): Promise<string[]> {
  if (agentGroupIds.length === 0) return [];
  try {
    const rows = await withCentralSync(
      () =>
        withRawDb(
          (db) =>
            db
              .prepare(
                `SELECT DISTINCT workgroup_id FROM agent_groups
            WHERE workgroup_id IS NOT NULL AND id IN (${agentGroupIds.map(() => '?').join(', ')})`,
              )
              .all(...agentGroupIds) as { workgroup_id: string }[],
        ),
      'attention workgroups for agent groups',
    );
    return rows.map((r) => r.workgroup_id);
  } catch (err) {
    log.warn('Attention sources: workgroup lookup for agent groups failed', { err });
    return [];
  }
}

/** Every workgroup that has declared anything at all — the `no_filter` caller's set. */
export async function workgroupIdsWithAttentionSources(): Promise<string[]> {
  try {
    const rows = await withCentralSync(
      () =>
        withRawDb(
          (db) => db.prepare(`SELECT id FROM workgroups WHERE attention_sources IS NOT NULL`).all() as { id: string }[],
        ),
      'attention workgroups with sources',
    );
    return rows.map((r) => r.id);
  } catch (err) {
    log.warn('Attention sources: workgroup scan failed', { err });
    return [];
  }
}
