/**
 * Host-side pre-task script execution (fleet-hardening Phase 1.1).
 *
 * A due task's `content.script` normally only runs after a container has
 * already been spawned for it (container/agent-runner/src/scheduling/
 * task-script.ts, via applyPreTaskScripts). For a monitor series that gates
 * (wakeAgent=false) most fires, that is a full container boot paid for
 * nothing. A series that opts in with `content.scriptHost === true` gets its
 * script run HERE instead, before admitDueTaskContexts admits the row — a
 * gated fire then costs one execFile call and no container at all.
 *
 * Execution and output parsing mirror task-script.ts's runScript exactly
 * (same timeout/buffer caps, same last-stdout-line JSON {wakeAgent, data}
 * contract) so a script behaves identically wherever it ends up running.
 *
 * SECURITY: unlike the container, the host process is long-lived and shared
 * across every session on the fleet, so nothing here runs unclassified. See
 * `classifyForHostExecution` below.
 */
import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import { evaluateManagedGitCommand } from '../../managed-git-command-guard.js';
// Import-order trap (see config.ts): process.env alone misses values that
// exist only in .env, because this module is imported before index.ts's
// loadEnvIntoProcess() runs.
import { TASK_SCRIPT_TIMEOUT_MS } from '../../config.js';

// Same rationale as the container-side constant (task-script.ts): the flat
// 30s default killed a working 56s watcher script into an auto-pause.
// Centralized in config.ts so .env actually reaches it (import-order trap).
const SCRIPT_TIMEOUT_MS = TASK_SCRIPT_TIMEOUT_MS;
const SCRIPT_MAX_BUFFER = 1024 * 1024;

export interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

// ── Classifier ──────────────────────────────────────────────────────────────
//
// ponytail: this is a deliberately narrow regex subset of the full AST-based
// destructive-command evaluator (block-destructive-core.ts, vendored into the
// bootstrap plugin and shared by every in-container provider adapter). That
// evaluator needs the `unbash` shell parser, which would be a new host
// dependency — out of scope here (the supply-chain policy requires an
// explicit approved audit for new deps; see CLAUDE.md "Supply Chain
// Security"). This subset only has to answer one conservative question: is it
// safe to run this text UNSANDBOXED, in the same long-lived process that
// holds every session's state? Managed Git mutations are classified first by
// the dependency-free parser in managed-git-command-guard.ts. A match there
// or on EITHER list below routes to "unsafe" → the fire falls back to the
// container path unchanged, which is sandboxed per-run.
// Upgrade path: vendor block-destructive-core.ts into the host the same way
// scripts/vendor-design-artifact-loop.ts vendors design-artifact-loop, once a
// host-side `unbash` dependency is approved (Phase 4).
const HARD_BLOCK_PATTERNS: Array<{ rx: RegExp; label: string }> = [
  { rx: /\brm\s+(?:-\w*[rf]\w*\s+)+/i, label: 'rm -r/-f' },
  { rx: /\b(?:unlink|shred)\b/i, label: 'unlink/shred' },
  { rx: /\btruncate\b/i, label: 'truncate' },
  { rx: /\beval\b/i, label: 'eval' },
  { rx: /\bfind\b[\s\S]*(?:-delete\b|-exec\s+(?:sudo\s+)?rm\b)/i, label: 'find -delete/-exec rm' },
  { rx: /\bxargs\s+(?:sudo\s+)?rm\b/i, label: 'xargs rm' },
  { rx: /\bdd\s+[\s\S]*\bif=/i, label: 'dd if=' },
  { rx: /\b(?:bash|sh|zsh|dash|ksh)\s+-c\b/i, label: 'shell -c' },
];

const GATED_PATTERNS: Array<{ rx: RegExp; label: string }> = [
  { rx: /\b(?:DROP|TRUNCATE)\s+(?:TABLE|SCHEMA|DATABASE|VIEW|INDEX)\b/i, label: 'DROP/TRUNCATE' },
  { rx: /\bDELETE\s+FROM\b/i, label: 'DELETE FROM' },
  { rx: /\bgit\s+push\s+(?:\S+\s+)*(?:--force|-f)\b/i, label: 'git push --force' },
  { rx: /\bterraform\s+destroy\b/i, label: 'terraform destroy' },
  { rx: /\bkubectl\s+delete\b/i, label: 'kubectl delete' },
  { rx: /\bdocker\s+(?:rm|rmi|(?:system\s+prune))\b/i, label: 'docker rm/rmi/prune' },
  { rx: /\baws\s+s3\s+(?:rm|rb)\b/i, label: 'aws s3 rm/rb' },
  { rx: /\bgcloud\b[\s\S]*\bdelete\b/i, label: 'gcloud delete' },
  { rx: /\b(?:FLUSHALL|FLUSHDB)\b/i, label: 'redis FLUSHALL/FLUSHDB' },
  { rx: /\.(?:drop|deleteMany|remove)\s*\(/i, label: 'mongo drop/deleteMany/remove' },
];

export interface ClassifyResult {
  safe: boolean;
  category?: 'hard-block' | 'gated';
  label?: string;
}

/** Pure — classify script text for host-unsandboxed execution. */
export function classifyForHostExecution(script: string): ClassifyResult {
  const managedGit = evaluateManagedGitCommand(script);
  if (managedGit.action === 'deny') {
    return { safe: false, category: 'hard-block', label: managedGit.operation };
  }
  for (const { rx, label } of HARD_BLOCK_PATTERNS) {
    if (rx.test(script)) return { safe: false, category: 'hard-block', label };
  }
  for (const { rx, label } of GATED_PATTERNS) {
    if (rx.test(script)) return { safe: false, category: 'gated', label };
  }
  return { safe: true };
}

// ── Execution ────────────────────────────────────────────────────────────────
// Mirrors container/agent-runner/src/scheduling/task-script.ts's runScript.

/**
 * Explicit minimal env — NEVER the host process's full process.env, which
 * carries credentials for every session on the fleet. A task script only
 * needs a normal shell environment.
 */
function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.TZ) env.TZ = process.env.TZ;
  return env;
}

export function runHostScript(script: string, taskId: string): Promise<ScriptResult | null> {
  const scriptPath = path.join(os.tmpdir(), `host-task-script-${taskId}-${Date.now()}.sh`);
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    let settled = false;
    // Hard deadline BEYOND execFile's own timeout: the built-in timeout sends
    // SIGTERM to the direct child only, and the callback fires when stdio
    // closes — a script that backgrounds children holding the pipes would
    // otherwise wedge this promise open, and with it the whole sequential
    // sweep session loop (this call is awaited inside prepareDueWake). The
    // race guarantees the sweep always advances: on deadline we kill the
    // ENTIRE process group (detached:true below makes the child its own
    // group leader, so -pid reaches backgrounded grandchildren too — a
    // lone SIGKILL to bash would orphan them mid-side-effect), unlink the
    // temp script, and resolve null.
    const hardDeadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
      try {
        fs.unlinkSync(scriptPath);
      } catch {
        /* best-effort cleanup */
      }
      log.warn('Host task-script exceeded hard deadline — killed process group, resolving null', { taskId });
      resolve(null);
    }, SCRIPT_TIMEOUT_MS + 10_000);
    const child = execFile(
      'bash',
      [scriptPath],
      // Node's ExecFileOptions typing omits `detached`, but the option is
      // passed through to spawn — it is what makes the child a process-group
      // leader so the deadline's -pid SIGKILL reaches grandchildren too.
      // (Stating utf8 selects the string-callback overload that `detached`
      // otherwise leaves ambiguous.)
      {
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: SCRIPT_MAX_BUFFER,
        env: minimalEnv(),
        detached: true,
        encoding: 'utf8',
      } as ExecFileOptionsWithStringEncoding,
      (error, stdout, stderr) => {
        clearTimeout(hardDeadline);
        if (settled) return;
        settled = true;
        // Node's built-in timeout SIGTERMs child.pid alone; with detached:true
        // any backgrounded grandchild would survive it. Group-kill here too.
        try {
          if (child.pid && (error as { killed?: boolean } | null)?.killed) {
            process.kill(-child.pid, 'SIGKILL');
          }
        } catch {
          /* already gone */
        }
        try {
          fs.unlinkSync(scriptPath);
        } catch {
          /* best-effort cleanup */
        }

        if (stderr) log.debug('Host task-script stderr', { taskId, stderr: stderr.slice(0, 500) });

        if (error) {
          log.warn('Host task-script error', { taskId, error: error.message });
          return resolve(null);
        }

        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log.warn('Host task-script produced no output', { taskId });
          return resolve(null);
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            log.warn('Host task-script output missing wakeAgent boolean', { taskId, lastLine: lastLine.slice(0, 200) });
            return resolve(null);
          }
          resolve(result as ScriptResult);
        } catch {
          log.warn('Host task-script output is not valid JSON', { taskId, lastLine: lastLine.slice(0, 200) });
          resolve(null);
        }
      },
    );
  });
}

// ── Sweep integration ───────────────────────────────────────────────────────

interface HostGatedTaskRow {
  id: string;
  content: string;
}

/**
 * Run host-side pre-task scripts for due task rows that opted in
 * (`content.scriptHost === true`). Called from host-sweep.ts's
 * prepareDueWake, BEFORE admitDueTaskContexts — a row this function resolves
 * never becomes "due" for admission, so a gated/errored fire never wakes a
 * container.
 *
 * Same query shape as admitDueTaskContexts' own due-row select (status =
 * 'pending', trigger = 0, process_after due), narrowed to kind = 'task' since
 * only task rows carry a script.
 *
 * Outcomes mirror applyPreTaskScripts, written directly to messages_in.status
 * — the host-owned equivalent of the container's processing_ack ack (see
 * syncProcessingAcks in db/session-db.ts, which maps the same two outcomes
 * onto the same two statuses):
 *   - wakeAgent=false → status='completed' (gated; recurrence never backs off)
 *   - script error     → status='failed' (recurrence reads the trailing
 *     failed streak off occurrence rows for backoff, same as a container
 *     script-skip:error ack)
 *   - wakeAgent=true   → content.scriptOutput is injected and the row is left
 *     pending/trigger=0 so admitDueTaskContexts admits it normally right
 *     after this returns; the carried scriptOutput also tells the
 *     container-side applyPreTaskScripts to skip re-running the script.
 *   - classifier hit (hard-block or gated) → left untouched entirely; falls
 *     through to the existing, unchanged container-side script execution.
 */
export async function runHostGatedTaskScripts(inDb: Database.Database, sessionId: string): Promise<void> {
  const due = inDb
    .prepare(
      `SELECT id, content FROM messages_in
        WHERE kind = 'task' AND status = 'pending' AND trigger = 0
          AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))`,
    )
    .all() as HostGatedTaskRow[];

  for (const row of due) {
    let content: Record<string, unknown>;
    try {
      content = JSON.parse(row.content);
    } catch {
      continue;
    }
    const script = typeof content.script === 'string' ? content.script : null;
    if (!script || content.scriptHost !== true) continue;

    const classification = classifyForHostExecution(script);
    if (!classification.safe) {
      log.warn('Host-gated script classified unsafe; falling back to container execution', {
        sessionId,
        taskId: row.id,
        category: classification.category,
        pattern: classification.label,
      });
      continue;
    }

    const result = await runHostScript(script, row.id);
    if (!result || !result.wakeAgent) {
      const status = result ? 'completed' : 'failed';
      inDb.prepare("UPDATE messages_in SET status = ? WHERE id = ? AND status = 'pending'").run(status, row.id);
      log.info('Host-gated script handled task without spawning a container', {
        sessionId,
        taskId: row.id,
        status,
      });
      continue;
    }

    content.scriptOutput = result.data ?? null;
    inDb
      .prepare("UPDATE messages_in SET content = ? WHERE id = ? AND status = 'pending' AND trigger = 0")
      .run(JSON.stringify(content), row.id);
  }
}
