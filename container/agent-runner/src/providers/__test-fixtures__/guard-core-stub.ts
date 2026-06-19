/**
 * Test stub for claude.ts's destructive-core delegation (loadCoreEvaluator).
 *
 * The REAL core (block-destructive-core.ts) lives in the bootstrap repo and its
 * verdict accuracy is validated there. This stub exists only to drive claude.ts's
 * WIRING — that the hooks import the named evaluators and map a non-`allow`
 * verdict to a deny. Pointed at via NANOCLAW_DESTRUCTIVE_GUARD_CORE.
 *
 * Each evaluator returns a deterministic verdict keyed on a sentinel string so a
 * test can prove the verdict came from THIS module (distinct reason text) rather
 * than the inline fallback.
 */
export function evaluateSelfApproval(command: string): { action: 'allow' | 'block'; reason?: string } {
  if (command.includes('STUB_SELF_APPROVAL')) {
    return { action: 'block', reason: 'STUB-CORE: self-approval blocked' };
  }
  return { action: 'allow' };
}

export function evaluateSnowflakeConnector(command: string): { action: 'allow' | 'block'; reason?: string } {
  if (command.includes('STUB_SNOWFLAKE')) {
    return { action: 'block', reason: 'STUB-CORE: snowflake connector blocked' };
  }
  return { action: 'allow' };
}

export function evaluateGitCloneDestination(command: string): { action: 'allow' | 'block'; reason?: string } {
  if (command.includes('STUB_GIT_CLONE')) {
    return { action: 'block', reason: 'STUB-CORE: git clone blocked' };
  }
  return { action: 'allow' };
}
