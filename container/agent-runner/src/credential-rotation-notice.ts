/**
 * Shared wording for telling a replayed turn that its credential was
 * rotated out from under it. Single-sourced because two providers hit this:
 * `claude.ts` rotates via `ClaudeProvider.rotateApiKey`, and `poll-loop.ts`'s
 * in-turn retry builds the replay prompt with this notice in
 * `formatCredentialRetryPrompt`. `codex.ts` rotates CODEX_HOME identities
 * inline inside its own `query()` generator — the rotation call is
 * `self.rotateCodexHome()` — and appends this notice itself to whatever prompt
 * `resolveCodexRestartTransition` produces for the resumed/restarted thread.
 *
 * Why this exists at all: a rotation replays the SAME conversation history
 * on a healthy credential, but the agent's own prior turn is still sitting
 * in that history — including any "You've hit your usage limit · resets …"
 * text the exhausted credential produced, and any task-notification saying
 * its background subagents were stopped. Without an explicit notice the
 * resumed agent reads its own stale transcript, concludes it is still
 * rate-limited, and schedules a wake for the reset time instead of
 * continuing on the credential that is now serving it fine.
 *
 * The wording is deliberately NOT "you hit a usage limit": poll-loop rotates
 * on every error `ClaudeProvider.isRetryable` accepts (429/rate limit,
 * overloaded, upstream_error, quota) except the ones `isTransientOverload`
 * recognises first, so the failure that triggered the swap may have been an upstream error
 * rather than a limit. The notice therefore names the failure class
 * generically and only asserts what is true on every path: the previous
 * credential failed, this attempt runs on a different one, and any limit text
 * in the history describes the previous credential.
 *
 * Same rule for the subagent sentence. Subagents die with the provider
 * process on both paths — Claude's abort tears the CLI down via
 * `queryAbortController` (fired by the query's `abort()`) and Codex kills the
 * app-server (`killCodexAppServer`) —
 * but neither path signals a process group or verifies descendants, so a
 * backgrounded shell command may outlive the attempt. The notice therefore
 * does NOT claim those were terminated; it tells the agent to check before
 * repeating side-effecting work. Every sentence here must stay at the level
 * the weakest path guarantees.
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
