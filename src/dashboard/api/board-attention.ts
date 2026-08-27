/**
 * The `release-board` attention-source provider — release-board PRs that are
 * mechanically ready and waiting only on a human typing the ship command in
 * chat.
 *
 * Without this, those PRs are invisible to the Observatory: nobody has claimed
 * them, so they have no thread and no row. This module is the PRODUCER only —
 * it turns a release desk's own state files into attention items.
 * Rendering, triage, and how these items enter the `needs_you`/`unassigned`
 * lanes is owned elsewhere (`threads.ts` `deriveThreadState` /
 * `WAITING_ON_NOTE`); this module never touches that.
 *
 * **No install identifiers live here.** The workgroup, the directory and the
 * channel all arrive in the {@link AttentionSourceDecl} the install wrote onto
 * its `workgroups.attention_sources` row (migration 057). See
 * `src/attention-sources.ts` for the seam.
 *
 * {@link deriveBoardAttentionItems} is pure (no fs/db) so the dedupe and
 * staleness rules below are unit-testable without a live board.
 * {@link readReleaseBoardSource} is the thin IO caller.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { containedRealpath, readContainedFile, resolveContainedRoot } from './attention-fs.js';
import { readClaims, type BoardClaim } from '../../claims-board.js';
import { log } from '../../log.js';
import { parseUtcTimestampMs } from '../../thread-context.js';
import type {
  AttentionSourceDecl,
  AttentionSourceEnv,
  ProvidedAttentionItem,
  ProviderRead,
} from '../../attention-sources.js';

/** The subset of a `release-state.json` item this provider reads. */
export interface ReleaseStateItem {
  id: string;
  kind: string;
  nextMover: string;
  owner?: string | null;
  why: string;
  since: string;
  url: string | null;
  title: string;
  nextAction: string;
}

/** One `action: "ship"` line from a `gates/<date>.jsonl` file. */
export interface GateShipRecord {
  target: string;
  ts: string;
}

const PR_ID = /^(.+)#(\d+)$/;

/**
 * Does an existing claim already cover PR number `n`? Two independent checks,
 * because a claim's slug and its note can each carry the PR number without the
 * other — one PR in the live install is claimed simultaneously under a slug
 * encoding a different tracking number (whose NOTE names the PR) and under a
 * slug that encodes the PR itself. Either match wins: the claim carries a
 * richer reason and a real owner, so it wins over a board item that would
 * otherwise show the same PR twice.
 *
 * ## Why the slug check is only the `gh-<n>` form
 *
 * A claim slug is an UNCONSTRAINED filename — `readClaims` derives it as
 * `entry.replace(/\.json$/, '')`, so it is whatever an agent named its file.
 * An earlier version of this check also accepted the loose `<prefix>-<n>-…`
 * shape, which matches any incidental number in any slug. Against the live
 * claims directory that shape fires on a marketing deck
 * (`…-proximo-1800-la` → PR #1800), a Jira ticket (`…-216-…` → PR #216) and a
 * channel id (`…-ch-902-01` → PR #902); against small PR numbers it is worse
 * still — `sprint-1-planning`, `step-1-of-3` and `release-1-notes` would each
 * suppress PR #1.
 *
 * The two error directions are not symmetric, and that asymmetry decides the
 * rule. A false negative shows one PR twice: annoying, VISIBLE, and it
 * self-corrects the moment anyone looks. A false positive deletes real blocked
 * work from the queue with no trace — the exact invisibility this whole feed
 * exists to prevent. So the slug check keeps only the unambiguous form, where
 * the literal `gh` token means the number is a GitHub reference and nothing
 * else. `(-|$)` rather than `$` so the compound slugs the convention really
 * produces (`gh-<n>-<words>`, `<prefix>-gh-<n>-<words>`) still match, while
 * `gh-9561` still does not match `n = 956`.
 *
 * Everything the loose shape used to catch is now the NOTE's job: a claim on a
 * PR whose slug does not say `gh` has to name `#<n>` in its note to suppress.
 * On the live board that costs exactly one suppression and keeps every other
 * one, including the `gh-963` claim whose note covers #956.
 */
function claimCoversPr(claims: BoardClaim[], n: string): boolean {
  const slugRe = new RegExp(`(^|-)gh-${n}(-|$)`, 'i');
  const noteRe = new RegExp(`(?<!\\d)#${n}(?!\\d)`);
  return claims.some((c) => slugRe.test(c.slug) || noteRe.test(c.note));
}

/**
 * Turn release-desk state into attention items.
 *
 * A gate `ship` record does NOT mean "merged" — the desk records every ship
 * command as typed, including ones it then refused because CI/threads were not
 * clean yet (raw text: "NOT MERGED — precondition unmet"). Treating any past
 * ship record as an exclusion reproduces exactly the invisibility bug this feed
 * exists to fix: two PRs in the live install carry failed ship attempts from
 * weeks before the current snapshot and are still open today. So only a ship
 * record at-or-after the snapshot's `asOf` counts — that is the narrow case
 * this check exists for: a human shipped it in the ~30min since the last
 * `release-state.json` regeneration, so the item's `nextMover: 'human'` is
 * momentarily stale.
 */
/**
 * Open pull requests per repo, as published by the release watcher.
 *
 * `complete` is the whole safety margin and it is PER REPO: a watcher run can
 * fetch one repo cleanly and fail on another, and a repo we could not read is
 * a repo we know nothing about. Filtering on an incomplete fetch would delete
 * real blocked work from the queue on the strength of a failed network call —
 * the same "absence is a fact" mistake that produced this bug in the first
 * place, pointed the other way.
 */
export type OpenPrState = Record<string, { complete?: boolean; open?: number[] } | undefined>;

/**
 * Is this PR known — not guessed — to be no longer open?
 *
 * Only ever true when that repo's fetch was COMPLETE and the number is absent
 * from it. Missing repo, missing file, incomplete fetch, unparseable number:
 * all answer false, i.e. keep the row. A board row surviving one cycle too long
 * is a visible nuisance; a genuinely blocked PR vanishing from the queue is the
 * failure this whole surface exists to prevent.
 */
function isKnownClosed(state: OpenPrState, repo: string, n: string): boolean {
  const entry = state[repo];
  if (!entry || entry.complete !== true || !Array.isArray(entry.open)) return false;
  const num = Number(n);
  if (!Number.isInteger(num)) return false;
  return !entry.open.includes(num);
}

export function deriveBoardAttentionItems(
  items: ReleaseStateItem[],
  asOf: string,
  shipRecords: GateShipRecord[],
  claims: BoardClaim[],
  binding: { workgroupId: string; channelKey: string },
  openPrs: OpenPrState = {},
): ProvidedAttentionItem[] {
  // PARSED on both sides, never compared as strings. `r.ts` is agent-written
  // into a gates file and `asOf` comes off the snapshot, so the two are not
  // guaranteed to share a shape — and `'2026-08-20T10:00:00+02:00' >=
  // '2026-08-20T09:00:00Z'` is lexically TRUE while being chronologically
  // false, and a naive `'2026-08-20 09:00:00'` sorts BELOW every `T`-form
  // stamp. Both miscompares point the dangerous way: a spurious match adds the
  // PR to the suppression set and the ready-to-ship row silently disappears,
  // which is the exact invisibility this feed exists to end.
  //
  // A stamp that will not parse suppresses NOTHING — on either side. An
  // unparseable `asOf` gives no reference point at all, so the whole
  // suppression is skipped rather than guessed at; an unparseable record just
  // drops out. Showing a row one cycle too long is visible and self-correcting;
  // hiding one is not.
  const asOfMs = parseUtcTimestampMs(asOf);
  const shippedSinceSnapshot = new Set(
    asOfMs === null
      ? []
      : shipRecords
          .filter((r) => {
            const ts = parseUtcTimestampMs(r.ts);
            return ts !== null && ts >= asOfMs;
          })
          .map((r) => r.target),
  );

  const out: ProvidedAttentionItem[] = [];
  for (const item of items) {
    if (item.kind !== 'pr' || item.nextMover !== 'human') continue;
    if (shippedSinceSnapshot.has(item.id)) continue;

    const match = PR_ID.exec(item.id);
    if (!match) continue; // not a "<repo>#<n>" shaped id — nothing to board/dedupe
    const n = match[2]!;
    if (claimCoversPr(claims, n)) continue;
    if (isKnownClosed(openPrs, match[1]!, n)) continue;

    // No owner is not a person called "unknown", it is an unassigned item — and
    // that is what a human should read. `claimOwner` stays null, which every
    // consumer already renders in its own words (`assign.ts`: "owner: nobody").
    // The note still has to say "waiting on" verbatim or `WAITING_ON_NOTE`
    // never routes the row into the `needs_you` lane.
    const owner = item.owner && item.owner.trim() ? item.owner : null;
    out.push({
      id: item.id,
      channel_key: binding.channelKey,
      title: item.title,
      url: item.url,
      workgroupId: binding.workgroupId,
      claimState: 'parked',
      claimNote: `waiting on ${owner ?? 'a human'}: ${item.why}`,
      claimOwner: owner,
      participants: [],
      sessionCount: 0,
      since: item.since,
      nextAction: item.nextAction,
    });
  }
  return out;
}

/**
 * Every `action: "ship"` record under `<root>/gates/*.jsonl`.
 *
 * An absent gates dir is normal — nothing recorded, nothing to exclude — so it
 * yields `[]` rather than failing the whole read. Each file is containment-
 * checked individually; see {@link containedRealpath}.
 */
/**
 * Open pull requests per repo, written by the release watcher every ~30 minutes.
 *
 * A FILE, not a network call: providers run inside the thread-list request,
 * which the console polls continuously from every open dashboard, so a GitHub
 * call here would block the event loop for every viewer — a memo bounds how
 * often that happens, not how long it blocks.
 *
 * Unreadable or malformed returns `{}`, which filters nothing. The safe
 * direction here is showing a stale row, never hiding a live one.
 */
function readOpenPrState(releasesDir: string, workgroupId: string): OpenPrState {
  const read = readContainedFile('Release board', releasesDir, '.pr-open-state.json', workgroupId);
  if (read === null) return {};
  try {
    const raw = JSON.parse(read.text) as { repos?: unknown };
    return raw.repos && typeof raw.repos === 'object' ? (raw.repos as OpenPrState) : {};
  } catch {
    // Absent is normal until the watcher has run once since this shipped.
    return {};
  }
}

/**
 * The largest number of gate files one read will open.
 *
 * `MAX_FILE_BYTES` in `attention-fs.ts` bounds how big each file may be;
 * nothing bounded how MANY there are. The gates directory is bind-mounted
 * read-write into that workgroup's own containers, so the file COUNT is chosen
 * by an agent, and the whole loop runs synchronously inside the thread-list
 * request — a directory grown to thousands of entries is gigabytes of blocking
 * read and `JSON.parse` on every memo miss, once a minute, for every viewer.
 *
 * The desk writes ONE file per calendar day (`gates/<YYYY-MM-DD>.jsonl`); the
 * live directory holds 20. 400 is over thirteen months of daily files, so the
 * cap cannot bite on a desk that is merely old — only on one whose archiver has
 * died or whose directory has been filled deliberately. Both of those are worth
 * a human's attention, which is why hitting it emits a row rather than quietly
 * reading less (see {@link gatesOverflowItem}).
 *
 * Files are taken NEWEST FIRST, by name descending. `readdirSync` order is
 * whatever the filesystem hands back, so an uncapped-order cut would drop an
 * arbitrary set — possibly including today's file, the only one whose records
 * can be at-or-after the snapshot's `asOf` and therefore the only one that can
 * actually suppress anything. The desk's `YYYY-MM-DD` naming makes lexical
 * order chronological, so descending sort keeps exactly the files that matter
 * and drops the oldest, which by construction can suppress nothing.
 */
const MAX_GATE_FILES = 400;

function readShipRecords(
  releasesDir: string,
  workgroupId: string,
): { records: GateShipRecord[]; total: number; skipped: number } {
  const none = { records: [], total: 0, skipped: 0 };
  const gatesDir = containedRealpath(releasesDir, path.join(releasesDir, 'gates'));
  if (gatesDir === null) return none;

  let allFiles: string[];
  try {
    allFiles = fs.readdirSync(gatesDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return none; // no gates dir yet — nothing recorded, nothing to exclude
  }
  const gateFiles =
    allFiles.length > MAX_GATE_FILES ? [...allFiles].sort().reverse().slice(0, MAX_GATE_FILES) : allFiles;
  const skipped = allFiles.length - gateFiles.length;
  if (skipped > 0) {
    log.warn('Release board gates: more gate files than the read cap, reading only the newest', {
      workgroupId,
      total: allFiles.length,
      cap: MAX_GATE_FILES,
      skipped,
    });
  }

  const shipRecords: GateShipRecord[] = [];
  for (const file of gateFiles) {
    // Containment, size cap and the read are one operation on one descriptor —
    // see `readContainedFile`. A gates dir is agent-writable like every other
    // path here, so a per-file check that a later `readFileSync` could outrun
    // is not a check.
    const read = readContainedFile('Release board gates', gatesDir, file, workgroupId);
    if (read === null) continue;
    for (const line of read.text.split('\n')) {
      if (!line.trim()) continue;
      let rec: { action?: unknown; target?: unknown; ts?: unknown };
      try {
        rec = JSON.parse(line) as typeof rec;
      } catch {
        continue; // one bad line must not blank the feed
      }
      if (rec.action === 'ship' && typeof rec.target === 'string' && typeof rec.ts === 'string') {
        shipRecords.push({ target: rec.target, ts: rec.ts });
      }
    }
  }
  return { records: shipRecords, total: allFiles.length, skipped };
}

/**
 * The gates directory outgrew {@link MAX_GATE_FILES}, as a work item.
 *
 * Silent truncation is the absence-as-fact bug this whole seam keeps
 * eliminating: the read would still look clean, the queue would still look
 * healthy, and nobody would learn that the source is only being partly read.
 * So it takes the shape every other degraded state in this seam takes — a
 * parked row whose note says `waiting on a human` verbatim, which is what
 * routes it into `needs_you` (`WAITING_ON_NOTE` in `threads.ts`) rather than a
 * backlog nobody reads.
 *
 * The id is derived from nothing but the condition, so the row keeps one
 * identity across polls and an `observatory_item_assignments` reservation on it
 * stays matched. `since` is the snapshot's own `asOf` — the moment this read
 * observed the overflow — never `now`, which would re-date itself every poll
 * and make the row the first one dropped by the age-fair cap.
 */
function gatesOverflowItem(
  counts: { total: number; skipped: number },
  asOf: string,
  binding: { workgroupId: string; channelKey: string },
): ProvidedAttentionItem {
  return {
    id: 'gates-overflow',
    channel_key: binding.channelKey,
    title: 'The release desk’s gates directory is being read only in part',
    // The seam knows the directory is oversized; it does not know where the
    // archiver that should be trimming it lives. Never invented.
    url: null,
    workgroupId: binding.workgroupId,
    claimState: 'parked',
    claimNote:
      `waiting on a human: the gates directory holds ${counts.total} files and only the newest ` +
      `${MAX_GATE_FILES} are read, so ${counts.skipped} are being ignored on every poll — ` +
      `ship records in them cannot de-duplicate the board`,
    claimOwner: null,
    participants: [],
    sessionCount: 0,
    since: asOf,
    nextAction: 'Archive or trim the release desk’s gates directory',
  };
}

/**
 * Thin IO caller: reads the three source files and calls the pure function
 * above.
 *
 * Returns the board's own `asOf` alongside the items so the display side can
 * mark a stale feed. Deliberately NO staleness threshold here: whether an age
 * is "too old" is a display judgment that will get tuned, and suppressing stale
 * items would make a dead watcher indistinguishable from a healthy empty queue
 * — silent exactly when the list is least trustworthy.
 *
 * `asOf` is null whenever no items could be read, for any reason.
 *
 * Pure function of (files on disk, `now`) — no writes, no hidden clock, no
 * module-level state. `now` feeds claim liveness only. Memoized by its caller;
 * see `ATTENTION_MEMO_TTL_MS`.
 *
 * ponytail: synchronous fs on the request path. `ATTENTION_MEMO_TTL_MS` bounds
 * how OFTEN a cache miss happens (once a minute per workgroup), not how long
 * one blocks the event loop — a miss stats and reads one JSON file plus a
 * directory of small JSONL, on a local disk. Going async means threading
 * promises through `readAttentionItems`, the memo and both `AttentionProvider`
 * callers, which is the whole seam. Convert when a board grows past a handful
 * of gate files or the read ever shows up in a latency profile; a half-async
 * path with a sync realpath in it would be worse than either.
 */
export function readReleaseBoardSource(
  decl: AttentionSourceDecl,
  workgroupId: string,
  now: number,
  env: AttentionSourceEnv = {},
): ProviderRead {
  const releasesDir = resolveContainedRoot(
    'Release board',
    env.groupsRoot ?? GROUPS_DIR,
    workgroupId,
    decl.root,
    env.dataRoot,
  );
  if (releasesDir === null) return { asOf: null, items: [] };

  const state = readContainedFile('Release board', releasesDir, 'release-state.json', workgroupId);
  if (state === null) return { asOf: null, items: [] };

  let releaseState: { asOf?: string; items?: ReleaseStateItem[] };
  try {
    releaseState = JSON.parse(state.text) as {
      asOf?: string;
      items?: ReleaseStateItem[];
    };
  } catch (err) {
    // Absent is normal (the declaration points at a board that has not
    // generated yet); malformed is not. Either way emit nothing — but never
    // silently, because an empty feed reads as "nothing is blocked on a human",
    // which is the one lie this file exists to prevent.
    log.warn('Release board: release-state.json unreadable, emitting nothing', { workgroupId, err });
    return { asOf: null, items: [] };
  }
  if (typeof releaseState.asOf !== 'string' || !Array.isArray(releaseState.items)) {
    log.warn('Release board: release-state.json malformed, emitting nothing', { workgroupId });
    return { asOf: null, items: [] };
  }

  const gates = readShipRecords(releasesDir, workgroupId);
  const openPrs = readOpenPrState(releasesDir, workgroupId);

  const claims =
    env.claimsRoot !== undefined ? readClaims(workgroupId, now, env.claimsRoot) : readClaims(workgroupId, now);
  const binding = { workgroupId, channelKey: decl.channel_key };
  return {
    asOf: releaseState.asOf,
    items: [
      ...deriveBoardAttentionItems(releaseState.items, releaseState.asOf, gates.records, claims, binding, openPrs),
      // A partial read of the gates directory is itself work — see
      // `gatesOverflowItem`. Appended rather than prepended so it never
      // displaces a real blocked PR under the seam's per-source cap.
      ...(gates.skipped > 0 ? [gatesOverflowItem(gates, releaseState.asOf, binding)] : []),
    ],
  };
}
