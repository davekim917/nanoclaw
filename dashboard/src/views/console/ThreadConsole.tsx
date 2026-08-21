import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { CalendarClock, Inbox, ListChecks, Menu } from 'lucide-react';
import useSWR from 'swr';
import {
  getThreadDetail,
  listGroups,
  listThreads,
  listWorkgroups,
  type AuthMe,
  type GroupSummary,
  type ThreadState,
  type ThreadSummary,
  type ThreadTranscriptEntry,
  type WorkgroupSummary,
} from '../../lib/api.js';
import { stripMarkdown } from '../../lib/markdown.js';
import { subscribe } from '../../lib/sse.ts';
import { useWorkgroupFilter } from '../../lib/use-workgroup-filter.js';
import { actionError } from './action-error.js';
import { setSnoozed } from './actions.js';
import { CloseThreadControl } from './CloseControl.js';
import { ScheduleLens } from './ScheduleLens.js';
import { ThreadDetail } from './ThreadDetail.js';
import { ThreadRow, type ThreadPreview } from './ThreadRow.js';
import { TriagePanel } from './TriagePanel.js';
import { LANE_ORDER, STATE_PRESENTATION, compareThreads, emptyQueueMessage, type Lane } from './thread-state.js';

/**
 * The Observatory console — `#/console`, and now the only surface.
 *
 * The legacy Observatory / inbox / workgroup / session routes are deleted; this
 * shell carries the thread queue and the Schedule lens. Backed entirely by
 * `GET /dashboard/api/threads`, whose row is a thread rather than a session
 * (DESIGN.md §3.1).
 *
 * Refresh is push-only. There is no polling loop here and must not be one: the
 * host already emits `session_event` over SSE for every inbound write, outbound
 * delivery and container-state transition, so a timer would only add cost. The
 * debounce below is the trailing-edge pattern the retired inbox board used, for
 * the same reason — a streaming burst emits dozens of frames per turn.
 */

/**
 * How many attention rows may fetch their hybrid line at once (§4.1).
 *
 * Message bodies live in per-session DB files with no central rollup, so each
 * preview opens files server-side. Attention rows are "a handful at a time" by
 * design; this cap is what makes that literally true even on a bad day. Do not
 * raise it to cover all rows without building a rollup table first.
 */
const PREVIEW_BUDGET = 8;

type ThemeChoice = 'system' | 'light' | 'dark';
const THEME_KEY = 'ncc-theme';
const THEME_CYCLE: ThemeChoice[] = ['system', 'dark', 'light'];

export function ThreadConsole({ authMe }: { authMe: AuthMe }) {
  /**
   * The primary axis is the WORKGROUP (`example-labs`, `example-dev`, …), not the
   * agent group. Siblings share a workgroup and most threads are multi-agent,
   * so an agent-group selector listed `example-labs` six times and made the
   * operator pick one sibling to see a thread all six are on.
   *
   * The endpoint has already scope-filtered this list: a workgroup where the
   * caller is allowed no sibling is simply not in it (workgroups.ts), and the
   * server intersects the filter with scope again on every query — selecting a
   * workgroup can only ever subtract.
   */
  const { data: workgroupsData } = useSWR('/dashboard/api/workgroups', () => listWorkgroups(), { refreshInterval: 0 });
  const workgroups: WorkgroupSummary[] = useMemo(() => workgroupsData?.workgroups ?? [], [workgroupsData]);
  const workgroupIds = useMemo(() => workgroups.map((w) => w.id), [workgroups]);
  const [workgroupFilter, setWorkgroupFilter] = useWorkgroupFilter(authMe.user_id, workgroupIds);
  const [lane, setLane] = useState<Lane>('all');
  const [rawChannel, setChannel] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusComposer, setFocusComposer] = useState(0);
  const [triage, setTriage] = useState<ThreadSummary[] | null>(null);
  const [notice, setNotice] = useState('');
  /**
   * Whether the sidebar is showing as a sheet. Mobile only in effect — above
   * the breakpoint the sidebar is always on screen and this attribute selects
   * nothing (§8 / console.css). It is deliberately NOT gated on a
   * `matchMedia` read: a JS breakpoint would be a second source of truth for
   * something CSS already knows, and the two drift.
   */
  const [navOpen, setNavOpen] = useState(false);
  const theme = useThemeChoice();
  const { lens, goToQueue } = useHashLens();

  /**
   * §4's fix: choosing ANY queue filter while the Schedule lens is open must
   * snap the view back to the queue, with that filter applied. Schedule used to
   * pin the page — a lane or channel tap still changed state, but the render
   * branch below kept drawing the lens, so nothing visible happened and the
   * only way out was a "Threads" link that is now gone. Every filter control
   * routes through one of these three instead of calling its setter directly.
   */
  const applyLaneFilter = useCallback(
    (next: Lane) => {
      if (lens === 'schedule') goToQueue();
      setLane(next);
    },
    [lens, goToQueue],
  );
  const applyChannelFilter = useCallback(
    (next: string | null) => {
      if (lens === 'schedule') goToQueue();
      setChannel(next);
    },
    [lens, goToQueue],
  );
  const applyQuery = useCallback(
    (next: string) => {
      if (lens === 'schedule') goToQueue();
      setQuery(next);
    },
    [lens, goToQueue],
  );
  const applyWorkgroupFilter = useCallback(
    (next: string) => {
      if (lens === 'schedule') goToQueue();
      setWorkgroupFilter(next);
    },
    [lens, goToQueue, setWorkgroupFilter],
  );

  const { data, mutate } = useSWR(
    ['/dashboard/api/threads', workgroupFilter],
    () => listThreads(workgroupFilter === 'all' ? {} : { workgroup: workgroupFilter }),
    { refreshInterval: 0, dedupingInterval: 500 },
  );
  useSseInvalidation(mutate);

  // Agent groups are still fetched — the Schedule lens keys its rows on
  // `agent_group_id` and needs the workgroup → siblings mapping to honour the
  // same filter. They are NOT a second selector; see the note on the header.
  const { data: groupsData } = useSWR('/dashboard/api/groups', () => listGroups(), { refreshInterval: 0 });
  const groups: GroupSummary[] = useMemo(() => groupsData?.groups ?? [], [groupsData]);
  const scheduleAgentGroupIds = useMemo(
    () =>
      workgroupFilter === 'all'
        ? null
        : new Set(groups.filter((g) => g.workgroup_id === workgroupFilter).map((g) => g.id)),
    [groups, workgroupFilter],
  );

  const threads = useMemo(() => data?.threads ?? [], [data]);

  const laneCounts = useMemo(() => {
    const counts = {} as Record<ThreadState, number>;
    for (const state of LANE_ORDER) counts[state] = 0;
    for (const t of threads) counts[t.state] = (counts[t.state] ?? 0) + 1;
    return counts;
  }, [threads]);

  /**
   * §3.2: channels group on the key PARSED FROM `thread_id`, which the endpoint
   * already did. Grouping on `messaging_group_id` instead would list the same
   * channel once per wired sibling bot.
   */
  const channels = useMemo(() => {
    const byKey = new Map<string, { key: string; name: string; total: number; attention: number }>();
    for (const t of threads) {
      const entry = byKey.get(t.channel_key) ?? { key: t.channel_key, name: t.channel_name, total: 0, attention: 0 };
      entry.total += 1;
      if (STATE_PRESENTATION[t.state].wantsAttention) entry.attention += 1;
      byKey.set(t.channel_key, entry);
    }
    return [...byKey.values()].sort((a, b) => b.attention - a.attention || b.total - a.total);
  }, [threads]);

  /**
   * The channel filter, validated against the channels that actually exist —
   * the same guard `use-workgroup-filter.ts` applies to a stored workgroup, for
   * same reason. `channels` is derived from the CURRENT window, so a channel
   * whose last thread aged out simply stops being listed; without this the
   * sidebar would show "All channels" pressed while an invisible filter kept
   * the queue empty, and the operator would be reading a lie.
   */
  const channel = channels.some((c) => c.key === rawChannel) ? rawChannel : null;
  const channelName = channels.find((c) => c.key === channel)?.name ?? null;
  useEffect(() => {
    // Only once there is a window to validate against: an empty fetch is not
    // evidence that the operator's channel is gone.
    if (rawChannel !== null && threads.length > 0 && !channels.some((c) => c.key === rawChannel)) setChannel(null);
  }, [rawChannel, channels, threads.length]);

  const snoozedCount = useMemo(() => threads.filter((t) => t.snoozed).length, [threads]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return threads
      .filter((t) => (lane === 'snoozed' ? t.snoozed : !t.snoozed))
      .filter((t) => lane === 'all' || lane === 'snoozed' || t.state === lane)
      .filter((t) => channel === null || t.channel_key === channel)
      .filter(
        (t) =>
          needle === '' ||
          (t.title ?? '').toLowerCase().includes(needle) ||
          t.channel_name.toLowerCase().includes(needle),
      )
      .sort(compareThreads);
  }, [threads, lane, channel, query]);

  // Which rows are allowed to spend a preview fetch — the first PREVIEW_BUDGET
  // attention rows in view, nobody else.
  const previewIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of visible) {
      if (!STATE_PRESENTATION[t.state].wantsAttention) continue;
      if (ids.size >= PREVIEW_BUDGET) break;
      ids.add(t.thread_id);
    }
    return ids;
  }, [visible]);

  const listRef = useRef<HTMLUListElement>(null);
  // Arrow keys walk the queue. `tsconfig.lib` has DOM but not DOM.Iterable, so
  // Array.from rather than a spread.
  const onListKeyDown = useCallback((e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const nodes = listRef.current?.querySelectorAll<HTMLButtonElement>('.ncc-row-main');
    const items = nodes ? Array.from(nodes) : [];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    const next = items[at + (e.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    next.focus();
  }, []);

  const laneLabel = lane === 'all' ? 'All threads' : lane === 'snoozed' ? 'Snoozed' : STATE_PRESENTATION[lane].label;
  const selected = visible.find((t) => t.thread_id === selectedId) ?? null;

  /**
   * The row's ONE verb, and it is one verb for every state now: open the
   * composer on this thread. Answer / Push / Steer / Assign / Hand to… are
   * words, not branches — `STATE_PRESENTATION` picks the word and this picks
   * nothing. Snooze and Close are the two actions that are NOT a message, and
   * both live on the detail pane rather than in the queue's verb column.
   *
   * There used to be a second non-message action here — Dismiss (formerly
   * Close), which archived every session on the thread and stopped nothing:
   * archiving hid the thread from the queue without stopping the agent, so the
   * work kept running unattended and unwatched. It was removed for that reason,
   * not brought back — the real `CloseThreadControl` below is a different
   * thing. It does not hide a thread that is still working; it asks the agent
   * to wrap up, clears its saved continuation, stops its container, and only
   * THEN archives it (`src/dashboard/thread-close.ts`). A thread that just gets
   * hidden from view is exactly the bug this feature fixes, not a shortcut to
   * bring back.
   */
  const onVerb = useCallback((t: ThreadSummary) => {
    setSelectedId(t.thread_id);
    setFocusComposer((n) => n + 1);
  }, []);

  const onToggleSnooze = useCallback(
    (t: ThreadSummary) => {
      setSnoozed(t.thread_id, !t.snoozed)
        .then(() => {
          setNotice(t.snoozed ? 'Un-snoozed.' : 'Snoozed until it moves.');
          void mutate();
        })
        .catch((err: unknown) => setNotice(`Could not snooze — ${actionError(err)}.`));
    },
    [mutate],
  );

  /**
   * Triage is a mode over the CURRENT FILTERED LIST (§11), so entering it
   * freezes `visible` — the same rows, the same order — and leaving it puts the
   * operator back exactly where they were, scroll position included. Entering
   * it while Schedule is open has the same trap §4 fixes elsewhere: the panel
   * lives in the same branch as the queue, so it must snap back to the queue
   * first or the tap would silently do nothing visible.
   */
  const savedScroll = useRef(0);
  const enterTriage = useCallback(() => {
    if (lens === 'schedule') goToQueue();
    savedScroll.current = listRef.current?.scrollTop ?? 0;
    setTriage(visible);
  }, [lens, goToQueue, visible]);
  const exitTriage = useCallback(() => setTriage(null), []);
  useEffect(() => {
    if (triage === null && listRef.current) listRef.current.scrollTop = savedScroll.current;
  }, [triage]);

  /**
   * Which pane a phone is looking at. Desktop ignores it — the list and the
   * thread are side by side there — but at ≤899px exactly one of them is
   * visible and this attribute is the switch (§8). Tied to the SCHEDULE lens
   * too: a thread selected before switching lenses must not blank the schedule.
   */
  const pane = lens === 'threads' && selected ? 'detail' : 'list';

  return (
    <div className="ncc" data-pane={pane} data-nav={navOpen ? 'open' : 'closed'}>
      <header className="ncc-top">
        {/* Mobile only (console.css) — opens the SAME nav as the sheet the
            bottom bar's Filters tab used to raise. There is no second,
            mobile-only control set: this button and the desktop sidebar share
            one `<nav>`, so there is exactly one lane list, one channel list,
            and one theme toggle in the DOM. */}
        <button
          type="button"
          className="ncc-hamburger"
          aria-label="Navigation"
          aria-expanded={navOpen}
          aria-controls="ncc-side"
          onClick={() => setNavOpen((open) => !open)}
        >
          <Menu size={18} aria-hidden="true" />
        </button>
        <span className="ncc-brand">Observatory</span>
        {/* One selector, one axis. There is deliberately no second
            narrow-to-one-sibling control: every row already carries the avatar
            stack of the agents on that thread, which answers "which sibling is
            on this" without costing the operator a click or a second piece of
            filter state to reason about. `group_id` is still a supported query
            parameter for other callers. */}
        <select
          className="ncc-select"
          aria-label="Workgroup"
          value={workgroupFilter}
          onChange={(e) => applyWorkgroupFilter(e.target.value)}
        >
          <option value="all">all workgroups</option>
          {workgroups.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        {/* The one row this header is (item 1): brand, workgroup, search — the
            "Needs you" tally, Triage entry and theme toggle used to live here
            too, stacked into three rows on a phone. They duplicated the left
            nav (desktop) and the Filters sheet (mobile), so they are gone from
            here entirely: the attention count lives on the sidebar's own
            "Needs you" lane, Triage is a nav entry (§ below), and the theme
            toggle is the nav's footer item. */}
        <input
          className="ncc-search"
          type="search"
          placeholder="Search threads"
          aria-label="Search threads"
          value={query}
          onChange={(e) => applyQuery(e.target.value)}
        />
      </header>

      <div className="ncc-body">
        {/* One nav, drawn in two places — §12's "a row is a row wherever it is
            drawn" applied to the sidebar. At ≤899px console.css lifts this same
            element into a sheet over the queue rather than duplicating its
            lanes, channels and lenses into a second mobile-only control set.
            Any activation inside it closes the sheet, so a phone tap does not
            leave the queue behind a panel. */}
        <nav className="ncc-side" id="ncc-side" aria-label="Queue and channels" onClick={() => setNavOpen(false)}>
          <h2 className="ncc-side-head">Queue</h2>
          <LaneButton
            label="All threads"
            count={threads.length}
            active={lane === 'all'}
            onClick={() => applyLaneFilter('all')}
          />
          {LANE_ORDER.map((state) => (
            <LaneButton
              key={state}
              label={STATE_PRESENTATION[state].label}
              count={laneCounts[state] ?? 0}
              tone={STATE_PRESENTATION[state].tone}
              active={lane === state}
              onClick={() => applyLaneFilter(state)}
              // The top bar's "Needs you N" chip is gone (item 2) — this lane's
              // own count is its only home now, so it keeps the chip's
              // aria-live rather than dropping the announcement on the floor.
              live={state === 'needs_you'}
            />
          ))}

          {snoozedCount > 0 && (
            <LaneButton
              label="Snoozed"
              count={snoozedCount}
              active={lane === 'snoozed'}
              onClick={() => applyLaneFilter('snoozed')}
            />
          )}

          {/* Triage was a top-bar button and a bottom-bar tab; it is now also a
              Queue-section entry, same shape as a lane, so desktop offers it
              without a duplicate row of chrome above the list (§2). */}
          <LaneButton
            label="Triage"
            count={visible.length}
            disabled={visible.length === 0 || triage !== null}
            onClick={enterTriage}
          />

          <div className="ncc-side-gap" />
          <h2 className="ncc-side-head">
            <span className="lbl">Channels</span>
            <span className="ncc-mono">{channels.length}</span>
          </h2>
          <LaneButton
            label="All channels"
            count={threads.length}
            active={channel === null}
            onClick={() => applyChannelFilter(null)}
          />
          {channels.map((c) => (
            <button
              key={c.key}
              type="button"
              className="ncc-side-item channel"
              aria-pressed={channel === c.key}
              onClick={() => applyChannelFilter(channel === c.key ? null : c.key)}
            >
              {/* §11: friendly per-channel display names, never internal ids.
                  `channel_name` is resolved from messaging_groups server-side
                  and falls back to the key's last segment. */}
              <span className="lbl">{c.name}</span>
              {c.attention > 0 && <span className="n attention">{c.attention}</span>}
              <span className="n">{c.total}</span>
            </button>
          ))}

          <div className="ncc-side-gap" />
          {/* §11: the schedule is a LENS, not a destination — same shell, same
              workgroup filter, a different thing to look at. The "LENSES"
              heading and its "Threads" entry are gone (item 4): the queue is
              the default view, and every filter above already returns to it,
              so a menu entry whose only job was "go back" had no point. */}
          <a className="ncc-side-item" href="#/scheduled" aria-current={lens === 'schedule' ? 'page' : undefined}>
            <span className="lbl">Schedule</span>
          </a>

          {/* The nav's footer item (item 2) — was a top-bar button, stacking a
              third row on a phone. Pinned to the bottom of this nav with
              `margin-top: auto`, which puts it at the foot of the sheet on
              mobile for free, since it is the same element either way. */}
          <div className="ncc-side-foot">
            <button
              type="button"
              className="ncc-solid-btn"
              onClick={theme.cycle}
              aria-label={`Colour theme: ${theme.choice}. Activate to change.`}
            >
              {theme.choice}
            </button>
          </div>
        </nav>

        {lens === 'schedule' ? (
          <ScheduleLens agentGroupIds={scheduleAgentGroupIds} groups={groups} />
        ) : (
          <>
            <section className="ncc-list-pane" aria-label="Threads" hidden={triage !== null}>
              <div className="ncc-list-head">
                <h2>{laneLabel}</h2>
                <span className="count">{visible.length}</span>
                <span className="ncc-spacer" />
                <span className="count">sort:urgency</span>
              </div>
              <ul className="ncc-list" ref={listRef} onKeyDown={onListKeyDown}>
                {visible.map((t) => (
                  <ConnectedRow
                    key={t.thread_id}
                    thread={t}
                    withPreview={previewIds.has(t.thread_id)}
                    selected={t.thread_id === selectedId}
                    onSelect={(x) => {
                      setSelectedId(x.thread_id);
                      // Opening a thread must not steal the cursor; only a verb
                      // asks for the composer. See ReplyComposer's focus effect.
                      setFocusComposer(0);
                    }}
                    onVerb={onVerb}
                  />
                ))}
              </ul>
              {/* Four different facts, four different sentences — see
              `emptyQueueMessage`. A clear attention lane is good news and says
              so; a narrowed question gets its narrowing spoken back. */}
              {visible.length === 0 && (
                <div className="ncc-empty">
                  {emptyQueueMessage({ total: threads.length, lane, channelName, query })}
                </div>
              )}
              {/* Every mutating action reports here, once, for screen readers and
              for anyone who did not watch the row change under the cursor. */}
              <div className="ncc-notice" role="status" aria-live="polite">
                {notice}
              </div>
            </section>

            {triage ? (
              <TriagePanel snapshot={triage} threads={threads} onExit={exitTriage} onChanged={() => void mutate()} />
            ) : (
              <div className="ncc-detail-wrap">
                {selected && (
                  /* The one action that is not a message. Everything else on this
                 screen is the composer below. */
                  <div className="ncc-detail-actions">
                    {/* On a phone the list and the thread are one pane, so
                        opening a thread is a navigation and needs its return.
                        Hidden above the breakpoint, where both are on screen. */}
                    <button type="button" className="ncc-verb ncc-back" onClick={() => setSelectedId(null)}>
                      ‹ queue
                    </button>
                    <button type="button" className="ncc-verb" onClick={() => onToggleSnooze(selected)}>
                      {selected.snoozed ? 'un-snooze' : 'snooze'}
                    </button>
                    {/* Close, next to Snooze. The two are independent — see the
                        note above `onVerb` — so neither gates the other and
                        `CloseThreadControl` reads only `selected` for its own
                        state. Keyed on the thread id so switching threads
                        mid-confirmation resets it rather than carrying an
                        armed "confirm close" over onto a different thread. */}
                    <CloseThreadControl key={selected.thread_id} thread={selected} onClosed={() => void mutate()} />
                  </div>
                )}
                <ThreadDetail thread={selected} focusComposer={focusComposer} onSent={() => void mutate()} />
              </div>
            )}
          </>
        )}
      </div>

      {/*
       * §8's bottom bar: 56px, three destinations, each with a distinct icon.
       * `display: none` above the breakpoint — on desktop the sidebar already
       * carries all of this, and a second copy would be the near-identical
       * duplicate control §12 warns about.
       *
       * Filters is gone from here (item 2): the header's hamburger raises the
       * same sidebar sheet now, so the bottom bar is down to the two lenses
       * plus Triage, the mode entered from the list (§11).
       */}
      <nav className="ncc-bottom" aria-label="Sections">
        {/* Triage is a MODE layered on top of the 'threads' lens (§11), not a
            lens of its own — `lens` alone therefore still reads 'threads'
            while it is open, and Queue's aria-current must say so too or the
            bottom bar highlights Queue while the operator is actually in
            Triage. */}
        <a
          className="ncc-bottom-item"
          href="#/console"
          aria-current={lens === 'threads' && triage === null ? 'page' : undefined}
          onClick={() => setSelectedId(null)}
        >
          <Inbox size={18} aria-hidden="true" />
          Queue
        </a>
        <a className="ncc-bottom-item" href="#/scheduled" aria-current={lens === 'schedule' ? 'page' : undefined}>
          <CalendarClock size={18} aria-hidden="true" />
          Schedule
        </a>
        <button
          type="button"
          className="ncc-bottom-item"
          aria-current={triage !== null ? 'page' : undefined}
          onClick={enterTriage}
          disabled={visible.length === 0 || triage !== null}
        >
          <ListChecks size={18} aria-hidden="true" />
          Triage
        </button>
      </nav>
    </div>
  );
}

/* ─── Sidebar lane ─────────────────────────────────────────────────────── */

function LaneButton({
  label,
  count,
  tone,
  active,
  disabled,
  live,
  onClick,
}: {
  label: string;
  count: number;
  tone?: 'attention' | 'live' | 'quiet';
  /** Omitted entirely for an action entry (Triage) rather than a filter toggle
   *  — `aria-pressed="false"` on a button that does not toggle is a worse
   *  reading than no `aria-pressed` at all. */
  active?: boolean;
  disabled?: boolean;
  /** The top bar's "Needs you N" chip carried `aria-live="polite"` (item 2
   *  removed it entirely); the Needs-you LANE is now the only place that count
   *  lives, so it keeps the announcement rather than dropping it. */
  live?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="ncc-side-item" aria-pressed={active} disabled={disabled} onClick={onClick}>
      <span className="lbl">{label}</span>
      <span
        className={`n${tone === 'attention' ? ' attention' : tone === 'live' ? ' live' : ''}`}
        aria-live={live ? 'polite' : undefined}
      >
        {count}
      </span>
    </button>
  );
}

/* ─── Row + its (budgeted) hybrid line ─────────────────────────────────── */

function ConnectedRow({
  thread,
  withPreview,
  selected,
  onSelect,
  onVerb,
}: {
  thread: ThreadSummary;
  withPreview: boolean;
  selected: boolean;
  onSelect: (t: ThreadSummary) => void;
  onVerb: (t: ThreadSummary) => void;
}) {
  // Keyed on `last_activity_at` as well as the id: SWR then reuses the cached
  // preview across every list refresh in which the thread did not actually move,
  // so an SSE burst on OTHER threads costs this row nothing.
  const wants = withPreview && STATE_PRESENTATION[thread.state].wantsAttention;
  const { data } = useSWR(
    wants ? ['thread-preview', thread.thread_id, thread.last_activity_at] : null,
    () => getThreadDetail(thread.thread_id),
    { refreshInterval: 0, revalidateOnFocus: false },
  );
  return (
    <ThreadRow
      thread={thread}
      preview={lastMessagePreview(data?.transcript)}
      selected={selected}
      onSelect={onSelect}
      onVerb={onVerb}
    />
  );
}

const EXCERPT_CHARS = 140;

/**
 * The actual last message as `Speaker: excerpt` (§4).
 *
 * Markdown is STRIPPED here, never rendered: this lands in a one-line flex cell
 * with an ellipsis, and rendering would inject `<p>` / `<ul>` / `<pre>` into it
 * and break the row. Leaving it raw is the other failure — the operator would
 * read `**ship it**`. `stripMarkdown` is a preview flattener and not a security
 * boundary; the excerpt is rendered as a text node, so there is nothing to
 * sanitise.
 */
export function lastMessagePreview(transcript: ThreadTranscriptEntry[] | undefined): ThreadPreview | null {
  const last = transcript?.[transcript.length - 1];
  if (!last || !last.text.trim()) return null;
  const text = stripMarkdown(last.text);
  if (!text) return null;
  return {
    // Inbound carries no author on the wire — the transcript records a
    // direction, not a human. Naming one would be an invention.
    speaker: last.direction === 'out' ? last.agent_name : '',
    excerpt: text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}…` : text,
  };
}

/* ─── Plumbing ─────────────────────────────────────────────────────────── */

/**
 * Which lens the hash selects.
 *
 * `#/scheduled` is a REAL route again rather than a redirect: it used to bounce
 * to the legacy Observatory, whose floor carried the schedule section, and that
 * indirection is what made the schedule invisible the moment the Observatory
 * was deleted. Every OTHER hash — including the retired `#/observatory`,
 * `#/inbox`, `#/workgroup` and `#/session/:id` bookmarks — still lands on the
 * thread queue rather than rendering nothing.
 */
export function lensForHash(hash: string): 'threads' | 'schedule' {
  return hash.replace(/^#/, '') === '/scheduled' ? 'schedule' : 'threads';
}

/**
 * `goToQueue` is item 4's fix for the Schedule trap: it sets BOTH the address
 * bar (so `#/console` stays the bookmarkable, back-button-honest URL) and the
 * lens state directly, rather than only writing the hash and waiting on the
 * `hashchange` listener below to notice. A filter tap needs the queue to
 * reappear in the SAME render pass it fires in — round-tripping through a
 * browser event that may not even land synchronously would reintroduce the
 * silent no-op this exists to fix. External navigation (a Schedule link, the
 * back button) still goes through the listener exactly as before.
 */
function useHashLens(): { lens: 'threads' | 'schedule'; goToQueue: () => void } {
  const [lens, setLens] = useState(() => lensForHash(location.hash));
  useEffect(() => {
    const handler = () => setLens(lensForHash(location.hash));
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);
  const goToQueue = useCallback(() => {
    location.hash = '#/console';
    setLens('threads');
  }, []);
  return { lens, goToQueue };
}

/** Trailing-edge debounce on `session_event`. No polling — see the file header. */
function useSseInvalidation(mutate: () => void): void {
  const timer = useRef<number | null>(null);
  const invalidate = useCallback(() => {
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      mutate();
    }, 300);
  }, [mutate]);
  useEffect(() => {
    const unsubscribe = subscribe('session_event', invalidate);
    return () => {
      unsubscribe();
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [invalidate]);
}

/**
 * Three-state theme: `system` follows `prefers-color-scheme`, `light` and
 * `dark` are explicit and must beat the system setting in BOTH directions —
 * which is why `system` REMOVES the attribute rather than writing "system"
 * into it. console.css matches on its presence.
 */
function useThemeChoice(): { choice: ThemeChoice; cycle: () => void } {
  const [choice, setChoice] = useState<ThemeChoice>(() => {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(THEME_KEY) : null;
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  });
  useEffect(() => {
    const root = document.documentElement;
    if (choice === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', choice);
    try {
      localStorage.setItem(THEME_KEY, choice);
    } catch {
      /* private mode — the choice just doesn't persist */
    }
  }, [choice]);
  const cycle = useCallback(
    () => setChoice((c) => THEME_CYCLE[(THEME_CYCLE.indexOf(c) + 1) % THEME_CYCLE.length]!),
    [],
  );
  return { choice, cycle };
}
