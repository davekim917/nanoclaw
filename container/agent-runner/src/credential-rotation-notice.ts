/**
 * Notice for a turn replayed on a rotated credential. Without it the agent reads
 * the exhausted credential's "usage limit · resets …" text in its own history
 * and schedules a wake instead of continuing. Every sentence must hold on the
 * weakest path: rotation also fires on retryable non-limit errors, and neither
 * provider verifies that backgrounded shell commands died with the attempt.
 */

export interface CredentialRotationInfo {
  /** 1-based position of the credential now active (primary is 1). */
  position: number;
  ringSize: number;
}

/** Emit only when a rotation actually happened, never for a plain retry. */
export function formatCredentialRotationNotice(info: CredentialRotationInfo): string {
  return (
    '<runner-credential-rotation>\n' +
    'The previous attempt at this batch was interrupted by an upstream failure on the credential it was running on ' +
    '(a usage limit, or a retryable API error such as an overload or upstream error). ' +
    `The runner rotated to a different credential (slot ${info.position} of ${info.ringSize}) and this attempt is running on it.\n` +
    'Any "You\'ve hit your … limit · resets …" text in your conversation history describes the PREVIOUS credential ' +
    'and does not apply to this attempt: do not pause, schedule a wake, or wait for a reset because of it.\n' +
    'Subagents launched by the previous attempt (Agent tool, including run_in_background) died with it; their ' +
    'partial work on disk survives. Backgrounded shell commands are different: the runner does not verify whether ' +
    'they survived, so check (process list, output files) before re-running anything with side effects. ' +
    'Inspect what landed, then re-dispatch only what is still needed.\n' +
    '</runner-credential-rotation>'
  );
}
