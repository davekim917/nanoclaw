/**
 * Gate post-check fail-closed fixture (codex #126 N1 + N2). Initial verdict is a
 * well-formed `gate` so the approval path runs. Command-keyed:
 *
 *  - 'NONBOOL_APPROVAL' → consumeGateApproval returns a TRUTHY NON-BOOLEAN ({}).
 *    The strict `=== true` check must NOT treat it as approved; it falls through
 *    to runNanoclawGate, which here signals a staging failure → DENY. (N1)
 *  - 'GATE_AFTER_APPROVAL' → consumeGateApproval returns true, and the skipGate
 *    post-check returns a well-formed `gate` AGAIN (stale core ignoring skipGate).
 *    Only an explicit `allow` may pass; the repeated gate must DENY. (N2)
 *
 * Pointed at via NANOCLAW_DESTRUCTIVE_GUARD_CORE in runner.test.ts.
 */
export const IS_NANOCLAW = true;

export function evaluateBashCommand(
  command: string,
  opts?: { skipGate?: boolean },
): { action: 'allow' | 'block' | 'gate'; reason?: string } {
  if (opts?.skipGate) {
    if (command.includes('GATE_AFTER_APPROVAL')) return { action: 'gate', reason: 'still gating (stale core)' };
    return { action: 'allow' };
  }
  return { action: 'gate', reason: 'stub gated command' };
}

export function consumeGateApproval(command: string): boolean {
  if (command.includes('NONBOOL_APPROVAL')) return {} as unknown as boolean; // truthy non-boolean
  return true; // GATE_AFTER_APPROVAL path: pretend approved
}

export function runNanoclawGate(
  _command: string,
  _reason: string,
  onStageError?: (e: unknown) => void,
): 'approved' | 'denied' | 'timeout' {
  // N1 reaches here (consumeGateApproval !== true). Signal a staging failure so
  // the guard denies — proving the non-boolean was NOT honored as an approval.
  onStageError?.(new Error('no session DB in test'));
  return 'denied';
}
