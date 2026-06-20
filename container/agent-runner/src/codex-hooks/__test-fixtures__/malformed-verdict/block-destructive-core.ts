/**
 * Malformed-VERDICT guard-core fixture: every required export is present and the
 * RIGHT type (so loadGuardCore's validateGuardCore PASSES), but
 * evaluateBashCommand returns a NON-verdict — undefined for one command, an
 * unknown action for another. This is distinct from the `malformed/` fixture
 * (which has wrong-typed exports caught at load): here the failure is at call
 * time, exercising runDestructiveGuard's verdict-SHAPE validation. The runner
 * must DENY (fail-closed), never fall through to allow.
 *
 * Pointed at via NANOCLAW_DESTRUCTIVE_GUARD_CORE in runner.test.ts.
 */
export const IS_NANOCLAW = false;

export function evaluateBashCommand(
  command: string,
  _opts?: { skipGate?: boolean },
): { action: 'allow' | 'block' | 'gate'; reason?: string } {
  // Garbage returns masquerading as verdicts:
  if (command.includes('VERDICT_UNDEFINED')) return undefined as unknown as { action: 'allow' };
  if (command.includes('VERDICT_NULL')) return null as unknown as { action: 'allow' };
  // Unknown action value — not allow|block|gate.
  return { action: 'banana' as unknown as 'allow' };
}

export function consumeGateApproval(_command: string): boolean {
  return false;
}

export function runNanoclawGate(
  _command: string,
  _reason: string,
  _onStageError?: (e: unknown) => void,
): 'approved' | 'denied' | 'timeout' {
  return 'denied';
}
