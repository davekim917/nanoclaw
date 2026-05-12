import React, { useState, useEffect, useCallback, useRef } from 'react';
import useSWR from 'swr';
import { getTask, postSteer, retryTask } from '../lib/api.js';
import { subscribe } from '../lib/sse.ts';
import { renderMarkdown } from '../lib/markdown.js';
import {
  extractGoal,
  extractLinearId,
  buildPhaseTimeline,
  relAge,
  textOfEntry,
} from '../lib/derive.js';
import type { AuthMe, TranscriptEntry } from '../lib/api.js';

interface TaskDetailProps {
  authMe: AuthMe;
  taskId: string;
}

const MAX_CHARS = 4000;

export const TaskDetail: React.FC<TaskDetailProps> = ({
  authMe: _authMe,
  taskId,
}) => {
  const { data, mutate } = useSWR(`/dashboard/api/tasks/${taskId}`, () =>
    getTask(taskId)
  );
  const invalidate = useCallback(() => { void mutate(); }, [mutate]);

  const childSessionId = data?.task?.child_session_id;
  useEffect(() => {
    const unsub = subscribe<{ task_id?: string; child_session_id?: string }>(
      'inbound_message',
      (payload) => {
        if (payload.task_id === taskId) {
          invalidate();
          return;
        }
        if (childSessionId && payload.child_session_id === childSessionId) {
          invalidate();
        }
      }
    );
    return unsub;
  }, [invalidate, taskId, childSessionId]);

  useEffect(() => {
    const unsub = subscribe<{ task_id?: string }>('task_event', (payload) => {
      if (!payload.task_id || payload.task_id === taskId) invalidate();
    });
    return unsub;
  }, [invalidate, taskId]);

  const [text, setText] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() =>
    crypto.randomUUID()
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retryAdmittedKey, setRetryAdmittedKey] = useState<string | null>(null);
  const [briefOpen, setBriefOpen] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const tooLong = text.length > MAX_CHARS;
  const isEmpty = !text.trim();
  const canSubmit = !isEmpty && !tooLong && !submitting;

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      await postSteer(taskId, { idempotency_key: idempotencyKey, text });
      setText('');
      setIdempotencyKey(crypto.randomUUID());
      void mutate();
    } catch (err: unknown) {
      const apiErr = err as {
        status?: number;
        error?: string;
        retry_after?: number;
      };
      if (apiErr.status === 422) {
        setSubmitError('Idempotency conflict; please try again.');
        setIdempotencyKey(crypto.randomUUID());
        setText('');
      } else if (apiErr.status === 429) {
        const retryAfter = apiErr.retry_after ?? 60;
        setSubmitError(`Rate limited; try again in ${retryAfter}s`);
      } else {
        setSubmitError('Send failed. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      void handleSubmit();
    }
  };

  const handleRetry = async () => {
    if (retrying) return;
    setRetryError(null);
    setRetryAdmittedKey(null);
    setRetrying(true);
    try {
      const res = await retryTask(taskId);
      setRetryAdmittedKey(res.idempotency_key);
      void mutate();
    } catch (err: unknown) {
      const apiErr = err as {
        status?: number;
        error?: string;
        message?: string;
      };
      if (apiErr.status === 409) {
        setRetryError('Task is no longer in a retryable state.');
      } else if (apiErr.status === 410) {
        setRetryError(
          'Original orchestrator session is gone — cannot retry from here.'
        );
      } else {
        setRetryError(apiErr.message ?? 'Retry failed. Please try again.');
      }
    } finally {
      setRetrying(false);
    }
  };

  const focusComposer = () => {
    composerRef.current?.focus();
    composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  if (!data?.task) {
    return (
      <div style={{ padding: 16, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        Loading…
      </div>
    );
  }

  const task = data.task;
  const transcript = data.transcript ?? [];
  const goal = extractGoal(task.task_content);
  const linearId = extractLinearId(task.task_content);
  const phases = buildPhaseTimeline(task, transcript);
  const currentPhase = phases.findIndex((p) => p.status === 'active') + 1;
  const lastDonePhase = phases.filter((p) => p.status === 'done').length;
  const displayPhase = task.status === 'running' ? Math.max(currentPhase, 1) : lastDonePhase || 1;

  const startedAge = task.started_at ? relAge(task.started_at) : null;
  const needsInput = !!task.needs_input;
  const goBack = () => { location.hash = '#/board'; };

  return (
    <div className="nc-frame" style={{ paddingBottom: 0 }}>
      <div className="nc-detail-header">
        <div className="nc-detail-nav">
          <button className="back" onClick={goBack}>← Board</button>
          <span className="crumb-id">{task.task_id.slice(0, 18)}…</span>
        </div>
        <h1 className="nc-detail-title">
          {linearId && <span className="ticket">{linearId}</span>}
          {goal}
        </h1>
        <div className="nc-detail-meta">
          <span className={`status-chip ${needsInput ? 'failed' : task.status}`}>
            ● {needsInput ? 'NEEDS YOU · STEER REQUESTED' : task.status.toUpperCase()}
          </span>
          {startedAge && <span>started {startedAge} ago</span>}
          {task.status === 'running' && !needsInput && (
            <span>phase {displayPhase} / 5</span>
          )}
          {linearId && (
            <a
              className="meta-link"
              style={{ color: 'var(--fg-2)', borderBottom: '1px dashed var(--line-2)' }}
              href={`https://linear.app/illysium/issue/${linearId}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              Linear ↗
            </a>
          )}
        </div>
        <div className="nc-detail-actions">
          {task.status === 'running' && (
            <button className="nc-btn" onClick={focusComposer}>
              ↪ Steer worker
            </button>
          )}
          {(task.status === 'failed' || task.status === 'cancelled') && (
            <button
              className="nc-btn primary"
              onClick={() => void handleRetry()}
              disabled={retrying}
            >
              {retrying ? 'Re-spawning…' : '↻ Retry task'}
            </button>
          )}
        </div>
        {retryAdmittedKey && (
          <div className="nc-success">
            Re-spawned successfully. New task admitted.
          </div>
        )}
        {retryError && (
          <div className="nc-error" role="alert">
            {retryError}
          </div>
        )}
      </div>

      <div className="nc-detail-body">
        {/* Brief — collapsed by default */}
        <div className="nc-section">
          <button
            className={'nc-section-head' + (briefOpen ? ' open' : '')}
            onClick={() => setBriefOpen((v) => !v)}
            aria-expanded={briefOpen}
          >
            <span>
              Brief <span className="meta">· you wrote this</span>
            </span>
            <span className="chev">›</span>
          </button>
          {briefOpen && (
            <div className="nc-section-body">
              <div
                className="md"
                dangerouslySetInnerHTML={{
                  __html: renderMarkdown(task.task_content),
                }}
              />
            </div>
          )}
        </div>

        {/* Progress — always open */}
        <div className="nc-section">
          <div className="nc-section-head open" style={{ cursor: 'default' }}>
            <span>
              Progress{' '}
              <span className="meta">
                · phase {displayPhase} of 5
              </span>
            </span>
            <span className="chev">›</span>
          </div>
          <div className="nc-section-body">
            <PhaseTimeline phases={phases} />
            {task.result_summary && (
              <div className={`nc-result ${task.status === 'failed' ? 'failed' : ''}`}>
                <div
                  className="md"
                  dangerouslySetInnerHTML={{
                    __html: renderMarkdown(task.result_summary),
                  }}
                />
              </div>
            )}
            {task.fail_reason && (
              <div className="nc-card-pillrow" style={{ marginTop: 8 }}>
                <span className="nc-pill failed">{task.fail_reason}</span>
              </div>
            )}
          </div>
        </div>

        {/* Transcript — collapsed by default */}
        <div className="nc-section">
          <button
            className={'nc-section-head' + (transcriptOpen ? ' open' : '')}
            onClick={() => setTranscriptOpen((v) => !v)}
            aria-expanded={transcriptOpen}
          >
            <span>
              Transcript <span className="meta">· {transcript.length} turns</span>
            </span>
            <span className="chev">›</span>
          </button>
          {transcriptOpen && (
            <div className="nc-section-body" style={{ paddingTop: 4 }}>
              {transcript.length === 0 && (
                <div className="nc-empty" style={{ margin: '8px 0' }}>
                  no transcript yet
                </div>
              )}
              {transcript.map((entry) => (
                <TranscriptBubble key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Sticky composer */}
      <form
        className="nc-composer"
        onSubmit={(e) => void handleSubmit(e)}
        aria-label="Steer the task"
      >
        {needsInput && task.steer_question && (
          <div role="note" className="nc-needs-prompt">
            <div className="nc-needs-prompt-label">Worker is asking</div>
            {task.steer_question}
          </div>
        )}
        <div className={'field' + (tooLong ? ' over' : '')}>
          <textarea
            ref={composerRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            maxLength={MAX_CHARS + 100}
            placeholder={needsInput ? 'Answer the worker… (⌘↵ to send)' : 'Steer the worker… (⌘↵ to send)'}
            rows={3}
          />
          <div className="row">
            <span className={tooLong ? 'over' : ''}>
              {text.length} / {MAX_CHARS}
            </span>
            <button type="submit" className="send" disabled={!canSubmit}>
              ↪ Send steer
            </button>
          </div>
        </div>
        {submitError && (
          <div className="nc-error" role="alert">
            {submitError}
          </div>
        )}
      </form>
    </div>
  );
};

function PhaseTimeline({
  phases,
}: {
  phases: ReturnType<typeof buildPhaseTimeline>;
}) {
  return (
    <div className="nc-timeline">
      {phases.map((p) => (
        <div key={p.phase} className={`step ${p.status}`}>
          <div className="phase-label">
            Phase {p.phase} · {p.label}
            {p.timestamp && (
              <span className="phase-time"> · {relAge(p.timestamp)} ago</span>
            )}
          </div>
          {p.message ? (
            <div className="phase-msg">{p.message}</div>
          ) : (
            <div
              className="phase-msg"
              style={{ color: 'var(--fg-4)', fontStyle: 'italic' }}
            >
              {p.status === 'active' ? 'in progress' : 'pending'}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function TranscriptBubble({ entry }: { entry: TranscriptEntry }) {
  const text = textOfEntry(entry);
  const who: 'agent' | 'dashboard' | 'system' =
    entry.source === 'dashboard'
      ? 'dashboard'
      : entry.source === 'system'
        ? 'system'
        : 'agent';
  const ts = (() => {
    const ms = Date.parse(entry.timestamp);
    if (Number.isNaN(ms)) return entry.timestamp;
    return relAge(entry.timestamp) + ' ago';
  })();
  return (
    <div className={`nc-msg ${who}`}>
      <div className="who">
        <span className="name">{entry.source}</span>
        <span>{entry.direction}</span>
        <span className="when">{ts}</span>
      </div>
      <div
        className="md"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
      />
    </div>
  );
}

