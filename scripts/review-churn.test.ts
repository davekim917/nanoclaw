// The pr-review-loop churn gate: does a finding CLASS that has survived three
// rounds actually stop the next site patch?
//
// The classifier ships with the skill as dependency-free ESM
// (`.claude/skills/pr-review-loop/scripts/review-churn.mjs`) because it also
// runs inside an agent container, where nothing is installed. So this suite
// drives it the way the loop does: as a subprocess, payload on stdin, decision
// on stderr and `--json` on stdout, and the exit code as the gate itself.
// Every fixture carries its own `sources`, so no case reads the checkout.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../src/test-hermeticity.js';

allowSubprocess(['node']);
enforceHermeticity();

const SCRIPT = path.resolve('.claude/skills/pr-review-loop/scripts/review-churn.mjs');
const CONTAINER_SCRIPT = path.resolve('container/skills/pr-review-loop/scripts/review-churn.mjs');
const FIXTURES = path.resolve('scripts/__fixtures__/review-churn');

interface Site {
  file: string;
  line: number | null;
  title?: string;
}
interface ClassRow {
  key: string;
  signature: string;
  seam: string | null;
  primitives: string[];
  rounds: number;
  findings: number;
  sites: Site[];
}
interface SeamRow {
  seam: string;
  rounds: number;
  severityFalling: boolean;
}
interface Report {
  classes: ClassRow[];
  seams: SeamRow[];
  totalRounds: number;
  totalFindings: number;
}
interface Decision {
  status: 'pass' | 'refuse' | 'override';
  flagged: (ClassRow & { lifted: boolean; liftedBy: string | null; reason: string })[];
  unlifted: ClassRow[];
  report: Report;
}

interface Payload {
  findings: unknown[];
  sources?: Record<string, string>;
  commits?: { sha: string; date: string; message: string; files: string[] }[];
  worktree?: string[];
}

function fixture(name: string): Payload {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as Payload;
}

function spawn(args: string[], payload: Payload, env: Record<string, string> = {}) {
  // REVIEW_LOOP_ALLOW_SITE_PATCH must never leak in from the caller's shell:
  // the override case has to be the one that sets it.
  const base = { ...process.env };
  delete base.REVIEW_LOOP_ALLOW_SITE_PATCH;
  const res = spawnSync('node', [SCRIPT, ...args], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...base, ...env },
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

function classify(payload: Payload): Report {
  const out = spawn(['classify', '--json'], payload);
  expect(out.status).toBe(0);
  return JSON.parse(out.stdout) as Report;
}

/** The gate as the loop sees it: exit status, machine decision, human text. */
function gate(payload: Payload, env: Record<string, string> = {}) {
  const out = spawn(['gate', '--json'], payload, env);
  return { status: out.status, decision: JSON.parse(out.stdout) as Decision, text: out.stderr };
}

const AFTER = '2026-09-02T00:00:00Z'; // later than every finding in toctou-class
const BEFORE = '2026-08-30T00:00:00Z'; // earlier than every finding in toctou-class

describe('review-churn classifier', () => {
  it('collapses one invariant reported at four call sites into one class', () => {
    const report = classify(fixture('toctou-class'));

    const churning = report.classes.filter((c) => c.rounds >= 3);
    expect(churning).toHaveLength(1);
    expect(churning[0].signature).toBe('inv:race');
    expect(churning[0].rounds).toBe(4);
    expect(churning[0].findings).toBe(4);
    expect(new Set(churning[0].sites.map((s) => s.file))).toEqual(
      new Set(['src/router.ts', 'src/delivery.ts', 'src/tasks.ts', 'src/dashboard/close.ts']),
    );
  });

  it('names the seam those sites share and the primitives they call', () => {
    const churning = classify(fixture('toctou-class')).classes.find((c) => c.rounds >= 3)!;
    expect(churning.seam).toBe('src/mailbox/write.ts');
    expect(churning.primitives).toContain('writeSessionMessage');
    expect(churning.primitives).toContain('wakeContainer');
  });

  it('sees churn the file-level detector cannot: no file reaches three rounds', () => {
    const payload = fixture('toctou-class');
    const roundsPerFile = new Map<string, Set<string>>();
    for (const f of payload.findings as { path: string; reviewId: string }[]) {
      if (!roundsPerFile.has(f.path)) roundsPerFile.set(f.path, new Set());
      roundsPerFile.get(f.path)!.add(f.reviewId);
    }
    expect(Math.max(...[...roundsPerFile.values()].map((s) => s.size))).toBeLessThan(3);

    expect(classify(payload).classes.some((c) => c.rounds >= 3)).toBe(true);
  });

  it('keeps an unrelated finding out of the churning class', () => {
    const report = classify(fixture('toctou-class'));
    const nullability = report.classes.find((c) => c.signature === 'inv:nullability');
    expect(nullability?.rounds).toBe(1);
    expect(report.classes.find((c) => c.rounds >= 3)!.sites.map((s) => s.title)).not.toContain(
      'Treat an absent config value as empty',
    );
  });

  it('reads severity direction per seam, not per finding', () => {
    const falling = classify(fixture('seam-drift-falling'));
    const flat = classify(fixture('seam-drift-flat'));
    expect(falling.seams[0].seam).toBe('src/mailbox/write.ts');
    expect(falling.seams[0].rounds).toBe(3);
    expect(falling.seams[0].severityFalling).toBe(true);
    expect(flat.seams[0].severityFalling).toBe(false);
  });
});

describe('review-churn gate', () => {
  it('refuses a site patch once a class has run three rounds', () => {
    const { status, decision, text } = gate(fixture('toctou-class'));
    expect(status).toBe(3);
    expect(decision.status).toBe('refuse');
    expect(decision.unlifted).toHaveLength(1);
    expect(text).toContain('REFRAME REQUIRED');
    expect(text).toContain('inv:race @ src/mailbox/write.ts');
    expect(text).toContain('src/mailbox/write.ts');
    expect(text).toContain('writeSessionMessage');
    expect(text).toContain('src/dashboard/close.ts');
    expect(text).toContain('Reframe: <invariant> enforced in <primitive>');
  });

  it('lifts when a commit after the last finding touches the primitive', () => {
    const payload = fixture('toctou-class');
    payload.commits = [
      { sha: 'aaa1111', date: AFTER, message: 'fix(mailbox): guard the write', files: ['src/mailbox/write.ts'] },
    ];
    const { status, decision } = gate(payload);
    expect(status).toBe(0);
    expect(decision.status).toBe('pass');
    expect(decision.flagged[0].liftedBy).toBe('diff touches the primitive');
  });

  it('lifts on the reframe trailer even when the diff is elsewhere', () => {
    const payload = fixture('toctou-class');
    payload.commits = [
      {
        sha: 'bbb2222',
        date: AFTER,
        message:
          'fix(mailbox): one guard for every caller\n\nReframe: session revalidation enforced in writeSessionMessage\n',
        files: ['src/somewhere-else.ts'],
      },
    ];
    const { status, decision } = gate(payload);
    expect(status).toBe(0);
    expect(decision.flagged[0].liftedBy).toBe('reframe trailer');
  });

  it('lifts on uncommitted work at the primitive, so the gate is runnable before committing', () => {
    const payload = fixture('toctou-class');
    payload.worktree = ['src/mailbox/write.ts'];
    expect(gate(payload).status).toBe(0);
  });

  it('does not accept a seam commit that predates the finding as the reframe', () => {
    const payload = fixture('toctou-class');
    payload.commits = [
      { sha: 'ccc3333', date: BEFORE, message: 'chore: earlier work', files: ['src/mailbox/write.ts'] },
    ];
    const { status, decision } = gate(payload);
    expect(status).toBe(3);
    expect(decision.status).toBe('refuse');
  });

  it('does not accept a patch at another site as the reframe', () => {
    const payload = fixture('toctou-class');
    payload.commits = [
      { sha: 'ddd4444', date: AFTER, message: 'fix: revalidate in the task path', files: ['src/tasks.ts'] },
    ];
    expect(gate(payload).status).toBe(3);
  });

  it('lets the override through, loudly, still naming the class', () => {
    const { status, decision, text } = gate(fixture('toctou-class'), { REVIEW_LOOP_ALLOW_SITE_PATCH: '1' });
    expect(status).toBe(0);
    expect(decision.status).toBe('override');
    expect(decision.unlifted).toHaveLength(1);
    expect(text).toContain('SITE PATCH OVERRIDE');
    expect(text).toContain('REVIEW_LOOP_ALLOW_SITE_PATCH=1');
    expect(text).toContain('inv:race @ src/mailbox/write.ts');
  });

  it('refuses three flat-severity rounds on one seam even when no class repeats', () => {
    const flat = gate(fixture('seam-drift-flat'));
    expect(flat.status).toBe(3);
    expect(flat.decision.unlifted[0].key).toBe('seam src/mailbox/write.ts');
    expect(flat.text).toContain('severity not falling');
  });

  it('passes three rounds on one seam when severity is falling', () => {
    const falling = gate(fixture('seam-drift-falling'));
    expect(falling.status).toBe(0);
    expect(falling.decision.status).toBe('pass');
    expect(falling.decision.flagged).toHaveLength(0);
  });

  it('passes a PR whose worst class has run two rounds', () => {
    const payload = fixture('toctou-class');
    payload.findings = (payload.findings as { reviewId: string }[]).filter(
      (f) => f.reviewId === 'PRR_1' || f.reviewId === 'PRR_2',
    );
    const { status, decision } = gate(payload);
    expect(status).toBe(0);
    expect(decision.status).toBe('pass');
    expect(decision.report.classes.every((c) => c.rounds < 3)).toBe(true);
  });
});

describe('skill wiring', () => {
  // The loop runs on the host AND inside agent containers, which mount
  // container/skills/. There is exactly one copy — the host path is a symlink
  // into the container tree — and a gate that exists in only one of them is a
  // gate half the fleet does not have. This asserts the link, because turning
  // it into a real directory is how the two would silently drift.
  it('serves one copy to the host and the container', () => {
    const host = path.resolve('.claude/skills/pr-review-loop');
    expect(fs.lstatSync(host).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(host)).toBe('../../container/skills/pr-review-loop');
    expect(fs.realpathSync(SCRIPT)).toBe(fs.realpathSync(CONTAINER_SCRIPT));
  });

  it('ships the classifier executable next to the helper', () => {
    expect(fs.existsSync(CONTAINER_SCRIPT)).toBe(true);
    expect(fs.statSync(CONTAINER_SCRIPT).mode & 0o111).toBeGreaterThan(0);
  });

  it('routes the push subcommand through the gate', () => {
    const helper = fs.readFileSync(path.resolve('container/skills/pr-review-loop/scripts/codex-review.sh'), 'utf8');
    expect(helper).toMatch(/push\)\n\s+#[\s\S]*?run_gate\n\s+shift\n\s+git push/);
  });
});
