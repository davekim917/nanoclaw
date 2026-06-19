/**
 * Malformed-core stub: the named evaluators are present but NOT functions
 * (wrong export shape). claude.ts's loadCoreEvaluator must reject this via its
 * `typeof === 'function'` check and fall back to the inline fail-closed policy.
 * Pointed at via NANOCLAW_DESTRUCTIVE_GUARD_CORE.
 */
export const evaluateSelfApproval = 'not-a-function';
export const evaluateSnowflakeConnector = 42;
export const evaluateGitCloneDestination = null;
