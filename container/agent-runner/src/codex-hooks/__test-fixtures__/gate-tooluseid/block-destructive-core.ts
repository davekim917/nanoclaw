/**
 * Records the 4th positional argument `runNanoclawGate` was called with, so a
 * test can prove the in-tree Codex chain forwards codex's `tool_use_id` into the
 * session-DB gate. Without it the two concurrently-dispatched PreToolUse guards
 * stage two approval cards for one command (#833).
 *
 * The recording goes to a FILE, not a module-level variable: the runner imports
 * the core dynamically and bun memoizes the module, so a test that read an
 * export would be reading whatever the previous test left behind.
 *
 * Pointed at via NANOCLAW_DESTRUCTIVE_GUARD_CORE in runner.test.ts.
 */
import fs from 'fs';

export const IS_NANOCLAW = true;

export function evaluateBashCommand(
  _command: string,
  opts?: { skipGate?: boolean },
): { action: 'allow' | 'block' | 'gate'; reason?: string } {
  return opts?.skipGate ? { action: 'allow' } : { action: 'gate', reason: 'stub gated command' };
}

export function consumeGateApproval(): boolean {
  return false; // force the real staging path
}

export function runNanoclawGate(
  _command: string,
  _reason: string,
  _onStageError?: (e: unknown) => void,
  toolUseId?: string,
): 'approved' | 'denied' | 'timeout' {
  const sink = process.env.NANOCLAW_TEST_GATE_ARG_SINK;
  if (sink) fs.writeFileSync(sink, JSON.stringify({ toolUseId: toolUseId ?? null }));
  return 'approved';
}
