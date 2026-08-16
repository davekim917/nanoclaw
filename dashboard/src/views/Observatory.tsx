import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import {
  listWorkgroups,
  getObservatory,
  listScheduled,
  type AuthMe,
  type ObservatorySnapshot,
  type ObservatoryRoom,
  type ObservatoryAgent,
  type ObservatoryClaim,
  type ObservatoryClaimState,
  type ReleaseState,
  type ReleaseItem,
  type ReleaseNextMover,
  type ScheduledRow,
  type ScheduledSnapshot,
} from '../lib/api.js';
import { relAge } from '../lib/derive.js';
import { RouteNav, type BoardRoute } from './BoardShell.js';
import { ScheduledDrawer } from './ScheduledDrawer.js';
import { buildReleaseGraph, unblockRanking } from './release-graph.js';
import { buildLedger, dueLabel, type Commitment } from './commitments.js';
import { WorkgroupPicker } from './WorkgroupDashboard.js';
import { DESK_ON, DESK_OFF, COBWEB, COUCH, BLANK_AVATAR, roomDecor, rugTone } from './office-sprites.js';

/**
 * Observatory — a top-down pixel-art OPEN-PLAN office floor you look down into.
 * One continuous checkerboard floor holds everything: each workgroup channel is
 * a desk cluster standing on its own rug under a hanging sign, agents with no
 * channel hang out in the lounge, and the clusters are separated by furniture
 * and aisle space rather than walls. Above the floor sit the boards the
 * operator acts on: the corkboard JOB BOARD (release desk), the WHITEBOARD
 * (claims), and WHAT'S SCHEDULED.
 *
 * Deliberately bright and warm — the rest of the dashboard is a dark control
 * surface; this is a lit room with people in it. No animation, no canvas, no
 * images: everything is CSS plus inline-SVG data URIs from office-sprites.ts.
 *
 * Polls GET /dashboard/api/observatory?workgroup=:id every 15s (no SSE — this
 * is a slow-moving status board, not a live chat feed). Zone POSITION is
 * stable (sorted platform, then name) regardless of activity, and each zone's
 * rug tone and furniture are hashed from its key — spatial memory is the
 * point. Activity is conveyed by lighting only.
 *
 * Everything a human would poke at is a real button or anchor: zones, tallies,
 * job-board rows and claim rows all open in place, and anything with a URL
 * links out in a new tab.
 */

const POLL_MS = 15_000;

interface ObservatoryProps {
  authMe: AuthMe;
  route: BoardRoute;
  onRouteChange: (r: BoardRoute) => void;
}

export function Observatory({ route, onRouteChange }: ObservatoryProps) {
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

  const [highlightedAgentId, setHighlightedAgentId] = useState<string | null>(null);
  // Shared across the fold: the strip sits above the office, the board below it.
  const [releaseFilter, setReleaseFilter] = useState<ReleaseGroupKey | null>(null);
  const [expandedClaim, setExpandedClaim] = useState<string | null>(null);
  const [openZone, setOpenZone] = useState<string | null>(null);

  // Which agent's popover is open, and whether a click pinned it there (vs. a
  // hover that closes on mouseleave). Single piece of state — one popover can
  // ever be open, whatever chip it came from.
  const [popover, setPopover] = useState<{ id: string; pinned: boolean } | null>(null);

  // Outside click closes whatever is open. A click ON a chip (or inside its own
  // popover, nested in the same div) is handled by the chip's own handlers, and
  // the same holds for a zone and its panel — this only fires for clicks that
  // land nowhere near either.
  useEffect(() => {
    if (!popover && !openZone) return;
    function onDocClick(e: MouseEvent) {
      const el = e.target as Element | null;
      if (!el?.closest?.('.nc-obs-chip')) setPopover(null);
      if (!el?.closest?.('.nc-obs-room')) setOpenZone(null);
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [popover, openZone]);

  function bindPopover(id: string) {
    return {
      isOpen: popover?.id === id,
      pinned: popover?.id === id && popover.pinned,
      onEnter: () =>
        setPopover((prev) =>
          prev?.pinned && prev.id !== id ? prev : { id, pinned: prev?.id === id ? prev.pinned : false },
        ),
      onLeave: () => setPopover((prev) => (prev?.id === id && !prev.pinned ? null : prev)),
      // A mouse click always fires mouseenter first, which already opened this
      // chip unpinned — so a click on an already-open-but-unpinned chip PINS
      // it rather than closing it. Only a click on an already-PINNED chip
      // closes it. This is what makes click "toggle" rather than "always
      // close what hover just opened".
      // Clicking someone is also how you ask "what is on THEIR desk" — the same
      // click that pins their card narrows the job board to their lane, and
      // un-pinning restores everyone. The office earns its keep by being a
      // control surface, not a picture.
      onToggle: () =>
        setPopover((prev) => {
          const next = !prev || prev.id !== id ? { id, pinned: true } : prev.pinned ? null : { id, pinned: true };
          setHighlightedAgentId(next ? id : null);
          return next;
        }),
      onClose: () => setPopover(null),
    };
  }

  const rooms = useMemo(() => sortRooms(snapshot?.rooms ?? []), [snapshot]);
  const agents = snapshot?.agents ?? [];
  const claims = useMemo(() => sortClaims(snapshot?.claims ?? []), [snapshot]);
  const deskAgents = agents.filter((a) => a.location === null);
  const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const awakeCount = agents.filter((a) => a.awake).length;

  // The strip above the floor must count the same set the board below shows,
  // so the owner filter is applied once, here, and handed to both.
  const ownerFilter = highlightedAgentId ? (agentsById.get(highlightedAgentId)?.name ?? null) : null;
  const allItems = snapshot?.releaseState?.items ?? [];
  const ownerFilteredItems = ownerFilter ? allItems.filter((i) => i.owner === ownerFilter) : allItems;

  const ledgerCounts = useMemo(() => buildLedger(ownerFilteredItems).counts, [ownerFilteredItems]);

  const claimClicked = (claim: ObservatoryClaim) => {
    const match = agents.find((a) => a.id === claim.owner || a.name === claim.owner);
    setHighlightedAgentId((prev) => (match && prev === match.id ? null : match?.id ?? null));
    setExpandedClaim((prev) => (prev === claim.slug ? null : claim.slug));
  };

  return (
    <div className="nc-frame nc-of">
      <header className="nc-pulse nc-of-topbar">
        <div className="nc-pulse-top">
          <div className="nc-brand">
            <span className="mark" aria-hidden="true"></span>
            <WorkgroupPicker workgroups={workgroups} selectedId={selectedId} onChange={selectWorkgroup} />
          </div>
          {snapshot && (
            <div className="nc-of-headcount">
              {awakeCount} awake <span aria-hidden="true">·</span> {rooms.length} channels
            </div>
          )}
          <RouteNav route={route} onRouteChange={onRouteChange} />
        </div>
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
            <CommitmentStrip items={ownerFilteredItems} />

            <ReleaseTallies
              items={ownerFilteredItems}
              filter={releaseFilter}
              onFilter={setReleaseFilter}
            />

            <div className="nc-obs-main">
              <div className="nc-of-floor">
                <div className="nc-obs-rooms">
                  {rooms.map((room) => (
                    <Zone
                      key={room.key}
                      room={room}
                      bodies={agents.filter((a) => a.location === room.key)}
                      agentsById={agentsById}
                      highlightedAgentId={highlightedAgentId}
                      openAgentId={popover?.id ?? null}
                      bindPopover={bindPopover}
                      panelOpen={openZone === room.key}
                      onToggle={() => {
                        setPopover(null);
                        setOpenZone((prev) => (prev === room.key ? null : room.key));
                      }}
                      onClosePanel={() => setOpenZone(null)}
                    />
                  ))}
                  {rooms.length === 0 && <div className="nc-empty">no channels wired for this workgroup</div>}
                </div>

                <div className="nc-obs-desks nc-of-bullpen">
                  <div className="nc-obs-desks-label">Lounge</div>
                  <img className="nc-of-sprite nc-of-lounge-couch" src={COUCH} alt="" aria-hidden="true" />
                  <div className="nc-obs-desks-row">
                    {deskAgents.length === 0 && <span className="nc-obs-desks-empty">no one home</span>}
                    {deskAgents.map((a) => (
                      <AgentChip key={a.id} agent={a} highlighted={a.id === highlightedAgentId} {...bindPopover(a.id)} />
                    ))}
                  </div>
                </div>
              </div>

              <details className="nc-of-board" open>
                <summary className="nc-of-board-summary">
                  Needs attention{' '}
                  <span className="nc-of-board-n">{ledgerCounts.breached + ledgerCounts.person}</span>
                </summary>
                <div className="inner">
                  <LedgerBoard items={ownerFilteredItems} />
                </div>
              </details>

              <details className="nc-of-board">
                <summary className="nc-of-board-summary">
                  Job Board <span className="nc-of-board-n">{ownerFilteredItems.length}</span>
                </summary>
                <ReleaseDesk
                  releaseState={snapshot.releaseState}
                  ownerFilter={ownerFilter}
                  onClearOwnerFilter={() => setHighlightedAgentId(null)}
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

function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
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
export const STATE_WORDS = { stalled: 'stalled', person: 'need a person', moving: 'moving' } as const;

export function CommitmentStrip({ items }: { items: ReleaseItem[] }) {
  const { counts } = useMemo(() => buildLedger(items), [items]);
  if (items.length === 0) return null;
  return (
    <div className="nc-of-commit-strip">
      <div className="nc-of-commit stop">
        <span className="n">{counts.breached}</span>
        <span className="l">stalled</span>
      </div>
      <div className="nc-of-commit warn">
        <span className="n">{counts.person}</span>
        <span className="l">need a person</span>
      </div>
      <div className="nc-of-commit go">
        <span className="n">{counts.onTrack}</span>
        <span className="l">moving</span>
      </div>
    </div>
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
function LedgerBoard({ items, now = Date.now() }: { items: ReleaseItem[]; now?: number }) {
  const ledger = useMemo(() => buildLedger(items, now), [items, now]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const shown = ledger.rows.filter((r) => r.state !== 'on-track');

  return (
    <div className="nc-obs-ledger">
      {/* Coverage before anything derived from it, same rule as the dependency
          view: a ledger where most promises have no clock is not a schedule. */}
      <div className={`nc-obs-ledger-cov ${ledger.datedPct < 100 ? 'partial' : ''}`}>
        <strong>{ledger.datedPct}%</strong> of owned work has a deadline
        {ledger.undatedCount > 0 && (
          <span className="nc-obs-ledger-gap">
            {' '}
            — {ledger.undatedCount} {ledger.undatedCount === 1 ? 'item has' : 'items have'} an owner but no clock,
            so nothing can tell whether they are late
          </span>
        )}
      </div>

      {ledger.unclassifiedP1 > 0 && (
        <div className="nc-obs-ledger-sec">
          <strong>{ledger.unclassifiedP1}</strong> p1 {ledger.unclassifiedP1 === 1 ? 'finding is' : 'findings are'} not
          classified as release-blocking either way. Tenant isolation and auth bypass block the release by rule; until
          QA applies the label, nothing computes it and they ship.
        </div>
      )}

      {shown.length === 0 ? (
        <div className="nc-obs-ledger-empty">every open commitment is on track</div>
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
                <span className={`nc-obs-ledger-due ${c.state}`}>{dueLabel(c)}</span>
                <span className="nc-obs-ledger-title">{c.item.title}</span>
                {c.item.blocksRelease && <span className="nc-obs-ledger-blocks">blocks release</span>}
                {c.item.kind === 'finding' && <span className="nc-obs-ledger-kind">finding</span>}
                <span className="nc-obs-ledger-owner">{c.item.owner ?? LEDGER_STATE_LABEL[c.state]}</span>
                {c.ageMs !== null && <span className="nc-obs-ledger-age">{magnitude(c.ageMs, now + c.ageMs)}</span>}
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
                </div>
              )}
            </li>
          ))}
        </ul>
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

/* ─── Agent at a desk — one agent's ONE body ─────────────────────────────── */

interface PopoverBinding {
  isOpen: boolean;
  pinned: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onToggle: () => void;
  onClose: () => void;
}

function AgentChip({
  agent,
  highlighted,
  isOpen,
  pinned,
  onEnter,
  onLeave,
  onToggle,
  onClose,
}: { agent: ObservatoryAgent; highlighted: boolean } & PopoverBinding) {
  return (
    <div
      className={`nc-obs-chip ${agent.awake ? 'awake' : 'asleep'} ${highlighted ? 'highlighted' : ''}`}
      data-agent-id={agent.id}
      role="button"
      tabIndex={0}
      aria-expanded={isOpen}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      {/* Avatar first in DOM so it sits on top of the desk and is the chip's
          first <img>; CSS, not source order, does the overlap. */}
      <div className="nc-of-station">
        {agent.avatarUrl ? (
          <img
            className={`nc-obs-avatar pixelated${agent.awake ? '' : ' asleep'}`}
            src={agent.avatarUrl}
            alt={agent.name}
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="nc-of-blank">
            <img
              className={`nc-obs-avatar pixelated blank${agent.awake ? '' : ' asleep'}`}
              src={BLANK_AVATAR}
              alt=""
              aria-hidden="true"
            />
            <span className="nc-of-blank-initials">{initials(agent.name)}</span>
          </span>
        )}
        <img className="nc-of-sprite nc-of-desk" src={agent.awake ? DESK_ON : DESK_OFF} alt="" aria-hidden="true" />
      </div>
      <span className="nc-obs-chip-glyph" aria-hidden="true">
        {agent.awake ? '●' : '💤'}
      </span>
      <span className="nc-obs-chip-name">{agent.name}</span>
      {isOpen && (
        // Stops a click inside the popover (including the close button) from
        // bubbling to the chip's own onClick and immediately re-opening it.
        <div className={`nc-obs-hover ${pinned ? 'pinned' : ''}`} onClick={(e) => e.stopPropagation()}>
          <button type="button" className="nc-obs-hover-close" aria-label="close" onClick={onClose}>
            ✕
          </button>
          <div className="nc-obs-hover-canonical">{agent.canonicalName}</div>
          <div>{agent.awake ? 'awake' : 'asleep'}</div>
          <div>{agent.lastSeenAt ? `last seen ${relAge(agent.lastSeenAt)} ago` : 'never seen'}</div>
          <div>{agent.holding.length > 0 ? `holding: ${agent.holding.join(', ')}` : 'holding nothing'}</div>
          <div>{agent.nextTask ? `next: ${agent.nextTask.title} (${relTime(agent.nextTask.at)})` : 'no upcoming task'}</div>
          {/* Steering opens the session rather than composing here: a message
              sent without the transcript in front of you is a guess, and the
              session view already has both. One click, no blind steer. */}
          {agent.lastSessionId ? (
            <a className="nc-obs-hover-steer" href={`#/session/${agent.lastSessionId}`}>
              open session to steer →
            </a>
          ) : (
            <div className="nc-obs-hover-nosession">no session to steer — it has never spoken</div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Zone — a rug, a hanging sign and a desk cluster on the open floor ──── */

function Zone({
  room,
  bodies,
  agentsById,
  highlightedAgentId,
  openAgentId,
  bindPopover,
  panelOpen,
  onToggle,
  onClosePanel,
}: {
  room: ObservatoryRoom;
  bodies: ObservatoryAgent[];
  agentsById: Map<string, ObservatoryAgent>;
  highlightedAgentId: string | null;
  openAgentId: string | null;
  bindPopover: (id: string) => PopoverBinding;
  panelOpen: boolean;
  onToggle: () => void;
  onClosePanel: () => void;
}) {
  const cls = roomActivityClass(room.lastActivityAt);
  const presentIds = new Set(bodies.map((a) => a.id));
  const absentMembers = room.memberAgentIds.filter((id) => !presentIds.has(id));
  const decor = roomDecor(room.key);
  // A dusty zone's filtered sprites create their own stacking context, which
  // can trap an open panel below zones later in the grid. Elevating the zone
  // itself (grid items honor z-index without needing position:relative) lifts
  // anything open inside it above every sibling.
  const hasOpenPanel = panelOpen || bodies.some((a) => a.id === openAgentId);

  return (
    <div
      className={`nc-obs-room nc-of-zone rug-${rugTone(room.key)} ${cls} ${hasOpenPanel ? 'has-open-popover' : ''}`}
      data-room-key={room.key}
      // Occupancy sets the footprint (layout law 4). Absent members still take
      // a seat — they belong to this channel and their empty desk is part of
      // what the room is — but a dead channel with nobody at all stays small
      // instead of becoming a big colour slab with one desk in the middle.
      style={{ ['--seats' as string]: String(Math.min(bodies.length + Math.min(absentMembers.length, 2) * 0.5, 3.5)) }}
    >
      <button
        type="button"
        className="nc-obs-room-head nc-of-sign"
        aria-expanded={panelOpen}
        onClick={onToggle}
      >
        <span className="nc-obs-room-name">{room.name}</span>
      </button>

      {cls === 'dusty' && (
        <img className="nc-obs-room-cobweb" src={COBWEB} alt="" aria-hidden="true" title="quiet for a while" />
      )}

      <div className="nc-of-decor" aria-hidden="true">
        {decor.map((d) => (
          <img key={d.name} className={`nc-of-sprite nc-of-decor-${d.name}`} src={d.src} alt="" data-decor={d.name} />
        ))}
      </div>

      <div className="nc-obs-room-bodies">
        {bodies.map((a) => (
          <AgentChip key={a.id} agent={a} highlighted={a.id === highlightedAgentId} {...bindPopover(a.id)} />
        ))}
        {bodies.length === 0 && (
          <div className="nc-of-empty-desks" aria-hidden="true">
            <img className="nc-of-sprite nc-of-desk" src={DESK_OFF} alt="" />
            <img className="nc-of-sprite nc-of-desk" src={DESK_OFF} alt="" />
          </div>
        )}
        {absentMembers.length > 0 && (
          <div className="nc-of-absent-row">
            {absentMembers.map((id) => {
              const known = agentsById.get(id);
              return known?.avatarUrl ? (
                <img
                  key={id}
                  className="nc-obs-avatar-sm pixelated"
                  src={known.avatarUrl}
                  alt={known.name}
                  title={known.name}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span key={id} className="nc-obs-room-absent" title={known?.name ?? id}>
                  {initials(known?.name ?? id)}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {panelOpen && (
        <div className="nc-obs-hover pinned nc-of-zone-panel" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="nc-obs-hover-close" aria-label="close" onClick={onClosePanel}>
            ✕
          </button>
          <div className="nc-of-zone-panel-name">{room.name}</div>
          <div className="nc-obs-hover-canonical">{room.platform}</div>
          <div>
            {bodies.length > 0 ? `here now: ${bodies.map((a) => a.name).join(', ')}` : 'nobody at these desks'}
          </div>
          <div>
            {room.lastActivityAt ? `last active ${relAge(room.lastActivityAt)} ago` : 'no activity on record'}
          </div>
          {room.permalink && <OutLink href={room.permalink}>open channel</OutLink>}
        </div>
      )}
    </div>
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
