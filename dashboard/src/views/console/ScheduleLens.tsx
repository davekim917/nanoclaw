import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { listScheduled, type GroupSummary, type ScheduledRow } from '../../lib/api.js';
import { relAge } from '../../lib/derive.js';
import { ScheduledDrawer } from '../ScheduledDrawer.js';

/**
 * The Schedule lens — DESIGN.md §11's "Schedule is likewise a lens", built.
 *
 * This is the ONLY way into scheduled work. The standalone `#/scheduled` board
 * was retired into the legacy Observatory's floor section, and that section went
 * with the Observatory; the endpoints behind it (list, detail, edit, pause,
 * resume, run-now, cancel, move preview + execute) never went anywhere. So this
 * is a new list around an unchanged `ScheduledDrawer` — the drawer holds the
 * whole verb×state contract, including the rule that a verb button's enabled
 * state comes SOLELY from the server's `available_verbs`, and it must not be
 * forked to live here.
 */

const SCHED_KIND_LABEL: Record<string, string> = {
  recurring: 'repeating job',
  one_off: 'one-time job',
  thread_loop: 'follow-up check',
};

// Magnitude of an ms duration, bucketed the same way relAge buckets an
// elapsed-time ISO string — fed a synthesized timestamp so the two never
// drift apart on what "3h" means.
function magnitude(ms: number, now = Date.now()): string {
  return relAge(new Date(now - Math.abs(ms)).toISOString(), now);
}

/** Signed relative time ("in 5m" / "3h ago"). */
export function relTime(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  return ms >= 0 ? `in ${magnitude(ms, now)}` : `${magnitude(ms, now)} ago`;
}

/**
 * Every series on this floor, soonest fire first — with the rows that have NO
 * next fire sorted last rather than dropped.
 *
 * The legacy `upcomingScheduled` filtered those rows out, because it was a
 * "what is coming up" card capped at eight. This is the management surface: a
 * paused series has no next fire and pausing it is exactly the state an
 * operator needs to find in order to resume it. Dropping them would hide the
 * work behind the verb the lens exists to offer.
 *
 * The null term is explicit for the same reason it is explicit in the thread
 * queue's comparator: a row with no fire time has no place on a time axis, and
 * defaulting it to zero parks every undated row at one end and calls that an
 * ordering.
 */
/**
 * `agentGroupIds` is null for "every workgroup", otherwise the sibling set of
 * the selected workgroup. Scheduled rows are keyed on `agent_group_id`, so the
 * console's workgroup axis has to be expanded to its siblings to filter them —
 * a single id would have shown one sibling's jobs and hidden the other five.
 */
export function scheduleRows(rows: ScheduledRow[], agentGroupIds: ReadonlySet<string> | null): ScheduledRow[] {
  return rows
    .filter((r) => agentGroupIds === null || agentGroupIds.has(r.agent_group_id))
    .slice()
    .sort((a, b) => {
      const at = a.next_fire_utc ? Date.parse(a.next_fire_utc) : null;
      const bt = b.next_fire_utc ? Date.parse(b.next_fire_utc) : null;
      if (at === null || bt === null) return (at === null ? 1 : 0) - (bt === null ? 1 : 0);
      return at - bt;
    });
}

/**
 * "6 on this floor · next in 4m" — the lens's context line.
 *
 * The soonest fire leads, so a fire in the PAST means the sweep has not run it
 * yet. That is a fact worth saying in words rather than dressing up as "next
 * 4d ago", which reads as a typo instead of as a late job.
 */
export function scheduleSummary(rows: ScheduledRow[], now = Date.now()): string {
  const next = rows.find((r) => r.next_fire_utc);
  if (rows.length === 0) return 'nothing scheduled';
  if (!next) return `${rows.length} on this floor · none due`;
  const ms = Date.parse(next.next_fire_utc!) - now;
  const when = ms >= 0 ? `next ${relTime(next.next_fire_utc!, now)}` : `next was due ${magnitude(ms, now)} ago`;
  return `${rows.length} on this floor · ${when}`;
}

export function ScheduleLens({
  agentGroupIds,
  groups,
}: {
  agentGroupIds: ReadonlySet<string> | null;
  groups: GroupSummary[];
}) {
  const { data, error, mutate } = useSWR('/dashboard/api/scheduled', () => listScheduled(), { refreshInterval: 0 });
  const [openKey, setOpenKey] = useState<string | null>(null);

  const names = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);
  const rows = useMemo(() => scheduleRows(data?.rows ?? [], agentGroupIds), [data, agentGroupIds]);

  const failed = Boolean(error) && !data;
  // A key whose row has dropped out of the window (it fired, or was cancelled
  // from another tab) must not hold a drawer open over a series that is no
  // longer on this floor. Same stale-selection rule as the queue's channel
  // filter and the composer's addressee.
  const open = rows.some((r) => r.key === openKey) ? openKey : null;

  return (
    <section className="ncc-list-pane" aria-label="Scheduled work">
      <div className="ncc-list-head">
        <h2>Schedule</h2>
        <span className="count">{rows.length}</span>
        <span className="ncc-spacer" />
        <span className="count">{scheduleSummary(rows)}</span>
      </div>

      {failed && <div className="ncc-empty">couldn’t load scheduled work</div>}
      {!failed && data && rows.length === 0 && (
        <div className="ncc-empty">
          {agentGroupIds === null ? 'nothing scheduled' : 'nothing scheduled for this workgroup'}
        </div>
      )}

      <ul className="ncc-list ncc-sched-list">
        {rows.map((r) => (
          <li key={r.key} className="ncc-sched-row" data-sched-key={r.key}>
            <button
              type="button"
              className="ncc-sched-open"
              aria-label={`Open scheduled job ${r.series_id}`}
              onClick={() => setOpenKey(r.key)}
            >
              <span className="ncc-sched-name">
                <span className="ncc-mono">{r.series_id}</span>
                <span className="ncc-sched-who">
                  {names.get(r.agent_group_id) ?? r.agent_group_name}
                  {r.channel_name ? ` in ${r.channel_name}` : ''}
                </span>
              </span>
              {/* Monospace is for the cron expression only; a series with no
                  cron says what kind of job it is instead. */}
              {r.cron ? (
                <span className="ncc-sched-cron ncc-mono">{r.cron}</span>
              ) : (
                <span className="ncc-sched-cron">{SCHED_KIND_LABEL[r.kind] ?? 'job'}</span>
              )}
              <span className="ncc-sched-when">{r.next_fire_utc ? relTime(r.next_fire_utc) : 'not due'}</span>
            </button>
          </li>
        ))}
      </ul>

      {open && (
        <ScheduledDrawer
          rowKey={open}
          // The drawer fetches its own row, which carries the code name; the
          // persona is only known out here, so it is handed down.
          groupName={names.get(rows.find((r) => r.key === open)!.agent_group_id) ?? null}
          onClose={() => setOpenKey(null)}
          onMutated={() => void mutate()}
        />
      )}
    </section>
  );
}
