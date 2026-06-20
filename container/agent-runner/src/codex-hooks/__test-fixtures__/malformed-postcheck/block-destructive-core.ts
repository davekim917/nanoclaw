/**
 * Malformed POST-CHECK fixture: the initial evaluateBashCommand returns a
 * well-formed `gate` verdict (so it reaches the approval path), consumeGateApproval
 * returns true (so the post-approval skipGate re-check fires), and the skipGate
 * re-check returns a MALFORMED verdict. runDestructiveGuard must DENY on the
 * malformed post-check, not fall through to allow. QA codex re-pass #2.
 *
 * Pointed at via NANOCLAW_DESTRUCTIVE_GUARD_CORE in runner.test.ts.
 */
export const IS_NANOCLAW = false;

export function evaluateBashCommand(
  _command: string,
  opts?: { skipGate?: boolean },
): { action: 'allow' | 'block' | 'gate'; reason?: string } {
  if (opts?.skipGate) return { action: 'banana' as unknown as 'allow' }; // malformed post-check
  return { action: 'gate', reason: 'stub gated infra command' }; // well-formed initial → gate path
}

export function consumeGateApproval(_command: string): boolean {
  return true; // pretend the gate was already approved → exercises the post-check
}

export function runNanoclawGate(
  _command: string,
  _reason: string,
  _onStageError?: (e: unknown) => void,
): 'approved' | 'denied' | 'timeout' {
  return 'denied';
}
