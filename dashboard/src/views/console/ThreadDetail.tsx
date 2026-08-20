import { useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import { getThreadDetail, type ThreadSummary } from '../../lib/api.js';
import { relAge } from '../../lib/derive.js';
import { AgentAvatar } from '../AgentAvatar.js';
import { sendReply } from './actions.js';
import { STATE_PRESENTATION, initials, replyTarget } from './thread-state.js';

/**
 * The thread detail pane — merged transcript (§10.1) plus the reply composer
 * that DESIGN §10.3's reconciliation lands on.
 *
 * **The composer always names a session.** A thread is N sessions, one per
 * participating agent, and the only steer path that works on an arbitrary
 * thread (`POST /dashboard/api/sessions/:id/message`) writes into exactly one
 * inbound queue. "Reply to this thread" is therefore not a well-formed request,
 * and the target selector is not decoration: it is the request. The default is
 * the agent whose state drove the row's urgency — the one that asked the
 * question, or the one whose container stalled — which the server computes as
 * `reply_target_session_id`.
 *
 * There is deliberately NO broadcast-to-every-participant option. Six agents
 * each receiving "yes, go ahead" in their own queue is six agents acting on it.
 */

export interface ThreadDetailProps {
  thread: ThreadSummary | null;
  /**
   * Bumped by the caller to move focus into the composer — what the row's
   * Answer / Steer verb and triage's `A` key do. `0` means "leave focus
   * alone", which is what a plain row selection passes.
   */
  focusComposer?: number;
  /** Fired after a reply lands, so the caller can revalidate and (in triage) advance. */
  onSent?: (thread: ThreadSummary) => void;
}

export function ThreadDetail({ thread, focusComposer = 0, onSent }: ThreadDetailProps) {
  const { data } = useSWR(
    thread ? ['thread-detail', thread.thread_id, thread.last_activity_at] : null,
    () => getThreadDetail(thread!.thread_id),
    { refreshInterval: 0 },
  );

  if (!thread) {
    return (
      <section className="ncc-detail" aria-label="Thread detail">
        <div className="ncc-empty">select a thread</div>
      </section>
    );
  }

  const presentation = STATE_PRESENTATION[thread.state];
  const sessionCount = thread.session_ids.length;

  return (
    <section className="ncc-detail" aria-label="Thread detail">
      <div className="ncc-detail-head">
        <span className="ncc-faces">
          {thread.participants.slice(0, 3).map((p) => (
            <span className="ncc-face" key={p.agent_group_id} title={p.name}>
              <AgentAvatar name={p.name} initials={initials(p.name)} avatarUrl={p.avatarUrl} size={25} />
            </span>
          ))}
        </span>
        <div style={{ flexGrow: 1, minWidth: 0 }}>
          <h2 className="ncc-detail-title">{thread.title ?? 'Untitled thread'}</h2>
          <div className="ncc-detail-meta">
            <span>{thread.channel_name}</span>
            <span aria-hidden="true">·</span>
            <span>{thread.participants.map((p) => p.name).join(', ') || 'no owner'}</span>
            <span aria-hidden="true">·</span>
            <span>{thread.last_activity_at ? `${relAge(thread.last_activity_at)} ago` : 'no activity'}</span>
          </div>
        </div>
        <span className={`ncc-state ${presentation.tone}`}>{presentation.label}</span>
      </div>

      {/* §10.1: a thread's messages are split across one DB pair per agent, so
          the merge is a real transformation the operator should know about. */}
      <div className="ncc-detail-note">
        Merged from {sessionCount} agent session{sessionCount === 1 ? '' : 's'} on this thread, in timestamp order.
      </div>

      <div className="ncc-transcript">
        {(data?.transcript ?? []).map((m) => (
          <div className={`ncc-msg ${m.direction}`} key={`${m.session_id}:${m.seq}`}>
            <span className="ncc-face">
              <AgentAvatar name={m.agent_name} initials={initials(m.agent_name)} avatarUrl={null} size={24} />
            </span>
            <div className="ncc-msg-body">
              <div className="ncc-msg-who">
                <span className="name">{m.direction === 'out' ? m.agent_name : 'Inbound'}</span>
                <span className="at">{relAge(m.timestamp)} ago</span>
              </div>
              <div className="ncc-msg-text">{m.text}</div>
            </div>
          </div>
        ))}
        {data && data.transcript.length === 0 && <div className="ncc-empty">no messages on this thread</div>}
      </div>

      <ReplyComposer
        key={thread.thread_id}
        thread={thread}
        focusNonce={focusComposer}
        {...(onSent ? { onSent } : {})}
      />
    </section>
  );
}

/* ─── Composer ─────────────────────────────────────────────────────────────── */

export function ReplyComposer({
  thread,
  focusNonce = 0,
  onSent,
}: {
  thread: ThreadSummary;
  focusNonce?: number;
  onSent?: (thread: ThreadSummary) => void;
}) {
  const fallback = useMemo(() => replyTarget(thread), [thread]);
  const [sessionId, setSessionId] = useState<string>(fallback?.session_id ?? '');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  // Zero means "do not touch focus" — a plain row selection. Any other value is
  // an explicit request from a verb or from triage's `A`, and it must fire on
  // MOUNT as well as on change: pressing Answer on a row that was not selected
  // yet mounts this composer for the first time, and a change-only effect would
  // land the operator's cursor nowhere.
  useEffect(() => {
    if (focusNonce === 0) return;
    box.current?.focus();
  }, [focusNonce]);

  if (thread.participants.length === 0) {
    return (
      <div className="ncc-composer">
        <div className="ncc-composer-note">No agent is on this thread — there is no inbound queue to reply into.</div>
      </div>
    );
  }

  const send = async (): Promise<void> => {
    const body = text.trim();
    if (!body || busy || !sessionId) return;
    setBusy(true);
    setError(null);
    try {
      await sendReply(sessionId, body);
      setText('');
      onSent?.(thread);
    } catch (err) {
      setError((err as { error?: string }).error ?? 'send_failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ncc-composer">
      <div className="ncc-composer-target">
        {/* Not decoration — this select IS the request. See the file header. */}
        <label htmlFor={`ncc-target-${thread.thread_id}`}>Reply goes to</label>
        <select
          id={`ncc-target-${thread.thread_id}`}
          className="ncc-select"
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
        >
          {thread.participants.map((p) => (
            <option key={p.session_id} value={p.session_id}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="ncc-composer-hint">only this agent receives it</span>
      </div>
      <div className="ncc-composer-row">
        <textarea
          ref={box}
          className="ncc-composer-box"
          rows={2}
          placeholder="Reply into this agent's queue…"
          aria-label="Reply text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter is a newline. Ctrl/Cmd are left alone so
            // the browser keeps its own bindings.
            if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button type="button" className="ncc-solid-btn" disabled={busy || !text.trim()} onClick={() => void send()}>
          {busy ? 'sending' : 'send'}
        </button>
      </div>
      <div className="ncc-composer-status" role="status" aria-live="polite">
        {error ? `could not send — ${error}` : ''}
      </div>
    </div>
  );
}
