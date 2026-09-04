// The churn gate at the container's push primitive.
//
// Two properties matter and they pull against each other: an explicit refusal
// must stop the push, and everything else must not. A gate that blocks a push
// because GitHub was slow would be worked around within a day, which is how
// the advisory detector this replaces ended up ignored.
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  CHURN_GATE_ARGS,
  CHURN_GATE_SCRIPT_ENV,
  CHURN_GATE_SCRIPT_PATHS,
  evaluateReviewChurnGate,
  type ChurnGateRun,
} from './review-churn-gate.js';

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
): (script: string, args: string[], worktree: string, timeoutMs: number) => ChurnGateRun {
  return () => ({ status: 0, stdout: '', stderr: '', ...result });
}

const present = { exists: () => true, scriptPaths: ['/skill/codex-review.sh'], worktree: '/w' };

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
    const result = evaluateReviewChurnGate({ worktree: '/w', exists: () => false });
    expect(result.status).toBe('skipped');
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

  test('judges only what the push will send', () => {
    // A push carries committed history. Uncommitted work at the primitive is
    // evidence for a pre-commit check, not for a push, so the gate is always
    // invoked with --committed-only here.
    expect(CHURN_GATE_ARGS).toEqual(['gate', '--committed-only']);
    let seen: string[] = [];
    evaluateReviewChurnGate({
      ...present,
      run: (_script, args) => {
        seen = args;
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    expect(seen).toEqual(['gate', '--committed-only']);
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
      worktree: '/w',
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
      const result = evaluateReviewChurnGate({ worktree: root, env: { [CHURN_GATE_SCRIPT_ENV]: script } });
      expect(result.status).toBe('refused');
      if (result.status !== 'refused') return;
      expect(result.message).toContain('inv:race @ seam');

      const clean = join(root, 'clean.sh');
      writeFileSync(clean, '#!/usr/bin/env bash\nexit 0\n');
      chmodSync(clean, 0o755);
      expect(evaluateReviewChurnGate({ worktree: root, env: { [CHURN_GATE_SCRIPT_ENV]: clean } }).status).toBe('pass');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
