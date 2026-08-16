import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import {
  listWorkgroups,
  getObservatory,
  type AuthMe,
  type ObservatorySnapshot,
  type ObservatoryRoom,
  type ObservatoryAgent,
  type ObservatoryClaim,
  type ObservatoryClaimState,
} from '../lib/api.js';
import { relAge } from '../lib/derive.js';
import { RouteNav, type BoardRoute } from './BoardShell.js';
import { WorkgroupPicker } from './WorkgroupDashboard.js';

/**
 * Observatory — an ambient "who is where, doing what" view for the human
 * operator. Concept: each workgroup channel is a ROOM, each agent has ONE
 * body. Not a game — no avatars walking, no animation beyond CSS
 * transitions, no interactivity beyond hover and click-through.
 *
 * Polls GET /dashboard/api/observatory?workgroup=:id every 15s (no SSE —
 * this is a slow-moving status board, not a live chat feed). Room CARD
 * POSITION is stable (sorted platform, then name) regardless of activity —
 * spatial memory is the point. Activity is conveyed by brightness only.
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

  // Which agent's popover is open, and whether a click pinned it there (vs. a
  // hover that closes on mouseleave). Single piece of state — one popover can
  // ever be open, whatever chip it came from.
  const [popover, setPopover] = useState<{ id: string; pinned: boolean } | null>(null);

  // Outside click closes the popover. A click ON a chip (or inside its own
  // popover, nested in the same div) is handled by the chip's own handlers —
  // this only fires for clicks that land nowhere near a chip.
  useEffect(() => {
    if (!popover) return;
    function onDocClick(e: MouseEvent) {
      const el = e.target as Element | null;
      if (!el?.closest?.('.nc-obs-chip')) setPopover(null);
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [popover]);

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
      onToggle: () =>
        setPopover((prev) => {
          if (!prev || prev.id !== id) return { id, pinned: true };
          return prev.pinned ? null : { id, pinned: true };
        }),
      onClose: () => setPopover(null),
    };
  }

  const rooms = useMemo(() => sortRooms(snapshot?.rooms ?? []), [snapshot]);
  const agents = snapshot?.agents ?? [];
  const claims = useMemo(() => sortClaims(snapshot?.claims ?? []), [snapshot]);
  const deskAgents = agents.filter((a) => a.location === null);
  const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const claimClicked = (claim: ObservatoryClaim) => {
    const match = agents.find((a) => a.id === claim.owner || a.name === claim.owner);
    setHighlightedAgentId((prev) => (match && prev === match.id ? null : match?.id ?? null));
  };

  return (
    <div className="nc-frame">
      <header className="nc-pulse">
        <div className="nc-pulse-top">
          <div className="nc-brand">
            <span className="mark" aria-hidden="true"></span>
            <WorkgroupPicker workgroups={workgroups} selectedId={selectedId} onChange={selectWorkgroup} />
          </div>
          <RouteNav route={route} onRouteChange={onRouteChange} />
        </div>
      </header>

      <div className="nc-obs-body">
        {!snapshot && !error && <div className="nc-empty">loading observatory…</div>}
        {!snapshot && error && <div className="nc-obs-offline">observatory offline</div>}

        {snapshot && (
          <>
            <div className="nc-obs-desks">
              <div className="nc-obs-desks-label">Desks</div>
              <div className="nc-obs-desks-row">
                {deskAgents.length === 0 && <span className="nc-obs-desks-empty">no one home</span>}
                {deskAgents.map((a) => (
                  <AgentChip key={a.id} agent={a} highlighted={a.id === highlightedAgentId} {...bindPopover(a.id)} />
                ))}
              </div>
            </div>

            <div className="nc-obs-main">
              <div className="nc-obs-rooms">
                {rooms.map((room) => (
                  <RoomCard
                    key={room.key}
                    room={room}
                    bodies={agents.filter((a) => a.location === room.key)}
                    agentsById={agentsById}
                    highlightedAgentId={highlightedAgentId}
                    openAgentId={popover?.id ?? null}
                    bindPopover={bindPopover}
                  />
                ))}
                {rooms.length === 0 && <div className="nc-empty">no rooms wired for this workgroup</div>}
              </div>

              <ClaimsWall claims={claims} onClaimClick={claimClicked} />
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

/** Stable room ordering — platform, then name. Never by activity. */
export function sortRooms(rooms: ObservatoryRoom[]): ObservatoryRoom[] {
  return [...rooms].sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name));
}

const CLAIM_ORDER: ObservatoryClaimState[] = ['stale', 'parked', 'expiring', 'live'];

/** Claims wall order: stale → parked → expiring → live. */
export function sortClaims(claims: ObservatoryClaim[]): ObservatoryClaim[] {
  return [...claims].sort((a, b) => CLAIM_ORDER.indexOf(a.state) - CLAIM_ORDER.indexOf(b.state));
}

/** Room-card light level, driven by lastActivityAt: today lit, 1-7d dim, else dusty. */
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

/* ─── Agent chip — one agent's ONE body ──────────────────────────────────── */

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
        </div>
      )}
    </div>
  );
}

/* ─── Room card ───────────────────────────────────────────────────────────── */

function RoomCard({
  room,
  bodies,
  agentsById,
  highlightedAgentId,
  openAgentId,
  bindPopover,
}: {
  room: ObservatoryRoom;
  bodies: ObservatoryAgent[];
  agentsById: Map<string, ObservatoryAgent>;
  highlightedAgentId: string | null;
  openAgentId: string | null;
  bindPopover: (id: string) => PopoverBinding;
}) {
  const cls = roomActivityClass(room.lastActivityAt);
  const presentIds = new Set(bodies.map((a) => a.id));
  const absentMembers = room.memberAgentIds.filter((id) => !presentIds.has(id));
  // A dim/dusty room's opacity creates its own stacking context, trapping any
  // popover rendered inside it below sibling room cards later in the grid.
  // Elevating the room itself (grid items honor z-index without needing
  // position:relative) lifts the trapped popover above every sibling.
  const hasOpenPopover = bodies.some((a) => a.id === openAgentId);

  return (
    <div className={`nc-obs-room ${cls} ${hasOpenPopover ? 'has-open-popover' : ''}`} data-room-key={room.key}>
      <div className="nc-obs-room-head">
        <span className="nc-obs-room-name">{room.name}</span>
        {cls === 'dusty' && (
          <span className="nc-obs-room-cobweb" aria-hidden="true" title="quiet for a while">
            🕸️
          </span>
        )}
      </div>
      <div className="nc-obs-room-platform">{room.platform}</div>
      <div className="nc-obs-room-bodies">
        {bodies.map((a) => (
          <AgentChip key={a.id} agent={a} highlighted={a.id === highlightedAgentId} {...bindPopover(a.id)} />
        ))}
        {absentMembers.map((id) => {
          const known = agentsById.get(id);
          return (
            <span key={id} className="nc-obs-room-absent" title={known?.name ?? id}>
              {initials(known?.name ?? id)}
            </span>
          );
        })}
      </div>
      {room.permalink && (
        <a className="nc-obs-room-link" href={room.permalink} target="_blank" rel="noreferrer">
          open ↗
        </a>
      )}
    </div>
  );
}

/* ─── Claims wall — "Who's on what" ──────────────────────────────────────── */

const CLAIM_GROUP_LABELS: Record<ObservatoryClaimState, string> = {
  stale: 'Stale',
  parked: 'Parked',
  expiring: 'Expiring',
  live: 'Live',
};

const CLAIM_GROUP_SUBTITLES: Record<ObservatoryClaimState, string> = {
  stale: 'abandoned — past its deadline, nobody is coming back',
  parked: 'deliberately handed off — free for anyone to take',
  expiring: 'past its deadline but inside the grace window',
  live: 'actively held — leave it alone',
};

function ClaimsWall({
  claims,
  onClaimClick,
}: {
  claims: ObservatoryClaim[];
  onClaimClick: (claim: ObservatoryClaim) => void;
}) {
  return (
    <aside className="nc-obs-claims">
      <div className="nc-obs-claims-title">Who&apos;s on what</div>
      {claims.length === 0 && <div className="nc-empty">no claims</div>}
      {CLAIM_ORDER.map((state) => {
        const rows = claims.filter((c) => c.state === state);
        if (rows.length === 0) return null;
        return (
          <div key={state} className="nc-obs-claim-group">
            <div className="nc-obs-claim-group-label">{CLAIM_GROUP_LABELS[state]}</div>
            <div className="nc-obs-claim-group-sub">{CLAIM_GROUP_SUBTITLES[state]}</div>
            {rows.map((c) => (
              <div
                key={c.slug}
                className={`nc-obs-claim-row ${c.state}`}
                data-slug={c.slug}
                onClick={() => onClaimClick(c)}
              >
                <div className="nc-obs-claim-top">
                  <span className="nc-obs-claim-slug">{c.slug}</span>
                  {!c.escalated && c.state === 'stale' && <span className="nc-pill failed">stale</span>}
                  {c.state === 'parked' && <span className="nc-pill needs">🅿️ needs an owner</span>}
                  {c.state === 'live' && <span className="nc-pill done">live</span>}
                  {c.state === 'expiring' && <span className="nc-pill pending">expiring</span>}
                </div>
                {c.escalated && (
                  <div className="nc-obs-claim-escalated">escalated · already announced in channel</div>
                )}
                <div className="nc-obs-claim-owner">
                  {c.owner && c.owner !== 'unknown' ? c.owner : <em>owner unknown</em>}
                </div>
                <div className="nc-obs-claim-age">{claimAgeLabel(c)}</div>
                {c.note && <div className="nc-obs-claim-note">{c.note}</div>}
              </div>
            ))}
          </div>
        );
      })}
    </aside>
  );
}
