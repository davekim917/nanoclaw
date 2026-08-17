import React, { useState, useEffect, useCallback, useRef } from 'react';
import useSWR from 'swr';
import { getSessionDetail, postSessionMessage, type AuthMe } from '../lib/api.js';
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
 * The steer destination. Reached from the Observatory's room sheet
 * ("open session to steer"), so it wears the same atrium chrome and does
 * exactly one job: show this conversation and let the operator answer it.
 *
 * Deliberately NOT here: dismiss/archive and any link back into the legacy
 * inbox board. Those actions still exist on the inbox itself; on the steer
 * page they were escape hatches into a UI the operator does not use. The
 * only way out of this page is back to the Observatory.
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

  const back = (
    <a className="nc-sd-back" href="#/observatory">
      ← back to the Observatory
    </a>
  );

  if (!data) {
    return (
      <div className="nc-frame nc-of nc-sd">
        <header className="nc-of-bar">{back}</header>
        <div className="nc-empty">loading session…</div>
      </div>
    );
  }

  const s = data.session;
  // Same four-state vocabulary the office floor uses, so a dot means the same
  // thing here as it did on the map the operator arrived from.
  const state = {
    needs_me: { dot: 'blocked', word: 'waiting on you' },
    active: { dot: 'working', word: 'working' },
    stale: { dot: 'waiting', word: 'gone quiet' },
    idle: { dot: 'idle', word: 'idle' },
  }[s.attention_state ?? 'idle'];

  return (
    <div className="nc-frame nc-of nc-sd">
      <header className="nc-of-bar">
        {back}
        <span className="nc-of-bar-meta">
          <span className="nc-of-live">
            <i className={`nc-of-sd ${state.dot}`} />
            {state.word}
          </span>
        </span>
      </header>

      <div className="nc-sd-body">
        <section className="nc-sd-head">
          <h1>{s.title ?? 'Conversation'}</h1>
          <p className="nc-sd-who">
            <b>{s.agent_group_id}</b>
            {s.messaging_group_id && <> in <span className="mono">{s.messaging_group_id}</span></>}
            {s.thread_id && <> · thread <span className="mono">{s.thread_id}</span></>}
          </p>
          <p className="nc-sd-facts">
            <span className="mono">{s.session_id}</span>
            <span>container {s.container_status}</span>
            {s.attached_task_id && <span>on a task ({s.attached_task_status ?? 'attached'})</span>}
            {s.has_pending_recurrence && <span>has scheduled work</span>}
            {s.last_inbound_at && <span>heard {relAge(s.last_inbound_at)} ago</span>}
            {s.last_outbound_at && <span>spoke {relAge(s.last_outbound_at)} ago</span>}
          </p>
        </section>

        <section className="nc-sd-convo">
          <h2>The conversation</h2>
          <TranscriptList entries={data.transcript.map(normalizeSessionEntry)} />
        </section>
      </div>

      <SteerComposer
        text={text}
        onChange={setText}
        onSubmit={handleSubmit}
        submitting={submitting}
        canSubmit={canSubmit}
        tooLong={tooLong}
        submitError={submitError}
        placeholder="Say something to this agent… (⌘↵ to send)"
        sendLabel="Send"
        ariaLabel="Send a message to this session"
      />
    </div>
  );
};
