import React, { useState, useEffect, useCallback, useRef } from 'react';
import useSWR from 'swr';
import { getTask, postSteer, retryTask, archiveTask, unarchiveTask } from '../lib/api.js';
import { subscribe } from '../lib/sse.ts';
import { renderMarkdown } from '../lib/markdown.js';
import { extractGoal, extractLinearId, relAge } from '../lib/derive.js';
import { TranscriptList, normalizeTaskEntry } from './TranscriptList.js';
import { SteerComposer, MAX_STEER_CHARS } from './SteerComposer.js';
import type { AuthMe } from '../lib/api.js';

interface TaskDetailProps {
  authMe: AuthMe;
  taskId: string;
}

const MAX_CHARS = MAX_STEER_CHARS;

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
  // The 5-phase template (Setup/Implement/Verify/Ship/Report) was tied to
  // the spawn-template's ticket-shipping flow. Most spawn tasks today
  // don't fit that shape (Linear updates, data investigations, ad-hoc
  // SQL), so the tracker was empty more often than not. Removed — the
  // status pill + last_progress_message + result_summary + transcript
  // already cover everything the timeline tried to add.

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
          {(task.status === 'failed' ||
            task.status === 'completed' ||
            task.status === 'cancelled') &&
            (task.archived_at ? (
              <button
                className="nc-btn ghost"
                onClick={() => {
                  void unarchiveTask(taskId).finally(() => void mutate());
                }}
              >
                ↩ Unarchive
              </button>
            ) : (
              <button
                className="nc-btn ghost"
                onClick={() => {
                  void archiveTask(taskId).finally(() => void mutate());
                }}
              >
                × Dismiss
              </button>
            ))}
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

        {/* Result section — only when there's a result_summary or
            fail_reason to render. The old phase-timeline view was tied to
            the spawn-template's ticket-shipping shape and most tasks
            don't fit it. */}
        {(task.result_summary || task.fail_reason) && (
          <div className="nc-section">
            <div className="nc-section-head open" style={{ cursor: 'default' }}>
              <span>Result</span>
              <span className="chev">›</span>
            </div>
            <div className="nc-section-body">
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
        )}

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
              <TranscriptList entries={transcript.map(normalizeTaskEntry)} />
            </div>
          )}
        </div>
      </div>

      {/* Sticky composer */}
      <SteerComposer
        text={text}
        onChange={setText}
        onSubmit={handleSubmit}
        submitting={false}
        canSubmit={canSubmit}
        tooLong={tooLong}
        submitError={submitError}
        needsInputPrompt={needsInput ? task.steer_question ?? null : null}
        placeholder={needsInput ? 'Answer the worker… (⌘↵ to send)' : 'Steer the worker… (⌘↵ to send)'}
        textareaRef={composerRef}
        sendLabel="↪ Send steer"
        ariaLabel="Steer the task"
      />
    </div>
  );
};

