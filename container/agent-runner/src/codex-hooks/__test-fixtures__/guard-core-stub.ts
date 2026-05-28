/**
 * Test stub mirroring the public surface of the bootstrap shared guard core
 * (block-destructive-core.ts) that runner.ts's destructive-guard step imports.
 *
 * The REAL core's verdict accuracy (terraform destroy, DROP TABLE, rm tiers,
 * shell-wrapper bypass, etc.) is validated in the bootstrap repo's 155-test
 * suite and the codex-guard functional test. THIS stub exists only to unit-test
 * runner.ts's WIRING — that it imports the core, calls evaluateBashCommand, and
 * maps verdicts (block/gate/allow) to the right codex decision (deny/continue) —
 * without depending on the cross-repo bootstrap mount being present in CI.
 *
 * Pointed at via NANOCLAW_DESTRUCTIVE_GUARD_CORE in runner.test.ts.
 */
export const IS_NANOCLAW = false;

export function evaluateBashCommand(
  command: string,
  _opts?: { skipGate?: boolean },
): { action: 'allow' | 'block' | 'gate'; reason?: string } {
  if (command.includes('STUB_BLOCK')) return { action: 'block', reason: 'BLOCKED: stub hard-block' };
  if (command.includes('STUB_GATE')) return { action: 'gate', reason: 'stub gated infra command' };
  return { action: 'allow' };
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
