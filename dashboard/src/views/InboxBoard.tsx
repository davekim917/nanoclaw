import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import {
  archiveSession,
  listGroups,
  listSessions,
  unarchiveSession,
  type AttentionState,
  type AuthMe,
  type GroupSummary,
  type SessionSummary,
} from '../lib/api.js';
import { subscribe } from '../lib/sse.ts';
import { relAge } from '../lib/derive.js';
import { useGroupFilter } from '../lib/use-group-filter.js';
import {
  BoardBrand,
  BoardFrame,
  RouteNav,
  ShowArchivedToggle,
  useIsMobile,
  type BoardRoute,
} from './BoardShell.js';
import { SwipeableCard } from './SwipeableCard.js';

/**
 * Operator inbox at `/dashboard/inbox`. Sister route to the existing
 * Kanban Board — both share the `<BoardShell>` chrome but differ in their
 * stream: the board groups task cards by status, the inbox groups
 * session cards by attention-state ("Needs me / Active / Idle / Stale").
 *
 * Data source: GET /dashboard/api/sessions (enriched in C3). The handler
 * computes `attention_state` server-side using heartbeat + last_inbound +
 * attached_task; the SPA just buckets rows and renders.
 *
 * Push channel: subscribes to `session_event` (added in C4). Any inbound
 * write, outbound delivery, container-state transition, or archive flip
 * invalidates the SWR cache and re-renders. Polling fallback is the
 * existing dashboard heartbeat — no extra timer here.
 */

interface InboxBoardProps {
  authMe: AuthMe;
  route: BoardRoute;
  onRouteChange: (r: BoardRoute) => void;
}

const LANES: Array<{ key: AttentionState; label: string; tone: 'attention' | 'working' | 'done' | 'idle' }> = [
  { key: 'needs_me', label: 'Needs me', tone: 'attention' },
  { key: 'active', label: 'Active', tone: 'working' },
  { key: 'idle', label: 'Idle', tone: 'idle' },
  { key: 'stale', label: 'Stale', tone: 'done' },
];

export const InboxBoard: React.FC<InboxBoardProps> = ({ authMe, route, onRouteChange }) => {
  const [groupFilter, setGroupFilter] = useGroupFilter(
    authMe.user_id,
    authMe.scopes.allowed_group_ids,
    authMe.scopes.no_filter,
  );
  const [showArchived, setShowArchived] = useState(false);
  // Mobile-only lane filter. Tapping a header breakdown cell sets this;
  // tapping the active cell again clears it. The desktop view shows all
  // four lanes as columns, so the filter doesn't apply there.
  const [laneFilter, setLaneFilter] = useState<AttentionState | null>(null);
  const isMobile = useIsMobile();

  const sessionsKey = ['/dashboard/api/sessions', groupFilter, showArchived] as const;
  const { data, mutate } = useSWR(
    sessionsKey,
    () =>
      listSessions({
        ...(groupFilter === 'all' ? {} : { group_id: groupFilter }),
        ...(showArchived ? { include_archived: true } : {}),
      }),
    { refreshInterval: 0, dedupingInterval: 500 },
  );
  const { data: groupsData } = useSWR('/dashboard/api/groups', () => listGroups(), { refreshInterval: 0 });
  const groups: GroupSummary[] = groupsData?.groups ?? [];

  // Debounce SSE-triggered refetches. A streaming-status burst (50
  // outbound rows in 5s under a heavy agent turn) emits 50 session_event
  // frames; without a trailing-edge debounce SWR fires 50 mutate() calls
  // even with its built-in 500ms dedupe (each is a distinct cache key
  // boundary if other state changed). One refetch at 300ms is enough
  // for the operator to see the new state.
  const debounceRef = useRef<number | null>(null);
  const invalidate = useCallback(() => {
    if (debounceRef.current !== null) return;
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      void mutate();
    }, 300);
  }, [mutate]);
  useEffect(() => {
    const unsubscribe = subscribe('session_event', invalidate);
    return () => {
      unsubscribe();
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [invalidate]);

  const onArchive = useCallback(
    async (sessionId: string) => {
      try {
        await archiveSession(sessionId);
      } catch {
        // soft failure — next refetch reconciles
      } finally {
        void mutate();
      }
    },
    [mutate],
  );

  const onUnarchive = useCallback(
    async (sessionId: string) => {
      try {
        await unarchiveSession(sessionId);
      } catch {
        // soft failure
      } finally {
        void mutate();
      }
    },
    [mutate],
  );

  const sessions: SessionSummary[] = data?.sessions ?? [];

  // Bucket by attention_state. Sessions with no `attention_state` field
  // (e.g., older backend in mixed-deploy) fall into `idle` so they still
  // surface somewhere rather than vanishing.
  const lanes = useMemo(() => {
    const empty: Record<AttentionState, SessionSummary[]> = {
      needs_me: [],
      active: [],
      idle: [],
      stale: [],
    };
    for (const s of sessions) {
      const state = s.attention_state ?? 'idle';
      empty[state].push(s);
    }
    return empty;
  }, [sessions]);

  const counts = {
    needs_me: lanes.needs_me.length,
    active: lanes.active.length,
    idle: lanes.idle.length,
    stale: lanes.stale.length,
    total: sessions.length,
    // "Live" sessions = anything in flight from the operator's POV. Idle
    // and stale are by definition not — idle = no activity in 24h; stale
    // = >24h and the container is down. Big-count headline reads `live`
    // so the number matches the lanes the operator actually acts on.
    live: lanes.needs_me.length + lanes.active.length,
  };

  const lastActivityIso =
    sessions
      .map((s) => s.last_outbound_at ?? s.last_inbound_at ?? s.last_active)
      .filter((s): s is string => !!s)
      .sort()
      .pop() ?? new Date().toISOString();

  return (
    <BoardFrame isMobile={isMobile}>
      {isMobile ? (
        <MobileInboxHeader
          counts={counts}
          lastActivityIso={lastActivityIso}
          route={route}
          onRouteChange={onRouteChange}
          groups={groups}
          groupFilter={groupFilter}
          onGroupFilter={setGroupFilter}
          showArchived={showArchived}
          onShowArchivedChange={setShowArchived}
          laneFilter={laneFilter}
          onLaneFilter={setLaneFilter}
        />
      ) : (
        <DesktopInboxHeader
          counts={counts}
          lastActivityIso={lastActivityIso}
          route={route}
          onRouteChange={onRouteChange}
          groups={groups}
          groupFilter={groupFilter}
          onGroupFilter={setGroupFilter}
          showArchived={showArchived}
          onShowArchivedChange={setShowArchived}
        />
      )}

      {isMobile ? (
        <div className="nc-stream">
          {LANES.filter(({ key }) => laneFilter == null || laneFilter === key).map(({ key, label }) => {
            const rows = lanes[key];
            if (rows.length === 0) return null;
            return (
              <React.Fragment key={key}>
                <div className="nc-section-label">
                  <span>{label}</span>
                  <div className="rule" aria-hidden="true"></div>
                  <span className="cnt">{rows.length}</span>
                </div>
                {rows.map((s) => (
                  <SessionCard key={s.session_id} session={s} onArchive={onArchive} onUnarchive={onUnarchive} />
                ))}
              </React.Fragment>
            );
          })}
          {sessions.length === 0 && <div className="nc-empty">no sessions yet</div>}
          {laneFilter != null && lanes[laneFilter].length === 0 && (
            <div className="nc-empty">no sessions in {laneFilter.replace('_', ' ')}</div>
          )}
        </div>
      ) : (
        <div className="nc-desktop-body">
          {LANES.map(({ key, label, tone }) => (
            <div className="nc-col" key={key}>
              <div className={`nc-col-head ${tone}`}>
                <div className="ttl">
                  <span className="swatch" aria-hidden="true"></span>
                  {label}
                  <span className="cnt">{lanes[key].length}</span>
                </div>
              </div>
              <div className="nc-col-body">
                {lanes[key].length === 0 && (
                  <div className="nc-empty" style={{ margin: 0 }}>
                    —
                  </div>
                )}
                {lanes[key].map((s) => (
                  <SessionCard key={s.session_id} session={s} onArchive={onArchive} onUnarchive={onUnarchive} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </BoardFrame>
  );
};

/* ─── Mobile header ─── */

function MobileInboxHeader({
  counts,
  lastActivityIso,
  route,
  onRouteChange,
  groups,
  groupFilter,
  onGroupFilter,
  showArchived,
  onShowArchivedChange,
  laneFilter,
  onLaneFilter,
}: {
  counts: { needs_me: number; active: number; idle: number; stale: number; total: number; live: number };
  lastActivityIso: string;
  route: BoardRoute;
  onRouteChange: (r: BoardRoute) => void;
  groups: GroupSummary[];
  groupFilter: string;
  onGroupFilter: (g: string) => void;
  showArchived: boolean;
  onShowArchivedChange: (v: boolean) => void;
  laneFilter: AttentionState | null;
  onLaneFilter: (next: AttentionState | null) => void;
}) {
  // Tap-toggle: clicking the active filter clears back to "all"; clicking
  // a different cell switches the filter. Replaces the old filter-chip row
  // — the header counts already show the breakdown, so making the cells
  // themselves the filter UI is one fewer redundant control.
  const toggle = (k: AttentionState) => () => onLaneFilter(laneFilter === k ? null : k);
  return (
    <>
      <header className="nc-pulse">
        <div className="nc-pulse-top">
          <BoardBrand groups={groups} groupFilter={groupFilter} onGroupFilter={onGroupFilter} />
          <RouteNav route={route} onRouteChange={onRouteChange} />
        </div>
        <div className="nc-pulse-grid">
          <div className="nc-pulse-bigcount">
            <span>{counts.live}</span>
            <span className="lbl">
              sessions
              <br />
              live
            </span>
          </div>
          <div className="nc-pulse-breakdown">
            <InboxCell n={counts.needs_me} label="Needs me" tone="needs" active={laneFilter === 'needs_me'} onClick={toggle('needs_me')} />
            <InboxCell n={counts.active} label="Active" tone="running" active={laneFilter === 'active'} onClick={toggle('active')} />
            <InboxCell n={counts.idle} label="Idle" tone="done" active={laneFilter === 'idle'} onClick={toggle('idle')} />
            <InboxCell n={counts.stale} label="Stale" tone="failed" active={laneFilter === 'stale'} onClick={toggle('stale')} />
          </div>
        </div>
        <div className="nc-pulse-meta">
          <span>
            <span className="dot" aria-hidden="true"></span>
            LIVE · last event {relAge(lastActivityIso)} ago
          </span>
        </div>
      </header>
      <div className="nc-archive-toolbar">
        <ShowArchivedToggle showArchived={showArchived} onChange={onShowArchivedChange} />
      </div>
    </>
  );
}

/* ─── Desktop header ─── */

function DesktopInboxHeader({
  counts,
  lastActivityIso,
  route,
  onRouteChange,
  groups,
  groupFilter,
  onGroupFilter,
  showArchived,
  onShowArchivedChange,
}: {
  counts: { needs_me: number; active: number; idle: number; stale: number; total: number; live: number };
  lastActivityIso: string;
  route: BoardRoute;
  onRouteChange: (r: BoardRoute) => void;
  groups: GroupSummary[];
  groupFilter: string;
  onGroupFilter: (g: string) => void;
  showArchived: boolean;
  onShowArchivedChange: (v: boolean) => void;
}) {
  return (
    <div className="nc-desktop-top">
      <div className="nc-desktop-pulse">
        <div className="nc-desktop-headerrow">
          <BoardBrand groups={groups} groupFilter={groupFilter} onGroupFilter={onGroupFilter} />
          <RouteNav route={route} onRouteChange={onRouteChange} />
        </div>
        <div className="bigcount">
          <span>{counts.live}</span>
          <span className="lbl">
            sessions live
            <br />
            {relAge(lastActivityIso)} since last event
          </span>
        </div>
        <div className="row2">
          <DesktopInboxCell n={counts.needs_me} label="Needs me" tone="needs" />
          <DesktopInboxCell n={counts.active} label="Active" tone="running" />
          <DesktopInboxCell n={counts.idle} label="Idle" tone="done" />
          <DesktopInboxCell n={counts.stale} label="Stale" tone="failed" />
        </div>
        <div className="nc-pulse-meta" style={{ marginTop: 18 }}>
          <span>
            <span className="dot" aria-hidden="true"></span>
            LIVE · last event {relAge(lastActivityIso)} ago
          </span>
        </div>
      </div>
      <div>
        <div className="nc-desktop-toolbar">
          <ShowArchivedToggle showArchived={showArchived} onChange={onShowArchivedChange} />
        </div>
        <div className="nc-desktop-summary">
          Operator inbox · <strong>{counts.total} sessions</strong>.{' '}
          <span className="c-need">{counts.needs_me} need you</span> ·{' '}
          <span className="c-run">{counts.active} active</span> ·{' '}
          <span className="c-done">{counts.idle} idle</span> ·{' '}
          <span className="c-fail">{counts.stale} stale</span>.
        </div>
      </div>
    </div>
  );
}

/* ─── Cells ─── */

function InboxCell({
  n,
  label,
  tone,
  active,
  onClick,
}: {
  n: number;
  label: string;
  tone: 'needs' | 'running' | 'done' | 'failed';
  active?: boolean;
  onClick?: () => void;
}) {
  if (onClick) {
    return (
      <button
        type="button"
        className={`nc-pulse-cell ${tone}${active ? ' active' : ''}`}
        onClick={onClick}
        aria-pressed={!!active}
      >
        <span className="n">{n}</span>
        <span className="lbl">{label}</span>
      </button>
    );
  }
  return (
    <div className={`nc-pulse-cell ${tone}`}>
      <span className="n">{n}</span>
      <span className="lbl">{label}</span>
    </div>
  );
}

function DesktopInboxCell({
  n,
  label,
  tone,
}: {
  n: number;
  label: string;
  tone: 'needs' | 'running' | 'done' | 'failed';
}) {
  return (
    <div className={`breadcell ${tone}`}>
      <span className="n">{n}</span>
      <span className="lbl">{label}</span>
    </div>
  );
}

/* ─── Session card ─── */

function SessionCard({
  session,
  onArchive,
  onUnarchive,
}: {
  session: SessionSummary;
  onArchive: (sessionId: string) => void;
  onUnarchive: (sessionId: string) => void;
}) {
  const isArchived = session.archived_at != null;
  const isAttachedTask = !!session.attached_task_id;
  const colourClass = session.attention_state === 'needs_me' ? 'needs' : 'running';
  const title = session.title ?? session.session_id;
  const lastInbound = session.last_inbound_at ?? session.last_active;
  const lastOutbound = session.last_outbound_at;

  // Cards with an attached_task short-circuit to TaskDetail (existing UX
  // for spawn workers). Every other card opens its own SessionDetail at
  // `#/session/:id`, where the operator can read recent messages and
  // send a steer via the C5 session-message endpoint.
  const onClick = () => {
    if (isAttachedTask) location.hash = `#/task/${session.attached_task_id}`;
    else location.hash = `#/session/${session.session_id}`;
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };
  const handleArchive = (e: React.MouseEvent) => {
    e.stopPropagation();
    onArchive(session.session_id);
  };
  const handleUnarchive = (e: React.MouseEvent) => {
    e.stopPropagation();
    onUnarchive(session.session_id);
  };

  return (
    <SwipeableCard
      className={`nc-card ${colourClass}${isArchived ? ' archived' : ''}`}
      enabled={!isArchived}
      onArchive={() => onArchive(session.session_id)}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={onKey}
      data-session-id={session.session_id}
    >
      <div className="nc-card-head">
        <span className="status-icon">
          <span className="glyph" aria-hidden="true"></span>
          {(session.attention_state ?? 'idle').replace('_', ' ').toUpperCase()}
        </span>
        <span className="sep">·</span>
        <span className="age">{lastInbound ? `${relAge(lastInbound)} since reply` : 'no inbound yet'}</span>
        {session.has_pending_recurrence && <span className="linear-id">⏰ scheduled</span>}
        {isArchived ? (
          <button
            type="button"
            className="nc-card-dismiss"
            aria-label="Unarchive session"
            onClick={handleUnarchive}
            title="Restore to inbox"
          >
            ↩ Unarchive
          </button>
        ) : (
          <button
            type="button"
            className="nc-card-dismiss"
            aria-label="Dismiss session"
            onClick={handleArchive}
            title="Dismiss from inbox"
          >
            ×
          </button>
        )}
      </div>
      <div className="nc-card-goal">{title}</div>
      {lastOutbound && (
        <div className="nc-card-progress">
          agent last spoke {relAge(lastOutbound)} ago
          {session.last_outbound_kind?.startsWith('chat-sdk:') ? ` (${session.last_outbound_kind.slice(9)})` : ''}
        </div>
      )}
      {isAttachedTask && (
        <div className="nc-card-pillrow">
          <span className="nc-pill">{session.attached_task_status ?? 'task'}</span>
          {session.attached_task_needs_input && <span className="nc-pill needs">needs steer</span>}
        </div>
      )}
    </SwipeableCard>
  );
}
