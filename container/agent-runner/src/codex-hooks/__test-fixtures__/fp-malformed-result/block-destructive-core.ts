/**
 * Benign destructive-guard core co-located with the malformed file-protection
 * fixture (codex #126 N3). The N3 test exercises a Write tool, so this guard
 * just allows — it exists only so NANOCLAW_DESTRUCTIVE_GUARD_CORE points into
 * this dir and loadFileProtectionCore resolves the sibling file-protection-core.ts.
 */
export const IS_NANOCLAW = false;

export function evaluateBashCommand(): { action: 'allow' | 'block' | 'gate'; reason?: string } {
  return { action: 'allow' };
}

export function consumeGateApproval(): boolean {
  return false;
}

export function runNanoclawGate(): 'approved' | 'denied' | 'timeout' {
  return 'denied';
}
