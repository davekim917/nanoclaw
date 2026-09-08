/**
 * Shared wording for telling a replayed turn that its credential was
 * rotated out from under it. Single-sourced because two providers hit this:
 * `claude.ts` rotates through `poll-loop.ts`'s in-turn retry (the retry
 * prompt is built there — see `formatCredentialRetryPrompt`), and
 * `codex.ts` rotates CODEX_HOME identities inline inside its own `query()`
 * generator and re-prompts the resumed thread itself.
 *
 * Why this exists at all: a rotation replays the SAME conversation history
 * on a healthy credential, but the agent's own prior turn is still sitting
 * in that history — including any "You've hit your usage limit · resets …"
 * text the exhausted credential produced, and any task-notification saying
 * its background subagents were stopped. Without an explicit notice the
 * resumed agent reads its own stale transcript, concludes it is still
 * rate-limited, and schedules a wake for the reset time instead of
 * continuing on the credential that is now serving it fine.
 */

export interface CredentialRotationInfo {
  /** 1-based position of the credential now active (primary is 1). */
  position: number;
  /** Total number of credentials in the rotation pool. */
  ringSize: number;
}

/**
 * Wrap a `<runner-credential-rotation>` notice around the given info.
 * Callers emit this only when a rotation actually happened — never for a
 * fresh turn or a retry that didn't involve swapping credentials.
 */
export function formatCredentialRotationNotice(info: CredentialRotationInfo): string {
  return (
    '<runner-credential-rotation>\n' +
    'The previous attempt at this batch was interrupted because the credential it ran on hit a usage limit. ' +
    `The runner rotated to a different credential (slot ${info.position} of ${info.ringSize}) and this attempt is running on it.\n` +
    'You are NOT rate-limited now. Any "You\'ve hit your … limit · resets …" text in your conversation history is ' +
    'stale and does not apply to this attempt: do not pause, schedule a wake, or wait for a reset because of it.\n' +
    'Any background subagents (Agent tool with run_in_background, or backgrounded shell commands) launched before ' +
    'the interruption were terminated with the previous attempt. Their partial work on disk survives; they are not ' +
    'running. Inspect what landed, then re-dispatch whatever is still needed.\n' +
    '</runner-credential-rotation>'
  );
}
