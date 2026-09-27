/**
 * Host-side pre-task script execution. A series with `content.scriptHost ===
 * true` runs its gate script HERE, before admission, so a gated fire costs no
 * container at all.
 *
 * Output contract matches the container's runScript (last stdout line is JSON
 * {wakeAgent, data}; 1MiB byte cap). Execution deliberately does not: this runs
 * in the process shared by the whole fleet, so it has a hard deadline, kills
 * the child's process group, and discards post-timeout output.
 *
 * SECURITY: the host process holds every session's state, so nothing here runs
 * unclassified (`classifyForHostExecution`).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { log } from '../../log.js';
import { evaluateManagedGitCommand } from '../../managed-git-command-guard.js';
// From config.ts, not process.env: this module is imported before .env is loaded.
import { TASK_SCRIPT_TIMEOUT_MS, TIMEZONE } from '../../config.js';
import { resolveGroupTimezone } from '../../container-config.js';
import type { NanoclawMailboxSession } from '../mailbox/index.js';
import { recordGateResult } from './observation.js';

const SCRIPT_TIMEOUT_MS = TASK_SCRIPT_TIMEOUT_MS;
const SCRIPT_MAX_BUFFER = 1024 * 1024;
// Past this fraction of the ceiling a host-gated script no longer fits the fast
// path: one slow upstream day turns it into timeouts, which count toward the
// recurrence auto-pause.
const HOST_SCRIPT_BUDGET_WARN_RATIO = 0.5;

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
  observation?: unknown;
}

/** One execution: the parsed last stdout line, or why there is none. */
export type HostScriptRun = { result: ScriptResult } | { error: string };

// A deliberately narrow regex subset of the in-container AST-based destructive
// command evaluator (which needs a new host dependency). It answers one
// conservative question: is this text safe to run UNSANDBOXED in the host
// process? Managed Git mutations go through managed-git-command-guard first. A
// match there or on EITHER list below falls back to the sandboxed container path.
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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Explicit minimal env — NEVER the host's process.env, which carries every
 * session's credentials. `tz` is the OWNING GROUP's timezone, so a gate's
 * local-time logic sees the clock the container path would.
 */
function minimalEnv(tz: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.HOME) env.HOME = process.env.HOME;
  env.TZ = tz;
  return env;
}

export function runHostScript(script: string, taskId: string, tz: string = TIMEZONE): Promise<HostScriptRun> {
  // PRIVATE 0700 DIRECTORY, not a guessable name in shared /tmp: a pre-created
  // symlink there would make the file we run UNSANDBOXED attacker-chosen.
  // `wx` refuses to follow or clobber; 0600 suffices since bash reads the path.
  let dir: string;
  let scriptPath: string;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-task-'));
    scriptPath = path.join(dir, 'script.sh');
    fs.writeFileSync(scriptPath, script, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    // Not thrown: outside the promise, a throw would abort the rest of this
    // session's sweep tick, and the row would retry identically every tick.
    log.warn('Host task-script could not be written to disk', { taskId, err });
    return Promise.resolve({ error: `script could not be written to disk: ${errorText(err)}` });
  }
  const cleanup = (): void => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  };

  const startedAtMs = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let overflowed = false;
    let timedOut = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutSize = { bytes: 0 };
    const stderrSize = { bytes: 0 };

    // `spawn` + `detached: true`, NOT execFile:
    //
    // 1. A script can trap SIGTERM, so execFile's timeout could leave the
    //    awaited promise (and the sequential sweep) open forever. The hard
    //    deadline below uses untrappable SIGKILL.
    // 2. Killing bash does not kill its descendants. execFile silently drops
    //    `detached`, and without it the child shares the HOST's process group,
    //    so a negative-pid kill would take down the daemon. `detached` makes the
    //    child its own group leader, so `-pid` reaches its group and never us.
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('bash', [scriptPath], {
        env: minimalEnv(tz),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      // A synchronous spawn throw would otherwise skip cleanup and leak the script.
      cleanup();
      log.warn('Host task-script could not be spawned', { taskId, err });
      return resolve({ error: `script could not be spawned: ${errorText(err)}` });
    }

    /**
     * Signal the child's process group, falling back to the child alone. Best
     * effort: a descendant that calls `setsid` escapes the group.
     */
    const killTree = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };

    const finish = (run: HostScriptRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(softTimeout);
      clearTimeout(hardDeadline);
      // ADMISSION-RULE INSTRUMENTATION: these scripts run sequentially inside
      // the awaited sweep, so every second here delays the fleet's only timer
      // for every other session. A script past the budget ratio belongs on the
      // container path; without this line a slow tick names no script.
      const elapsedMs = Date.now() - startedAtMs;
      if (elapsedMs > SCRIPT_TIMEOUT_MS * HOST_SCRIPT_BUDGET_WARN_RATIO) {
        log.warn('Host task-script over budget — belongs on the container path, not scriptHost', {
          taskId,
          elapsedMs,
          ceilingMs: SCRIPT_TIMEOUT_MS,
          pctOfCeiling: Math.round((elapsedMs / SCRIPT_TIMEOUT_MS) * 100),
          timedOut,
        });
      } else {
        log.debug('Host task-script timing', { taskId, elapsedMs, ceilingMs: SCRIPT_TIMEOUT_MS });
      }
      // Drop the pipes: an escaped or D-state descendant holds the write ends
      // open, and the host could not exit while it lives.
      for (const s of [child.stdout, child.stderr]) {
        try {
          s?.removeAllListeners();
          s?.destroy();
        } catch {
          /* already gone */
        }
      }
      cleanup();
      resolve(run);
    };

    // Accumulate BYTES and decode once: string `length` counts UTF-16 units, so
    // a character cap would admit ~3x the intended memory, and split multibyte
    // sequences across chunks stop mattering.
    const capture = (
      stream: NodeJS.ReadableStream | null,
      chunks: Buffer[],
      size: { bytes: number },
      label: 'stdout' | 'stderr',
    ): void => {
      if (!stream) return;
      stream.on('data', (chunk: Buffer) => {
        if (size.bytes + chunk.length > SCRIPT_MAX_BUFFER) {
          overflowed = true;
          log.warn('Host task-script exceeded max output buffer', { taskId, stream: label });
          killTree('SIGKILL');
          return;
        }
        size.bytes += chunk.length;
        chunks.push(chunk);
      });
    };
    capture(child.stdout, stdoutChunks, stdoutSize, 'stdout');
    capture(child.stderr, stderrChunks, stderrSize, 'stderr');

    // Graceful first, so a script's own TERM trap can clean up. `timedOut` keeps
    // that trap's output from counting as a verdict (see below).
    const softTimeout = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
    }, SCRIPT_TIMEOUT_MS);
    // Then the untrappable kill, ten seconds later, resolving on the timer
    // itself: SIGKILL cannot reach a process in uninterruptible D-state.
    const hardDeadline = setTimeout(() => {
      killTree('SIGKILL');
      log.warn('Host task-script exceeded hard deadline — SIGKILL sent to process group', { taskId });
      finish({ error: `timed out after ${SCRIPT_TIMEOUT_MS}ms and ignored SIGTERM; killed at the hard deadline` });
    }, SCRIPT_TIMEOUT_MS + 10_000);

    child.on('error', (err) => {
      log.warn('Host task-script failed to spawn', { taskId, error: err.message });
      finish({ error: `script failed to spawn: ${err.message}` });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      if (stderr) log.debug('Host task-script stderr', { taskId, stderr: stderr.slice(0, 500) });

      if (overflowed) return finish({ error: `output exceeded the ${SCRIPT_MAX_BUFFER}-byte cap` });
      // Past the soft deadline, output is not a verdict: a `wakeAgent:false`
      // success would reset the failure streak, so a series that times out
      // every fire would never reach the auto-pause.
      if (timedOut) {
        log.warn('Host task-script exceeded timeout — output discarded', { taskId, signal });
        return finish({ error: `timed out after ${SCRIPT_TIMEOUT_MS}ms; output discarded` });
      }
      if (code !== 0) {
        log.warn('Host task-script error', { taskId, code, signal });
        const tail = stderr.trim().slice(-300);
        return finish({
          error: `exited with ${signal ? `signal ${signal}` : `code ${code}`}${tail ? `; stderr: ${tail}` : ''}`,
        });
      }

      const lines = stdout.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      if (!lastLine) {
        log.warn('Host task-script produced no output', { taskId });
        return finish({ error: 'no output' });
      }

      let result: unknown;
      try {
        result = JSON.parse(lastLine);
      } catch {
        log.warn('Host task-script output is not valid JSON', { taskId, lastLine: lastLine.slice(0, 200) });
        return finish({ error: `last stdout line is not JSON: ${lastLine.slice(0, 200)}` });
      }
      if (
        result === null ||
        typeof result !== 'object' ||
        typeof (result as { wakeAgent?: unknown }).wakeAgent !== 'boolean'
      ) {
        log.warn('Host task-script output missing wakeAgent boolean', { taskId, lastLine: lastLine.slice(0, 200) });
        return finish({ error: `last stdout line has no wakeAgent boolean: ${lastLine.slice(0, 200)}` });
      }
      finish({ result: result as ScriptResult });
    });
  });
}

/**
 * Run host-side pre-task scripts for due task rows with `scriptHost`, BEFORE
 * admitDueTaskContexts, so a gated or errored fire never wakes a container.
 *
 * Record, then act: each result is upserted into the gate lane of
 * `task_run_outcomes` BEFORE the occurrence moves; after a crash the row is
 * still due and the rerun overwrites the ledger. Outcomes, written directly to
 * messages_in.status (the host-owned processing_ack):
 *   - wakeAgent=false → 'completed' (gated)
 *   - script error     → 'failed' (feeds the recurrence failure streak)
 *   - wakeAgent=true   → content.scriptOutput injected, row left pending for
 *     normal admission; the container then skips re-running the script
 *   - classifier hit   → untouched; the container-side path runs it
 *
 * Returns ids whose result could not be recorded; the caller must withhold
 * them from admission this tick, or the container would run them unrecorded.
 */
export async function runHostGatedTaskScripts(
  mailbox: NanoclawMailboxSession,
  agentGroupId: string,
  sessionId: string,
): Promise<Set<string>> {
  // The sweep's own session, passed down: opening a second one for the same key
  // would trip the nesting guard. Candidates are read first; the session stays
  // held while the scripts run.
  const unrecorded = new Set<string>();
  const due = mailbox.listDueTaskRows();
  if (due.length === 0) return unrecorded;

  // Once per tick: every due row here belongs to the same group.
  const tz = await resolveGroupTimezone(agentGroupId);

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

    const run = await runHostScript(script, row.id, tz);
    try {
      await recordGateResult({
        agentGroupId,
        sessionId,
        seriesId: row.series_id ?? row.id,
        occurrenceId: row.id,
        raw: run,
      });
    } catch (err) {
      unrecorded.add(row.id);
      log.warn('Host-gated result could not be recorded — occurrence withheld, script re-runs next tick', {
        sessionId,
        taskId: row.id,
        err,
      });
      continue;
    }

    if ('error' in run || !run.result.wakeAgent) {
      const status = 'error' in run ? 'failed' : 'completed';
      mailbox.resolvePendingTask(row.id, status);
      log.info('Host-gated script handled task without spawning a container', {
        sessionId,
        taskId: row.id,
        status,
      });
      continue;
    }

    content.scriptOutput = run.result.data ?? null;
    mailbox.setPendingTaskContent(row.id, JSON.stringify(content));
  }
  return unrecorded;
}
