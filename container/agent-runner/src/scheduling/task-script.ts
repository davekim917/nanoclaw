import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { MessageInRow } from '../db/messages-in.js';
import { touchHeartbeat } from '../heartbeat.js';
import { beginProviderBusyScope, endProviderBusyScope } from '../modules/mailbox/index.js';
import { evaluateManagedGitCommand } from '../managed-git-guard.js';
import { MCP_HEADER_ONLY_SECRET_VARS } from '../providers/secret-env.js';

// Pre-task scripts get 120s by default (env-overridable). The old flat 30s
// killed a working 56s watcher script eight times in a row on 2026-08-22,
// which auto-paused the series and left the board blind for ~6h the day
// before a release. A script that truly hangs still dies here — just later.
// Read per call, not once at module load: the value is fixed for the life of a
// container in production (the env is set at spawn), so this changes nothing
// there — but it lets the seam test drive a real timeout through
// applyPreTaskScripts instead of waiting out the full ceiling.
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

// ── Destructive-command classifier (fleet-hardening Phase 4, P1 leg 2) ────────
// A pre-task script runs unattended, pre-turn, with no approval round-trip —
// so `ncl tasks create --script` (access:'open') was an ungated bash-exec path
// that let an agent do what the interactive Bash gate would have blocked. Fix:
// run the script through the SAME evaluator the interactive Bash PreToolUse
// hook uses (claude.ts loadCoreEvaluator → block-destructive-core), and refuse
// anything it would block OR gate. Reusing the core (not a private regex) means
// this path inherits future matrix additions (e.g. P2 git history-mutation)
// for free. Destructive work belongs inside the awakened turn, where the real
// gate can card an approver.
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

// Fail-closed fallback for a plugin-less install / a core that fails to import:
// the egregious hard-block set, same shape as the host-side classifier
// (src/modules/scheduling/host-script.ts). ponytail: intentionally narrow —
// the mounted core above is the source of truth and is present in every
// production container (every Bash command depends on it); this only backstops
// its absence so the refusal never silently fails open.
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
export async function classifyScript(script: string): Promise<{ safe: boolean; reason?: string }> {
  // Managed canonical metadata is shared by every topic worktree in a
  // workgroup. Enforce its host-only maintenance boundary before consulting
  // the Bootstrap evaluator so unattended scripts cannot reach a command the
  // interactive provider hooks would deny.
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

/**
 * Env for a pre-task subprocess — parity with the interactive Bash path
 * (secret-env.ts). Strips the MCP header-only secrets, which no shell needs.
 * Provider credentials, data-tool creds and the OneCLI proxy vars stay, so a
 * scheduled script can drive `claude -p` / `codex exec` and keep its
 * credentialed monitors working, exactly as an interactive Bash command can.
 */
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
          if ((error as { killed?: boolean }).killed) {
            log(
              `[${taskId}] timed out after ${timeoutMs}ms and was killed; output discarded — raise NANOCLAW_TASK_SCRIPT_TIMEOUT_MS if the script is legitimately this slow`,
            );
          } else {
            log(`[${taskId}] error: ${error.message}`);
          }
          return resolve(null);
        }

        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log(`[${taskId}] no output`);
          return resolve(null);
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            log(`[${taskId}] output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`);
            return resolve(null);
          }
          resolve(result as ScriptResult);
        } catch {
          log(`[${taskId}] output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
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
export type ScriptSkipReason = 'gated' | 'error' | 'blocked';

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

    // Fleet-hardening Phase 1.1: a host-gated fire (content.scriptHost) already
    // ran this script on the host and wrote its scriptOutput before the
    // container was even spawned — see runHostGatedTaskScripts in
    // src/modules/scheduling/host-script.ts. Running it again here would
    // double-execute a script that may have side effects (state files, API
    // calls) for no reason. A due row the host classifier routed back to the
    // container (hard-block/gated script, or scriptHost unset) never carries
    // scriptOutput and reaches the normal execution path below.
    if (content.scriptOutput !== undefined) {
      keep.push(msg);
      continue;
    }

    const verdict = await classifyScript(script);
    if (!verdict.safe) {
      log(`task ${msg.id} BLOCKED: destructive pre-task script refused — ${verdict.reason}`);
      skipped.push({ id: msg.id, reason: 'blocked' });
      continue;
    }

    log(`running script for task ${msg.id}`);
    // The batch is deliberately claimed only AFTER these scripts run (see the
    // caller in poll-loop.ts), so for as long as a script executes the host
    // sees no processing claim for it. The heartbeat alone does not save the
    // container: the poll loop touches it every iteration, so it means "alive",
    // not "busy", and the task reaper does not look at it. provider_executing
    // is the signal that does mean busy — without it a script that outlives a
    // sweep tick is killed mid-run once its row stops counting as due.
    //
    // A scope, not the turn level: the active poll callback runs this path
    // concurrently with a provider turn, and neither side may clear the other.
    touchHeartbeat();
    beginProviderBusyScope();
    let result: ScriptResult | null;
    try {
      result = await runScript(script, msg.id);
    } finally {
      endProviderBusyScope();
    }
    touchHeartbeat();

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
