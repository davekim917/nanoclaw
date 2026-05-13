import React, { useState, useEffect, useCallback, useRef } from 'react';
import useSWR from 'swr';
import {
  getSessionDetail,
  postSessionMessage,
  archiveSession,
  unarchiveSession,
  type AuthMe,
  type SessionTranscriptEntry,
} from '../lib/api.js';
import { subscribe } from '../lib/sse.ts';
import { relAge } from '../lib/derive.js';
import { renderMarkdown } from '../lib/markdown.js';

interface SessionDetailProps {
  authMe: AuthMe;
  sessionId: string;
}

const MAX_CHARS = 4000;

/**
 * Per-session detail page mirroring TaskDetail's shape: header with key
 * meta + steer composer + recent transcript. Lives at `#/session/:id`,
 * navigated from the inbox board's session cards. Direct-conversation
 * sessions (no attached task) only have this route — they don't slot into
 * the TaskDetail flow.
 *
 * Steer composer posts to `POST /dashboard/api/sessions/:id/message` via
 * `postSessionMessage`. The C5 generalized steer handler does the rest:
 * writes the inbound row, wakes the container, echoes the message into
 * the session's originating Slack/Discord thread when the session is
 * wired to a chat surface.
 */
export const SessionDetail: React.FC<SessionDetailProps> = ({ authMe: _authMe, sessionId }) => {
  const { data, mutate } = useSWR(`/dashboard/api/sessions/${sessionId}`, () => getSessionDetail(sessionId));
  const invalidate = useCallback(() => {
    void mutate();
  }, [mutate]);

  // SSE: any session_event for this id triggers a refetch. Same trailing-edge
  // debounce pattern as InboxBoard so a streaming-status burst coalesces.
  const debounceRef = useRef<number | null>(null);
  const scheduleInvalidate = useCallback(() => {
    if (debounceRef.current !== null) return;
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      invalidate();
    }, 300);
  }, [invalidate]);
  useEffect(() => {
    const unsub = subscribe<{ session_id?: string | null }>('session_event', (payload) => {
      if (payload.session_id == null || payload.session_id === sessionId) scheduleInvalidate();
    });
    return () => {
      unsub();
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [scheduleInvalidate, sessionId]);

  const [text, setText] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const tooLong = text.length > MAX_CHARS;
  const isEmpty = !text.trim();
  const canSubmit = !isEmpty && !tooLong && !submitting;

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      await postSessionMessage(sessionId, { idempotency_key: idempotencyKey, text });
      setText('');
      setIdempotencyKey(crypto.randomUUID());
      void mutate();
    } catch (err: unknown) {
      const e2 = err as { error?: string; status?: number };
      setSubmitError(e2.error ?? 'send_failed');
    } finally {
      setSubmitting(false);
    }
  };

  const onBack = () => {
    location.hash = '#/inbox';
  };

  if (!data) {
    return (
      <div className="nc-frame">
        <header className="nc-pulse">
          <div className="nc-pulse-top">
            <div className="nc-brand">
              <span className="mark" aria-hidden="true"></span>
              <button type="button" className="nav-link" onClick={onBack}>
                ← Inbox
              </button>
            </div>
          </div>
        </header>
        <div className="nc-empty">loading session…</div>
      </div>
    );
  }

  const s = data.session;
  const isArchived = s.archived_at != null;

  return (
    <div className="nc-frame">
      <header className="nc-pulse">
        <div className="nc-pulse-top">
          <div className="nc-brand">
            <span className="mark" aria-hidden="true"></span>
            <button type="button" className="nav-link" onClick={onBack}>
              ← Inbox
            </button>
          </div>
          <nav className="nc-pulse-actions">
            {isArchived ? (
              <button
                type="button"
                className="nav-link"
                onClick={async () => {
                  await unarchiveSession(sessionId);
                  void mutate();
                }}
              >
                ↩ Unarchive
              </button>
            ) : (
              <button
                type="button"
                className="nav-link"
                onClick={async () => {
                  await archiveSession(sessionId);
                  void mutate();
                }}
              >
                Dismiss
              </button>
            )}
          </nav>
        </div>
      </header>

      <div className="nc-task-detail">
        <h2>{s.title ?? s.session_id}</h2>
        <div className="nc-meta-row">
          <span className="nc-pill">{s.attention_state ?? 'idle'}</span>
          <span className="nc-pill">container · {s.container_status}</span>
          <span className="nc-pill">{s.agent_group_id}</span>
          {s.has_pending_recurrence && <span className="nc-pill">⏰ scheduled</span>}
          {s.attached_task_id && (
            <button
              type="button"
              className="nc-pill"
              onClick={() => {
                location.hash = `#/task/${s.attached_task_id}`;
              }}
              title="Open attached task"
            >
              task · {s.attached_task_status ?? 'attached'}
            </button>
          )}
        </div>
        <div className="nc-meta-row" style={{ color: 'var(--fg-3)', fontSize: 12 }}>
          {s.last_inbound_at && <span>last inbound {relAge(s.last_inbound_at)} ago</span>}
          {s.last_outbound_at && (
            <span>
              · last outbound {relAge(s.last_outbound_at)} ago
              {s.last_outbound_kind?.startsWith('chat-sdk:') ? ` (${s.last_outbound_kind.slice(9)})` : ''}
            </span>
          )}
        </div>

        <SessionComposer
          text={text}
          onChange={setText}
          onSubmit={handleSubmit}
          submitting={submitting}
          canSubmit={canSubmit}
          tooLong={tooLong}
          submitError={submitError}
        />

        <h3 style={{ marginTop: 24 }}>Recent messages</h3>
        {data.transcript.length === 0 && <div className="nc-empty">no messages yet</div>}
        <ul className="nc-transcript">
          {groupTranscript(data.transcript).map((group, idx) =>
            group.kind === 'thinking' ? (
              <ThinkingGroupRow key={`thinking-${group.entries[0]!.seq}-${idx}`} entries={group.entries} />
            ) : (
              <TranscriptRow key={`${group.entry.direction}-${group.entry.seq}`} entry={group.entry} />
            ),
          )}
        </ul>
      </div>
    </div>
  );
};

function SessionComposer({
  text,
  onChange,
  onSubmit,
  submitting,
  canSubmit,
  tooLong,
  submitError,
}: {
  text: string;
  onChange: (v: string) => void;
  onSubmit: (e?: React.FormEvent) => void;
  submitting: boolean;
  canSubmit: boolean;
  tooLong: boolean;
  submitError: string | null;
}) {
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSubmit();
    }
  };
  return (
    <form onSubmit={onSubmit} className="nc-composer">
      <textarea
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKey}
        placeholder="Send a message to this session… (⌘/Ctrl+Enter)"
        rows={3}
      />
      <div className="nc-composer-meta">
        <span style={{ color: tooLong ? 'var(--st-failed)' : 'var(--fg-3)' }}>
          {text.length}/{MAX_CHARS}
        </span>
        {submitError && <span style={{ color: 'var(--st-failed)' }}>{submitError}</span>}
        <button type="submit" disabled={!canSubmit} className="nc-btn">
          {submitting ? 'sending…' : 'send'}
        </button>
      </div>
    </form>
  );
}

/**
 * Returns true when an outbound entry is one of the agent's "thinking"
 * status updates — kind=status with the `> 💭` block-quote prefix that
 * Claude Code emits between tool calls. These pile up between real chat
 * responses and clutter the transcript when reviewing past sessions; the
 * inbox UX collapses contiguous runs of them into one expandable block.
 */
function isThinking(entry: SessionTranscriptEntry): boolean {
  if (entry.direction !== 'out') return false;
  if (entry.kind !== 'status') return false;
  // The leading `> 💭` quote prefix is the canonical thinking marker the
  // agent-runner emits. Match leniently in case of trailing whitespace.
  return /^>\s*💭/.test(entry.text.trim());
}

type TranscriptGroup =
  | { kind: 'entry'; entry: SessionTranscriptEntry }
  | { kind: 'thinking'; entries: SessionTranscriptEntry[] };

/**
 * Walk the transcript (newest-first from the API) and coalesce contiguous
 * thinking entries into a single group. Non-thinking entries (chat messages,
 * inbound user messages) each become their own single-entry group. The
 * caller renders thinking groups as a collapsed `<details>` and individual
 * entries via the normal row component.
 */
function groupTranscript(entries: SessionTranscriptEntry[]): TranscriptGroup[] {
  const out: TranscriptGroup[] = [];
  for (const e of entries) {
    if (isThinking(e)) {
      const last = out[out.length - 1];
      if (last && last.kind === 'thinking') {
        last.entries.push(e);
        continue;
      }
      out.push({ kind: 'thinking', entries: [e] });
    } else {
      out.push({ kind: 'entry', entry: e });
    }
  }
  return out;
}

const TRUNCATE_AT = 800;

function TranscriptRow({ entry }: { entry: SessionTranscriptEntry }) {
  const isInbound = entry.direction === 'in';
  const isLong = entry.text.length > TRUNCATE_AT;

  // `<details>` gives us free expand/collapse semantics — no React state,
  // keyboard-accessible, browser-remembered if the user scrolls away. The
  // `open` attribute is set by default for short messages so they render
  // exactly as before; long messages get a collapsed preview + a "show
  // more" affordance built into the summary.
  const previewSrc = isLong ? entry.text.slice(0, TRUNCATE_AT) : entry.text;
  const previewHtml = renderMarkdown(previewSrc);
  const fullHtml = isLong ? renderMarkdown(entry.text) : null;

  return (
    <li className={`nc-transcript-row ${isInbound ? 'inbound' : 'outbound'}`}>
      <div className="nc-transcript-meta">
        <span className="nc-pill">{isInbound ? '→ in' : '← out'}</span>
        <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>{entry.kind}</span>
        <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>{relAge(entry.timestamp)} ago</span>
      </div>
      {isLong ? (
        <details className="nc-transcript-expand">
          <summary>
            <div
              className="nc-transcript-text nc-md"
              dangerouslySetInnerHTML={{ __html: previewHtml + '<span class="nc-truncate-ellipsis">…</span>' }}
            />
            <span className="nc-transcript-more">show full message ({entry.text.length} chars)</span>
          </summary>
          <div className="nc-transcript-text nc-md" dangerouslySetInnerHTML={{ __html: fullHtml ?? '' }} />
        </details>
      ) : (
        <div className="nc-transcript-text nc-md" dangerouslySetInnerHTML={{ __html: previewHtml }} />
      )}
    </li>
  );
}

/**
 * Collapsible group of consecutive thinking status updates. Default
 * closed; opening reveals every individual entry's text. Each entry
 * inside the group is itself markdown-rendered (Claude's thinking blocks
 * often contain bullets / nested quoted lines) and individually
 * timestamp-tagged so the operator can correlate with adjacent chat
 * messages.
 */
function ThinkingGroupRow({ entries }: { entries: SessionTranscriptEntry[] }) {
  const label = entries.length === 1 ? '1 thinking step' : `${entries.length} thinking steps`;
  return (
    <li className="nc-transcript-row outbound nc-transcript-thinking">
      <details>
        <summary>
          <span className="nc-pill">💭 {label}</span>
          <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>
            {relAge(entries[entries.length - 1]!.timestamp)} → {relAge(entries[0]!.timestamp)} ago
          </span>
        </summary>
        <div className="nc-thinking-list">
          {entries.map((e) => (
            <div key={`${e.seq}`} className="nc-thinking-entry">
              <div style={{ color: 'var(--fg-3)', fontSize: 11, marginBottom: 4 }}>
                {relAge(e.timestamp)} ago
              </div>
              <div className="nc-transcript-text nc-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(e.text) }} />
            </div>
          ))}
        </div>
      </details>
    </li>
  );
}
