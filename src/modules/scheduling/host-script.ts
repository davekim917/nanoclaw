/**
 * Host-side pre-task script execution (fleet-hardening Phase 1.1).
 *
 * A due task's `content.script` normally only runs after a container has
 * already been spawned for it (container/agent-runner/src/scheduling/
 * task-script.ts, via applyPreTaskScripts). For a monitor series that gates
 * (wakeAgent=false) most fires, that is a full container boot paid for
 * nothing. A series that opts in with `content.scriptHost === true` gets its
 * script run HERE instead, before admitDueTaskContexts admits the row — a
 * gated fire then costs one spawn and no container at all.
 *
 * Output parsing mirrors task-script.ts's runScript on the part that defines a
 * script's contract — the last stdout line is JSON {wakeAgent, data}. Execution
 * deliberately does NOT match, because only this path can stall a process
 * shared by the whole fleet: this one carries a hard deadline, kills the
 * child's process group, and discards output produced after the timeout.
 * The container path's bound is the container lifecycle itself.
 *
 * Both paths cap output at the same 1MiB of BYTES — execFile's `maxBuffer` is
 * documented in bytes and measured as such (400k `中`, 1.2MB of UTF-8, errors
 * with stdout truncated at ~353k code units ≈ 1MiB). They differ only in
 * DELIVERY: execFile hands back a string truncated mid-codepoint alongside its
 * error, while this path refuses the run outright.
 *
 * SECURITY: unlike the container, the host process is long-lived and shared
 * across every session on the fleet, so nothing here runs unclassified. See
 * `classifyForHostExecution` below.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { log } from '../../log.js';
import { evaluateManagedGitCommand } from '../../managed-git-command-guard.js';
// Import-order trap (see config.ts): process.env alone misses values that
// exist only in .env, because this module is imported before index.ts's
// loadEnvIntoProcess() runs.
import { TASK_SCRIPT_TIMEOUT_MS, TIMEZONE } from '../../config.js';
import { resolveGroupTimezone } from '../../container-config.js';
import { isShadowHost } from '../../shadow-host.js';
import type { NanoclawMailboxSession } from '../mailbox/index.js';

// Same rationale as the container-side constant (task-script.ts): the flat
// 30s default killed a working 56s watcher script into an auto-pause.
// Centralized in config.ts so .env actually reaches it (import-order trap).
const SCRIPT_TIMEOUT_MS = TASK_SCRIPT_TIMEOUT_MS;
const SCRIPT_MAX_BUFFER = 1024 * 1024;
// Fraction of the ceiling past which a host-gated script is reported as no
// longer fitting the fast path. Half leaves the "with margin" the admission
// rule asks for: a script routinely at 50% of its ceiling has no headroom for
// a slow upstream, and the next slow day turns it into a timeout — which,
// because timeouts count as failures, walks the series toward the 8-strike
// absorbing auto-pause (recurrence.ts SCRIPT_FAIL_PAUSE_CAP).
const HOST_SCRIPT_BUDGET_WARN_RATIO = 0.5;

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
// Output contract mirrors container/agent-runner/src/scheduling/task-script.ts's
// runScript; the hard deadline in runHostScript is host-only (see header).

/**
 * Explicit minimal env — NEVER the host process's full process.env, which
 * carries credentials for every session on the fleet. A task script only
 * needs a normal shell environment.
 *
 * `tz` is the OWNING GROUP's effective timezone, not the host daemon's own —
 * see the container-runner.ts comment above the equivalent container-side
 * `TZ=` push. A gate that reads `date`, weekday, or other local-time logic
 * must see the same clock the container path would give it.
 */
function minimalEnv(tz: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.HOME) env.HOME = process.env.HOME;
  env.TZ = tz;
  return env;
}

export function runHostScript(script: string, taskId: string, tz: string = TIMEZONE): Promise<ScriptResult | null> {
  // PRIVATE 0700 DIRECTORY, not a predictable name in shared /tmp.
  //
  // The old path was `${os.tmpdir()}/host-task-script-${taskId}-${Date.now()}.sh`
  // at mode 0o755. `taskId` is a series id that appears in logs and on the
  // board, so the name is guessable, host /tmp is world-writable, and the
  // sticky bit does not stop anyone PRE-CREATING that name as a symlink.
  // `fs.writeFileSync` follows symlinks and `mode` only applies when the file
  // is created — so a predicted name is a write-through primitive, and the
  // file we then execute UNSANDBOXED as the host user is attacker-chosen.
  // That is precisely what classifyForHostExecution exists to prevent, routed
  // around entirely. `mkdtempSync` gives a 0700 directory nobody else can
  // traverse; `wx` refuses to follow or clobber anything already there; 0600
  // is enough because `spawn('bash', [path])` never needs the execute bit.
  let dir: string;
  let scriptPath: string;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-task-'));
    scriptPath = path.join(dir, 'script.sh');
    fs.writeFileSync(scriptPath, script, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    // Outside the promise, so an uncaught throw here does not just fail this
    // row — it propagates through runHostGatedTaskScripts and prepareDueWake
    // and aborts the REST OF THIS SESSION'S SWEEP TICK, including unrelated
    // due rows. /tmp at ENOSPC or an unwritable TMPDIR is enough to trigger it,
    // and the row stays pending so every later tick retries identically.
    log.warn('Host task-script could not be written to disk', { taskId, err });
    return Promise.resolve(null);
  }
  /** Remove the script and its private directory. */
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

    // `spawn` + `detached: true`, NOT execFile. Two reasons, both load-bearing:
    //
    // 1. A SCRIPT CAN OUTLIVE ANY SIGNAL WE SEND ITS DIRECT CHILD. execFile's
    //    `timeout` sends SIGTERM to bash alone; `trap '' TERM` ignores it, bash
    //    never exits, and the 'close' the callback waits on never fires — the
    //    promise stays open forever, taking the sequential sweep session loop
    //    with it (this call is awaited inside prepareDueWake). Measured on Node
    //    v20.20.1: `trap '' TERM; sleep 60` with a 1000ms timeout had still not
    //    called back at 11500ms with the child ALIVE. SIGKILL is untrappable,
    //    which is why the deadline below uses it.
    //
    // 2. KILLING BASH DOES NOT KILL WHAT BASH STARTED. Signalling only the
    //    direct child orphans every descendant — a `gh api` fan-out, a
    //    `capped-check.sh` run. The previous version tried to solve this with
    //    `process.kill(-child.pid)` while passing `detached` to execFile, which
    //    SILENTLY DROPS IT (Node allowlists exactly cwd/env/gid/shell/signal/
    //    uid/windowsHide/windowsVerbatimArguments when execFile calls spawn).
    //    The child was therefore never a group leader, so that call only ever
    //    threw ESRCH and the group kill never once ran.
    //
    //    That failure was load-bearing in the other direction too: WITHOUT
    //    `detached` the child inherits the HOST's process group, so "fixing"
    //    the ESRCH by passing the real PGID would have SIGKILLed the NanoClaw
    //    daemon itself (measured: child pid 630842, pgid 630830, host node pid
    //    630831 in that same group). `detached: true` is what makes `-pid` both
    //    correct AND safe: the child becomes its own group leader, so the
    //    negative-pid kill reaches the descendants that stay in its group and
    //    can never reach us. It is containment for the ordinary case, not a
    //    guarantee — see killTree on what escapes it.
    //
    // The cost of spawn() over execFile() is hand-rolled stdout/stderr
    // accumulation and the maxBuffer cap below. That is worth paying rather
    // than resting descendant cleanup on the unenforced assumption that every
    // agent-authored script wraps its own children in `timeout`.
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('bash', [scriptPath], {
        env: minimalEnv(tz),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      // A synchronous spawn throw (bad option shape) would otherwise reject
      // this promise past every cleanup path below, leaking the temp script and
      // leaving the row pending to be retried identically on the next tick.
      cleanup();
      log.warn('Host task-script could not be spawned', { taskId, err });
      return resolve(null);
    }

    /**
     * Signal the child's process group, falling back to the child alone.
     *
     * BEST EFFORT, not a guarantee. It reaches only descendants still IN that
     * group: a script that calls `setsid` (which the classifier does not block)
     * puts its child in a new group we cannot name, and nothing here can reach
     * it. Process-group containment covers the ordinary case — a `gh api`
     * fan-out, a `capped-check.sh` run — not a deliberate escape.
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

    const finish = (result: ScriptResult | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(softTimeout);
      clearTimeout(hardDeadline);
      // ADMISSION-RULE INSTRUMENTATION. `scriptHost` is a fast-path privilege,
      // not a free one: these run SEQUENTIALLY inside the awaited sweep
      // (host-sweep.ts's `for (const session of sessions) await sweepSession`),
      // so every second here is a second the fleet's only timer is late for
      // every other session — processing_ack sync, stale detection, due wakes,
      // ceiling accountability. Measured over ~10.9k ticks: 11% exceeded the
      // 60s sweep interval, worst 1501s, and 65% of those had <=20 sessions,
      // i.e. per-session blocking work rather than session volume.
      //
      // The rule a host-gated script must satisfy is "provable worst case under
      // the ceiling, with margin". Nothing can prove that statically, so
      // MEASURE it: anything past HOST_SCRIPT_BUDGET_WARN_RATIO of its ceiling
      // is a script that no longer fits the fast path and belongs on the
      // container path (sandboxed per run, bounded by the container lifecycle,
      // and crucially OFF this thread). Without this line the attribution does
      // not exist — a slow tick names no script.
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
      // Drop the pipes explicitly. An escaped or D-state descendant keeps the
      // write ends open, and without this the host holds those handles for as
      // long as it lives — the promise resolves but the process cannot exit.
      // Measured: promise resolved at 10.111s, node could not exit until the
      // escaped child ended at 12.011s.
      for (const s of [child.stdout, child.stderr]) {
        try {
          s?.removeAllListeners();
          s?.destroy();
        } catch {
          /* already gone */
        }
      }
      cleanup();
      resolve(result);
    };

    // Accumulate BYTES, not decoded strings, and decode once at the end.
    // `chunk.length` on a utf8-decoded string counts UTF-16 code units, so a
    // character cap silently admits far more memory than intended — 400,000
    // `中` is 1.2MB of UTF-8 but only 400,000 units. `execFile`'s maxBuffer is
    // documented in bytes; matching that keeps the cap an actual memory bound.
    // Concatenating first also makes multibyte sequences split across chunk
    // boundaries a non-issue.
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

    // Graceful first, so a script's own EXIT/TERM trap can clean up.
    //
    // `timedOut` is what makes that grace window safe. A script whose TERM trap
    // emits valid JSON and exits 0 would otherwise be accepted as a SUCCESS —
    // and a `wakeAgent:false` success marks the row completed, RESETTING the
    // recurrence failure streak. A series that blows its budget on every fire
    // would then never reach the 8-failure auto-pause it exists to trigger.
    // The trap still gets to run and clean up; its output just isn't a verdict.
    const softTimeout = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
    }, SCRIPT_TIMEOUT_MS);
    // Then the untrappable one, ten seconds later. `finish` is called here and
    // not left to 'close': a SIGKILL cannot reach a process wedged in
    // uninterruptible D-state, so the sweep must advance on the timer itself
    // rather than on the child's exit. The kill is best-effort cleanup; this
    // resolve is the actual bound.
    const hardDeadline = setTimeout(() => {
      killTree('SIGKILL');
      log.warn('Host task-script exceeded hard deadline — SIGKILL sent to process group, resolving null', { taskId });
      finish(null);
    }, SCRIPT_TIMEOUT_MS + 10_000);

    child.on('error', (err) => {
      log.warn('Host task-script failed to spawn', { taskId, error: err.message });
      finish(null);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      if (stderr) log.debug('Host task-script stderr', { taskId, stderr: stderr.slice(0, 500) });

      if (overflowed) return finish(null);
      // Past the soft deadline the script has already overrun its budget. Its
      // trap was allowed to run, but whatever it printed is not a verdict —
      // accepting it would mark the row completed and reset the recurrence
      // failure streak, so a series that times out every fire would never
      // reach the auto-pause that exists to stop exactly that.
      if (timedOut) {
        log.warn('Host task-script exceeded timeout — output discarded, resolving null', { taskId, signal });
        return finish(null);
      }
      if (code !== 0) {
        log.warn('Host task-script error', { taskId, code, signal });
        return finish(null);
      }

      const lines = stdout.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      if (!lastLine) {
        log.warn('Host task-script produced no output', { taskId });
        return finish(null);
      }

      try {
        const result = JSON.parse(lastLine);
        if (typeof result.wakeAgent !== 'boolean') {
          log.warn('Host task-script output missing wakeAgent boolean', { taskId, lastLine: lastLine.slice(0, 200) });
          return finish(null);
        }
        finish(result as ScriptResult);
      } catch {
        log.warn('Host task-script output is not valid JSON', { taskId, lastLine: lastLine.slice(0, 200) });
        finish(null);
      }
    });
  });
}

// ── Sweep integration ───────────────────────────────────────────────────────

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
 * syncProcessingAcks in the mailbox module, which maps the same two outcomes
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
export async function runHostGatedTaskScripts(
  mailbox: NanoclawMailboxSession,
  agentGroupId: string,
  sessionId: string,
): Promise<void> {
  // The sweep's own session, passed down. `host-sweep.ts` is the only
  // production caller and already holds one for this key, so opening a second
  // here would trip the same-key nesting guard (invariant I-3). Taking the
  // SESSION rather than a raw handle is what keeps this file off the mailbox
  // ratchet's raw-access allowlist (invariant I-9 forbids handles, not
  // sessions).
  //
  // Read every candidate first, then run the scripts: the read is one
  // statement and the loop below can spend the full pre-task timeout per row.
  // The caller therefore holds its session across script execution — which is
  // exactly what the pre-seam state already did by passing the sweep's open
  // inbound handle, so this is not a regression. Closing the session before
  // the scripts run is a host-sweep restructure, not this PR.
  // A host-side script can reach anything the host can, production's image
  // store included; on a shadow host every task script runs in its container.
  if (isShadowHost()) return;
  const due = mailbox.listDueTaskRows();
  if (due.length === 0) return;

  // Resolved once per sweep tick, not per row: every due row here belongs to
  // the same session and therefore the same group. Same value the container
  // path would get (container-runner.ts's `TZ=` push) — a gate that reads
  // local-time logic must not disagree with the container it might still hand
  // off to.
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

    const result = await runHostScript(script, row.id, tz);
    if (!result || !result.wakeAgent) {
      const status = result ? 'completed' : 'failed';
      mailbox.resolvePendingTask(row.id, status);
      log.info('Host-gated script handled task without spawning a container', {
        sessionId,
        taskId: row.id,
        status,
      });
      continue;
    }

    content.scriptOutput = result.data ?? null;
    mailbox.setPendingTaskContent(row.id, JSON.stringify(content));
  }
}
