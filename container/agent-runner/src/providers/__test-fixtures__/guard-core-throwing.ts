/**
 * Throwing-core stub: the named evaluators are functions but throw when called.
 * claude.ts's hooks must catch the throw and fall back to the inline fail-closed
 * policy (not crash the turn). Pointed at via NANOCLAW_DESTRUCTIVE_GUARD_CORE.
 */
export function evaluateSelfApproval(): { action: 'allow' | 'block' } {
  throw new Error('STUB-CORE: evaluateSelfApproval boom');
}
export function evaluateSnowflakeConnector(): { action: 'allow' | 'block' } {
  throw new Error('STUB-CORE: evaluateSnowflakeConnector boom');
}
export function evaluateGitCloneDestination(): { action: 'allow' | 'block' } {
  throw new Error('STUB-CORE: evaluateGitCloneDestination boom');
}
