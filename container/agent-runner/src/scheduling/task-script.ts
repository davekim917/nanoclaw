import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { MessageInRow } from '../db/messages-in.js';
import { touchHeartbeat } from '../heartbeat.js';
import { beginProviderBusyScope, endProviderBusyScope } from '../modules/mailbox/index.js';
import { evaluateManagedGitCommand } from '../managed-git-guard.js';
import { MCP_HEADER_ONLY_SECRET_VARS } from '../providers/secret-env.js';
import { writeGateRow } from './gate-row.js';

// 120s default (env-overridable): a flat 30s killed working watcher scripts and auto-paused their series.
// Read per call so tests can drive a real timeout.
function scriptTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.NANOCLAW_TASK_SCRIPT_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}
const SCRIPT_MAX_BUFFER = 1024 * 1024;

export interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

function log(msg: string): void {
  console.error(`[task-script] ${msg}`);
}

// Pre-task scripts run unattended with no approval round-trip, so they go through the SAME evaluator as the
// interactive Bash hook, and anything it would block OR gate is refused.
const DEFAULT_GUARD_CORE_PATH =
  '/workspace/plugins/bootstrap/plugins/workflow-agents/hooks/guards/block-destructive-core.ts';
type BashEvaluator = (
  command: string,
  opts?: { skipGate?: boolean },
) => { action: 'allow' | 'block' | 'gate'; reason?: string };
let _evalBash: BashEvaluator | null | undefined;
async function loadBashEvaluator(): Promise<BashEvaluator | null> {
  if (_evalBash !== undefined) return _evalBash;
  const corePath = process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE || DEFAULT_GUARD_CORE_PATH;
  try {
    const core = (await import(corePath)) as Record<string, unknown>;
    const fn = core.evaluateBashCommand;
    _evalBash = typeof fn === 'function' ? (fn as BashEvaluator) : null;
  } catch {
    _evalBash = null;
  }
  return _evalBash;
}

// Fail-closed fallback when the core is missing or fails to import, so the refusal never fails open.
const FALLBACK_BLOCK: RegExp[] = [
  /\brm\s+(?:-\w*[rf]\w*\s+)+/i,
  /\b(?:unlink|shred|truncate)\b/i,
  /\beval\b/i,
  /\b(?:bash|sh|zsh|dash|ksh)\s+-c\b/i,
  /\bdd\s+[\s\S]*\bif=/i,
  /\b(?:DROP|TRUNCATE)\s+(?:TABLE|SCHEMA|DATABASE|VIEW|INDEX)\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bgit\s+push\s+(?:\S+\s+)*(?:--force|-f)\b/i,
];

/** Refuse a pre-task script the interactive Bash gate would block or gate. */
async function classifyScript(script: string): Promise<{ safe: boolean; reason?: string }> {
  // Managed canonical metadata is host-only; enforce that before the Bootstrap evaluator.
  const managedGit = evaluateManagedGitCommand(script);
  if (managedGit.action === 'deny') return { safe: false, reason: managedGit.reason };

  const evaluate = await loadBashEvaluator();
  if (evaluate) {
    try {
      const v = evaluate(script);
      if (v?.action === 'block' || v?.action === 'gate') return { safe: false, reason: v.reason ?? v.action };
      return { safe: true };
    } catch {
      /* core threw — fall through to the fail-closed fallback */
    }
  }
  const hit = FALLBACK_BLOCK.find((rx) => rx.test(script));
  return hit ? { safe: false, reason: 'destructive command (fallback classifier)' } : { safe: true };
}

/** Parity with the interactive Bash env (secret-env.ts): strip only the MCP header-only secrets. */
function scriptEnv(): NodeJS.ProcessEnv {
  const strip = new Set<string>(MCP_HEADER_ONLY_SECRET_VARS);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!strip.has(k)) env[k] = v;
  return env;
}

export async function runScript(
  script: string,
  taskId: string,
  timeoutMs: number = scriptTimeoutMs(),
  onFailure?: (reason: string) => void,
): Promise<ScriptResult | null> {
  const scriptPath = path.join('/tmp', `task-script-${taskId}.sh`);
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      { timeout: timeoutMs, maxBuffer: SCRIPT_MAX_BUFFER, env: scriptEnv() },
      (error, stdout, stderr) => {
        try {
          fs.unlinkSync(scriptPath);
        } catch {
          /* best-effort cleanup */
        }

        if (stderr) {
          log(`[${taskId}] stderr: ${stderr.slice(0, 500)}`);
        }
        const fail = (reason: string): void => {
          log(`[${taskId}] ${reason}`);
          onFailure?.(reason);
          resolve(null);
        };

        if (error) {
          // execFile kills on timeout, so a script that ran too long arrives
          // here as a generic "Command failed: bash /tmp/task-script-<id>.sh"
          // — the same string a script that exited non-zero on its first line
          // produces. `killed` is the only thing that separates them.
          //
          // This matters more here than upstream: a timeout acks as reason
          // 'error', and eight consecutive 'error' acks auto-pause the whole
          // series (recurrence.ts SCRIPT_FAIL_PAUSE_CAP). An operator reading
          // "error: Command failed" goes hunting for a bug in a script that is
          // merely slow, when the fix is NANOCLAW_TASK_SCRIPT_TIMEOUT_MS. Name
          // the timeout and the ceiling it hit.
          return fail(
            (error as { killed?: boolean }).killed
              ? `timed out after ${timeoutMs}ms and was killed; output discarded — raise NANOCLAW_TASK_SCRIPT_TIMEOUT_MS if the script is legitimately this slow`
              : `error: ${error.message}`,
          );
        }

        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) return fail('no output');

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            return fail(`output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`);
          }
          resolve(result as ScriptResult);
        } catch {
          fail(`output is not valid JSON: ${lastLine.slice(0, 200)}`);
        }
      },
    );
  });
}

/**
 * Why a script gated its task: deliberate wakeAgent=false vs a broken script vs
 * a destructive script the classifier refused to run. 'blocked' acks like
 * 'error' (backoff) so a misconfigured/hostile series throttles itself.
 */
type ScriptSkipReason = 'gated' | 'error' | 'blocked';

export interface TaskScriptOutcome {
  keep: MessageInRow[];
  skipped: Array<{ id: string; reason: ScriptSkipReason }>;
}

/**
 * Run pre-task scripts for any task messages that carry one, serially.
 * - Errors / missing output / wakeAgent=false → task id added to `skipped`,
 *   with the reason. The caller acks these as script-skips (not plain
 *   completions) so the host can count consecutive failures and back off.
 * - wakeAgent=true → content JSON is mutated to carry `scriptOutput`, so the
 *   formatter renders it into the prompt.
 * Non-task messages and tasks without scripts pass through unchanged.
 */
export async function applyPreTaskScripts(messages: MessageInRow[]): Promise<TaskScriptOutcome> {
  const keep: MessageInRow[] = [];
  const skipped: Array<{ id: string; reason: ScriptSkipReason }> = [];

  for (const msg of messages) {
    if (msg.kind !== 'task') {
      keep.push(msg);
      continue;
    }

    let content: Record<string, unknown>;
    try {
      content = JSON.parse(msg.content);
    } catch {
      keep.push(msg);
      continue;
    }

    const script = typeof content.script === 'string' ? (content.script as string) : null;
    if (!script) {
      keep.push(msg);
      continue;
    }

    // A host-gated fire already ran the script on the host; running it again would double its side effects.
    if (content.scriptOutput !== undefined) {
      keep.push(msg);
      continue;
    }

    const verdict = await classifyScript(script);
    if (!verdict.safe) {
      log(`task ${msg.id} BLOCKED: destructive pre-task script refused — ${verdict.reason}`);
      if (!(await writeGateRow(msg.id, null, `refused by the destructive-command classifier: ${verdict.reason}`)))
        continue;
      skipped.push({ id: msg.id, reason: 'blocked' });
      continue;
    }

    log(`running script for task ${msg.id}`);
    // The batch is claimed only AFTER scripts run, and the heartbeat means "alive", not "busy", so publish a busy
    // scope or the task reaper kills a long script mid-run. A scope, not the turn level: this runs concurrently
    // with a provider turn.
    touchHeartbeat();
    beginProviderBusyScope();
    let result: ScriptResult | null;
    let failure = 'script produced no result';
    try {
      result = await runScript(script, msg.id, undefined, (reason) => (failure = reason));
    } finally {
      endProviderBusyScope();
    }
    touchHeartbeat();
    if (!(await writeGateRow(msg.id, result, failure))) continue;

    if (!result || !result.wakeAgent) {
      const reason: ScriptSkipReason = result ? 'gated' : 'error';
      log(`task ${msg.id} skipped: ${reason === 'gated' ? 'wakeAgent=false' : 'script error, timeout, or no output'}`);
      skipped.push({ id: msg.id, reason });
      continue;
    }

    log(`task ${msg.id} wakeAgent=true, enriching prompt`);
    content.scriptOutput = result.data ?? null;
    keep.push({ ...msg, content: JSON.stringify(content) });
  }

  return { keep, skipped };
}
