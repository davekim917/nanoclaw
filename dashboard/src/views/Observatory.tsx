import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import {
  listWorkgroups,
  getObservatory,
  listScheduled,
  type AuthMe,
  type ObservatorySnapshot,
  type ObservatoryRoom,
  type ObservatoryClaim,
  type ObservatoryClaimState,
  type ReleaseState,
  type ReleaseItem,
  type ReleaseNextMover,
  type ScheduledRow,
  type ScheduledSnapshot,
} from '../lib/api.js';
import { relAge } from '../lib/derive.js';
import { type BoardRoute } from './BoardShell.js';
import { ScheduledDrawer } from './ScheduledDrawer.js';
import { buildReleaseGraph, unblockRanking } from './release-graph.js';
import { buildLedger, dueLabel, type Commitment } from './commitments.js';
import { assignItem } from '../lib/api.js';
import { OfficeMap } from './OfficeMap.js';
import { buildOfficeData } from './office-data.js';
import { WorkgroupPicker } from './WorkgroupDashboard.js';


/**
 * Observatory — the layer above Slack: one page that answers what is stuck,
 * what needs a person, and what is moving on its own, before any interaction.
 *
 * Three surfaces, in this order:
 *   1. the headline — one dominant number (stalled), two secondary, and the
 *      coverage gaps that qualify them, stated once;
 *   2. the office — the vendored <office-map> custom element, a hand-authored
 *      tile plan where each channel is a room and each agent sits in the room
 *      it last worked in. Geometry is FIXED; only occupancy comes from data.
 *      Picking a room opens the room sheet and filters the queue to its people;
 *   3. the queue and the collapsed boards — the ranked commitment ledger, the
 *      job board, work claims, and what is scheduled.
 *
 * The map is the ONLY illustrated surface. Everything around it is the atrium
 * light chrome (see styles.css): hairline cards, sentence case, one accent used
 * for interaction and muted status colours used for nothing else.
 *
 * Polls GET /dashboard/api/observatory?workgroup=:id every 15s — this is a
 * slow-moving status board, not a live feed. Detail opens IN PLACE, never by
 * navigating away; anything with a URL still links out in a new tab.
 */

const POLL_MS = 15_000;

interface ObservatoryProps {
  authMe: AuthMe;
  route: BoardRoute;
  onRouteChange: (r: BoardRoute) => void;
}

// Props are the shell's routing contract, kept so main.tsx and the legacy
// boards stay uniform. The Observatory itself no longer navigates: it is the
// only destination, and detail opens over the floor rather than away from it.
export function Observatory({ authMe }: ObservatoryProps) {
  const { data: wgData } = useSWR('/dashboard/api/workgroups', () => listWorkgroups(), { refreshInterval: 0 });
  const workgroups = wgData?.workgroups ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Remember the operator's office across visits — the first-workgroup default
  // put a viewer of a 13-room workgroup in a 1-room one with no way out.
  useEffect(() => {
    if (selectedId !== null || workgroups.length === 0) return;
    const remembered = localStorage.getItem('nc-obs-workgroup');
    const match = remembered && workgroups.find((w) => w.id === remembered);
    setSelectedId(match ? match.id : workgroups[0]!.id);
  }, [workgroups, selectedId]);

  const selectWorkgroup = (id: string) => {
    localStorage.setItem('nc-obs-workgroup', id);
    setSelectedId(id);
  };

  const {
    data: snapshot,
    error,
  } = useSWR<ObservatorySnapshot>(
    selectedId ? `/dashboard/api/observatory?workgroup=${selectedId}` : null,
    () => getObservatory(selectedId!),
    { refreshInterval: POLL_MS },
  );

  // Shared across the fold: the strip sits above the office, the board below it.
  const [releaseFilter, setReleaseFilter] = useState<ReleaseGroupKey | null>(null);
  const [selectedRoom, setSelectedRoom] = useState<string>('');
  const [flowFilter, setFlowFilter] = useState<FlowSlice | null>(null);
  const [teleportTo, setTeleportTo] = useState<string | null>(null);
  const [expandedClaim, setExpandedClaim] = useState<string | null>(null);

  const rooms = useMemo(() => sortRooms(snapshot?.rooms ?? []), [snapshot]);
  const agents = snapshot?.agents ?? [];
  const claims = useMemo(() => sortClaims(snapshot?.claims ?? []), [snapshot]);
  const awakeCount = agents.filter((a) => a.awake).length;

  // The strip above the floor must count the same set the board below shows,
  // so the owner filter is applied once, here, and handed to both.
  const allItems = snapshot?.releaseState?.items ?? [];

  // Selecting a room filters the queue to the people IN that room.
  //
  // Filtering by the room itself is what the design intends, but no release
  // item carries the channel it belongs to (checked 2026-08-16: zero of 71),
  // so there is nothing to match on. Whose desk the work is on IS derivable,
  // and it answers the same question — "what is going on in there" — without
  // inventing a field. It becomes a true room filter the day the watcher
  // publishes `channel`.
  const officeData = useMemo(() => buildOfficeData(rooms, agents, allItems), [rooms, agents, allItems]);

  // The occupants of the selected room, with the live fields the sheet needs
  // (holding, session) that the map's plan data does not carry. Uncapped, on
  // purpose: the plan seats two, but a filter that silently ignored the third
  // occupant would under-report the room.
  const selectedRoomAgents = useMemo(() => {
    if (!selectedRoom) return null;
    const idx = officeData.rooms.findIndex((r) => r.slot === selectedRoom);
    const room = officeData.rooms[idx];
    const src = idx >= 0 ? rooms[idx] : undefined;
    if (!room || !src) return null;
    // You steer WORK, not a worker. `holding` is claim slugs, so join it back
    // to the claims to get the thread each piece of work actually lives in.
    const bySlug = new Map(claims.map((c) => [c.slug, c]));
    return {
      label: room.label,
      agents: agents
        .filter((a) => a.location === src.key)
        .map((a) => ({
          id: a.id,
          name: a.name,
          held: a.holding.map((slug) => ({ slug, threadUrl: bySlug.get(slug)?.threadUrl ?? null })),
          state: room.agents.find((x) => x.name === a.name)?.status ?? 'idle',
        })),
    };
  }, [selectedRoom, officeData, rooms, agents, claims]);

  const roomOwners = useMemo(
    () => (selectedRoomAgents ? new Set(selectedRoomAgents.agents.map((a) => a.name)) : null),
    [selectedRoomAgents],
  );

  const ownerFilter = roomOwners ? [...roomOwners].join(', ') : null;
  const ownerFilteredItems = roomOwners
    ? allItems.filter((i) => i.owner && roomOwners.has(i.owner))
    : allItems;

  const ledgerCounts = useMemo(() => buildLedger(ownerFilteredItems).counts, [ownerFilteredItems]);
  const flowCount = flowFilter
    ? flowFilter === 'stalled'
      ? ledgerCounts.breached
      : flowFilter === 'person'
        ? ledgerCounts.person
        : ledgerCounts.onTrack
    : 0;

  // Where the camera opens. The plan's first slot is at its left edge, so
  // defaulting there spent the first screen on lawn. Open on the room that
  // most needs looking at — worst state first, then most occupied.
  const startSlot = useMemo(() => {
    const rank: Record<string, number> = { blocked: 0, waiting: 1, working: 2, idle: 3 };
    return [...officeData.rooms].sort(
      (a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9) || b.agents.length - a.agents.length,
    )[0]?.slot;
  }, [officeData]);

  const claimClicked = (claim: ObservatoryClaim) => {
    setExpandedClaim((prev) => (prev === claim.slug ? null : claim.slug));
  };

  return (
    <div className="nc-frame nc-of">
      <header className="nc-of-bar">
        <span className="nc-of-bar-title">The Observatory</span>
        <WorkgroupPicker workgroups={workgroups} selectedId={selectedId} onChange={selectWorkgroup} />
        {snapshot && (
          <span className="nc-of-bar-meta">
            <span className="nc-of-bar-count">
              {agents.length} agents <span aria-hidden="true">·</span> {rooms.length} channels
            </span>
            <span className="nc-of-live">
              <i className={awakeCount > 0 ? 'on' : ''} />
              {awakeCount} awake
            </span>
          </span>
        )}
      </header>

      <div className="nc-obs-body">
        {!snapshot && !error && <div className="nc-empty">loading observatory…</div>}
        {!snapshot && error && <div className="nc-obs-offline">observatory offline</div>}

        {snapshot && (
          <>
            {/* Layout law 1: one-line summary, then the OFFICE, then the dense
                boards — below the fold and closed. Before this, the job board
                rendered first and fully expanded, which put the floor ten
                pages down and made the office a footnote to its own page. */}
            <CommitmentStrip items={ownerFilteredItems} slice={flowFilter} onSlice={setFlowFilter} />

            <div className="nc-obs-main">
              {/* The floor is the vendored <office-map> custom element: a
                  tile-based, hand-authored plan with real furniture, pan, and
                  teleport. Geometry is FIXED; only who is in which room comes
                  from data. Replaces the CSS-rectangle floor entirely. */}
              {/* The floor and the sheet that describes the room you picked are
                  one thing; on a wide screen they hold still while the queue
                  they filter scrolls beside them. */}
              <div className="nc-of-left">
              <section className="nc-of-mapcard">
                <div className="nc-of-mapcard-head">
                  <span className="nc-of-mapcard-title">The office</span>
                  <span className="nc-of-mapcard-hint">drag to pan · tap a room to filter the queue</span>
                  {selectedRoom && (
                    <button type="button" className="nc-of-chip" onClick={() => setSelectedRoom('')}>
                      All rooms
                    </button>
                  )}
                </div>
                <OfficeMap
                  data={officeData}
                  {...(startSlot ? { start: startSlot } : {})}
                  selected={selectedRoom}
                  onSelect={(k) => setSelectedRoom((prev) => (prev === k ? '' : k))}
                  teleportTo={teleportTo}
                />
                <div className="nc-of-teleport">
                  {officeData.rooms.map((r) => (
                    <button
                      key={r.slot}
                      type="button"
                      className={`nc-of-chip ${selectedRoom === r.slot ? 'on' : ''}`}
                      onClick={() => {
                        setTeleportTo(r.slot);
                        setSelectedRoom((prev) => (prev === r.slot ? '' : r.slot));
                      }}
                    >
                      <i className={`nc-of-sd ${r.state}`} />
                      {r.label}
                    </button>
                  ))}
                </div>
                {officeData.overflow.length > 0 && (
                  // Its own line: inside the chip row this dead-end sentence sat
                  // on the same baseline as five controls and read as one.
                  <p className="nc-of-overflow">
                    {officeData.overflow.length} more{' '}
                    {officeData.overflow.length === 1 ? 'channel has' : 'channels have'} no room on this floor
                  </p>
                )}
              </section>

              {selectedRoomAgents && (
                <aside className="nc-of-sheet">
                  <header>
                    <span className="nc-of-sheet-title">{selectedRoomAgents.label}</span>
                    <button type="button" className="nc-of-sheet-x" onClick={() => setSelectedRoom('')} aria-label="Close">
                      ✕
                    </button>
                  </header>
                  {selectedRoomAgents.agents.length === 0 ? (
                    <p className="nc-of-sheet-empty">nobody is in this room right now</p>
                  ) : (
                    <ul className="nc-of-sheet-list">
                      {selectedRoomAgents.agents.map((a) => (
                        <li key={a.id}>
                          <span className="nc-of-sheet-who">
                            <i className={`nc-of-sd ${a.state}`} />
                            {a.name}
                          </span>
                          {/* Steer is per PIECE OF WORK, not per agent: one row
                              per held claim, each linking into the thread that
                              work lives in. An agent holding nothing gets no
                              affordance — there is nothing to steer. */}
                          {a.held.length === 0 ? (
                            <span className="nc-of-sheet-holding">holding nothing</span>
                          ) : (
                            <div className="nc-of-sheet-held">
                              {a.held.map((h) => (
                                <div className="nc-of-sheet-held-row" key={h.slug}>
                                  <span className="nc-of-sheet-held-slug">{h.slug}</span>
                                  {h.threadUrl ? (
                                    <OutLink href={h.threadUrl}>steer in thread</OutLink>
                                  ) : (
                                    <span className="nc-of-sheet-nothread">no thread recorded</span>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </aside>
              )}

              </div>

              <div className="nc-of-right">
              <details className="nc-of-board" open>
                <summary className="nc-of-board-summary">
                  Needs attention{' '}
                  {/* "62" alone read as a fourth, unexplained total. Against the
                      denominator it is obviously the two slices that are not
                      moving on their own. */}
                  <span className="nc-of-board-n">
                    {flowFilter
                      ? `${FLOW_LABEL[flowFilter]} · ${flowCount} of ${ownerFilteredItems.length}`
                      : `${ledgerCounts.breached + ledgerCounts.person} of ${ownerFilteredItems.length}`}
                  </span>
                  {flowFilter && (
                    <button
                      type="button"
                      className="nc-of-clearfilter"
                      onClick={(e) => {
                        // The summary is a disclosure; clearing the filter must
                        // not also collapse the list it filters.
                        e.preventDefault();
                        e.stopPropagation();
                        setFlowFilter(null);
                      }}
                    >
                      show all
                    </button>
                  )}
                </summary>
                <div className="inner">
                  <LedgerBoard
                    items={ownerFilteredItems}
                    slice={flowFilter}
                    {...(authMe.scopes.role !== 'member' && selectedId
                      ? {
                          assign: {
                            workgroupId: selectedId,
                            agents: agents.map((a) => ({ id: a.id, name: a.name })),
                          },
                        }
                      : {})}
                  />
                </div>
              </details>

              <details className="nc-of-board">
                <summary className="nc-of-board-summary">
                  Job board <span className="nc-of-board-n">{ownerFilteredItems.length}</span>
                </summary>
                <div className="inner">
                  <ReleaseTallies
                    items={ownerFilteredItems}
                    filter={releaseFilter}
                    onFilter={setReleaseFilter}
                  />
                </div>
                <ReleaseDesk
                  releaseState={snapshot.releaseState}
                  ownerFilter={ownerFilter}
                  onClearOwnerFilter={() => setSelectedRoom('')}
                  filter={releaseFilter}
                />
              </details>

              <details className="nc-of-board">
                <summary className="nc-of-board-summary">
                  Who&apos;s on what <span className="nc-of-board-n">{claims.length}</span>
                </summary>
                <ClaimsWall claims={claims} expandedSlug={expandedClaim} onClaimClick={claimClicked} />
              </details>

              <details className="nc-of-board">
                <summary className="nc-of-board-summary">What&apos;s scheduled</summary>
                <ScheduledSection agentGroupIds={agents.map((a) => a.id)} />
              </details>
              </div>
            </div>
          </>
        )}
      </div>

      <footer className="nc-obs-footer">
        {snapshot && !error && <span>as of {relAge(snapshot.asOf)} ago — source: live host state</span>}
        {snapshot && error && <span className="nc-obs-stale">stale since {relAge(snapshot.asOf)} ago</span>}
        {!snapshot && !error && <span>—</span>}
      </footer>
    </div>
  );
}

/* ─── Pure helpers (exported for tests) ──────────────────────────────────── */

/** Stable zone ordering — platform, then name. Never by activity. */
export function sortRooms(rooms: ObservatoryRoom[]): ObservatoryRoom[] {
  return [...rooms].sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name));
}

const CLAIM_ORDER: ObservatoryClaimState[] = ['stale', 'parked', 'expiring', 'live'];

/** Claims wall order: stale → parked → expiring → live. */
export function sortClaims(claims: ObservatoryClaim[]): ObservatoryClaim[] {
  return [...claims].sort((a, b) => CLAIM_ORDER.indexOf(a.state) - CLAIM_ORDER.indexOf(b.state));
}

/** Zone light level, driven by lastActivityAt: today lit, 1-7d dim, else dusty. */
export function roomActivityClass(lastActivityAt: string | null, now = Date.now()): 'lit' | 'dim' | 'dusty' {
  if (!lastActivityAt) return 'dusty';
  const days = (now - new Date(lastActivityAt).getTime()) / 86_400_000;
  if (days < 1) return 'lit';
  if (days <= 7) return 'dim';
  return 'dusty';
}


// Magnitude of an ms duration, bucketed the same way relAge buckets an
// elapsed-time ISO string — fed a synthesized timestamp so the two never
// drift apart on what "3h" means.
function magnitude(ms: number, now = Date.now()): string {
  return relAge(new Date(now - Math.abs(ms)).toISOString(), now);
}

// Signed relative time ("in 5m" / "3h ago").
function relTime(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  return ms >= 0 ? `in ${magnitude(ms, now)}` : `${magnitude(ms, now)} ago`;
}

/** Claim row age line — phrasing depends on state, magnitude from staleMs. */
export function claimAgeLabel(c: ObservatoryClaim, now = Date.now()): string {
  const mag = magnitude(c.staleMs, now);
  if (c.state === 'live') return `${mag} left`;
  if (c.state === 'parked') return `parked ${mag} ago`;
  return `${mag} past deadline`;
}

/** Link that always leaves the page safely. */
function OutLink({ href, children }: { href: string; children: string }) {
  return (
    <a className="nc-of-link" href={href} target="_blank" rel="noopener noreferrer">
      {children} ↗
    </a>
  );
}

/* ─── Job board — "what's in the way, and who has to move" ───────────────── */

type ReleaseGroupKey = 'blockers' | ReleaseNextMover;

const MOVER_ORDER: ReleaseNextMover[] = ['human', 'agent', 'nobody'];

const MOVER_GROUP_LABELS: Record<ReleaseNextMover, string> = {
  human: 'Waiting on a person',
  agent: 'Agents are handling it',
  nobody: 'Nobody is on this',
};

const MOVER_GROUP_SUBTITLES: Record<ReleaseNextMover, string> = {
  human: 'nothing moves until someone decides or approves',
  agent: 'being worked automatically right now',
  nobody: 'no owner, no progress — it stays stuck until someone picks it up',
};

const MOVER_TAG: Record<ReleaseNextMover, string> = {
  human: 'needs a person',
  agent: 'automated',
  nobody: 'unowned',
};

const KIND_GLYPH: Record<string, string> = { pr: '🔀', finding: '🐞', decision: '⚖️', claim: '📌', ops: '🧰' };
function kindGlyph(kind: string): string {
  return KIND_GLYPH[kind] ?? '•';
}

/** "open PR" for a pull request, "open issue" for everything else. */
function itemLinkLabel(kind: string): string {
  return kind === 'pr' ? 'open PR' : 'open issue';
}

/**
 * Split items into the blockers group plus the three mover groups, with a
 * blocksRelease item appearing ONLY in blockers — never duplicated into its
 * mover group too.
 */
export function groupReleaseItems(items: ReleaseItem[]): {
  blockers: ReleaseItem[];
  human: ReleaseItem[];
  agent: ReleaseItem[];
  nobody: ReleaseItem[];
} {
  const blockers = items.filter((i) => i.blocksRelease);
  const rest = items.filter((i) => !i.blocksRelease);
  return {
    blockers,
    human: rest.filter((i) => i.nextMover === 'human'),
    agent: rest.filter((i) => i.nextMover === 'agent'),
    nobody: rest.filter((i) => i.nextMover === 'nobody'),
  };
}

/**
 * The four tallies, zero terms dropped. Rendered as big chunky number buttons
 * on the corkboard; the joined form is `releaseCounts`, and the two must stay
 * in lockstep — the counts line is a contract, not decoration.
 */
export function releaseCountParts(items: ReleaseItem[]): { key: ReleaseGroupKey; n: number; label: string }[] {
  const g = groupReleaseItems(items);
  return [
    { key: 'blockers' as const, n: g.blockers.length, label: 'blocking' },
    { key: 'human' as const, n: g.human.length, label: 'need a person' },
    { key: 'agent' as const, n: g.agent.length, label: 'automated' },
    { key: 'nobody' as const, n: g.nobody.length, label: 'unowned' },
  ].filter((p) => p.n > 0);
}

/** "2 blocking · 28 need a person · 9 automated · 32 unowned" — zero terms omitted. */
export function releaseCounts(items: ReleaseItem[]): string {
  return releaseCountParts(items)
    .map((p) => `${p.n} ${p.label}`)
    .join(' · ');
}

/** The label an ownerless item files under. Not a real owner — see the sort. */
export const UNOWNED_LANE = 'Nobody has this';

/**
 * The same items grouped by WHOSE DESK they are on rather than by what has to
 * happen next. Both reads are useful and it is one dataset, so the board
 * toggles between them instead of shipping a second board.
 *
 * Lanes sort by urgency, not alphabetically: whoever holds a blocker comes
 * first, then by how much they are carrying. The ownerless lane is pinned last
 * however big it is — it is a backlog, not a person, and letting it win the
 * sort would bury every real assignee under it.
 */
export function groupReleaseItemsByOwner(items: ReleaseItem[]): { owner: string; items: ReleaseItem[] }[] {
  const lanes = new Map<string, ReleaseItem[]>();
  for (const item of items) {
    const owner = item.owner?.trim() || UNOWNED_LANE;
    const lane = lanes.get(owner);
    if (lane) lane.push(item);
    else lanes.set(owner, [item]);
  }

  // Within a lane: blockers first, then being-worked, waiting, unowned — the
  // "now / next / stuck" read, without nesting three more headings per person.
  const moverRank: Record<ReleaseNextMover, number> = { agent: 0, human: 1, nobody: 2 };
  for (const lane of lanes.values()) {
    // Boolean() before Number(): blocksRelease is optional, and Number(undefined)
    // is NaN, which makes the whole comparator return NaN and sort nothing.
    lane.sort(
      (a, b) =>
        Number(Boolean(b.blocksRelease)) - Number(Boolean(a.blocksRelease)) ||
        moverRank[a.nextMover] - moverRank[b.nextMover],
    );
  }

  return [...lanes.entries()]
    .map(([owner, laneItems]) => ({ owner, items: laneItems }))
    .sort((a, b) => {
      const aUnowned = a.owner === UNOWNED_LANE;
      const bUnowned = b.owner === UNOWNED_LANE;
      if (aUnowned !== bUnowned) return aUnowned ? 1 : -1;
      const aBlocks = a.items.filter((i) => i.blocksRelease).length;
      const bBlocks = b.items.filter((i) => i.blocksRelease).length;
      return bBlocks - aBlocks || b.items.length - a.items.length || a.owner.localeCompare(b.owner);
    });
}

/** "2 blocking · 3 automated" for one lane's own strip. */
export function laneSummary(items: ReleaseItem[]): string {
  return releaseCounts(items) || 'nothing open';
}

function ReleaseRow({
  item,
  moverTag,
  boldOwner,
  expanded,
  onToggle,
}: {
  item: ReleaseItem;
  moverTag?: string;
  boldOwner?: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="nc-obs-release-row" data-item-id={item.id}>
      {item.url ? (
        <a className="nc-obs-release-row-id" href={item.url} target="_blank" rel="noopener noreferrer">
          {item.id}
        </a>
      ) : (
        <span className="nc-obs-release-row-id">{item.id}</span>
      )}
      <button type="button" className="nc-obs-release-row-toggle" aria-expanded={expanded} onClick={onToggle}>
        <span className="nc-obs-release-row-kind" aria-hidden="true">
          {kindGlyph(item.kind)}
        </span>
        <span className="nc-obs-release-row-title">{item.title}</span>
        {moverTag && <span className="nc-obs-release-row-tag">{moverTag}</span>}
        {item.owner && (
          <span className="nc-obs-release-row-owner">{boldOwner ? <strong>{item.owner}</strong> : item.owner}</span>
        )}
        {item.since && <span className="nc-obs-release-row-age">{relAge(item.since)}</span>}
      </button>
      {expanded && (
        <div className="nc-obs-release-row-detail">
          {item.why && <div className="nc-obs-release-row-why">{item.why}</div>}
          {item.owner && <div className="nc-obs-release-row-meta">owner: {item.owner}</div>}
          {item.since && <div className="nc-obs-release-row-meta">open for {relAge(item.since)}</div>}
          {item.url && <OutLink href={item.url}>{itemLinkLabel(item.kind)}</OutLink>}
        </div>
      )}
    </div>
  );
}

/**
 * The tally strip — one line, directly under the header and directly above the
 * floor. It is the page's summary and its only always-open dense element; the
 * boards it filters sit BELOW the office, collapsed. Layout law 1 of the
 * office-16 system: the office is the hero and is reachable without scrolling.
 */
export function ReleaseTallies({
  items,
  filter,
  onFilter,
}: {
  items: ReleaseItem[];
  filter: ReleaseGroupKey | null;
  onFilter: (next: ReleaseGroupKey | null) => void;
}) {
  const parts = releaseCountParts(items);
  if (parts.length === 0) return null;
  return (
    <div className="nc-of-tally-row nc-of-tally-strip">
      {/* textContent of .nc-obs-release-counts stays exactly
          "1 blocking · 2 automated" — the ALL reset lives outside it. */}
      <div className="nc-obs-release-counts">
        {parts.map((p, i) => (
          <span key={p.key} className="nc-of-tally">
            {i > 0 && <span className="nc-of-tally-sep">{' · '}</span>}
            <button
              type="button"
              className={`nc-of-tally-btn ${filter === p.key ? 'active' : ''}`}
              data-tally={p.key}
              aria-pressed={filter === p.key}
              onClick={() => onFilter(filter === p.key ? null : p.key)}
            >
              <span className="nc-of-tally-n">{p.n}</span>
              <span className="nc-of-tally-l">{' ' + p.label}</span>
            </button>
          </span>
        ))}
      </div>
      <button
        type="button"
        className={`nc-of-tally-all ${filter === null ? 'active' : ''}`}
        aria-pressed={filter === null}
        onClick={() => onFilter(null)}
      >
        All
      </button>
    </div>
  );
}

function ReleaseDesk({
  releaseState,
  ownerFilter,
  onClearOwnerFilter,
  filter,
}: {
  releaseState: ReleaseState | null;
  /** Set by clicking someone on the floor. Matched against `item.owner`. */
  ownerFilter?: string | null;
  onClearOwnerFilter?: () => void;
  /** Lifted: the strip above the floor and the board below it share one filter. */
  filter: ReleaseGroupKey | null;
}) {
  const [view, setView] = useState<'status' | 'agent' | 'graph'>('status');
  const [expandedItem, setExpandedItem] = useState<string | null>(null);

  if (!releaseState) {
    return (
      <section className="nc-obs-release nc-of-corkboard">
        <div className="nc-obs-release-title">Job Board</div>
        <div className="nc-obs-release-empty">
          no release desk — the release watcher has not published release-state.json yet
        </div>
      </section>
    );
  }

  const { release, asOf } = releaseState;
  // Clicking someone on the floor narrows the WHOLE board to their desk, in
  // either view — the counts included, so the tallies never describe a set the
  // rows below aren't showing.
  const items = ownerFilter ? releaseState.items.filter((i) => i.owner === ownerFilter) : releaseState.items;
  const groups = groupReleaseItems(items);
  const lanes = groupReleaseItemsByOwner(items);
  const shows = (key: ReleaseGroupKey) => filter === null || filter === key;
  const toggleItem = (id: string) => setExpandedItem((prev) => (prev === id ? null : id));

  return (
    <section className="nc-obs-release nc-of-corkboard">
      <div className="nc-obs-release-head">
        <div>
          <span className="nc-obs-release-title">Job Board</span>
          <span className="nc-obs-release-fresh"> — updated {relAge(asOf)} ago by the release watcher</span>
          <div className="nc-obs-release-views" role="group" aria-label="Group the board by">
            <button
              type="button"
              className={`nc-obs-release-view ${view === 'status' ? 'active' : ''}`}
              aria-pressed={view === 'status'}
              onClick={() => setView('status')}
            >
              By status
            </button>
            <button
              type="button"
              className={`nc-obs-release-view ${view === 'agent' ? 'active' : ''}`}
              aria-pressed={view === 'agent'}
              onClick={() => setView('agent')}
            >
              By agent
            </button>
            <button
              type="button"
              className={`nc-obs-release-view ${view === 'graph' ? 'active' : ''}`}
              aria-pressed={view === 'graph'}
              onClick={() => setView('graph')}
            >
              What unblocks what
            </button>
          </div>
        </div>
      </div>

      {release?.moratorium && <div className="nc-obs-release-moratorium">release-day moratorium active</div>}

      {release?.holds && release.holds.length > 0 && (
        <div className="nc-obs-release-holds">
          {release.holds.map((h, i) => (
            <span key={i} className="nc-obs-release-hold">
              {h.kind}
              {h.reason ? `: ${h.reason}` : ''}
            </span>
          ))}
        </div>
      )}

      {ownerFilter && (
        <div className="nc-obs-release-owner-filter">
          <span>
            showing only <strong>{ownerFilter}</strong>&apos;s desk
          </span>
          <button type="button" className="nc-obs-release-owner-clear" onClick={onClearOwnerFilter}>
            show everyone
          </button>
        </div>
      )}

      {items.length === 0 && (
        <div className="nc-obs-release-empty">
          {ownerFilter ? `nothing open on ${ownerFilter}'s desk` : 'nothing open — clear to ship pending the usual gates'}
        </div>
      )}

      {view === 'graph' && <DependencyView items={items} />}

      {view === 'agent' &&
        lanes.map((lane) => (
          <div key={lane.owner} className={`nc-obs-release-lane ${lane.owner === UNOWNED_LANE ? 'unowned' : ''}`}>
            <div className="nc-obs-release-lane-head">
              <span className="nc-obs-release-lane-owner">{lane.owner}</span>
              <span className="nc-obs-release-lane-sum">{laneSummary(lane.items)}</span>
            </div>
            {lane.items.map((item) => (
              <ReleaseRow
                key={item.id}
                item={item}
                moverTag={MOVER_TAG[item.nextMover]}
                expanded={expandedItem === item.id}
                onToggle={() => toggleItem(item.id)}
              />
            ))}
          </div>
        ))}

      {view === 'status' && groups.blockers.length > 0 && shows('blockers') && (
        <div className="nc-obs-release-group blockers">
          <div className="nc-obs-release-group-label">Blocking the release</div>
          <div className="nc-obs-release-group-sub">nothing ships until these are cleared</div>
          {groups.blockers.map((item) => (
            <ReleaseRow
              key={item.id}
              item={item}
              moverTag={MOVER_TAG[item.nextMover]}
              expanded={expandedItem === item.id}
              onToggle={() => toggleItem(item.id)}
            />
          ))}
        </div>
      )}

      {view === 'status' &&
        MOVER_ORDER.map((mover) => {
        const rows = groups[mover];
        if (rows.length === 0 || !shows(mover)) return null;
        return (
          <div key={mover} className="nc-obs-release-group">
            <div className="nc-obs-release-group-label">{MOVER_GROUP_LABELS[mover]}</div>
            <div className="nc-obs-release-group-sub">{MOVER_GROUP_SUBTITLES[mover]}</div>
            {rows.map((item) => (
              <ReleaseRow
                key={item.id}
                item={item}
                boldOwner={mover === 'human'}
                expanded={expandedItem === item.id}
                onToggle={() => toggleItem(item.id)}
              />
            ))}
          </div>
        );
      })}
    </section>
  );
}

/**
 * The headline. It used to read "4 awake · 10 channels", which measures agent
 * liveness — a container can be awake, animated and busy-looking while the work
 * it holds rotted three days ago. These three numbers measure FLOW instead:
 * what has already failed its promise, what a person owes, and what is moving.
 */
/**
 * ONE canonical name per state, shared by this strip, the ledger rows and the
 * job-board tallies. "Waiting on a person" and "need a person" were the same
 * state under two names, stacked vertically on one screen.
 */
/** Header wording for a filtered queue. */
const FLOW_LABEL: Record<FlowSlice, string> = {
  stalled: 'stalled',
  person: 'need a person',
  moving: 'moving on their own',
};

export const STATE_WORDS = { stalled: 'stalled', person: 'need a person', moving: 'moving' } as const;

/** Which slice of the headline the queue is showing. */
export type FlowSlice = 'stalled' | 'person' | 'moving';

/** The slice a commitment belongs to. Every row is in exactly one. */
export function flowSlice(c: Commitment): FlowSlice {
  if (c.state === 'breached' || c.state === 'unowned') return 'stalled';
  return c.mover === 'human' ? 'person' : 'moving';
}

export function CommitmentStrip({
  items,
  slice,
  onSlice,
}: {
  items: ReleaseItem[];
  slice?: FlowSlice | null;
  onSlice?: (s: FlowSlice | null) => void;
}) {
  const ledger = useMemo(() => buildLedger(items), [items]);
  const { counts } = ledger;
  if (items.length === 0) return null;
  // The numbers ARE the way into the queue. Reading "30 need a person" and
  // having no way to see which thirty was the gap: the most decision-relevant
  // slice had no entry point.
  const pick = (s: FlowSlice) => () => onSlice?.(slice === s ? null : s);
  return (
    <section className="nc-of-head">
      <div className="nc-of-head-main">
        {/* ONE dominant number. Three equal ones made the reader choose which
            to care about; the ten-second read has to answer that for them. */}
        <button
          type="button"
          className={`nc-of-hero ${slice === 'stalled' ? 'on' : ''}`}
          aria-pressed={slice === 'stalled'}
          onClick={pick('stalled')}
        >
          <span className="nc-of-hero-n">{counts.breached}</span>
          <span className="nc-of-hero-l">
            items are stalled
            <span>past a promised deadline, or owned by nobody</span>
          </span>
        </button>
        <div className="nc-of-sub">
          <button
            type="button"
            className={`nc-of-slice ${slice === 'person' ? 'on' : ''}`}
            aria-pressed={slice === 'person'}
            onClick={pick('person')}
          >
            <b className="warn">{counts.person}</b> need a person
          </button>
          <button
            type="button"
            className={`nc-of-slice ${slice === 'moving' ? 'on' : ''}`}
            aria-pressed={slice === 'moving'}
            onClick={pick('moving')}
          >
            <b className="go">{counts.onTrack}</b> moving on their own
          </button>
          {/* The three numbers are DISJOINT slices of one denominator: every
              commitment is in exactly one. Without saying so, a reader reads
              30 and 8 as subsets of 32 and finds an arithmetic contradiction
              where there is none. */}
          <span className="nc-of-sub-total">{items.length} open commitments, split three ways</span>
        </div>
      </div>
      {/* The gaps in the data, one line each. These are never hidden — they
          report that the numbers above are incomplete, and a collapsed
          disclosure would soften exactly the thing that must not soften. On a
          phone only the ELABORATION drops, so the claim still reads in full
          while the block stops pushing the office below the fold. */}
      <div className="nc-of-notes">
        <p>
          <i className="warn" />
          <span>
            <b>{ledger.datedPct}% of owned work has a deadline.</b>
            <span className="nc-of-note-more">
              {' '}
              Nothing here can be measured as late, so &ldquo;stalled&rdquo; undercounts.
            </span>
          </span>
        </p>
        {ledger.unclassifiedP1 > 0 && (
          <p>
            <i className="stop" />
            <span>
              <b>
                {ledger.unclassifiedP1} p1 security {ledger.unclassifiedP1 === 1 ? 'finding is' : 'findings are'} not
                classified as release-blocking either way.
              </b>
              <span className="nc-of-note-more"> A person has to decide.</span>
            </span>
          </p>
        )}
      </div>
    </section>
  );
}

/* ─── The ledger — every open commitment, breach-ordered ─────────────────── */

const LEDGER_STATE_LABEL: Record<Commitment['state'], string> = {
  unowned: 'nobody owns this',
  breached: 'past its promise',
  undated: 'no deadline set',
  'due-soon': 'due soon',
  'on-track': 'on track',
};

/**
 * The one view. Every open item as a commitment, ordered so that anything that
 * has already failed its promise is first and the oldest failure leads.
 *
 * It is a list on purpose: this has to work on a phone, and the answer to
 * "what is stuck" is a ranking, not a picture.
 */
/** Rows on the first screen. The rest expand on demand. */
const LEDGER_FIRST_PAGE = 15;

interface AssignWiring {
  workgroupId: string;
  agents: { id: string; name: string }[];
}

/**
 * The assign control on one expanded row. Sends three ids; the server owns the
 * prompt, the role gate and the wiring check — a rejection comes back as its
 * error name so the operator learns WHY (not wired, no channel), not just "no".
 */
function AssignControl({ item, wiring }: { item: ReleaseItem; wiring: AssignWiring }) {
  const [agentId, setAgentId] = useState('');
  const [state, setState] = useState<{ phase: 'idle' | 'busy' | 'done' | 'error'; note?: string }>({ phase: 'idle' });

  if (!item.channel) return null;
  if (state.phase === 'done') return <div className="nc-obs-assign-done">{state.note}</div>;

  const go = async () => {
    if (!agentId) return;
    setState({ phase: 'busy' });
    try {
      const r = await assignItem(wiring.workgroupId, item.id, agentId);
      setState({ phase: 'done', note: `assigned — ${r.agent} was tasked in ${r.channel}` });
    } catch (e) {
      const err = e as { error?: string; status?: number };
      const why =
        err.error === 'agent_not_wired_to_channel'
          ? `that agent is not wired to ${item.channel}`
          : err.error === 'recently_assigned'
            ? 'already assigned in the last few minutes'
            : (err.error ?? 'failed');
      setState({ phase: 'error', note: why });
    }
  };

  return (
    <div className="nc-obs-assign">
      <select
        aria-label="Assign to agent"
        value={agentId}
        onChange={(e) => setAgentId(e.target.value)}
        disabled={state.phase === 'busy'}
      >
        <option value="">assign to…</option>
        {wiring.agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      <button type="button" onClick={go} disabled={!agentId || state.phase === 'busy'}>
        {state.phase === 'busy' ? 'assigning…' : `task it in ${item.channel}`}
      </button>
      {state.phase === 'error' && <span className="nc-obs-assign-err">{state.note}</span>}
    </div>
  );
}

function LedgerBoard({
  items,
  now = Date.now(),
  slice = null,
  assign,
}: {
  items: ReleaseItem[];
  now?: number;
  /** Headline slice the queue is filtered to, or null for everything open. */
  slice?: FlowSlice | null;
  /** Present only for roles that may assign; absent hides the control. */
  assign?: AssignWiring;
}) {
  const ledger = useMemo(() => buildLedger(items, now), [items, now]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  // Unfiltered, the queue is everything NOT moving on its own; picking
  // "moving" is the one case that widens it rather than narrowing it.
  //
  // Filtered on the SAME slices the headline counts, deliberately. The old
  // default (state !== 'on-track') admitted agent-owned undated rows that the
  // headline had already counted under "moving", so the board's own "62 of 70"
  // could disagree with the number of rows under it.
  const all = ledger.rows.filter((r) => (slice ? flowSlice(r) === slice : flowSlice(r) !== 'moving'));
  // The queue is ranked, so the first screen is the answer. 62 rows rendered
  // at once is the wall of list the operator asked us to get out from under —
  // the rest is one tap away, and the count says how much is behind it.
  const shown = showAll ? all : all.slice(0, LEDGER_FIRST_PAGE);

  return (
    <div className="nc-obs-ledger">
      {/* The two coverage gaps are stated ONCE, in the headline above. Repeating
          them here read as two separate warnings about two separate problems. */}
      {shown.length === 0 ? (
        <div className="nc-obs-ledger-empty">
          {slice ? 'nothing in this slice' : 'every open commitment is on track'}
        </div>
      ) : (
        <ul className="nc-obs-ledger-rows">
          {shown.map((c) => (
            <li
              key={c.item.id}
              className={`nc-obs-ledger-row ${c.state} ${c.item.blocksRelease ? 'blocks' : ''}`}
              data-ledger-id={c.item.id}
            >
              <button
                type="button"
                className="nc-obs-ledger-btn"
                aria-expanded={expanded === c.item.id}
                onClick={() => setExpanded((p) => (p === c.item.id ? null : c.item.id))}
              >
                {/* Fixed grammar down the row: lead · title · owner · type ·
                    age. Every column shares one edge so the list is scannable
                    top to bottom rather than ragged. */}
                <span className="nc-obs-ledger-lead">
                  <span className={`nc-obs-ledger-due ${c.state}`}>{dueLabel(c)}</span>
                </span>
                <span className="nc-obs-ledger-title">
                  {c.item.blocksRelease && <span className="nc-obs-ledger-blocks">blocks release</span>}
                  {c.item.title}
                </span>
                <span className="nc-obs-ledger-owner">{c.item.owner ?? '—'}</span>
                <span className="nc-obs-ledger-kind">{c.item.kind}</span>
                <span className="nc-obs-ledger-age num">
                  {c.ageMs !== null ? magnitude(c.ageMs, now + c.ageMs) : '—'}
                </span>
              </button>
              {expanded === c.item.id && (
                <div className="nc-obs-ledger-detail">
                  {c.item.nextAction && <div className="nc-obs-ledger-next">next: {c.item.nextAction}</div>}
                  {c.item.why && <div>{c.item.why}</div>}
                  <div className="nc-obs-ledger-meta">
                    {LEDGER_STATE_LABEL[c.state]}
                    {c.item.owner ? ` · ${c.item.owner}` : ''}
                  </div>
                  {c.item.url && <OutLink href={c.item.url}>{itemLinkLabel(c.item.kind)}</OutLink>}
                  {assign && <AssignControl item={c.item} wiring={assign} />}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {all.length > shown.length && (
        <button type="button" className="nc-obs-ledger-more" onClick={() => setShowAll(true)}>
          show the other {all.length - shown.length}
        </button>
      )}
    </div>
  );
}

/* ─── Dependency view — "land this and N things move" ────────────────────── */

/**
 * The ranked list leads and the picture follows, because the ranking is the
 * answer and the picture is the evidence. A node-link diagram is also the half
 * that cannot work at 390px, so on a phone the list IS the feature and the
 * layered columns scroll sideways underneath it.
 */
function DependencyView({ items }: { items: ReleaseItem[] }) {
  const graph = useMemo(() => buildReleaseGraph(items), [items]);
  const ranked = useMemo(() => unblockRanking(graph), [graph]);
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="nc-obs-dep">
      {/* Coverage is stated before anything derived from it. A graph built on
          29% declared data is not wrong, but reading it as if it were complete
          is, and the reader can only avoid that if we say so first. */}
      <div className={`nc-obs-dep-coverage ${graph.declaredPct < 100 ? 'partial' : ''}`}>
        <strong>{graph.declaredPct}%</strong> of items have declared what blocks them
        {graph.undeclaredCount > 0 && (
          <span className="nc-obs-dep-coverage-gap">
            {' '}
            — {graph.undeclaredCount} {graph.undeclaredCount === 1 ? 'item has' : 'items have'} not said, so
            anything below is a partial picture
          </span>
        )}
      </div>

      {graph.cycles.length > 0 && (
        <div className="nc-obs-dep-cycle">
          {graph.cycles.length} items block each other in a loop — nothing in it can go first:{' '}
          {graph.cycles.join(', ')}
        </div>
      )}

      {ranked.length === 0 ? (
        <div className="nc-obs-dep-empty">
          nothing on this board unblocks anything else yet — either the work is genuinely independent, or the
          dependencies have not been declared
        </div>
      ) : (
        <ol className="nc-obs-dep-rank">
          {ranked.map((n) => (
            <li key={n.item.id} className="nc-obs-dep-rank-row">
              <button
                type="button"
                className="nc-obs-dep-rank-btn"
                aria-expanded={expanded === n.item.id}
                onClick={() => setExpanded((p) => (p === n.item.id ? null : n.item.id))}
              >
                <span className="nc-obs-dep-rank-n">{n.unblocks}</span>
                <span className="nc-obs-dep-rank-l">
                  {n.unblocks === 1 ? 'item moves' : 'items move'} if{' '}
                  <span className="nc-obs-dep-rank-id">{n.item.id}</span> lands
                </span>
                {n.item.blocksRelease && <span className="nc-obs-dep-flag">blocks release</span>}
              </button>
              {expanded === n.item.id && (
                <div className="nc-obs-dep-rank-detail">
                  <div>{n.item.title}</div>
                  {n.item.owner && <div className="nc-obs-dep-meta">owner: {n.item.owner}</div>}
                  {n.item.url && <OutLink href={n.item.url}>{itemLinkLabel(n.item.kind)}</OutLink>}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      <div className="nc-obs-dep-plan" role="img" aria-label="Dependency layers, earliest work on the left">
        {graph.layers.map((layer, i) => (
          <div key={i} className="nc-obs-dep-layer">
            <div className="nc-obs-dep-layer-head">{i === 0 ? 'can start now' : `after ${i}`}</div>
            {layer.map((n) => (
              <a
                key={n.item.id}
                className={[
                  'nc-obs-dep-node',
                  n.item.blocksRelease ? 'blocks' : '',
                  n.depsKnown ? '' : 'undeclared',
                  n.inCycle ? 'cycle' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                href={n.item.url ?? undefined}
                target={n.item.url ? '_blank' : undefined}
                rel={n.item.url ? 'noopener noreferrer' : undefined}
                data-node-id={n.item.id}
                title={n.item.title}
              >
                <span className="nc-obs-dep-node-id">{n.item.id}</span>
                <span className="nc-obs-dep-node-title">{n.item.title}</span>
                {/* The whole point: an undeclared node must not read as a root. */}
                {!n.depsKnown && <span className="nc-obs-dep-node-tag">deps not declared</span>}
                {n.inCycle && <span className="nc-obs-dep-node-tag cycle">in a loop</span>}
              </a>
            ))}
          </div>
        ))}
      </div>

      {graph.danglingRefs.length > 0 && (
        <div className="nc-obs-dep-dangling">
          {graph.danglingRefs.length} declared {graph.danglingRefs.length === 1 ? 'dependency names' : 'dependencies name'}{' '}
          something not on this board (closed, another repo, or a typo):{' '}
          {graph.danglingRefs.map((d) => `${d.from} → ${d.to}`).join(', ')}
        </div>
      )}
    </div>
  );
}

/* ─── What's scheduled — the next few automatic jobs ─────────────────────── */

const SCHED_KIND_LABEL: Record<string, string> = {
  recurring: 'repeating job',
  one_off: 'one-time job',
  thread_loop: 'follow-up check',
};

/**
 * The next `limit` fires belonging to agents on this floor, soonest first.
 * Rows with no next fire (cancelled, finished one-offs) are not upcoming work
 * and drop out.
 */
export function upcomingScheduled(rows: ScheduledRow[], agentGroupIds: string[], limit = 8): ScheduledRow[] {
  const mine = new Set(agentGroupIds);
  return rows
    .filter((r) => mine.has(r.agent_group_id) && r.next_fire_utc)
    .sort((a, b) => Date.parse(a.next_fire_utc!) - Date.parse(b.next_fire_utc!))
    .slice(0, limit);
}

function ScheduledSection({ agentGroupIds }: { agentGroupIds: string[] }) {
  const { data, error, mutate } = useSWR<ScheduledSnapshot>('/dashboard/api/scheduled', () => listScheduled(), {
    refreshInterval: POLL_MS,
  });
  const [openKey, setOpenKey] = useState<string | null>(null);
  const rows = upcomingScheduled(data?.rows ?? [], agentGroupIds);
  // A key whose row has dropped out of the window (it fired, or was cancelled
  // from another tab) must not hold a drawer open over a series that is no
  // longer on this floor.
  const open = rows.some((r) => r.key === openKey) ? openKey : null;

  return (
    <section className="nc-of-sched">
      <div className="nc-of-sched-title">What&apos;s scheduled</div>
      {error && !data && <div className="nc-of-sched-empty">couldn&apos;t load scheduled work</div>}
      {!error && data && rows.length === 0 && <div className="nc-of-sched-empty">nothing scheduled</div>}
      {rows.length > 0 && (
        <ul className="nc-of-sched-list">
          {rows.map((r) => (
            <li key={r.key} className="nc-of-sched-row" data-sched-key={r.key}>
              <button
                type="button"
                className="nc-of-sched-open"
                onClick={() => setOpenKey(r.key)}
                aria-label={`Open scheduled job ${r.series_id}`}
              >
                <span className="nc-of-sched-who">{r.agent_group_name}</span>
                <span className="nc-of-sched-what">{SCHED_KIND_LABEL[r.kind] ?? 'job'}</span>
                <span className="nc-of-sched-when">{relTime(r.next_fire_utc!)}</span>
                {r.channel_name && <span className="nc-of-sched-where">in {r.channel_name}</span>}
                <span className="nc-of-sched-id">{r.series_id}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && <ScheduledDrawer rowKey={open} onClose={() => setOpenKey(null)} onMutated={() => void mutate()} />}
    </section>
  );
}

/* ─── Whiteboard — "Who's on what" ───────────────────────────────────────── */

const CLAIM_GROUP_LABELS: Record<ObservatoryClaimState, string> = {
  stale: 'Abandoned',
  parked: 'Handed off, needs an owner',
  expiring: 'Running out of time',
  live: 'Being worked on now',
};

const CLAIM_GROUP_SUBTITLES: Record<ObservatoryClaimState, string> = {
  stale: 'abandoned — past its deadline, nobody is coming back',
  parked: 'deliberately handed off — free for anyone to take',
  expiring: 'past its deadline but inside the grace window',
  live: 'actively held — leave it alone',
};

const CLAIM_PILL: Record<ObservatoryClaimState, { cls: string; text: string }> = {
  stale: { cls: 'failed', text: 'abandoned' },
  parked: { cls: 'needs', text: '🅿️ needs an owner' },
  expiring: { cls: 'pending', text: 'running out of time' },
  live: { cls: 'done', text: 'in progress' },
};

function ClaimsWall({
  claims,
  expandedSlug,
  onClaimClick,
}: {
  claims: ObservatoryClaim[];
  expandedSlug: string | null;
  onClaimClick: (claim: ObservatoryClaim) => void;
}) {
  return (
    <aside className="nc-obs-claims nc-of-whiteboard">
      <div className="nc-obs-claims-title">Who&apos;s on what</div>
      {claims.length === 0 && <div className="nc-empty">nobody has picked anything up</div>}
      {CLAIM_ORDER.map((state) => {
        const rows = claims.filter((c) => c.state === state);
        if (rows.length === 0) return null;
        return (
          <div key={state} className="nc-obs-claim-group">
            <div className="nc-obs-claim-group-label">{CLAIM_GROUP_LABELS[state]}</div>
            <div className="nc-obs-claim-group-sub">{CLAIM_GROUP_SUBTITLES[state]}</div>
            {rows.map((c) => {
              const expanded = expandedSlug === c.slug;
              const pill = CLAIM_PILL[c.state];
              return (
                <div key={c.slug} className={`nc-obs-claim-row ${c.state}`} data-slug={c.slug}>
                  <button
                    type="button"
                    className="nc-obs-claim-toggle"
                    aria-expanded={expanded}
                    onClick={() => onClaimClick(c)}
                  >
                    <span className="nc-obs-claim-top">
                      <span className="nc-obs-claim-slug">{c.slug}</span>
                      {!(c.escalated && c.state === 'stale') && (
                        <span className={`nc-pill ${pill.cls}`}>{pill.text}</span>
                      )}
                    </span>
                    {c.escalated && (
                      <span className="nc-obs-claim-escalated">escalated · already announced in channel</span>
                    )}
                    <span className="nc-obs-claim-owner">
                      {c.owner && c.owner !== 'unknown' ? c.owner : <em>owner unknown</em>}
                    </span>
                    <span className="nc-obs-claim-age">{claimAgeLabel(c)}</span>
                  </button>
                  {expanded && (
                    <div className="nc-obs-claim-detail">
                      {c.note && <div className="nc-obs-claim-note">{c.note}</div>}
                      {c.threadUrl && <OutLink href={c.threadUrl}>open thread</OutLink>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </aside>
  );
}
