/**
 * Malformed email-gate core: importable, exports evaluateEmailSend, but returns
 * a verdict with an UNKNOWN action ('bogus') for a real send. claude.ts's
 * createEmailGateHook must treat this as untrusted and fall back to the inline
 * fail-CLOSED evaluator (which gates an interactive send) — NOT let it slip
 * through the non-'gate' branch as an allow. Pointed at via NANOCLAW_EMAIL_GATE_CORE.
 * Regression fixture for codex #126 F2.
 */
export function evaluateEmailSend(
  _command: string,
  _env: { isScheduledTask: boolean },
): { action: 'allow' | 'gate' } {
  return { action: 'bogus' as unknown as 'allow' }; // malformed → must NOT be honored
}
