import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import {
  listGroups,
  listScheduled,
  searchScheduled,
  type AuthMe,
  type GroupSummary,
  type HealthState,
  type ScheduledRow,
  type ScheduledSnapshot,
} from '../lib/api.js';
import { subscribe } from '../lib/sse.ts';
import { useGroupFilter } from '../lib/use-group-filter.js';
import { BoardBrand, BoardFrame, RouteNav, useIsMobile, type BoardRoute } from './BoardShell.js';
import { ScheduledDrawer } from './ScheduledDrawer.js';

/**
 * Operator scheduled-tasks board at `/dashboard/scheduled`. Third route peer
 * of the Kanban Board and the Inbox — same `<BoardShell>` chrome, different
 * stream. Where the inbox buckets sessions by attention-state, this view
 * surfaces every recurring/scheduled series fleet-wide with a SERVER-DERIVED
 * health verdict, so a die-off (the May/June incident class this feature
 * exists to catch) is the first thing on screen, never row 28.
 *
 * Data source: GET /dashboard/api/scheduled (assembled read-only from each
 * authorized session DB; design §3a/§4.1). The handler computes `health` and
 * `available_verbs` per series — the SPA NEVER re-derives either. Health
 * drives the sort and the pill palette; available_verbs drives the drawer's
 * buttons. Re-deriving them client-side is the cycle-2 failure mode the
 * single-source rule forbids.
 *
 * Push channel: subscribes to `session_event` (shared with the inbox). Any
 * mutation handler emits one, with a 300ms trailing debounce so an
 * outbound-status burst collapses to a single refetch. A 45s refreshInterval
 * is the S3 backstop in case an SSE frame is dropped.
 */

interface ScheduledBoardProps {
  authMe: AuthMe;
  route: BoardRoute;
  onRouteChange: (r: BoardRoute) => void;
}

/**
 * Health-state display order. Unhealthy first — the entire reason for the
 * board (design §3c). `stalled`/`strand` (dead) lead, then `unknown` (we
 * can't tell — an observability failure that must not hide behind "healthy"),
 * then `late`, then the operational states, then `healthy` last.
 */
const HEALTH_ORDER: HealthState[] = [
  'stalled',
  'strand',
  'unknown',
  'late',
  'processing',
  'paused',
  'healthy',
];

const HEALTH_RANK: Record<HealthState, number> = HEALTH_ORDER.reduce(
  (acc, h, i) => {
    acc[h] = i;
    return acc;
  },
  {} as Record<HealthState, number>,
);

/** A row whose health is in this set is "unhealthy" — surfaced in the strip's inline list. */
const UNHEALTHY: ReadonlySet<HealthState> = new Set<HealthState>(['stalled', 'strand']);

const HEALTH_LABEL: Record<HealthState, string> = {
  healthy: 'Healthy',
  late: 'Late',
  stalled: 'Stalled',
  paused: 'Paused',
  processing: 'Running',
  unknown: 'Unknown',
  strand: 'Stranded',
};

/**
 * The summary strip's cells, in scan order. `unreadable` and `one_off` are
 * snapshot-level counts (not per-row health), so they read straight off
 * `counts` rather than being tallied from rows. `unknown` and `unreadable`
 * are kept DISTINCT (S14) — an observability failure (unreadable session DB)
 * is a different signal from a claim-state-unknowable row.
 */
const STRIP_CELLS: Array<{ key: HealthState | 'unreadable' | 'one_off'; label: string; tone: string }> = [
  { key: 'stalled', label: 'Stalled', tone: 'stalled' },
  { key: 'late', label: 'Late', tone: 'late' },
  { key: 'unknown', label: 'Unknown', tone: 'unknown' },
  { key: 'unreadable', label: 'Unreadable', tone: 'unreadable' },
  { key: 'paused', label: 'Paused', tone: 'paused' },
  { key: 'healthy', label: 'Healthy', tone: 'healthy' },
  { key: 'one_off', label: 'One-off', tone: 'oneoff' },
];

type OwnershipFilter = 'all' | 'operator' | 'module';
type HealthFilter = 'all' | HealthState;

export const ScheduledBoard: React.FC<ScheduledBoardProps> = ({ authMe, route, onRouteChange }) => {
  const [groupFilter, setGroupFilter] = useGroupFilter(
    authMe.user_id,
    authMe.scopes.allowed_group_ids,
    authMe.scopes.no_filter,
  );
  const [ownership, setOwnership] = useState<OwnershipFilter>('all');
  const [healthFilter, setHealthFilter] = useState<HealthFilter>('all');
  const [search, setSearch] = useState('');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const isMobile = useIsMobile();

  const scheduledKey = ['/dashboard/api/scheduled', groupFilter] as const;
  const { data, mutate } = useSWR<ScheduledSnapshot>(
    scheduledKey,
    () => listScheduled(groupFilter === 'all' ? {} : { group_id: groupFilter }),
    // 45s S3 backstop: SSE is the primary channel, this only covers a dropped frame.
    { refreshInterval: 45_000, dedupingInterval: 500 },
  );
  const { data: groupsData } = useSWR('/dashboard/api/groups', () => listGroups(), { refreshInterval: 0 });
  const groups: GroupSummary[] = groupsData?.groups ?? [];

  // Prompt/title search is SERVER-side: prompt/script aren't on the lean list
  // row, so the client can't substring-match them. Debounce the query feeding
  // the fetch (no request per keystroke); the instant on-row haystack in
  // filterRows still covers name/group/channel/cron with zero latency while
  // prompt/script matches stream in here as a set of keys (prompt text itself
  // never reaches the SPA). null key (empty query) means no request at all.
  const [searchDebounced, setSearchDebounced] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setSearchDebounced(search.trim()), 250);
    return () => window.clearTimeout(id);
  }, [search]);
  const searchSwrKey = searchDebounced
    ? (['/dashboard/api/scheduled/search', searchDebounced, groupFilter] as const)
    : null;
  const { data: searchData } = useSWR(
    searchSwrKey,
    () => searchScheduled(searchDebounced, groupFilter === 'all' ? {} : { group_id: groupFilter }),
    { dedupingInterval: 250, keepPreviousData: true },
  );
  const promptMatchKeys = useMemo(() => new Set(searchData?.keys ?? []), [searchData]);

  // Trailing-edge debounce, identical rationale to InboxBoard: a status burst
  // emits many session_event frames; one refetch at 300ms is enough.
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

  const snapshot = data;
  const rows: ScheduledRow[] = snapshot?.rows ?? [];
  const counts = snapshot?.counts ?? {};
  const degraded = snapshot?.degraded ?? false;

  // Client-side filtering of the already-fetched snapshot (E3). Pure — never
  // re-derives health; only reads the server-computed `health`/`module_owner`.
  const filtered = useMemo(
    () => filterRows(rows, { ownership, health: healthFilter, search, promptMatchKeys }),
    [rows, ownership, healthFilter, search, promptMatchKeys],
  );

  // Unhealthy-first ordering (E1 ASSERT): sort by health rank, then group, then
  // next fire so a die-off leads the list regardless of insertion order.
  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const hr = (HEALTH_RANK[a.health] ?? 99) - (HEALTH_RANK[b.health] ?? 99);
      if (hr !== 0) return hr;
      if (a.agent_group_name !== b.agent_group_name) {
        return a.agent_group_name.localeCompare(b.agent_group_name);
      }
      return (a.next_fire_utc ?? '').localeCompare(b.next_fire_utc ?? '');
    });
  }, [filtered]);

  // Stalled/stranded rows enumerated inline at the top, always first (§3c).
  // These come from the full (unfiltered) row set so a hidden die-off can't be
  // filtered out of view.
  const stalledInline = useMemo(() => rows.filter((r) => UNHEALTHY.has(r.health)), [rows]);

  // Group the sorted rows by agent group, preserving the unhealthy-first order
  // of first appearance so the most-broken group's section leads.
  const sections = useMemo(() => groupByAgentGroup(sorted), [sorted]);

  const openRow = useMemo(() => rows.find((r) => r.key === openKey) ?? null, [rows, openKey]);

  return (
    <BoardFrame isMobile={isMobile}>
      <ScheduledHeader
        counts={counts}
        degraded={degraded}
        stalledInline={stalledInline}
        route={route}
        onRouteChange={onRouteChange}
        groups={groups}
        groupFilter={groupFilter}
        onGroupFilter={setGroupFilter}
        ownership={ownership}
        onOwnership={setOwnership}
        healthFilter={healthFilter}
        onHealthFilter={setHealthFilter}
        search={search}
        onSearch={setSearch}
        onOpen={setOpenKey}
      />

      <div className="nc-sched-body">
        {sections.length === 0 && <div className="nc-empty">no scheduled series</div>}
        {sections.map((section) => (
          <GroupSection key={section.agentGroupId} section={section} onOpen={setOpenKey} />
        ))}
      </div>

      {openRow && (
        <ScheduledDrawer rowKey={openRow.key} onClose={() => setOpenKey(null)} onMutated={() => void mutate()} />
      )}
    </BoardFrame>
  );
};

/**
 * Pure filter — operates only on server-provided fields. `health` and
 * `module_owner` are read, never recomputed (single-source rule).
 */
export function filterRows(
  rows: ScheduledRow[],
  filters: {
    ownership: OwnershipFilter;
    health: HealthFilter;
    search: string;
    /**
     * Keys the server matched on prompt/script (and metadata) for the current
     * query. A row passes search if it matches the INSTANT on-row haystack OR is
     * in this set — so name/group/channel/cron filter with zero latency while
     * prompt/script matches (which the lean row can't carry) union in from the
     * server. Undefined/empty before the debounced search resolves → graceful
     * degradation to on-row matching only. During typing this set may briefly
     * reflect the PREVIOUS query (250ms debounce + keepPreviousData), so a
     * prompt-only match for the prior query can show for ~one round-trip until
     * the current query resolves — bounded over-inclusion, never a leak (keys
     * only, never prompt text).
     */
    promptMatchKeys?: Set<string>;
  },
): ScheduledRow[] {
  const q = filters.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (filters.ownership === 'module' && r.module_owner == null) return false;
    if (filters.ownership === 'operator' && r.module_owner != null) return false;
    if (filters.health !== 'all' && r.health !== filters.health) return false;
    if (q) {
      const hay = [r.series_id, r.agent_group_name, r.channel_name ?? '', r.cron ?? '']
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q) && !filters.promptMatchKeys?.has(r.key)) return false;
    }
    return true;
  });
}

interface Section {
  agentGroupId: string;
  agentGroupName: string;
  rows: ScheduledRow[];
}

function groupByAgentGroup(rows: ScheduledRow[]): Section[] {
  const order: string[] = [];
  const map = new Map<string, Section>();
  for (const r of rows) {
    let section = map.get(r.agent_group_id);
    if (!section) {
      section = { agentGroupId: r.agent_group_id, agentGroupName: r.agent_group_name, rows: [] };
      map.set(r.agent_group_id, section);
      order.push(r.agent_group_id);
    }
    section.rows.push(r);
  }
  return order.map((id) => map.get(id)!);
}

/* ─── Header: brand + nav + health strip + toolbar ─── */

function ScheduledHeader({
  counts,
  degraded,
  stalledInline,
  route,
  onRouteChange,
  groups,
  groupFilter,
  onGroupFilter,
  ownership,
  onOwnership,
  healthFilter,
  onHealthFilter,
  search,
  onSearch,
  onOpen,
}: {
  counts: ScheduledSnapshot['counts'];
  degraded: boolean;
  stalledInline: ScheduledRow[];
  route: BoardRoute;
  onRouteChange: (r: BoardRoute) => void;
  groups: GroupSummary[];
  groupFilter: string;
  onGroupFilter: (g: string) => void;
  ownership: OwnershipFilter;
  onOwnership: (o: OwnershipFilter) => void;
  healthFilter: HealthFilter;
  onHealthFilter: (h: HealthFilter) => void;
  search: string;
  onSearch: (s: string) => void;
  onOpen: (key: string) => void;
}) {
  return (
    <div className="nc-sched-top">
      <div className="nc-sched-headerrow">
        <BoardBrand groups={groups} groupFilter={groupFilter} onGroupFilter={onGroupFilter} fallback="Scheduled" />
        <RouteNav route={route} onRouteChange={onRouteChange} />
      </div>

      <div className="nc-sched-strip" role="group" aria-label="Health summary">
        {STRIP_CELLS.map((cell) => (
          <div className={`nc-sched-pill ${cell.tone}`} key={cell.key}>
            <span className="n">{counts[cell.key] ?? 0}</span>
            <span className="lbl">{cell.label}</span>
          </div>
        ))}
        {degraded && (
          <div className="nc-sched-degraded" title="Snapshot assembly exceeded its budget — data may be stale">
            <span className="dot" aria-hidden="true"></span>
            degraded
          </div>
        )}
      </div>

      {stalledInline.length > 0 && (
        <div className="nc-sched-stalled-inline" role="alert">
          <span className="hdr">⚠ {stalledInline.length} stalled</span>
          <ul>
            {stalledInline.map((r) => (
              <li key={r.key}>
                <button
                  type="button"
                  className="nc-sched-stalled-link"
                  onClick={() => onOpen(r.key)}
                >
                  <span className="nm">{r.series_id}</span>
                  <span className="grp">{r.agent_group_name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="nc-sched-toolbar">
        <select
          className="nc-sched-ownership"
          aria-label="Ownership filter"
          value={ownership}
          onChange={(e) => onOwnership(e.target.value as OwnershipFilter)}
        >
          <option value="all">All owners</option>
          <option value="operator">Operator</option>
          <option value="module">Module-owned</option>
        </select>
        <select
          className="nc-sched-health"
          aria-label="Health filter"
          value={healthFilter}
          onChange={(e) => onHealthFilter(e.target.value as HealthFilter)}
        >
          <option value="all">All health</option>
          {HEALTH_ORDER.map((h) => (
            <option value={h} key={h}>
              {HEALTH_LABEL[h]}
            </option>
          ))}
        </select>
        <input
          className="nc-sched-search"
          type="search"
          placeholder="Search name, group, channel, cron, prompt…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          aria-label="Search scheduled series"
        />
      </div>
    </div>
  );
}

/* ─── Group section (collapsible) ─── */

function GroupSection({ section, onOpen }: { section: Section; onOpen: (key: string) => void }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className="nc-sched-section">
      <button
        type="button"
        className="nc-sched-section-head"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((v) => !v)}
      >
        <span className="chev" aria-hidden="true">
          {collapsed ? '▸' : '▾'}
        </span>
        <span className="nm">{section.agentGroupName}</span>
        <span className="cnt">{section.rows.length}</span>
      </button>
      {!collapsed && (
        <div className="nc-sched-section-body">
          {section.rows.map((r) => (
            <ScheduledRowItem key={r.key} row={r} onOpen={onOpen} />
          ))}
        </div>
      )}
    </section>
  );
}

/* ─── A single series row ─── */

function ScheduledRowItem({ row, onOpen }: { row: ScheduledRow; onOpen: (key: string) => void }) {
  const onClick = () => onOpen(row.key);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };
  // Health pill tone is the server-derived `health` verbatim — the palette
  // class is the only thing the SPA chooses, never the state itself.
  return (
    <div
      className={`nc-sched-row health-${row.health}`}
      data-series-id={row.series_id}
      data-row-key={row.key}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={onKey}
    >
      <div className="nc-sched-row-main">
        <span className={`nc-sched-healthpill ${row.health}`}>{HEALTH_LABEL[row.health]}</span>
        <span className="nc-sched-name">{row.series_id}</span>
        {row.module_owner != null && (
          <span className="nc-sched-badge module" title={`Owned by the ${row.module_owner} module`}>
            ⚙ {row.module_owner}
          </span>
        )}
        {row.kind === 'thread_loop' && (
          <span className="nc-sched-badge thread" title="Thread-bound loop — move disabled">
            ⛓ thread
          </span>
        )}
        {row.kind === 'one_off' && <span className="nc-sched-badge oneoff">one-off</span>}
        {row.quiet_status && <span className="nc-sched-badge quiet">quiet</span>}
      </div>
      <div className="nc-sched-row-meta">
        <span className="chan">
          {row.channel_name ?? '—'}
          {row.thread_id ? ` · ${row.thread_id}` : ''}
        </span>
        <span className="cron">{row.cron ?? '—'}</span>
        <span className="fire">
          next:&nbsp;
          <span className="utc">{row.next_fire_utc ?? '—'}</span>
          {row.next_fire_local && <span className="local"> ({row.next_fire_local})</span>}
        </span>
        {row.last_fires[0] && <span className="last">last: {row.last_fires[0].outcome}</span>}
      </div>
    </div>
  );
}
