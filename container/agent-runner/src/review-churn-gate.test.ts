// The churn gate at the container's push primitive.
//
// Two properties matter and they pull against each other: an explicit refusal
// must stop the push, and everything else must not. A gate that blocks a push
// because GitHub was slow would be worked around within a day, which is how
// the advisory detector this replaces ended up ignored.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  CHURN_GATE_SCRIPT_ENV,
  CHURN_GATE_SCRIPT_PATHS,
  churnGateArgs,
  evaluateReviewChurnGate,
  type ChurnGateRun,
} from './review-churn-gate.js';
import { allowSubprocess, clearHermeticityAttempts, resetHermeticityAllowances } from './test-hermeticity.js';

// One case drives a real script through the real spawn, which is the seam the
// stubs above stand in for, so `bash` is opted in by name rather than left as
// an undeclared escape under `NANOCLAW_TEST_HERMETICITY=enforce`.
//
// Granted per test and never re-granted in teardown: bun runs a file's tests in
// one process, so an allowance re-established after the last test would still
// be live for whichever suite runs next, and that suite's undeclared bash would
// pass the tripwire silently.
beforeEach(() => {
  allowSubprocess(['bash']);
});
afterEach(() => {
  clearHermeticityAttempts();
  resetHermeticityAllowances();
});

const REFRAME_TEXT = [
  '======================================================================',
  'REFRAME REQUIRED',
  '======================================================================',
  'class: inv:race @ src/mailbox/write.ts',
  '  4 rounds on one finding class',
  '  candidate primitive(s): writeSessionMessage',
].join('\n');

function stub(
  result: Partial<ChurnGateRun>,
): (script: string, args: string[], worktree: string, timeoutMs: number, env: NodeJS.ProcessEnv) => ChurnGateRun {
  return () => ({ status: 0, stdout: '', stderr: '', ...result });
}

const present = {
  exists: () => true,
  scriptPaths: ['/skill/codex-review.sh'],
  worktree: '/w',
  branch: 'topic/thing',
  head: 'abc1234def',
};

describe('review churn gate at git_push', () => {
  test('refuses the push on the gate exit status, carrying its decision', () => {
    const result = evaluateReviewChurnGate({ ...present, run: stub({ status: 3, stderr: REFRAME_TEXT }) });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.message).toContain('REFRAME REQUIRED');
    expect(result.message).toContain('inv:race @ src/mailbox/write.ts');
    expect(result.message).toContain('writeSessionMessage');
    // The way out is the reframe, or a recorded override — never a silent retry.
    expect(result.message).toContain('not patch another call site');
    expect(result.message).toContain('REVIEW_LOOP_ALLOW_SITE_PATCH=1');
  });

  test('passes a clean gate', () => {
    expect(evaluateReviewChurnGate({ ...present, run: stub({ status: 0 }) }).status).toBe('pass');
  });

  test('fails open when the skill is not mounted', () => {
    const result = evaluateReviewChurnGate({ ...present, exists: () => false });
    expect(result.status).toBe('skipped');
  });

  test('binds the override command to the identity that was refused', () => {
    // The escape hatch is the last consumer of the pinned identity. Unbound, it
    // would resolve the PR from the checkout and let git pick the refspec, so
    // following a refusal could push a sibling's branch and record the override
    // on their PR.
    const result = evaluateReviewChurnGate({ ...present, run: stub({ status: 3, stderr: REFRAME_TEXT }) });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.message).toContain("BRANCH='topic/thing'");
    expect(result.message).toContain("'abc1234def:refs/heads/topic/thing'");
  });

  test('shell-quotes what it puts in a command an agent will run', () => {
    // Git accepts `&` and backticks in a branch name; unquoted, one splits the
    // assignment and the other substitutes a command.
    const result = evaluateReviewChurnGate({
      ...present,
      branch: 'topic/foo&`whoami`',
      run: stub({ status: 3, stderr: REFRAME_TEXT }),
    });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.message).toContain("BRANCH='topic/foo&`whoami`'");
    expect(result.message).toContain("'abc1234def:refs/heads/topic/foo&`whoami`'");
  });

  test('names the script it actually selected in the refusal', () => {
    // The refusal tells the agent how to take the recorded override. Printing
    // the first hard-coded path when the /app fallback or an override was used
    // hands them a command that just fails.
    const fallback = evaluateReviewChurnGate({
      ...present,
      scriptPaths: CHURN_GATE_SCRIPT_PATHS,
      exists: (p) => p === CHURN_GATE_SCRIPT_PATHS[1],
      run: stub({ status: 3, stderr: REFRAME_TEXT }),
    });
    expect(fallback.status).toBe('refused');
    if (fallback.status !== 'refused') return;
    expect(fallback.message).toContain(`'${CHURN_GATE_SCRIPT_PATHS[1]}' push`);
    expect(fallback.message).not.toContain(CHURN_GATE_SCRIPT_PATHS[0]);
  });

  test('fails open when the branch has no PR, gh is unauthenticated, or bash errors', () => {
    // Anything that is not exit 3 is the gate declining to answer.
    for (const status of [1, 2, 127, null]) {
      const result = evaluateReviewChurnGate({ ...present, run: stub({ status, stderr: 'no pull requests found' }) });
      expect(result.status).toBe('skipped');
    }
  });

  test('fails open when the spawn itself fails or times out', () => {
    const spawnFailed = evaluateReviewChurnGate({
      ...present,
      run: stub({ status: null, error: new Error('spawnSync bash ETIMEDOUT') }),
    });
    expect(spawnFailed.status).toBe('skipped');

    const threw = evaluateReviewChurnGate({
      ...present,
      run: () => {
        throw new Error('no bash on PATH');
      },
    });
    expect(threw.status).toBe('skipped');
    if (threw.status !== 'skipped') return;
    expect(threw.reason).toContain('no bash on PATH');
  });

  test('asks about the identity the caller pinned, not the checkout', () => {
    // A push carries committed history, and the caller has already decided
    // which branch and commit it is sending. The gate is told both, so its
    // verdict cannot describe a revision a sibling checked out meanwhile.
    expect(churnGateArgs('abc1234def')).toEqual(['gate', '--committed-only', '--head', 'abc1234def']);
    let seenArgs: string[] = [];
    let seenEnv: NodeJS.ProcessEnv = {};
    evaluateReviewChurnGate({
      ...present,
      env: { PATH: '/usr/bin' },
      run: (_script, args, _worktree, _timeout, env) => {
        seenArgs = args;
        seenEnv = env;
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    expect(seenArgs).toEqual(['gate', '--committed-only', '--head', 'abc1234def']);
    expect(seenEnv.BRANCH).toBe('topic/thing');
    expect(seenEnv.PATH).toBe('/usr/bin');
  });

  test('reads the mounted skill from both provider paths', () => {
    // Claude sees the read-only trunk mount at ~/.claude/skills; every other
    // provider reaches the same directory through /app/skills.
    expect(CHURN_GATE_SCRIPT_PATHS).toEqual([
      '/home/node/.claude/skills/pr-review-loop/scripts/codex-review.sh',
      '/app/skills/pr-review-loop/scripts/codex-review.sh',
    ]);
    const seen: string[] = [];
    evaluateReviewChurnGate({
      ...present,
      scriptPaths: undefined,
      exists: (p) => {
        seen.push(p);
        return false;
      },
    });
    expect(seen).toEqual(CHURN_GATE_SCRIPT_PATHS);
  });

  test('runs a real script through bash, and honours the path override', () => {
    const root = mkdtempSync(join(tmpdir(), 'churn-gate-'));
    try {
      const script = join(root, 'codex-review.sh');
      writeFileSync(script, '#!/usr/bin/env bash\necho "REFRAME REQUIRED: inv:race @ seam" >&2\nexit 3\n');
      chmodSync(script, 0o755);
      const result = evaluateReviewChurnGate({
        ...present,
        scriptPaths: undefined,
        worktree: root,
        env: { [CHURN_GATE_SCRIPT_ENV]: script },
      });
      expect(result.status).toBe('refused');
      if (result.status !== 'refused') return;
      expect(result.message).toContain('inv:race @ seam');

      const clean = join(root, 'clean.sh');
      writeFileSync(clean, '#!/usr/bin/env bash\nexit 0\n');
      chmodSync(clean, 0o755);
      expect(
        evaluateReviewChurnGate({
          ...present,
          scriptPaths: undefined,
          worktree: root,
          env: { [CHURN_GATE_SCRIPT_ENV]: clean },
        }).status,
      ).toBe('pass');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
