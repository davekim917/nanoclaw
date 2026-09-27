/**
 * The `release-board` attention-source provider: release-board PRs that are mechanically ready and waiting only on a
 * human to ship them, which otherwise have no thread and no row. Producer only; lane routing lives in `threads.ts`.
 * {@link deriveBoardAttentionItems} is pure; {@link readReleaseBoardSource} is the IO caller.
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

export interface GateShipRecord {
  target: string;
  ts: string;
}

const PR_ID = /^(.+)#(\d+)$/;

/**
 * Does an existing claim already cover PR `n`? The slug and the note are checked independently; either match wins.
 * The slug check accepts only the `gh-<n>` form: a slug is an unconstrained filename, and a loose `<prefix>-<n>`
 * shape matches incidental numbers (`sprint-1-planning` would match number 1). A false positive silently deletes real
 * blocked work, while a false negative only shows a PR twice. `(-|$)` keeps compound slugs matching while `gh-9561`
 * does not match 956.
 */
function claimCoversPr(claims: BoardClaim[], n: string): boolean {
  const slugRe = new RegExp(`(^|-)gh-${n}(-|$)`, 'i');
  const noteRe = new RegExp(`(?<!\\d)#${n}(?!\\d)`);
  return claims.some((c) => slugRe.test(c.slug) || noteRe.test(c.note));
}

/**
 * A gate `ship` record does NOT mean merged: refused ship attempts are recorded too. Only a ship record at or after
 * the snapshot's `asOf` suppresses an item (a human shipped it since the last regeneration).
 */
/**
 * `complete` is PER REPO: a repo whose fetch failed is one we know nothing about, and filtering on it would delete
 * real blocked work.
 */
export type OpenPrState = Record<string, { complete?: boolean; open?: number[] } | undefined>;

/**
 * True only when the repo's fetch was complete and the number is absent. Every unknown answers false and keeps the
 * row.
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
  // PARSED on both sides, never compared as strings: agent-written `r.ts` and `asOf` need not share a shape, and a
  // lexical miscompare adds the PR to the suppression set and hides the row. An unparseable `asOf` skips suppression
  // entirely; an unparseable record drops out.
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

    // No owner stays null (an unassigned item, not a person called "unknown"). The note must say "waiting on"
    // verbatim or `WAITING_ON_NOTE` never routes the row to `needs_you`.
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
 * Every `action: "ship"` record under `<root>/gates/*.jsonl`. An absent gates dir yields `[]`; each file is
 * containment-checked individually.
 */
/**
 * A file, not a network call: providers run inside the continuously polled thread-list request. Unreadable or
 * malformed returns `{}`, which filters nothing.
 */
function readOpenPrState(releasesDir: string, workgroupId: string): OpenPrState {
  const read = readContainedFile('Release board', releasesDir, '.pr-open-state.json', workgroupId);
  if (read === null) return {};
  try {
    const raw = JSON.parse(read.text) as { repos?: unknown };
    return raw.repos && typeof raw.repos === 'object' ? (raw.repos as OpenPrState) : {};
  } catch {
    // Absent until the watcher has run once.
    return {};
  }
}

/**
 * The most gate files one read opens. The gates dir is agent-writable and the read is synchronous on the request
 * path, so the file COUNT must be bounded. The desk writes one file per day, so 400 bites only on a dead archiver or
 * a deliberately filled dir, and hitting it emits a row (see {@link gatesOverflowItem}).
 * Files are taken newest first by name: today's file is the only one that can suppress anything, and `YYYY-MM-DD`
 * names sort chronologically.
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
    // Containment, size cap and read are one operation on one descriptor (`readContainedFile`); the dir is
    // agent-writable.
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
 * A gates directory that outgrew {@link MAX_GATE_FILES}, as a parked `waiting on a human` row: silent truncation
 * would look clean. The id depends only on the condition so assignment reservations keep matching; `since` is the
 * snapshot's `asOf`, never `now`, which would re-date the row every poll.
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
    // Never invented: the seam does not know where the archiver lives.
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
 * Reads the three source files and calls the pure function. Returns the board's own `asOf` (null when nothing could
 * be read) so the display can mark a stale feed; no staleness threshold here, because suppressing stale items makes a
 * dead watcher look like a healthy empty queue.
 * Synchronous fs on the request path: the memo bounds how often a miss happens, not how long it blocks.
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
    // Absent or malformed, emit nothing but never silently: an empty feed reads as "nothing is blocked on a human".
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
      // Appended so it never displaces a real blocked PR under the per-source cap.
      ...(gates.skipped > 0 ? [gatesOverflowItem(gates, releaseState.asOf, binding)] : []),
    ],
  };
}
