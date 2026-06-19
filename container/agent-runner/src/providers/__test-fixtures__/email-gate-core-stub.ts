/**
 * Test stub for claude.ts's email-gate-core delegation (loadEmailGateEvaluator).
 *
 * The REAL core (email-gate-core.ts) lives in the bootstrap repo. This stub only
 * drives claude.ts's WIRING — that createEmailGateHook consumes the verdict
 * (allow vs gate + card) and runs its async ack round-trip on `gate`. Pointed at
 * via NANOCLAW_EMAIL_GATE_CORE.
 *
 * Sentinel-keyed so a test can prove the verdict came from THIS module (distinct
 * label text) rather than the inline fallback.
 */
export function evaluateEmailSend(
  command: string,
  env: { isScheduledTask: boolean },
): { action: 'allow' | 'gate'; label?: string; summary?: string } {
  if (env.isScheduledTask) return { action: 'allow' };
  if (command.includes('STUB_EMAIL_GATE')) {
    return { action: 'gate', label: 'STUB-CORE email label', summary: 'STUB-CORE email summary' };
  }
  return { action: 'allow' };
}
