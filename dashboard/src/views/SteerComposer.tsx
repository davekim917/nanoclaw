import type { FormEvent, KeyboardEvent, RefObject } from 'react';

/**
 * Sticky-bottom steer composer shared by TaskDetail and SessionDetail.
 *
 * Both views used to inline their own form with near-identical markup —
 * the only diffs were the placeholder text and an optional "Worker is
 * asking" prompt when a task has needs_input flipped. This component
 * folds them together so future composer changes (rate-limit hints,
 * draft persistence, attachments, etc.) only land in one place.
 *
 * Visual contract: relies on the existing `.nc-composer` / `.field` /
 * `.row` / `.send` CSS in styles.css — same DOM shape the prior
 * TaskDetail form rendered. SessionDetail loses its old inline
 * `.nc-composer-meta` row in favor of this `.row` structure (the
 * old `.nc-composer-meta` markup wasn't wired up to the sticky-
 * positioning either; matching TaskDetail's `.field` shape gives
 * SessionDetail the sticky behavior for free).
 */

export const MAX_STEER_CHARS = 4000;

interface Props {
  text: string;
  onChange: (v: string) => void;
  onSubmit: (e?: FormEvent) => void | Promise<void>;
  submitting: boolean;
  canSubmit: boolean;
  tooLong: boolean;
  submitError: string | null;
  /**
   * Render an attention banner above the textarea — used by TaskDetail
   * when the spawn worker has flipped needs_input and posted a specific
   * steer question. Passing null hides it entirely (the SessionDetail
   * case; sessions don't carry an explicit steer_question contract).
   */
  needsInputPrompt?: string | null;
  /** Customize placeholder per-surface (task worker vs session). */
  placeholder?: string;
  /** Optional ref so callers can programmatically focus (e.g., after retry). */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  /** Override the send button label. */
  sendLabel?: string;
  /** Aria label for the form element. */
  ariaLabel?: string;
}

export function SteerComposer({
  text,
  onChange,
  onSubmit,
  submitting,
  canSubmit,
  tooLong,
  submitError,
  needsInputPrompt,
  placeholder = 'Send a message… (⌘↵ to send)',
  textareaRef,
  sendLabel = '↪ Send',
  ariaLabel = 'Send a message',
}: Props) {
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void onSubmit();
    }
  };

  return (
    <form className="nc-composer" onSubmit={(e) => void onSubmit(e)} aria-label={ariaLabel}>
      {needsInputPrompt && (
        <div role="note" className="nc-needs-prompt">
          <div className="nc-needs-prompt-label">Worker is asking</div>
          {needsInputPrompt}
        </div>
      )}
      <div className={'field' + (tooLong ? ' over' : '')}>
        <textarea
          {...(textareaRef ? { ref: textareaRef } : {})}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          maxLength={MAX_STEER_CHARS + 100}
          placeholder={placeholder}
          rows={3}
        />
        <div className="row">
          <span className={tooLong ? 'over' : ''}>
            {text.length} / {MAX_STEER_CHARS}
          </span>
          <button type="submit" className="send" disabled={!canSubmit || submitting}>
            {submitting ? 'sending…' : sendLabel}
          </button>
        </div>
      </div>
      {submitError && (
        <div className="nc-error" role="alert">
          {submitError}
        </div>
      )}
    </form>
  );
}
