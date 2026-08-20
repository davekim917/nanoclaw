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
import { subscribe } from '../../lib/sse.ts';
import { useGroupFilter } from '../../lib/use-group-filter.js';
import { closeThread, setSnoozed } from './actions.js';
import { ThreadDetail } from './ThreadDetail.js';
import { ThreadRow, type ThreadPreview } from './ThreadRow.js';
import { TriagePanel } from './TriagePanel.js';
import { LANE_ORDER, STATE_PRESENTATION, urgencyRank } from './thread-state.js';

/**
 * The Observatory console — `#/console`.
 *
 * Lives ALONGSIDE the legacy Observatory / inbox / workgroup routes; retiring
 * those is Phase 4. Backed entirely by `GET /dashboard/api/threads`, whose row
 * is a thread rather than a session (DESIGN.md §3.1).
 *
 * Refresh is push-only. There is no polling loop here and must not be one: the
 * host already emits `session_event` over SSE for every inbound write, outbound
 * delivery and container-state transition, so a timer would only add cost. The
 * debounce below is the same trailing-edge pattern InboxBoard uses, for the same
 * reason — a streaming burst emits dozens of frames per turn.
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

/**
 * `snoozed` is a pseudo-lane, NOT an eighth state: a snooze is this operator's
 * own view decision and a thread can be snoozed while it is running. It is a
 * lane rather than a silent filter so a snoozed thread is always reachable —
 * hiding work with no way back is how a queue starts lying.
 */
type Lane = ThreadState | 'all' | 'snoozed';
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
  const [channel, setChannel] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusComposer, setFocusComposer] = useState(0);
  const [triage, setTriage] = useState<ThreadSummary[] | null>(null);
  const [notice, setNotice] = useState('');
  const theme = useThemeChoice();

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
      .sort(
        (a, b) =>
          urgencyRank(a.state) - urgencyRank(b.state) ||
          activityMs(b.last_activity_at) - activityMs(a.last_activity_at),
      );
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

  const laneLabel =
    lane === 'all' ? 'All threads' : lane === 'snoozed' ? 'Snoozed' : STATE_PRESENTATION[lane].label;
  const selected = visible.find((t) => t.thread_id === selectedId) ?? null;

  /**
   * The row's ONE verb (§5). Exactly two of the seven have a backing endpoint
   * today — `compose` (Answer / Steer, through the session-message path) and
   * `close` (archive every session on the thread). The other three render
   * inert with their reason; `STATE_PRESENTATION` owns that decision, and the
   * row never calls this for them.
   */
  const onVerb = useCallback(
    (t: ThreadSummary) => {
      const action = STATE_PRESENTATION[t.state].action;
      if (action === 'compose') {
        setSelectedId(t.thread_id);
        setFocusComposer((n) => n + 1);
        return;
      }
      if (action === 'close') {
        setNotice(`Closing ${t.title ?? 'thread'}…`);
        closeThread(t)
          .then(() => {
            setNotice(`Closed ${t.title ?? 'thread'}.`);
            void mutate();
          })
          .catch((err: { error?: string }) => setNotice(`Could not close — ${err.error ?? 'request failed'}.`));
      }
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
        .catch((err: { error?: string }) => setNotice(`Could not snooze — ${err.error ?? 'request failed'}.`));
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
          <LaneButton label="All threads" count={threads.length} active={lane === 'all'} onClick={() => setLane('all')} />
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
          <LaneButton label="All channels" count={threads.length} active={channel === null} onClick={() => setChannel(null)} />
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
          {/* §11: the floor plan and the schedule are LENSES, not destinations.
              Phase 2 points them at the surfaces that already render them;
              folding them into this shell is later work. */}
          <a className="ncc-side-item" href="#/observatory">
            <span className="lbl">Floor plan</span>
          </a>
          <a className="ncc-side-item" href="#/observatory">
            <span className="lbl">Schedule</span>
          </a>
        </nav>

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
          {visible.length === 0 && <div className="ncc-empty">no threads in view</div>}
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
              <div className="ncc-detail-actions">
                <button type="button" className="ncc-verb" onClick={() => onToggleSnooze(selected)}>
                  {selected.snoozed ? 'un-snooze' : 'snooze'}
                </button>
              </div>
            )}
            <ThreadDetail thread={selected} focusComposer={focusComposer} onSent={() => void mutate()} />
          </div>
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

/** The actual last message as `Speaker: excerpt` (§4). */
export function lastMessagePreview(transcript: ThreadTranscriptEntry[] | undefined): ThreadPreview | null {
  const last = transcript?.[transcript.length - 1];
  if (!last || !last.text.trim()) return null;
  const text = last.text.replace(/\s+/g, ' ').trim();
  return {
    // Inbound carries no author on the wire — the transcript records a
    // direction, not a human. Naming one would be an invention.
    speaker: last.direction === 'out' ? last.agent_name : '',
    excerpt: text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}…` : text,
  };
}

/* ─── Plumbing ─────────────────────────────────────────────────────────── */

function activityMs(iso: string | null): number {
  return iso ? new Date(iso).getTime() : 0;
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
