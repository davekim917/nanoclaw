import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import useSWR from 'swr';
import {
  getThreadDetail,
  listGroups,
  listThreads,
  type AuthMe,
  type GroupSummary,
  type ThreadState,
  type ThreadSummary,
  type ThreadTranscriptEntry,
} from '../../lib/api.js';
import { stripMarkdown } from '../../lib/markdown.js';
import { subscribe } from '../../lib/sse.ts';
import { useGroupFilter } from '../../lib/use-group-filter.js';
import { actionError } from './action-error.js';
import { closeThread, setSnoozed } from './actions.js';
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
  const [groupFilter, setGroupFilter] = useGroupFilter(
    authMe.user_id,
    authMe.scopes.allowed_group_ids,
    authMe.scopes.no_filter,
  );
  const [lane, setLane] = useState<Lane>('all');
  const [rawChannel, setChannel] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusComposer, setFocusComposer] = useState(0);
  const [triage, setTriage] = useState<ThreadSummary[] | null>(null);
  const [notice, setNotice] = useState('');
  const theme = useThemeChoice();
  const lens = useHashLens();

  const { data, mutate } = useSWR(
    ['/dashboard/api/threads', groupFilter],
    () => listThreads(groupFilter === 'all' ? {} : { group_id: groupFilter }),
    { refreshInterval: 0, dedupingInterval: 500 },
  );
  useSseInvalidation(mutate);

  const { data: groupsData } = useSWR('/dashboard/api/groups', () => listGroups(), { refreshInterval: 0 });
  const groups: GroupSummary[] = groupsData?.groups ?? [];

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
   * the same guard `use-group-filter.ts` applies to a stored group id, for the
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

  const attentionCount = useMemo(
    () => threads.filter((t) => STATE_PRESENTATION[t.state].wantsAttention).length,
    [threads],
  );

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
   * nothing. Close and Snooze are the two actions that are NOT a message, and
   * they live on the detail pane rather than in the queue's verb column.
   */
  const onVerb = useCallback((t: ThreadSummary) => {
    setSelectedId(t.thread_id);
    setFocusComposer((n) => n + 1);
  }, []);

  const onClose = useCallback(
    (t: ThreadSummary) => {
      setNotice(`Closing ${t.title ?? 'thread'}…`);
      closeThread(t)
        .then(() => {
          setNotice(`Closed ${t.title ?? 'thread'}.`);
          void mutate();
        })
        .catch((err: unknown) => setNotice(`Could not close — ${actionError(err)}.`));
    },
    [mutate],
  );

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
   * operator back exactly where they were, scroll position included.
   */
  const savedScroll = useRef(0);
  const enterTriage = useCallback(() => {
    savedScroll.current = listRef.current?.scrollTop ?? 0;
    setTriage(visible);
  }, [visible]);
  const exitTriage = useCallback(() => setTriage(null), []);
  useEffect(() => {
    if (triage === null && listRef.current) listRef.current.scrollTop = savedScroll.current;
  }, [triage]);

  return (
    <div className="ncc">
      <header className="ncc-top">
        <span className="ncc-brand">Observatory</span>
        <select
          className="ncc-select"
          aria-label="Agent group"
          value={groupFilter}
          onChange={(e) => setGroupFilter(e.target.value)}
        >
          <option value="all">all groups</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <span className="ncc-spacer" />
        <input
          className="ncc-search"
          type="search"
          placeholder="Search threads"
          aria-label="Search threads"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {/* §7.2's filled-accent chip, in the product and not only in the test:
            its text token flips to near-black in dark mode. */}
        <span className="ncc-attn-chip" aria-live="polite">
          Needs you <span className="ncc-mono">{attentionCount}</span>
        </span>
        {/* §11: triage is entered FROM the list and is never the home screen. */}
        <button
          type="button"
          className="ncc-solid-btn"
          onClick={enterTriage}
          disabled={visible.length === 0 || triage !== null}
        >
          Triage <span className="ncc-mono">{visible.length}</span>
        </button>
        <button
          type="button"
          className="ncc-solid-btn"
          onClick={theme.cycle}
          aria-label={`Colour theme: ${theme.choice}. Activate to change.`}
        >
          {theme.choice}
        </button>
      </header>

      <div className="ncc-body">
        <nav className="ncc-side" aria-label="Queue and channels">
          <h2 className="ncc-side-head">Queue</h2>
          <LaneButton
            label="All threads"
            count={threads.length}
            active={lane === 'all'}
            onClick={() => setLane('all')}
          />
          {LANE_ORDER.map((state) => (
            <LaneButton
              key={state}
              label={STATE_PRESENTATION[state].label}
              count={laneCounts[state] ?? 0}
              tone={STATE_PRESENTATION[state].tone}
              active={lane === state}
              onClick={() => setLane(state)}
            />
          ))}

          {snoozedCount > 0 && (
            <LaneButton
              label="Snoozed"
              count={snoozedCount}
              active={lane === 'snoozed'}
              onClick={() => setLane('snoozed')}
            />
          )}

          <div className="ncc-side-gap" />
          <h2 className="ncc-side-head">
            <span className="lbl">Channels</span>
            <span className="ncc-mono">{channels.length}</span>
          </h2>
          <LaneButton
            label="All channels"
            count={threads.length}
            active={channel === null}
            onClick={() => setChannel(null)}
          />
          {channels.map((c) => (
            <button
              key={c.key}
              type="button"
              className="ncc-side-item channel"
              aria-pressed={channel === c.key}
              onClick={() => setChannel(channel === c.key ? null : c.key)}
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
          <h2 className="ncc-side-head">Lenses</h2>
          {/* §11: the schedule is a LENS, not a destination — same shell, same
              group filter, a different thing to look at. The floor-plan lens is
              gone with the floor plan itself; a lens with no target is worse
              than no lens. */}
          <a className="ncc-side-item" href="#/console" aria-current={lens === 'threads' ? 'page' : undefined}>
            <span className="lbl">Threads</span>
          </a>
          <a className="ncc-side-item" href="#/scheduled" aria-current={lens === 'schedule' ? 'page' : undefined}>
            <span className="lbl">Schedule</span>
          </a>
        </nav>

        {lens === 'schedule' ? (
          <ScheduleLens groupFilter={groupFilter} groups={groups} />
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
                  /* The two actions that are not a message. Everything else on this
                 screen is the composer below. */
                  <div className="ncc-detail-actions">
                    <button type="button" className="ncc-verb" onClick={() => onToggleSnooze(selected)}>
                      {selected.snoozed ? 'un-snooze' : 'snooze'}
                    </button>
                    <button type="button" className="ncc-verb" onClick={() => onClose(selected)}>
                      close
                    </button>
                  </div>
                )}
                <ThreadDetail thread={selected} focusComposer={focusComposer} onSent={() => void mutate()} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ─── Sidebar lane ─────────────────────────────────────────────────────── */

function LaneButton({
  label,
  count,
  tone,
  active,
  onClick,
}: {
  label: string;
  count: number;
  tone?: 'attention' | 'live' | 'quiet';
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="ncc-side-item" aria-pressed={active} onClick={onClick}>
      <span className="lbl">{label}</span>
      <span className={`n${tone === 'attention' ? ' attention' : tone === 'live' ? ' live' : ''}`}>{count}</span>
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

function useHashLens(): 'threads' | 'schedule' {
  const [lens, setLens] = useState(() => lensForHash(location.hash));
  useEffect(() => {
    const handler = () => setLens(lensForHash(location.hash));
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);
  return lens;
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
