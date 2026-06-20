/**
 * Throwing guard-core fixture: exports are correctly shaped (passes validation)
 * but evaluateBashCommand throws when called. runDestructiveGuard must catch the
 * throw and DENY (fail-closed), never fall through to allow. Pointed at via
 * NANOCLAW_DESTRUCTIVE_GUARD_CORE.
 */
export function evaluateBashCommand(): { action: 'allow' | 'block' | 'gate'; reason?: string } {
  throw new Error('STUB-CORE: evaluateBashCommand boom');
}
export function consumeGateApproval(): boolean {
  return false;
}
export function runNanoclawGate(): 'approved' | 'denied' | 'timeout' {
  return 'denied';
}
export const IS_NANOCLAW = false;
