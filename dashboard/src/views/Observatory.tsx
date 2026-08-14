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

  useEffect(() => {
    if (selectedId === null && workgroups.length > 0) setSelectedId(workgroups[0]!.id);
  }, [workgroups, selectedId]);

  const {
    data: snapshot,
    error,
  } = useSWR<ObservatorySnapshot>(
    selectedId ? `/dashboard/api/observatory?workgroup=${selectedId}` : null,
    () => getObservatory(selectedId!),
    { refreshInterval: POLL_MS },
  );

  const [highlightedAgentId, setHighlightedAgentId] = useState<string | null>(null);

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
            <span className="nc-group-title nc-group-title-static">Observatory</span>
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
                  <AgentChip key={a.id} agent={a} highlighted={a.id === highlightedAgentId} />
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

// Signed relative time ("in 5m" / "3h ago") — reuses relAge's magnitude
// bucketing by feeding it a synthesized elapsed-time ISO string.
function relTime(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  const mag = relAge(new Date(now - Math.abs(ms)).toISOString(), now);
  return ms >= 0 ? `in ${mag}` : `${mag} ago`;
}

/* ─── Agent chip — one agent's ONE body ──────────────────────────────────── */

function AgentChip({ agent, highlighted }: { agent: ObservatoryAgent; highlighted: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      className={`nc-obs-chip ${agent.awake ? 'awake' : 'asleep'} ${highlighted ? 'highlighted' : ''}`}
      data-agent-id={agent.id}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span className="nc-obs-chip-glyph" aria-hidden="true">
        {agent.awake ? '●' : '💤'}
      </span>
      <span className="nc-obs-chip-name">{agent.name}</span>
      {hover && (
        <div className="nc-obs-hover">
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
}: {
  room: ObservatoryRoom;
  bodies: ObservatoryAgent[];
  agentsById: Map<string, ObservatoryAgent>;
  highlightedAgentId: string | null;
}) {
  const cls = roomActivityClass(room.lastActivityAt);
  const presentIds = new Set(bodies.map((a) => a.id));
  const absentMembers = room.memberAgentIds.filter((id) => !presentIds.has(id));

  return (
    <div className={`nc-obs-room ${cls}`} data-room-key={room.key}>
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
          <AgentChip key={a.id} agent={a} highlighted={a.id === highlightedAgentId} />
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
            {rows.map((c) => (
              <div
                key={c.slug}
                className={`nc-obs-claim-row ${c.state}`}
                data-slug={c.slug}
                onClick={() => onClaimClick(c)}
              >
                <div className="nc-obs-claim-top">
                  <span className="nc-obs-claim-slug">{c.slug}</span>
                  {c.escalated && <span className="nc-pill failed">escalated</span>}
                  {!c.escalated && c.state === 'stale' && <span className="nc-pill failed">stale</span>}
                  {c.state === 'parked' && <span className="nc-pill needs">🅿️ needs an owner</span>}
                  {c.state === 'live' && <span className="nc-pill done">live</span>}
                  {c.state === 'expiring' && <span className="nc-pill pending">expiring</span>}
                </div>
                <div className="nc-obs-claim-owner">{c.owner ?? '—'}</div>
                {c.note && <div className="nc-obs-claim-note">{c.note}</div>}
              </div>
            ))}
          </div>
        );
      })}
    </aside>
  );
}
