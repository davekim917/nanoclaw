import { writeMessageOut } from '../db/messages-out.js';

export type HookFailureStage = 'mailbox start' | 'hook chain';

const ERROR_SUMMARY_MAX = 200;

export function summarizeHookError(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const line = raw.replace(/\s+/g, ' ').trim();
  return line.length > ERROR_SUMMARY_MAX ? `${line.slice(0, ERROR_SUMMARY_MAX)}…` : line;
}

export function hookFailureDenyReason(stage: HookFailureStage, err: unknown): string {
  return (
    `BLOCKED: guard hook failed at ${stage} (${summarizeHookError(err)}) — denying for safety. ` +
    'This is a hook failure, not a policy verdict: retry the command once, and if it fails again, ' +
    'report it with the UTC time.'
  );
}

/** Best effort: the work_log row outlives the container; stderr does not. */
export async function recordHookFailure(stage: HookFailureStage, err: unknown): Promise<void> {
  try {
    await writeMessageOut({
      id: `hook-failure-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'work_log',
      content: JSON.stringify({
        text: `[codex-hook] PreToolUse failed closed at ${stage}, ${new Date().toISOString()}: ${summarizeHookError(err)}`,
      }),
    });
  } catch {
    // An unstarted or unwritable mailbox leaves stderr as the only record.
  }
}
