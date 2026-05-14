import React, { useState, useEffect, useCallback, useRef } from 'react';
import useSWR from 'swr';
import {
  getSessionDetail,
  postSessionMessage,
  archiveSession,
  unarchiveSession,
  type AuthMe,
} from '../lib/api.js';
import { subscribe } from '../lib/sse.ts';
import { relAge } from '../lib/derive.js';
import { TranscriptList, normalizeSessionEntry } from './TranscriptList.js';
import { SteerComposer, MAX_STEER_CHARS } from './SteerComposer.js';

interface SessionDetailProps {
  authMe: AuthMe;
  sessionId: string;
}

const MAX_CHARS = MAX_STEER_CHARS;

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

        <h3 style={{ marginTop: 24 }}>Recent messages</h3>
        <TranscriptList entries={data.transcript.map(normalizeSessionEntry)} />
      </div>

      <SteerComposer
        text={text}
        onChange={setText}
        onSubmit={handleSubmit}
        submitting={submitting}
        canSubmit={canSubmit}
        tooLong={tooLong}
        submitError={submitError}
        placeholder="Send a message to this session… (⌘↵ to send)"
        sendLabel="↪ Send"
        ariaLabel="Send a message to this session"
      />
    </div>
  );
};

