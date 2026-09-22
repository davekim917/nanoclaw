/**
 * Records every command `evaluateBashCommand` is called with, so a test can
 * prove the in-tree Codex chain hands the destructive-action guard raw command
 * text. That chain applies no `exec </dev/null` stdin prefix at all (it is
 * Claude-only), and this recorder is what pins that: a prefix reaching the
 * guard would land on the approval card an admin reads.
 *
 * The recording goes to a FILE (appended, one JSON string per line), not a
 * module-level variable: the runner imports the core dynamically and bun
 * memoizes the module, so an export would carry state across tests.
 *
 * Pointed at via NANOCLAW_DESTRUCTIVE_GUARD_CORE in runner.test.ts.
 */
import fs from 'fs';

export const IS_NANOCLAW = false;

export function evaluateBashCommand(
  command: string,
  _opts?: { skipGate?: boolean },
): { action: 'allow' | 'block' | 'gate'; reason?: string } {
  const sink = process.env.NANOCLAW_TEST_GUARD_COMMAND_SINK;
  if (sink) fs.appendFileSync(sink, `${JSON.stringify(command)}\n`);
  return { action: 'allow' };
}

export function consumeGateApproval(): boolean {
  return false;
}

export function runNanoclawGate(): 'approved' | 'denied' | 'timeout' {
  return 'denied';
}
