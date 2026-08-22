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
 * slug that encodes the PR itself (whose note does not). Either match wins:
 * the claim carries a richer reason and a real owner, so it wins over a board
 * item that would otherwise show the same PR twice.
 *
 * The slug shapes are the two the work-claims convention produces —
 * `gh-<n>` and `<prefix>-<n>-<words>` — so this is a shape check, not an
 * install-specific one.
 */
function claimCoversPr(claims: BoardClaim[], n: string): boolean {
  const slugRe = new RegExp(`(^|-)gh-${n}$|(^|-)${n}-`, 'i');
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
 */
export function readReleaseBoardSource(
  decl: AttentionSourceDecl,
  workgroupId: string,
  now: number,
  env: AttentionSourceEnv = {},
): ProviderRead {
  const releasesDir = path.join(env.groupsRoot ?? GROUPS_DIR, workgroupId, decl.root);

  let releaseState: { asOf?: string; items?: ReleaseStateItem[] };
  try {
    releaseState = JSON.parse(fs.readFileSync(path.join(releasesDir, 'release-state.json'), 'utf8')) as {
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

  const shipRecords: GateShipRecord[] = [];
  let gateFiles: string[] = [];
  try {
    gateFiles = fs.readdirSync(path.join(releasesDir, 'gates')).filter((f) => f.endsWith('.jsonl'));
  } catch {
    // no gates dir yet — nothing recorded, nothing to exclude
  }
  for (const file of gateFiles) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(releasesDir, 'gates', file), 'utf8');
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
