import React, { useEffect, useState, useCallback, useMemo } from 'react';
import useSWR from 'swr';
import { listTasks, listGroups, archiveTask, unarchiveTask, bulkArchive } from '../lib/api.js';
import { subscribe, startSSE } from '../lib/sse.ts';
import {
  extractGoal,
  extractLinearId,
  heatOf,
  relAge,
  countTasks,
  streamGroups,
  type Counts,
} from '../lib/derive.js';
import { useGroupFilter, type GroupFilter } from '../lib/use-group-filter.js';
import {
  BoardBrand,
  BoardFrame,
  RouteNav,
  ShowArchivedToggle as ShellShowArchivedToggle,
  useIsMobile,
  type BoardRoute,
} from './BoardShell.js';
import { SwipeableCard } from './SwipeableCard.js';
import type { AuthMe, GroupSummary, TaskSummary } from '../lib/api.js';

interface KanbanBoardProps {
  authMe: AuthMe;
  route: BoardRoute;
  onRouteChange: (r: BoardRoute) => void;
}

type FilterId = 'all' | 'needs' | 'run' | 'done';

interface BoardActions {
  onArchive: (taskId: string) => void;
  onUnarchive: (taskId: string) => void;
  onBulkClearFailed: () => void;
  showArchived: boolean;
  setShowArchived: (v: boolean) => void;
  // Bulk endpoint requires a concrete group_id — the button hides when the
  // operator is looking across all visible groups.
  canBulkClearFailed: boolean;
}

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
  const [showArchived, setShowArchived] = useState(false);

  // SWR key includes the group filter + archive toggle so toggling either
  // triggers a refetch through the existing cache instead of muting+remounting.
  const tasksKey = ['/dashboard/api/tasks', groupFilter, showArchived] as const;
  const { data, mutate } = useSWR(
    tasksKey,
    () =>
      listTasks({
        ...(groupFilter === 'all' ? {} : { group_id: groupFilter }),
        ...(showArchived ? { include_archived: true } : {}),
      }),
    // dedupingInterval caps refetch storm from rapid SSE bursts (e.g.,
    // dismissing 5 cards in 2 seconds emits 5 task_events → 1 refetch).
    { refreshInterval: 0, dedupingInterval: 500 },
  );
  const { data: groupsData } = useSWR('/dashboard/api/groups', () => listGroups(), {
    refreshInterval: 0,
  });
  const groups: GroupSummary[] = groupsData?.groups ?? [];

  const invalidate = useCallback(() => { void mutate(); }, [mutate]);
  useEffect(() => subscribe('task_event', invalidate), [invalidate]);

  const onArchive = useCallback(
    async (taskId: string) => {
      try {
        await archiveTask(taskId);
      } catch {
        // soft failure — next refetch will reconcile, no toast lib in tree yet
      } finally {
        void mutate();
      }
    },
    [mutate],
  );
  const onUnarchive = useCallback(
    async (taskId: string) => {
      try {
        await unarchiveTask(taskId);
      } catch {
        // ignore
      } finally {
        void mutate();
      }
    },
    [mutate],
  );
  const onBulkClearFailed = useCallback(async () => {
    if (groupFilter === 'all') return;
    const ok = window.confirm('Archive every failed task in this group?');
    if (!ok) return;
    try {
      await bulkArchive('failed', groupFilter);
    } catch {
      // ignore
    } finally {
      void mutate();
    }
  }, [groupFilter, mutate]);

  const isMobile = useIsMobile();

  const [filter, setFilter] = useState<FilterId>('all');
  const tasks = data?.tasks ?? [];
  // Counts represent actionable work — archived cards are excluded even
  // when `showArchived` is on, so the pulse breakdown ("11 Failed") matches
  // the rebuilt state after a bulk dismiss. Rendered card lists still use
  // the raw `tasks` array so archived cards remain visible when toggled on.
  const activeTasks = tasks.filter((t) => t.archived_at == null);
  const counts = countTasks(activeTasks);

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

  // counts.failed is now the actionable-failed count (archived excluded);
  // the bulk-clear button reads it directly. Alias kept for clarity at
  // the callsite that drives "Clear failed (N)".
  const failedActionableCount = counts.failed;

  // Memoize so future `React.memo`-wrapped descendants don't churn on
  // identity alone — callbacks are already stable via useCallback.
  const boardActions: BoardActions = useMemo(
    () => ({
      onArchive,
      onUnarchive,
      onBulkClearFailed,
      showArchived,
      setShowArchived,
      canBulkClearFailed: groupFilter !== 'all',
    }),
    [onArchive, onUnarchive, onBulkClearFailed, showArchived, groupFilter],
  );

  return isMobile ? (
    <MobileBoard
      tasks={tasks}
      visible={visible}
      counts={counts}
      failedActionableCount={failedActionableCount}
      filter={filter}
      onFilter={setFilter}
      route={route}
      onRouteChange={onRouteChange}
      lastActivityIso={lastActivityIso}
      groups={groups}
      groupFilter={groupFilter}
      onGroupFilter={setGroupFilter}
      actions={boardActions}
    />
  ) : (
    <DesktopBoard
      tasks={tasks}
      counts={counts}
      failedActionableCount={failedActionableCount}
      route={route}
      onRouteChange={onRouteChange}
      lastActivityIso={lastActivityIso}
      groups={groups}
      groupFilter={groupFilter}
      onGroupFilter={setGroupFilter}
      actions={boardActions}
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
  route: BoardRoute;
  onRouteChange: (r: BoardRoute) => void;
  groups: GroupSummary[];
  groupFilter: GroupFilter;
  onGroupFilter: (next: GroupFilter) => void;
}) {
  return (
    <header className="nc-pulse">
      <div className="nc-pulse-top">
        <BoardBrand groups={groups} groupFilter={groupFilter} onGroupFilter={onGroupFilter} />
        <RouteNav route={route} onRouteChange={onRouteChange} />
      </div>
      <div className="nc-pulse-grid">
        <div className="nc-pulse-bigcount">
          <span>{counts.live}</span>
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

function ShowArchivedToggle({ actions }: { actions: BoardActions }) {
  return <ShellShowArchivedToggle showArchived={actions.showArchived} onChange={actions.setShowArchived} />;
}

function BulkClearFailedButton({
  actions,
  failedCount,
  label = `Clear failed (${failedCount})`,
}: {
  actions: BoardActions;
  failedCount: number;
  label?: string;
}) {
  if (!actions.canBulkClearFailed || failedCount <= 0) return null;
  return (
    <button type="button" className="nc-btn ghost" onClick={() => actions.onBulkClearFailed()}>
      {label}
    </button>
  );
}

function ArchiveToolbar({
  filter,
  actions,
  failedCount,
}: {
  filter: FilterId;
  actions: BoardActions;
  failedCount: number;
}) {
  return (
    <div className="nc-archive-toolbar">
      <ShowArchivedToggle actions={actions} />
      {filter === 'needs' && (
        <BulkClearFailedButton actions={actions} failedCount={failedCount} label={`Clear all failed (${failedCount})`} />
      )}
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

function TaskCard({
  task,
  onArchive,
  onUnarchive,
}: {
  task: TaskSummary;
  onArchive?: ((taskId: string) => void) | undefined;
  onUnarchive?: ((taskId: string) => void) | undefined;
}) {
  const goal = extractGoal(task.task_content);
  const linearId = extractLinearId(task.task_content);
  const needsInput = !!task.needs_input;
  const isArchived = task.archived_at != null;
  const heat = heatOf({
    status: task.status,
    admitted_at: task.admitted_at,
    needs_input: task.needs_input,
  });
  const colourClass = needsInput ? 'needs' : task.status;
  // Terminal states can be archived; pending/running cannot (operator would
  // be hiding an in-flight task from themselves).
  const isTerminal =
    task.status === 'failed' || task.status === 'completed' || task.status === 'cancelled';

  const onClick = () => {
    location.hash = `#/task/${task.task_id}`;
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };

  const handleArchive = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onArchive) onArchive(task.task_id);
  };
  const handleUnarchive = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onUnarchive) onUnarchive(task.task_id);
  };

  // Swipe-to-archive is only enabled when the card is in a state that can
  // actually archive — terminal task with onArchive bound, non-archived.
  const swipeEnabled = !isArchived && isTerminal && !!onArchive;
  return (
    <SwipeableCard
      className={`nc-card ${colourClass} heat-${heat}${isArchived ? ' archived' : ''}`}
      enabled={swipeEnabled}
      onArchive={() => onArchive?.(task.task_id)}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={onKey}
      data-task-id={task.task_id}
    >
      <div className="nc-card-head">
        <StatusGlyph status={task.status} needsInput={needsInput} />
        <span className="sep">·</span>
        <span className="age">{relAge(task.admitted_at)} ago</span>
        {linearId && <span className="linear-id">{linearId}</span>}
        {isArchived && onUnarchive && (
          <button
            type="button"
            className="nc-card-dismiss"
            aria-label="Unarchive task"
            onClick={handleUnarchive}
            title="Restore to board"
          >
            ↩ Unarchive
          </button>
        )}
        {!isArchived && isTerminal && onArchive && (
          <button
            type="button"
            className="nc-card-dismiss"
            aria-label="Dismiss task"
            onClick={handleArchive}
            title="Dismiss from board"
          >
            ×
          </button>
        )}
      </div>
      <div className="nc-card-goal">{goal}</div>
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
    </SwipeableCard>
  );
}

/* ─── Mobile ─── */

function MobileBoard({
  tasks,
  visible,
  counts,
  failedActionableCount,
  filter,
  onFilter,
  route,
  onRouteChange,
  lastActivityIso,
  groups,
  groupFilter,
  onGroupFilter,
  actions,
}: {
  tasks: TaskSummary[];
  visible: TaskSummary[];
  counts: Counts;
  failedActionableCount: number;
  filter: FilterId;
  onFilter: (v: FilterId) => void;
  route: BoardRoute;
  onRouteChange: (r: BoardRoute) => void;
  lastActivityIso: string;
  groups: GroupSummary[];
  groupFilter: GroupFilter;
  onGroupFilter: (next: GroupFilter) => void;
  actions: BoardActions;
}) {
  const g = streamGroups(visible);
  const [foldOpen, setFoldOpen] = useState(false);
  const doneVisible = foldOpen ? g.done : g.done.slice(0, 2);
  const coldVisible = foldOpen ? g.cold : [];
  const moreCount = g.done.length - doneVisible.length + (foldOpen ? 0 : g.cold.length);

  return (
    <BoardFrame isMobile={true}>
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
      <ArchiveToolbar
        filter={filter}
        actions={actions}
        failedCount={failedActionableCount}
      />

      <div className="nc-stream">
        {filter === 'all' && (
          <>
            <Section
              title="Needs you"
              tasks={g.needsMe}
              hideWhenEmpty
              onArchive={actions.onArchive}
              onUnarchive={actions.onUnarchive}
            />
            <Section
              title="Working"
              tasks={g.running}
              hideWhenEmpty
              onArchive={actions.onArchive}
              onUnarchive={actions.onUnarchive}
            />
            <Section
              title="Queued"
              tasks={g.pending}
              hideWhenEmpty
              onArchive={actions.onArchive}
              onUnarchive={actions.onUnarchive}
            />
            {g.done.length > 0 && (
              <>
                <SectionLabel title="Done · last 24h" count={g.done.length} />
                {doneVisible.map((t) => (
                  <TaskCard
                    key={t.task_id}
                    task={t}
                    onArchive={actions.onArchive}
                    onUnarchive={actions.onUnarchive}
                  />
                ))}
                {coldVisible.map((t) => (
                  <TaskCard
                    key={t.task_id}
                    task={t}
                    onArchive={actions.onArchive}
                    onUnarchive={actions.onUnarchive}
                  />
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
          visible.map((t) => (
            <TaskCard
              key={t.task_id}
              task={t}
              onArchive={actions.onArchive}
              onUnarchive={actions.onUnarchive}
            />
          ))}

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
    </BoardFrame>
  );
}

function Section({
  title,
  tasks,
  hideWhenEmpty,
  onArchive,
  onUnarchive,
}: {
  title: string;
  tasks: TaskSummary[];
  hideWhenEmpty?: boolean;
  onArchive?: ((taskId: string) => void) | undefined;
  onUnarchive?: ((taskId: string) => void) | undefined;
}) {
  if (hideWhenEmpty && tasks.length === 0) return null;
  return (
    <>
      <SectionLabel title={title} count={tasks.length} />
      {tasks.map((t) => (
        <TaskCard key={t.task_id} task={t} onArchive={onArchive} onUnarchive={onUnarchive} />
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
  failedActionableCount,
  route,
  onRouteChange,
  lastActivityIso,
  groups,
  groupFilter,
  onGroupFilter,
  actions,
}: {
  tasks: TaskSummary[];
  counts: Counts;
  failedActionableCount: number;
  route: BoardRoute;
  onRouteChange: (r: BoardRoute) => void;
  lastActivityIso: string;
  groups: GroupSummary[];
  groupFilter: GroupFilter;
  onGroupFilter: (next: GroupFilter) => void;
  actions: BoardActions;
}) {
  const needsMe = tasks.filter((t) => t.status === 'failed');
  const working = tasks.filter((t) => t.status === 'running');
  const pending = tasks.filter((t) => t.status === 'pending');
  const done = tasks.filter((t) => t.status === 'completed');
  const cancelled = tasks.filter((t) => t.status === 'cancelled');

  const [pendingOpen, setPendingOpen] = useState(false);
  const [cancelledOpen, setCancelledOpen] = useState(false);

  return (
    <BoardFrame isMobile={false}>
      <div className="nc-desktop-top">
        <div className="nc-desktop-pulse">
          <div className="nc-desktop-headerrow">
            <BoardBrand groups={groups} groupFilter={groupFilter} onGroupFilter={onGroupFilter} />
            <RouteNav route={route} onRouteChange={onRouteChange} />
          </div>
          <div className="bigcount">
            <span>{counts.live}</span>
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
            <ShowArchivedToggle actions={actions} />
            <div className="right">
              <BulkClearFailedButton actions={actions} failedCount={failedActionableCount} />
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
              <span className="cnt">{counts.failed}</span>
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
              <TaskCard
                key={t.task_id}
                task={t}
                onArchive={actions.onArchive}
                onUnarchive={actions.onUnarchive}
              />
            ))}
          </div>
        </div>

        <div className="nc-col">
          <div className="nc-col-head working">
            <div className="ttl">
              <span className="swatch" aria-hidden="true"></span>Working
              <span className="cnt">{counts.running}</span>
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
              <TaskCard
                key={t.task_id}
                task={t}
                onArchive={actions.onArchive}
                onUnarchive={actions.onUnarchive}
              />
            ))}
            {pending.length > 0 && (
              <>
                {pendingOpen && pending.map((t) => (
                  <TaskCard
                    key={t.task_id}
                    task={t}
                    onArchive={actions.onArchive}
                    onUnarchive={actions.onUnarchive}
                  />
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
              <span className="cnt">{counts.done}</span>
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
              <TaskCard
                key={t.task_id}
                task={t}
                onArchive={actions.onArchive}
                onUnarchive={actions.onUnarchive}
              />
            ))}
            {cancelled.length > 0 && (
              <>
                {cancelledOpen && cancelled.map((t) => (
                  <TaskCard
                    key={t.task_id}
                    task={t}
                    onArchive={actions.onArchive}
                    onUnarchive={actions.onUnarchive}
                  />
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
    </BoardFrame>
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
