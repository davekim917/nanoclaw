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
import { containedRealpath, resolveContainedRoot } from './attention-fs.js';
import { readClaims, type BoardClaim } from '../../claims-board.js';
import { log } from '../../log.js';
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
export function deriveBoardAttentionItems(
  items: ReleaseStateItem[],
  asOf: string,
  shipRecords: GateShipRecord[],
  claims: BoardClaim[],
  binding: { workgroupId: string; channelKey: string },
): ProvidedAttentionItem[] {
  const shippedSinceSnapshot = new Set(shipRecords.filter((r) => r.ts >= asOf).map((r) => r.target));

  const out: ProvidedAttentionItem[] = [];
  for (const item of items) {
    if (item.kind !== 'pr' || item.nextMover !== 'human') continue;
    if (shippedSinceSnapshot.has(item.id)) continue;

    const match = PR_ID.exec(item.id);
    if (!match) continue; // not a "<repo>#<n>" shaped id — nothing to board/dedupe
    const n = match[2]!;
    if (claimCoversPr(claims, n)) continue;

    const owner = item.owner && item.owner.trim() ? item.owner : 'unknown';
    out.push({
      id: item.id,
      channel_key: binding.channelKey,
      title: item.title,
      url: item.url,
      workgroupId: binding.workgroupId,
      claimState: 'parked',
      claimNote: `waiting on ${owner}: ${item.why}`,
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
function readShipRecords(releasesDir: string): GateShipRecord[] {
  const gatesDir = containedRealpath(releasesDir, path.join(releasesDir, 'gates'));
  if (gatesDir === null) return [];

  let gateFiles: string[];
  try {
    gateFiles = fs.readdirSync(gatesDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return []; // no gates dir yet — nothing recorded, nothing to exclude
  }

  const shipRecords: GateShipRecord[] = [];
  for (const file of gateFiles) {
    const gatePath = containedRealpath(gatesDir, path.join(gatesDir, file));
    if (gatePath === null) {
      log.warn('Release board: gates file absent or escapes the root, skipping', { file });
      continue;
    }
    let text: string;
    try {
      text = fs.readFileSync(gatePath, 'utf8');
    } catch (err) {
      log.warn('Release board: unreadable gates file, skipping', { file, err });
      continue;
    }
    for (const line of text.split('\n')) {
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
  return shipRecords;
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
  const releasesDir = resolveContainedRoot('Release board', env.groupsRoot ?? GROUPS_DIR, workgroupId, decl.root);
  if (releasesDir === null) return { asOf: null, items: [] };

  const statePath = containedRealpath(releasesDir, path.join(releasesDir, 'release-state.json'));
  if (statePath === null) {
    log.warn('Release board: release-state.json absent or escapes the root, emitting nothing', { workgroupId });
    return { asOf: null, items: [] };
  }

  let releaseState: { asOf?: string; items?: ReleaseStateItem[] };
  try {
    releaseState = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
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

  const shipRecords = readShipRecords(releasesDir);

  const claims =
    env.claimsRoot !== undefined ? readClaims(workgroupId, now, env.claimsRoot) : readClaims(workgroupId, now);
  return {
    asOf: releaseState.asOf,
    items: deriveBoardAttentionItems(releaseState.items, releaseState.asOf, shipRecords, claims, {
      workgroupId,
      channelKey: decl.channel_key,
    }),
  };
}
