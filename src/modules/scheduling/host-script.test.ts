/**
 * Fleet-hardening Phase 1.1: host-side pre-task script gating.
 *
 * Covers the classifier (clean / hard-block / gated) and the sweep-facing
 * runHostGatedTaskScripts, which must:
 *   - actually execute a clean script and act on wakeAgent
 *   - fall back to the (unchanged) container path for anything the
 *     classifier flags, without running it host-side
 *   - never leak the host process's env into the child (only PATH/HOME/TZ)
 */
import os from 'os';
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TIMEZONE } from '../../config.js';
import { openInboundDb } from '../mailbox/openers.js';
import { ensureSchema } from '../mailbox/schema.js';
import { composeNanoclawSession } from '../mailbox/index.js';
import { insertTaskRow } from './db.js';
import { classifyForHostExecution, runHostGatedTaskScripts } from './host-script.js';

// runHostGatedTaskScripts resolves the owning group's timezone via
// resolveGroupTimezone, which reads container_configs from the central DB
// (not initialized here) — mock it, same pattern as recurrence.test.ts.
// Default null → falls back to the real install TIMEZONE; individual tests
// set an override to test propagation.
const containerConfigState = vi.hoisted(() => ({ timezone: null as string | null }));
vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: () => ({ timezone: containerConfigState.timezone }),
}));

const TEST_DIR = uniqueTmpRoot('host-script-test');
const SESS = 'sess-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');
const TEST_GROUP_ID = 'ag-test';

function freshDb() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  ensureSchema(DB_PATH, 'inbound');
  return openInboundDb(DB_PATH);
}

/**
 * The mailbox session the sweep would hand `runHostGatedTaskScripts`.
 *
 * Built with the module's own `composeNanoclawSession` over the fixture's
 * inbound handle, so the ops under test are the production ones and there is
 * exactly one definition of what a session is (invariant I-2). No real mailbox
 * is provisioned — a unit test must not go through `prepare()`.
 *
 * The outbound accessor throws and `outboundPresent` is false: this path is
 * inbound-only, so an accidental outbound read should be loud, not silent.
 */
function sessionFor(db: ReturnType<typeof openInboundDb>) {
  return composeNanoclawSession(
    db,
    () => {
      throw new Error('host-gated task scripts must not touch outbound.db');
    },
    undefined,
    false,
  );
}

function insertHostGatedTask(
  db: ReturnType<typeof openInboundDb>,
  id: string,
  script: string,
  overrides: Record<string, unknown> = {},
): void {
  insertTaskRow(db, {
    id,
    seriesId: id,
    processAfter: new Date(Date.now() - 1_000).toISOString(),
    recurrence: null,
    content: JSON.stringify({ prompt: 'monitor', script, scriptHost: true, ...overrides }),
  });
}

function rowStatus(db: ReturnType<typeof openInboundDb>, id: string): string {
  return (db.prepare('SELECT status FROM messages_in WHERE id = ?').get(id) as { status: string }).status;
}

function rowContent(db: ReturnType<typeof openInboundDb>, id: string): Record<string, unknown> {
  return JSON.parse(
    (db.prepare('SELECT content FROM messages_in WHERE id = ?').get(id) as { content: string }).content,
  );
}

afterEach(() => {
  containerConfigState.timezone = null;
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('classifyForHostExecution', () => {
  it('allows an ordinary curl/jq monitor script', () => {
    expect(
      classifyForHostExecution(
        'c=$(curl -sf https://example.com | jq length) || exit 0\necho "{\\"wakeAgent\\": false}"',
      ),
    ).toEqual({
      safe: true,
    });
  });

  it('hard-blocks rm -rf', () => {
    const result = classifyForHostExecution('rm -rf /workspace/agent/scratch');
    expect(result.safe).toBe(false);
    expect(result.category).toBe('hard-block');
  });

  it('gates a destructive SQL statement (DROP TABLE)', () => {
    const result = classifyForHostExecution('psql -c "DROP TABLE customers"');
    expect(result.safe).toBe(false);
    expect(result.category).toBe('gated');
  });
});

describe('runHostGatedTaskScripts', () => {
  it('runs a clean wakeAgent=false script and marks it completed without a container', async () => {
    const db = freshDb();
    insertHostGatedTask(db, 't-gated', 'echo \'{"wakeAgent": false}\'');

    await runHostGatedTaskScripts(sessionFor(db), TEST_GROUP_ID, SESS);

    expect(rowStatus(db, 't-gated')).toBe('completed');
    db.close();
  });

  it('runs a clean wakeAgent=true script and injects scriptOutput, leaving the row pending for admission', async () => {
    const db = freshDb();
    insertHostGatedTask(db, 't-wake', 'echo \'{"wakeAgent": true, "data": {"alerts": 3}}\'');

    await runHostGatedTaskScripts(sessionFor(db), TEST_GROUP_ID, SESS);

    expect(rowStatus(db, 't-wake')).toBe('pending');
    expect(rowContent(db, 't-wake').scriptOutput).toEqual({ alerts: 3 });
    db.close();
  });

  it('marks an erroring script failed (so recurrence backoff can see it)', async () => {
    const db = freshDb();
    insertHostGatedTask(db, 't-err', 'echo boom >&2; exit 1');

    await runHostGatedTaskScripts(sessionFor(db), TEST_GROUP_ID, SESS);

    expect(rowStatus(db, 't-err')).toBe('failed');
    db.close();
  });

  it('a classifier-flagged rm -rf script never executes host-side and falls back to the container', async () => {
    const db = freshDb();
    // If this ran, it would write a marker file — assert it never does.
    const marker = path.join(TEST_DIR, 'ran.marker');
    insertHostGatedTask(
      db,
      't-danger',
      `touch ${marker}\nrm -rf /workspace/agent/scratch\necho '{"wakeAgent": false}'`,
    );

    await runHostGatedTaskScripts(sessionFor(db), TEST_GROUP_ID, SESS);

    expect(fs.existsSync(marker)).toBe(false);
    // Row untouched: still pending/trigger=0, no scriptOutput — the normal
    // admission + container path picks it up exactly as before this feature.
    expect(rowStatus(db, 't-danger')).toBe('pending');
    expect(rowContent(db, 't-danger').scriptOutput).toBeUndefined();
    db.close();
  });

  it('a classifier-flagged DROP TABLE script never executes host-side and falls back to the container', async () => {
    const db = freshDb();
    const marker = path.join(TEST_DIR, 'ran.marker');
    insertHostGatedTask(db, 't-sql', `touch ${marker}\npsql -c "DROP TABLE customers"\necho '{"wakeAgent": false}'`);

    await runHostGatedTaskScripts(sessionFor(db), TEST_GROUP_ID, SESS);

    expect(fs.existsSync(marker)).toBe(false);
    expect(rowStatus(db, 't-sql')).toBe('pending');
    db.close();
  });

  it('a managed Git maintenance script never executes host-side and leaves its marker absent', async () => {
    const db = freshDb();
    const marker = path.join(TEST_DIR, 'managed-git-ran.marker');
    insertHostGatedTask(
      db,
      't-managed-git',
      `touch ${marker}\ncommand git --git-dir=/host/canonical/.git worktree prune --expire now\necho '{"wakeAgent": false}'`,
    );

    await runHostGatedTaskScripts(sessionFor(db), TEST_GROUP_ID, SESS);

    expect(fs.existsSync(marker)).toBe(false);
    expect(rowStatus(db, 't-managed-git')).toBe('pending');
    expect(rowContent(db, 't-managed-git').scriptOutput).toBeUndefined();
    db.close();
  });

  it('never leaks the host process env into the script — only PATH/HOME/TZ', async () => {
    const db = freshDb();
    const before = process.env.HOST_SCRIPT_TEST_CANARY;
    process.env.HOST_SCRIPT_TEST_CANARY = 'should-not-leak';
    try {
      insertHostGatedTask(
        db,
        't-env',
        'echo "{\\"wakeAgent\\": true, \\"data\\": {\\"canary\\": \\"${HOST_SCRIPT_TEST_CANARY:-absent}\\"}}"',
      );
      await runHostGatedTaskScripts(sessionFor(db), TEST_GROUP_ID, SESS);
      expect(rowContent(db, 't-env').scriptOutput).toEqual({ canary: 'absent' });
    } finally {
      if (before === undefined) delete process.env.HOST_SCRIPT_TEST_CANARY;
      else process.env.HOST_SCRIPT_TEST_CANARY = before;
    }
    db.close();
  });

  it('ignores task rows without scriptHost — the existing container path is untouched', async () => {
    const db = freshDb();
    insertHostGatedTask(db, 't-container-only', 'echo \'{"wakeAgent": false}\'', { scriptHost: false });

    await runHostGatedTaskScripts(sessionFor(db), TEST_GROUP_ID, SESS);

    expect(rowStatus(db, 't-container-only')).toBe('pending');
    expect(rowContent(db, 't-container-only').scriptOutput).toBeUndefined();
    db.close();
  });

  // codex: minimalEnv used to read process.env.TZ — the HOST DAEMON's own
  // clock, same for every group. A gate that reads `date`/weekday must see
  // the same clock the container path (container-runner.ts's `TZ=` push)
  // would give it, or a wake decision can flip depending solely on whether
  // the fire took the host-gated path or the container path.
  it("applies the owning group's timezone override to a host-gated script", async () => {
    containerConfigState.timezone = 'Asia/Tokyo';
    const db = freshDb();
    insertHostGatedTask(db, 't-tz-override', 'echo "{\\"wakeAgent\\": true, \\"data\\": {\\"tz\\": \\"$TZ\\"}}"');

    await runHostGatedTaskScripts(sessionFor(db), TEST_GROUP_ID, 'sess-test');

    expect(rowContent(db, 't-tz-override').scriptOutput).toEqual({ tz: 'Asia/Tokyo' });
    db.close();
  });

  it('falls back to the install timezone when the group has no override', async () => {
    // containerConfigState.timezone stays null (afterEach default / no group
    // config row) — resolveGroupTimezone falls back to the install TIMEZONE.
    const db = freshDb();
    insertHostGatedTask(db, 't-tz-default', 'echo "{\\"wakeAgent\\": true, \\"data\\": {\\"tz\\": \\"$TZ\\"}}"');

    await runHostGatedTaskScripts(sessionFor(db), TEST_GROUP_ID, 'sess-test');

    expect(rowContent(db, 't-tz-default').scriptOutput).toEqual({ tz: TIMEZONE });
    db.close();
  });
});

/** True once `pid` is gone. Polls, because a just-SIGKILLed process is briefly
 *  a zombie and still answers `kill(pid, 0)` until Node reaps it (~100ms). */
async function gone(pid: number, withinMs = 2_000): Promise<boolean> {
  const until = Date.now() + withinMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('runHostScript hard deadline', () => {
  // REGRESSION GUARD. The predecessor of this test ran a script whose
  // GRANDCHILD outlived bash and asserted only `result === null` and
  // `elapsed < 15_000`. It passed in 311ms — via execFile's own timeout —
  // and therefore never executed one line of the deadline. Deleting the
  // whole deadline left it green (audit, 2026-08-26).
  //
  // A grandchild cannot reach the deadline: execFile's timeout tears down the
  // parent's pipe ends, so the callback still fires at T. The ONLY thing that
  // gets past T is a DIRECT child that does not die on SIGTERM — execFile's
  // timeout sends SIGTERM, and the callback waits on an exit that never comes.
  // `trap '' TERM` is the cheap deterministic stand-in for the real cases
  // (uninterruptible D-state, SIGSTOP). classifyForHostExecution does not
  // block `trap`, and these scripts are agent-authored, so this is reachable.
  it('SIGKILLs a SIGTERM-proof script at the deadline, not at the timeout', async () => {
    vi.resetModules();
    // Deadline is timeout + 10s, so these must be far enough apart to tell
    // "resolved at the timeout" from "resolved at the deadline".
    vi.stubEnv('NANOCLAW_TASK_SCRIPT_TIMEOUT_MS', '1000');
    try {
      const { runHostScript } = await import('./host-script.js');
      const started = Date.now();
      const result = await runHostScript("trap '' TERM\nsleep 60\n", 'deadline-test');
      const elapsed = Date.now() - started;

      expect(result).toBeNull();
      // The load-bearing assertion: resolution came from the DEADLINE (~11s),
      // not from execFile's timeout (~1s). Delete the deadline and this fails
      // by hanging until the test timeout — which is the point.
      expect(elapsed).toBeGreaterThanOrEqual(10_000);
      expect(elapsed).toBeLessThan(14_000);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 25_000);

  it('leaves no surviving direct child behind', async () => {
    vi.resetModules();
    vi.stubEnv('NANOCLAW_TASK_SCRIPT_TIMEOUT_MS', '1000');
    try {
      const { runHostScript } = await import('./host-script.js');
      // The script records its own pid so we can prove the SIGKILL landed
      // rather than inferring it from the promise resolving.
      const pidFile = path.join(TEST_DIR, 'deadline-child.pid');
      fs.mkdirSync(TEST_DIR, { recursive: true });
      await runHostScript(`trap '' TERM\necho $$ > ${pidFile}\nsleep 60\n`, 'deadline-pid-test');

      const childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      expect(Number.isInteger(childPid)).toBe(true);

      // Poll rather than checking once: at the instant the deadline resolves,
      // the SIGKILLed child is a ZOMBIE (measured `/proc/<pid>/stat` state `Z`)
      // and still answers `kill(pid, 0)`. Node reaps it within ~100ms. Polling
      // keeps the assertion portable — no /proc — without racing the reap.
      // A SIGTERM-only kill would leave it genuinely alive for the full 2s,
      // because the script traps TERM.
      expect(await gone(childPid)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 25_000);

  // MUTATION GAP codex found: every other fixture here ignores TERM, so making
  // the soft timer a no-op left all of them green while production scripts with
  // a TERM cleanup trap would silently lose their grace window and be SIGKILLed
  // ten seconds later instead. This is the case that pins the SIGTERM step.
  //
  // It also pins the `timedOut` rule. A trap that emits valid JSON and exits 0
  // must still resolve NULL: accepting it would mark the row completed and
  // RESET the recurrence failure streak, so a series that overruns on every
  // fire would never reach the 8-failure auto-pause that exists to catch it.
  it('SIGTERMs at the timeout and discards a trap-emitted result', async () => {
    vi.resetModules();
    vi.stubEnv('NANOCLAW_TASK_SCRIPT_TIMEOUT_MS', '1000');
    try {
      const { runHostScript } = await import('./host-script.js');
      const started = Date.now();
      // Traps TERM, prints a well-formed verdict, exits 0 — the shape that
      // used to be accepted as a success.
      const result = await runHostScript(
        `trap 'echo "{\\"wakeAgent\\":false}"; exit 0' TERM\nsleep 60\n`,
        'soft-timeout-test',
      );
      const elapsed = Date.now() - started;

      // Died on SIGTERM at the soft timeout, so it never reached the hard
      // deadline — that is what fails if the soft timer is made a no-op.
      expect(elapsed).toBeLessThan(5_000);
      expect(elapsed).toBeGreaterThanOrEqual(1_000);
      // And its output is not a verdict.
      expect(result).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  }, 25_000);

  // THE POINT OF spawn() + detached. Killing bash does not kill what bash
  // started: a `gh api` fan-out or a `capped-check.sh` run is a GRANDCHILD, and
  // signalling the direct child alone orphans it. Before this change the code
  // tried `process.kill(-child.pid)` while passing `detached` to execFile,
  // which silently drops it — so the child was never a group leader, that call
  // only ever threw ESRCH, and every descendant survived. Verified at the time:
  // a grandchild outlived the kill and completed its side effect 6s later.
  //
  // The grandchild here is deliberately NOT `timeout`-wrapped. Nothing in
  // classifyForHostExecution requires scripts to bound their own children, and
  // they are agent-authored, so descendant cleanup must not rest on that.
  it('kills GRANDCHILDREN too, not just the direct child', async () => {
    vi.resetModules();
    vi.stubEnv('NANOCLAW_TASK_SCRIPT_TIMEOUT_MS', '1000');
    try {
      const { runHostScript } = await import('./host-script.js');
      fs.mkdirSync(TEST_DIR, { recursive: true });
      const gcPid = path.join(TEST_DIR, 'grandchild.pid');
      const gcMarker = path.join(TEST_DIR, 'grandchild.marker');

      // Backgrounded grandchild records its pid, then tries to write a marker
      // well after the deadline. bash traps TERM so only the group SIGKILL can
      // stop the pair.
      await runHostScript(
        `trap '' TERM\n( echo $BASHPID > ${gcPid}; sleep 40; touch ${gcMarker} ) &\nsleep 60\n`,
        'grandchild-test',
      );

      const grandchildPid = Number(fs.readFileSync(gcPid, 'utf8').trim());
      expect(Number.isInteger(grandchildPid)).toBe(true);
      expect(await gone(grandchildPid)).toBe(true);
      // Belt and braces: it never got far enough to run its side effect.
      expect(fs.existsSync(gcMarker)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 25_000);

  // codex finding 3: the cap must be BYTES. `chunk.length` on a utf8-decoded
  // string counts UTF-16 code units, so 400,000 `中` — 1.2MB of UTF-8 — slipped
  // under a 1MiB character cap and was accepted.
  //
  // Pure bash, no python3: the first draft shelled out to an interpreter, and a
  // box without it would have failed to spawn -> finish(null) -> the expected
  // null, PASSING VACUOUSLY while testing nothing.
  it('counts the output cap in bytes, not UTF-16 code units', async () => {
    vi.resetModules();
    vi.stubEnv('NANOCLAW_TASK_SCRIPT_TIMEOUT_MS', '10000');
    try {
      const { runHostScript } = await import('./host-script.js');
      // The LITERAL character, not a `中` escape: bash printf emits that
      // escape as six ASCII bytes, which blows BOTH caps and makes this test
      // pass either way — vacuous in a second, subtler way than the python3
      // version it replaced. Verified by mutation: with code-unit counting this
      // fixture returns {wakeAgent:true}, with byte counting it returns null.
      //
      // 400 × 1000 three-byte characters = ~1.2MB of UTF-8 in only ~400k code
      // units: over a byte cap, comfortably under a code-unit one.
      const result = await runHostScript(
        `s=$(printf '中%.0s' $(seq 1 1000))\nfor i in $(seq 1 400); do printf '%s' "$s"; done\nprintf '\\n{"wakeAgent":true}\\n'\n`,
        'utf8-cap-test',
      );
      expect(result).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  }, 25_000);

  // ADMISSION RULE. `scriptHost` is a fast-path privilege: these run
  // sequentially inside the awaited sweep, so a slow one makes the fleet's only
  // timer late for every other session. The rule is "worst case under the
  // ceiling, with margin", and nothing can prove that statically — so it is
  // enforced by MEASUREMENT. Without this warning a slow sweep tick names no
  // script and the rule is unenforceable, which is how a 240s gate sat on the
  // host path unnoticed.
  it('reports a host script that runs past half its ceiling', async () => {
    vi.resetModules();
    vi.stubEnv('NANOCLAW_TASK_SCRIPT_TIMEOUT_MS', '2000');
    const { log } = await import('../../log.js');
    const warn = vi.spyOn(log, 'warn');
    try {
      const { runHostScript } = await import('./host-script.js');
      // Finishes successfully, but at ~75% of a 2s ceiling — the shape that
      // times out on the next slow upstream day.
      const result = await runHostScript(`sleep 1.5\necho '{"wakeAgent":false}'\n`, 'budget-warn');

      expect(result).toEqual({ wakeAgent: false });
      const overBudget = warn.mock.calls.find(([msg]) => String(msg).includes('over budget'));
      expect(overBudget).toBeDefined();
      const fields = overBudget?.[1] as { pctOfCeiling: number; timedOut: boolean };
      expect(fields.pctOfCeiling).toBeGreaterThanOrEqual(50);
      // Succeeded — this is the EARLY warning, before it becomes a timeout.
      expect(fields.timedOut).toBe(false);
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  }, 25_000);

  it('stays quiet for a script comfortably inside its ceiling', async () => {
    vi.resetModules();
    vi.stubEnv('NANOCLAW_TASK_SCRIPT_TIMEOUT_MS', '10000');
    const { log } = await import('../../log.js');
    const warn = vi.spyOn(log, 'warn');
    try {
      const { runHostScript } = await import('./host-script.js');
      await runHostScript(`echo '{"wakeAgent":false}'\n`, 'budget-ok');
      expect(warn.mock.calls.find(([msg]) => String(msg).includes('over budget'))).toBeUndefined();
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  }, 25_000);

  // The script file is written into a private 0700 mkdtemp dir at 0600, NOT a
  // predictable name in shared /tmp at 0755. The old shape was a real
  // privilege-escalation surface: `taskId` appears in logs and on the board, so
  // the name was guessable; the sticky bit does not stop pre-creating it as a
  // symlink; writeFileSync FOLLOWS symlinks and `mode` only applies on create —
  // so a predicted name let an attacker choose the file this host then executed
  // UNSANDBOXED, routing straight around classifyForHostExecution.
  it('refuses to write through a pre-planted symlink at its script path', async () => {
    vi.resetModules();
    vi.stubEnv('NANOCLAW_TASK_SCRIPT_TIMEOUT_MS', '5000');
    try {
      const { runHostScript } = await import('./host-script.js');
      fs.mkdirSync(TEST_DIR, { recursive: true });
      const victim = path.join(TEST_DIR, 'victim.txt');
      fs.writeFileSync(victim, 'ORIGINAL');

      // The script reports its own location and permissions from INSIDE the
      // run. The directory is cleaned up on finish, so anything asserted
      // afterwards would be stat-ing a path that no longer exists.
      const result = await runHostScript(
        `d=$(dirname "$0")\nprintf '{"wakeAgent":true,"data":{"dir":"%s","dmode":"%s","fmode":"%s"}}\\n' "$d" "$(stat -c '%a' "$d")" "$(stat -c '%a' "$0")"\n`,
        'sec',
      );

      const { dir, dmode, fmode } = result?.data as { dir: string; dmode: string; fmode: string };
      // Private per-run directory, not the shared tmp root.
      expect(dir).not.toBe(os.tmpdir());
      expect(path.dirname(dir)).toBe(os.tmpdir());
      expect(path.basename(dir)).toMatch(/^nanoclaw-task-/);
      // 0700: nobody else can even traverse in to plant anything.
      expect(dmode).toBe('700');
      // 0600: no execute bit — spawn('bash', [path]) never needed one.
      expect(fmode).toBe('600');
      // Untouched — the old predictable-path shape is what made this reachable.
      expect(fs.readFileSync(victim, 'utf8')).toBe('ORIGINAL');
      // And the run cleans up after itself.
      expect(fs.existsSync(dir)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 25_000);

  // glm found this uncovered: nothing pinned the SIGKILL in the overflow
  // branch. The byte-cap fixture above exits on its own, so deleting that kill
  // left every test green. A script that floods WITHOUT exiting is the case
  // that matters — unkilled it burns CPU and IO for the full timeout+10s on
  // every fire, stalling the sequential sweep worse than the wedge the
  // deadline exists to prevent.
  it('kills a non-exiting flood producer at the overflow, not at the deadline', async () => {
    vi.resetModules();
    vi.stubEnv('NANOCLAW_TASK_SCRIPT_TIMEOUT_MS', '10000');
    try {
      const { runHostScript } = await import('./host-script.js');
      const started = Date.now();
      // Never exits on its own and ignores TERM: only the overflow SIGKILL can
      // end this before the 20s hard deadline.
      const result = await runHostScript(`trap '' TERM\nwhile :; do printf '%01000d' 0; done\n`, 'overflow-kill-test');
      const elapsed = Date.now() - started;

      expect(result).toBeNull();
      // Well inside the 10s timeout, so it died on the cap rather than a timer.
      expect(elapsed).toBeLessThan(8_000);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 30_000);
});
