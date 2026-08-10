import { useCallback, useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import {
  listWorkgroups,
  getWorkgroupSummary,
  getWorkgroupUsage,
  getWorkgroupClaims,
  type AuthMe,
  type WorkgroupSummary,
  type WorkgroupSeriesRow,
  type WorkgroupClaim,
  type WorkgroupUsageRow,
} from '../lib/api.js';
import { renderMarkdown } from '../lib/markdown.js';
import { relAge } from '../lib/derive.js';
import { RouteNav, type BoardRoute } from './BoardShell.js';

/**
 * Read-only workgroup dashboard at `/dashboard/workgroup` (fleet-hardening
 * Phase 3). Fourth route peer of Inbox/Scheduled — same pulse-header chrome,
 * but scoped to ONE workgroup at a time rather than the fleet, via a picker
 * in the brand slot (most users have exactly one workgroup, so the picker
 * degrades to static text in that case — same affordance rule as GroupTitle).
 *
 * Four sections, all read from GET /dashboard/api/workgroup/:id/{summary,
 * usage,claims}: the release board + gate log, the workgroup's live task
 * series (read-only — no verbs, that's the Scheduled board's job), per-agent
 * daily usage, and work claims. No SSE for v1 — fetch on mount plus an
 * explicit refresh button.
 */

interface WorkgroupDashboardProps {
  authMe: AuthMe;
  route: BoardRoute;
  onRouteChange: (r: BoardRoute) => void;
}

export function WorkgroupDashboard({ route, onRouteChange }: WorkgroupDashboardProps) {
  const { data: wgData } = useSWR('/dashboard/api/workgroups', () => listWorkgroups(), { refreshInterval: 0 });
  const workgroups = wgData?.workgroups ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Default to the first workgroup once the list loads — most users have one.
  useEffect(() => {
    if (selectedId === null && workgroups.length > 0) setSelectedId(workgroups[0]!.id);
  }, [workgroups, selectedId]);

  const { data: summary, mutate: mutateSummary } = useSWR(
    selectedId ? `/dashboard/api/workgroup/${selectedId}/summary` : null,
    () => getWorkgroupSummary(selectedId!),
    { refreshInterval: 0 },
  );
  const { data: usage, mutate: mutateUsage } = useSWR(
    selectedId ? `/dashboard/api/workgroup/${selectedId}/usage` : null,
    () => getWorkgroupUsage(selectedId!),
    { refreshInterval: 0 },
  );
  const { data: claims, mutate: mutateClaims } = useSWR(
    selectedId ? `/dashboard/api/workgroup/${selectedId}/claims` : null,
    () => getWorkgroupClaims(selectedId!),
    { refreshInterval: 0 },
  );

  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([mutateSummary(), mutateUsage(), mutateClaims()]);
    } finally {
      setRefreshing(false);
    }
  }, [mutateSummary, mutateUsage, mutateClaims]);

  return (
    <div className="nc-frame">
      <header className="nc-pulse">
        <div className="nc-pulse-top">
          <div className="nc-brand">
            <span className="mark" aria-hidden="true"></span>
            <WorkgroupPicker workgroups={workgroups} selectedId={selectedId} onChange={setSelectedId} />
          </div>
          <RouteNav route={route} onRouteChange={onRouteChange} />
        </div>
        <div className="nc-pulse-meta">
          <button
            type="button"
            className="nav-link"
            onClick={() => void refresh()}
            disabled={refreshing || !selectedId}
          >
            {refreshing ? 'Refreshing…' : '↻ Refresh'}
          </button>
        </div>
      </header>

      <div className="nc-task-detail" style={{ maxWidth: 1100 }}>
        {workgroups.length === 0 && <div className="nc-empty">no workgroups visible</div>}
        {selectedId && (
          <>
            <BoardSection board={summary?.board ?? null} />
            <GatesSection gates={summary?.gates ?? []} />
            <SeriesSection series={claims?.series ?? []} />
            <UsageSection usage={usage?.usage ?? []} />
            <ClaimsSection claims={claims?.claims ?? []} />
          </>
        )}
      </div>
    </div>
  );
}

/* ─── Workgroup picker ───────────────────────────────────────────────────────
 * Same dropdown pattern as GroupTitle (trigger + menu, collapses to static
 * text for a single option) minus the "all" entry — a workgroup view always
 * shows exactly one workgroup, never a merged "all" view.
 */

function WorkgroupPicker({
  workgroups,
  selectedId,
  onChange,
}: {
  workgroups: WorkgroupSummary[];
  selectedId: string | null;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  if (workgroups.length <= 1) {
    return <span className="nc-group-title nc-group-title-static">{workgroups[0]?.name ?? 'Workgroup'}</span>;
  }

  const selectedName = workgroups.find((w) => w.id === selectedId)?.name ?? 'Workgroup';

  return (
    <div className="nc-group-title" ref={rootRef}>
      <button
        type="button"
        className="nc-group-title-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{selectedName}</span>
        <span className="nc-group-title-chev" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <ul className="nc-group-title-menu" role="listbox">
          {workgroups.map((w) => (
            <li
              key={w.id}
              role="option"
              aria-selected={selectedId === w.id}
              className={selectedId === w.id ? 'active' : ''}
              onClick={() => {
                onChange(w.id);
                setOpen(false);
              }}
            >
              {w.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ─── Release board + gate log ────────────────────────────────────────────── */

function BoardSection({ board }: { board: string | null }) {
  return (
    <div className="nc-section">
      <div className="nc-section-head open" style={{ cursor: 'default' }}>
        <span>Release board</span>
      </div>
      <div className="nc-section-body">
        {board ? (
          <div className="nc-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(board) }} />
        ) : (
          <div className="nc-empty">no release board for this workgroup</div>
        )}
      </div>
    </div>
  );
}

// Gate log entries are opaque (arbitrary per-skill JSON) — the server never
// asserts a schema beyond "one JSON object per line", so the client renders
// generically: a `ts` field (if present) drives the relative-age prefix, the
// full entry renders as compact JSON. Collapsed by default (can be long).
function GatesSection({ gates }: { gates: Record<string, unknown>[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="nc-section">
      <button
        className={'nc-section-head' + (open ? ' open' : '')}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>
          Gate log <span className="meta">· {gates.length} recent entries</span>
        </span>
        <span className="chev">›</span>
      </button>
      {open && (
        <div className="nc-section-body">
          {gates.length === 0 ? (
            <div className="nc-empty">no gate log entries</div>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {gates.map((g, i) => (
                <li
                  key={i}
                  style={{
                    border: '1px solid var(--line)',
                    borderRadius: 4,
                    padding: '6px 10px',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                  }}
                >
                  {typeof g.ts === 'string' && (
                    <div style={{ color: 'var(--fg-3)', marginBottom: 3 }}>{relAge(g.ts)} ago</div>
                  )}
                  <div style={{ wordBreak: 'break-word', color: 'var(--fg-2)' }}>{JSON.stringify(g)}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Task series (read-only projection — no verbs) ─────────────────────────── */

function SeriesSection({ series }: { series: WorkgroupSeriesRow[] }) {
  return (
    <div className="nc-section">
      <div className="nc-section-head open" style={{ cursor: 'default' }}>
        <span>
          Task series <span className="meta">· {series.length}</span>
        </span>
      </div>
      <div className="nc-section-body">
        {series.length === 0 ? (
          <div className="nc-empty">no live task series</div>
        ) : (
          <div className="nc-md">
            <table>
              <thead>
                <tr>
                  <th>Series</th>
                  <th>Agent</th>
                  <th>Cron</th>
                  <th>Health</th>
                  <th>Next fire</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {series.map((s) => (
                  <tr key={s.series_id}>
                    <td>{s.series_id}</td>
                    <td>{s.agent_group_name}</td>
                    <td>{s.cron ?? 'one-off'}</td>
                    <td>{s.health}</td>
                    <td>{s.next_fire_local ?? '—'}</td>
                    <td>{s.script_host && <span className="nc-pill">host-gated</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Per-agent daily usage ───────────────────────────────────────────────── */

function UsageSection({ usage }: { usage: WorkgroupUsageRow[] }) {
  return (
    <div className="nc-section">
      <div className="nc-section-head open" style={{ cursor: 'default' }}>
        <span>
          Usage <span className="meta">· last 14 days, most recent first</span>
        </span>
      </div>
      <div className="nc-section-body">
        {usage.length === 0 ? (
          <div className="nc-empty">no usage recorded yet</div>
        ) : (
          <div className="nc-md">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Agent</th>
                  <th>Provider</th>
                  <th>Model</th>
                  <th>Turns</th>
                  <th>In</th>
                  <th>Out</th>
                  <th>Cache R</th>
                  <th>Cache W</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((r, i) => (
                  <tr key={i}>
                    <td>{r.date}</td>
                    <td>{r.agent_group_id}</td>
                    <td>{r.provider}</td>
                    <td>{r.model || '—'}</td>
                    <td>{r.turns}</td>
                    <td>{r.input_tokens}</td>
                    <td>{r.output_tokens}</td>
                    <td>{r.cache_read_tokens}</td>
                    <td>{r.cache_write_tokens}</td>
                    <td>${r.cost_usd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Work claims ─────────────────────────────────────────────────────────── */

function ClaimsSection({ claims }: { claims: WorkgroupClaim[] }) {
  return (
    <div className="nc-section">
      <div className="nc-section-head open" style={{ cursor: 'default' }}>
        <span>
          Work claims <span className="meta">· {claims.length}</span>
        </span>
      </div>
      <div className="nc-section-body">
        {claims.length === 0 ? (
          <div className="nc-empty">no active claims</div>
        ) : (
          <div className="nc-md">
            <table>
              <thead>
                <tr>
                  <th>Slug</th>
                  <th>Owner</th>
                  <th>Age</th>
                  <th>Status</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {claims.map((c) => (
                  <tr key={c.slug}>
                    <td>{c.slug}</td>
                    <td>{c.owner ?? '—'}</td>
                    <td>{c.claimed_at ? `${relAge(c.claimed_at)} ago` : '—'}</td>
                    <td>
                      {c.escalated && <span className="nc-pill failed">escalated</span>}
                      {!c.escalated && c.stale && <span className="nc-pill needs">stale</span>}
                      {!c.stale && <span className="nc-pill">live</span>}
                    </td>
                    <td>{c.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
