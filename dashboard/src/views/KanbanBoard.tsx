import React, { useEffect, useState, useCallback } from 'react';
import useSWR from 'swr';
import { listTasks, listGroups } from '../lib/api.js';
import { subscribe, startSSE } from '../lib/sse.ts';
import {
  extractGoal,
  extractLinearId,
  extractPhase,
  heatOf,
  relAge,
  countTasks,
  streamGroups,
  type Counts,
} from '../lib/derive.js';
import { useGroupFilter, type GroupFilter } from '../lib/use-group-filter.js';
import { GroupTitle } from './GroupTitle.js';
import type { AuthMe, GroupSummary, TaskSummary } from '../lib/api.js';

interface KanbanBoardProps {
  authMe: AuthMe;
  route: 'board' | 'sessions';
  onRouteChange: (r: 'board' | 'sessions') => void;
}

type FilterId = 'all' | 'needs' | 'run' | 'done';
const MOBILE_QUERY = '(max-width: 899px)';

export const KanbanBoard: React.FC<KanbanBoardProps> = ({
  authMe,
  route,
  onRouteChange,
}) => {
  const [groupFilter, setGroupFilter] = useGroupFilter(
    authMe.user_id,
    authMe.scopes.allowed_group_ids,
    authMe.scopes.no_filter,
  );

  // SWR key includes the group filter so switching groups triggers a refetch
  // through the existing cache instead of muting+remounting.
  const tasksKey = ['/dashboard/api/tasks', groupFilter] as const;
  const { data, mutate } = useSWR(
    tasksKey,
    () => listTasks(groupFilter === 'all' ? {} : { group_id: groupFilter }),
    { refreshInterval: 0 },
  );
  const { data: groupsData } = useSWR('/dashboard/api/groups', () => listGroups(), {
    refreshInterval: 0,
  });
  const groups: GroupSummary[] = groupsData?.groups ?? [];

  const invalidate = useCallback(() => { void mutate(); }, [mutate]);
  useEffect(() => subscribe('task_event', invalidate), [invalidate]);

  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia(MOBILE_QUERY).matches
  );
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const [filter, setFilter] = useState<FilterId>('all');
  const tasks = data?.tasks ?? [];
  const counts = countTasks(tasks);

  let visible: TaskSummary[];
  if (filter === 'needs') visible = tasks.filter((t) => t.status === 'failed');
  else if (filter === 'run') visible = tasks.filter((t) => t.status === 'running');
  else if (filter === 'done') visible = tasks.filter((t) => t.status === 'completed');
  else visible = tasks;

  const lastActivityIso =
    tasks
      .map((t) => t.admitted_at)
      .sort()
      .pop() ?? new Date().toISOString();

  return isMobile ? (
    <MobileBoard
      tasks={tasks}
      visible={visible}
      counts={counts}
      filter={filter}
      onFilter={setFilter}
      route={route}
      onRouteChange={onRouteChange}
      lastActivityIso={lastActivityIso}
      groups={groups}
      groupFilter={groupFilter}
      onGroupFilter={setGroupFilter}
    />
  ) : (
    <DesktopBoard
      tasks={tasks}
      counts={counts}
      route={route}
      onRouteChange={onRouteChange}
      lastActivityIso={lastActivityIso}
      groups={groups}
      groupFilter={groupFilter}
      onGroupFilter={setGroupFilter}
    />
  );
};

export { startSSE };

/* ─── Shared building blocks ─── */

function PulseHeader({
  counts,
  lastActivityIso,
  route,
  onRouteChange,
  groups,
  groupFilter,
  onGroupFilter,
}: {
  counts: Counts;
  lastActivityIso: string;
  route: 'board' | 'sessions';
  onRouteChange: (r: 'board' | 'sessions') => void;
  groups: GroupSummary[];
  groupFilter: GroupFilter;
  onGroupFilter: (next: GroupFilter) => void;
}) {
  return (
    <header className="nc-pulse">
      <div className="nc-pulse-top">
        <div className="nc-brand">
          <span className="mark" aria-hidden="true"></span>
          <GroupTitle
            groups={groups}
            selectedId={groupFilter}
            onChange={onGroupFilter}
            fallback="Agent Board"
          />
        </div>
        <nav className="nc-pulse-actions">
          <button
            className={`nav-link ${route === 'board' ? 'active' : ''}`}
            onClick={() => onRouteChange('board')}
          >
            Board
          </button>
          <button
            className={`nav-link ${route === 'sessions' ? 'active' : ''}`}
            onClick={() => onRouteChange('sessions')}
          >
            Sessions
          </button>
        </nav>
      </div>
      <div className="nc-pulse-grid">
        <div className="nc-pulse-bigcount">
          <span>{counts.total}</span>
          <span className="lbl">
            tasks
            <br />
            live
          </span>
        </div>
        <div className="nc-pulse-breakdown">
          <BreakdownCell n={counts.failed} label="Failed" tone="failed" />
          <BreakdownCell n={counts.needs} label="Needs you" tone="needs" />
          <BreakdownCell n={counts.running} label="Running" tone="running" />
          <BreakdownCell n={counts.done} label="Done" tone="done" />
        </div>
      </div>
      <div className="nc-pulse-meta">
        <span>
          <span className="dot" aria-hidden="true"></span>
          LIVE · last event {relAge(lastActivityIso)} ago
        </span>
        <span>{counts.pending} queued</span>
      </div>
    </header>
  );
}

function BreakdownCell({
  n,
  label,
  tone,
}: {
  n: number;
  label: string;
  tone: 'failed' | 'needs' | 'running' | 'done';
}) {
  return (
    <div className={`nc-pulse-cell ${tone}`}>
      <span className="n">{n}</span>
      <span className="lbl">{label}</span>
    </div>
  );
}

function FilterChips({
  value,
  onChange,
  counts,
}: {
  value: FilterId;
  onChange: (v: FilterId) => void;
  counts: Counts;
}) {
  const chips: { id: FilterId; label: string; count: number; attn: boolean }[] = [
    { id: 'all', label: 'All', count: counts.total, attn: false },
    {
      id: 'needs',
      label: 'Needs me',
      count: counts.failed + counts.needs,
      attn: true,
    },
    { id: 'run', label: 'Running', count: counts.running, attn: false },
    { id: 'done', label: 'Done', count: counts.done, attn: false },
  ];
  return (
    <div className="nc-chips" role="tablist" aria-label="Task filter">
      {chips.map((c) => {
        const active = value === c.id;
        return (
          <button
            key={c.id}
            role="tab"
            aria-selected={active}
            className={
              'nc-chip' + (active ? ' active' : '') + (c.attn ? ' attn' : '')
            }
            onClick={() => onChange(c.id)}
          >
            {c.label} <span className="count">{c.count}</span>
          </button>
        );
      })}
    </div>
  );
}

function StatusGlyph({
  status,
  needsInput,
}: {
  status: TaskSummary['status'];
  needsInput?: boolean;
}) {
  if (needsInput) {
    return (
      <span className="status-icon">
        <span className="glyph" aria-hidden="true"></span>
        NEEDS YOU
      </span>
    );
  }
  const label: Record<TaskSummary['status'], string> = {
    failed: 'FAILED',
    running: 'RUNNING',
    pending: 'PENDING',
    completed: 'DONE',
    cancelled: 'CANCELLED',
  };
  return (
    <span className="status-icon">
      <span className="glyph" aria-hidden="true"></span>
      {label[status]}
    </span>
  );
}

function TaskCard({ task }: { task: TaskSummary }) {
  const goal = extractGoal(task.task_content);
  const linearId = extractLinearId(task.task_content);
  const phase = extractPhase(task.last_progress_message);
  const needsInput = !!task.needs_input;
  const heat = heatOf({
    status: task.status,
    admitted_at: task.admitted_at,
    needs_input: task.needs_input,
  });
  const colourClass = needsInput ? 'needs' : task.status;

  const onClick = () => {
    location.hash = `#/task/${task.task_id}`;
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <div
      className={`nc-card ${colourClass} heat-${heat}`}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={onKey}
      data-task-id={task.task_id}
    >
      <div className="nc-card-head">
        <StatusGlyph status={task.status} needsInput={needsInput} />
        <span className="sep">·</span>
        <span className="age">{relAge(task.admitted_at)} ago</span>
        {linearId && <span className="linear-id">{linearId}</span>}
      </div>
      <div className="nc-card-goal">{goal}</div>
      {task.status === 'running' && !needsInput && phase !== null && (
        <div className="nc-phasebar" aria-hidden="true">
          {[1, 2, 3, 4, 5].map((p) => (
            <div
              key={p}
              className={
                'seg ' +
                (p < phase ? 'done' : p === phase ? 'active' : '')
              }
            ></div>
          ))}
        </div>
      )}
      {needsInput && task.steer_question && (
        <div className="nc-card-progress">{task.steer_question}</div>
      )}
      {!needsInput && task.last_progress_message && (
        <div className="nc-card-progress">{task.last_progress_message}</div>
      )}
      {(task.fail_reason || needsInput) && (
        <div className="nc-card-pillrow">
          {task.fail_reason && <span className="nc-pill failed">{task.fail_reason}</span>}
          {needsInput && <span className="nc-pill needs">steer requested</span>}
        </div>
      )}
    </div>
  );
}

/* ─── Mobile ─── */

function MobileBoard({
  tasks,
  visible,
  counts,
  filter,
  onFilter,
  route,
  onRouteChange,
  lastActivityIso,
  groups,
  groupFilter,
  onGroupFilter,
}: {
  tasks: TaskSummary[];
  visible: TaskSummary[];
  counts: Counts;
  filter: FilterId;
  onFilter: (v: FilterId) => void;
  route: 'board' | 'sessions';
  onRouteChange: (r: 'board' | 'sessions') => void;
  lastActivityIso: string;
  groups: GroupSummary[];
  groupFilter: GroupFilter;
  onGroupFilter: (next: GroupFilter) => void;
}) {
  const g = streamGroups(visible);
  const [foldOpen, setFoldOpen] = useState(false);
  const doneVisible = foldOpen ? g.done : g.done.slice(0, 2);
  const coldVisible = foldOpen ? g.cold : [];
  const moreCount = g.done.length - doneVisible.length + (foldOpen ? 0 : g.cold.length);

  return (
    <div className="nc-frame nc-mobile">
      <PulseHeader
        counts={counts}
        lastActivityIso={lastActivityIso}
        route={route}
        onRouteChange={onRouteChange}
        groups={groups}
        groupFilter={groupFilter}
        onGroupFilter={onGroupFilter}
      />
      <FilterChips value={filter} onChange={onFilter} counts={counts} />

      <div className="nc-stream">
        {filter === 'all' && (
          <>
            <Section title="Needs you" tasks={g.needsMe} hideWhenEmpty />
            <Section title="Working" tasks={g.running} hideWhenEmpty />
            <Section title="Queued" tasks={g.pending} hideWhenEmpty />
            {g.done.length > 0 && (
              <>
                <SectionLabel title="Done · last 24h" count={g.done.length} />
                {doneVisible.map((t) => (
                  <TaskCard key={t.task_id} task={t} />
                ))}
                {coldVisible.map((t) => (
                  <TaskCard key={t.task_id} task={t} />
                ))}
                {moreCount > 0 && (
                  <button
                    className="nc-fold"
                    onClick={() => setFoldOpen((v) => !v)}
                  >
                    {foldOpen ? 'collapse' : `+ ${moreCount} older · expand`}
                  </button>
                )}
              </>
            )}
            {tasks.length === 0 && (
              <div className="nc-empty">no tasks yet · spawn one from chat</div>
            )}
          </>
        )}

        {filter !== 'all' && visible.length > 0 &&
          visible.map((t) => <TaskCard key={t.task_id} task={t} />)}

        {filter !== 'all' && visible.length === 0 && (
          <div className="nc-empty">no tasks match this filter</div>
        )}

        {filter === 'needs' && visible.length > 0 && (
          <div className="nc-empty" style={{ marginTop: 14 }}>
            {visible.length} item{visible.length === 1 ? '' : 's'} need attention ·{' '}
            {counts.running} running silently
          </div>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  tasks,
  hideWhenEmpty,
}: {
  title: string;
  tasks: TaskSummary[];
  hideWhenEmpty?: boolean;
}) {
  if (hideWhenEmpty && tasks.length === 0) return null;
  return (
    <>
      <SectionLabel title={title} count={tasks.length} />
      {tasks.map((t) => (
        <TaskCard key={t.task_id} task={t} />
      ))}
    </>
  );
}

function SectionLabel({ title, count }: { title: string; count: number }) {
  return (
    <div className="nc-section-label">
      <span>{title}</span>
      <div className="rule" aria-hidden="true"></div>
      <span className="cnt">{count}</span>
    </div>
  );
}

/* ─── Desktop ─── */

function DesktopBoard({
  tasks,
  counts,
  route,
  onRouteChange,
  lastActivityIso,
  groups,
  groupFilter,
  onGroupFilter,
}: {
  tasks: TaskSummary[];
  counts: Counts;
  route: 'board' | 'sessions';
  onRouteChange: (r: 'board' | 'sessions') => void;
  lastActivityIso: string;
  groups: GroupSummary[];
  groupFilter: GroupFilter;
  onGroupFilter: (next: GroupFilter) => void;
}) {
  const needsMe = tasks.filter((t) => t.status === 'failed');
  const working = tasks.filter((t) => t.status === 'running');
  const pending = tasks.filter((t) => t.status === 'pending');
  const done = tasks.filter((t) => t.status === 'completed');
  const cancelled = tasks.filter((t) => t.status === 'cancelled');

  const [pendingOpen, setPendingOpen] = useState(false);
  const [cancelledOpen, setCancelledOpen] = useState(false);

  return (
    <div className="nc-frame nc-desktop">
      <div className="nc-desktop-top">
        <div className="nc-desktop-pulse">
          <div className="nc-brand">
            <span className="mark" aria-hidden="true"></span>
            <GroupTitle
              groups={groups}
              selectedId={groupFilter}
              onChange={onGroupFilter}
              fallback="Agent Board"
            />
          </div>
          <div className="bigcount">
            <span>{counts.total}</span>
            <span className="lbl">
              tasks live
              <br />
              {relAge(lastActivityIso)} since last event
            </span>
          </div>
          <div className="row2">
            <DesktopBreadcell n={counts.failed} label="Failed" tone="failed" />
            <DesktopBreadcell n={counts.needs} label="Needs you" tone="needs" />
            <DesktopBreadcell n={counts.running} label="Running" tone="running" />
            <DesktopBreadcell n={counts.done} label="Done" tone="done" />
          </div>
          <div className="nc-pulse-meta" style={{ marginTop: 18 }}>
            <span>
              <span className="dot" aria-hidden="true"></span>
              LIVE · last event {relAge(lastActivityIso)} ago
            </span>
            <span>
              {pending.length} queued · {cancelled.length} cancelled
            </span>
          </div>
        </div>
        <div>
          <div className="nc-desktop-toolbar">
            <div style={{ display: 'flex', alignItems: 'baseline' }}>
              <h1>Spawn Board</h1>
              <span className="sub">/dashboard/board</span>
            </div>
            <div className="right">
              <button
                className={`nc-btn ghost ${route === 'sessions' ? '' : ''}`}
                onClick={() => onRouteChange('sessions')}
              >
                Sessions
              </button>
            </div>
          </div>
          <div className="nc-desktop-summary">
            Orchestrator fanned out <strong>{tasks.length} children</strong>.{' '}
            <span className="c-fail">{counts.failed} failed</span> ·{' '}
            <span className="c-need">{counts.needs} awaiting your steer</span> ·{' '}
            <span className="c-run">{counts.running} actively working</span> ·{' '}
            <span className="c-done">{counts.done} shipped in last 24h</span>.
          </div>
        </div>
      </div>

      <div className="nc-desktop-body">
        <div className="nc-col">
          <div className="nc-col-head attention">
            <div className="ttl">
              <span className="swatch" aria-hidden="true"></span>Needs you
              <span className="cnt">{needsMe.length}</span>
            </div>
            <span className="hint">↑ act first</span>
          </div>
          <div className="nc-col-body">
            {needsMe.length === 0 && (
              <div className="nc-empty" style={{ margin: 0 }}>
                nothing needs you · 🎉
              </div>
            )}
            {needsMe.map((t) => (
              <TaskCard key={t.task_id} task={t} />
            ))}
          </div>
        </div>

        <div className="nc-col">
          <div className="nc-col-head working">
            <div className="ttl">
              <span className="swatch" aria-hidden="true"></span>Working
              <span className="cnt">{working.length}</span>
            </div>
            <span className="hint">auto · live</span>
          </div>
          <div className="nc-col-body">
            {working.length === 0 && pending.length === 0 && (
              <div className="nc-empty" style={{ margin: 0 }}>
                no active workers
              </div>
            )}
            {working.map((t) => (
              <TaskCard key={t.task_id} task={t} />
            ))}
            {pending.length > 0 && (
              <>
                {pendingOpen && pending.map((t) => (
                  <TaskCard key={t.task_id} task={t} />
                ))}
                <button
                  className="nc-fold"
                  onClick={() => setPendingOpen((v) => !v)}
                >
                  {pendingOpen ? 'collapse queued' : `+ ${pending.length} queued · expand`}
                </button>
              </>
            )}
          </div>
        </div>

        <div className="nc-col">
          <div className="nc-col-head done">
            <div className="ttl">
              <span className="swatch" aria-hidden="true"></span>Done
              <span className="cnt">{done.length}</span>
            </div>
            <span className="hint">last 24h</span>
          </div>
          <div className="nc-col-body">
            {done.length === 0 && cancelled.length === 0 && (
              <div className="nc-empty" style={{ margin: 0 }}>
                no completed tasks yet
              </div>
            )}
            {done.map((t) => (
              <TaskCard key={t.task_id} task={t} />
            ))}
            {cancelled.length > 0 && (
              <>
                {cancelledOpen && cancelled.map((t) => (
                  <TaskCard key={t.task_id} task={t} />
                ))}
                <button
                  className="nc-fold"
                  onClick={() => setCancelledOpen((v) => !v)}
                >
                  {cancelledOpen ? 'collapse cancelled' : `+ ${cancelled.length} cancelled · expand`}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DesktopBreadcell({
  n,
  label,
  tone,
}: {
  n: number;
  label: string;
  tone: 'failed' | 'needs' | 'running' | 'done';
}) {
  return (
    <div className={`breadcell ${tone}`}>
      <span className="n">{n}</span>
      <span className="lbl">{label}</span>
    </div>
  );
}
