import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it, afterEach, beforeEach } from 'vitest';

import {
  checkFreshness,
  fingerprintDirt,
  isIgnorableDirtPath,
  partitionDirt,
  pathsForLines,
  runCheckBuildClean,
} from './check-build-clean.js';
import { checkBuildDidNotMove } from './write-build-info.js';

/**
 * check-build-clean.ts refuses `pnpm run build` on a dirty tree because
 * dist/ is compiled from the working tree, not HEAD. Docs-only dirt
 * (docs/**, root-level markdown) can't affect dist/, so it must not block a
 * build — but any dirt under src/, container/, scripts/, etc. still must.
 *
 * It also refuses to start a build unless HEAD matches origin/main
 * (checkFreshness), and write-build-info.ts refuses to stamp BUILD_INFO.json
 * if HEAD moved or new blocking dirt appeared between the two steps
 * (checkBuildDidNotMove) — closing the "committed then reset mid-build"
 * failure where a dist/ built from one tree got stamped with a different
 * tree's sha.
 */

describe('isIgnorableDirtPath', () => {
  it('ignores anything under docs/', () => {
    expect(isIgnorableDirtPath('docs/specs/host-sweep-seam/plan.md')).toBe(true);
    expect(isIgnorableDirtPath('docs/specs/host-sweep-seam/run.md')).toBe(true);
    expect(isIgnorableDirtPath('docs/api-details.md')).toBe(true);
  });

  it('ignores root-level markdown', () => {
    expect(isIgnorableDirtPath('README.md')).toBe(true);
    expect(isIgnorableDirtPath('CHANGELOG.md')).toBe(true);
    expect(isIgnorableDirtPath('CONTRIBUTING.md')).toBe(true);
  });

  it('ignores README variants at root regardless of extension', () => {
    expect(isIgnorableDirtPath('README')).toBe(true);
    expect(isIgnorableDirtPath('README-internal.txt')).toBe(true);
  });

  it('does not ignore markdown nested outside docs/', () => {
    expect(isIgnorableDirtPath('dashboard/README.md')).toBe(false);
    expect(isIgnorableDirtPath('container/skills/foo/SKILL.md')).toBe(false);
  });

  it('does not ignore build-relevant paths', () => {
    expect(isIgnorableDirtPath('src/router.ts')).toBe(false);
    expect(isIgnorableDirtPath('container/agent-runner/src/index.ts')).toBe(false);
    expect(isIgnorableDirtPath('scripts/check-build-clean.ts')).toBe(false);
    expect(isIgnorableDirtPath('package.json')).toBe(false);
    expect(isIgnorableDirtPath('pnpm-lock.yaml')).toBe(false);
    expect(isIgnorableDirtPath('tsconfig.json')).toBe(false);
    expect(isIgnorableDirtPath('dashboard/src/App.tsx')).toBe(false);
    expect(isIgnorableDirtPath('setup/verify.ts')).toBe(false);
    expect(isIgnorableDirtPath('.github/workflows/ci.yml')).toBe(false);
  });
});

describe('partitionDirt', () => {
  it('treats docs-only dirt as fully ignorable', () => {
    const lines = [' M docs/specs/host-sweep-seam/plan.md', '?? docs/specs/host-sweep-seam/run.md', ' M README.md'];
    const { blocking, ignored } = partitionDirt(lines);
    expect(blocking).toEqual([]);
    expect(ignored).toEqual(lines);
  });

  it('blocks on mixed docs + src dirt, listing only the non-ignored paths', () => {
    const lines = [' M docs/specs/host-sweep-seam/plan.md', ' M src/router.ts', '?? README.md'];
    const { blocking, ignored } = partitionDirt(lines);
    expect(blocking).toEqual([' M src/router.ts']);
    expect(ignored).toEqual([' M docs/specs/host-sweep-seam/plan.md', '?? README.md']);
  });

  it('blocks a rename unless both sides are ignorable', () => {
    const lines = ['R  docs/old.md -> src/new.ts', 'R  docs/old.md -> docs/new.md'];
    const { blocking, ignored } = partitionDirt(lines);
    expect(blocking).toEqual(['R  docs/old.md -> src/new.ts']);
    expect(ignored).toEqual(['R  docs/old.md -> docs/new.md']);
  });

  it('handles an empty list', () => {
    expect(partitionDirt([])).toEqual({ blocking: [], ignored: [] });
  });
});

describe('pathsForLines', () => {
  it('dedupes and sorts paths across lines, including rename sides', () => {
    expect(pathsForLines([' M b.ts', ' M a.ts', 'R  c.ts -> a.ts'])).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('handles an empty list', () => {
    expect(pathsForLines([])).toEqual([]);
  });
});

describe('fingerprintDirt', () => {
  let dir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fingerprint-test-')));
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is stable for the same content', () => {
    fs.writeFileSync('a.ts', 'hello');
    const lines = [' M a.ts'];
    expect(fingerprintDirt(lines)).toBe(fingerprintDirt(lines));
  });

  it('changes when a blocking path is edited', () => {
    fs.writeFileSync('a.ts', 'hello');
    const before = fingerprintDirt([' M a.ts']);
    fs.writeFileSync('a.ts', 'goodbye');
    expect(fingerprintDirt([' M a.ts'])).not.toBe(before);
  });

  it('changes when the set of blocking paths changes', () => {
    fs.writeFileSync('a.ts', 'hello');
    fs.writeFileSync('b.ts', 'world');
    const before = fingerprintDirt([' M a.ts']);
    expect(fingerprintDirt([' M a.ts', ' M b.ts'])).not.toBe(before);
  });

  it('is stable regardless of input line order', () => {
    fs.writeFileSync('a.ts', 'hello');
    fs.writeFileSync('b.ts', 'world');
    expect(fingerprintDirt([' M a.ts', ' M b.ts'])).toBe(fingerprintDirt([' M b.ts', ' M a.ts']));
  });

  it('is stable for a missing (deleted) path', () => {
    const lines = [' D a.ts'];
    expect(fingerprintDirt(lines)).toBe(fingerprintDirt(lines));
  });

  it('gives a stable value for an empty blocking set', () => {
    expect(fingerprintDirt([])).toBe(fingerprintDirt([]));
  });
});

describe('checkFreshness', () => {
  const head = 'a'.repeat(40);
  const originMain = 'b'.repeat(40);

  it('passes silently when HEAD already matches origin/main', () => {
    expect(checkFreshness(head, head, false)).toEqual({ ok: true, message: null });
  });

  it('refuses when HEAD does not match origin/main and no override is set', () => {
    const result = checkFreshness(head, originMain, false);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('BUILD REFUSED');
    expect(result.message).toContain(head);
    expect(result.message).toContain(originMain);
  });

  it('allows and warns when BUILD_ALLOW_LOCAL overrides a mismatch', () => {
    const result = checkFreshness(head, originMain, true);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('BUILD_ALLOW_LOCAL=1');
    expect(result.message).toContain(head);
    expect(result.message).toContain(originMain);
  });
});

describe('checkBuildDidNotMove', () => {
  const sha = 'c'.repeat(40);
  const otherSha = 'd'.repeat(40);
  const fpA = 'fingerprint-a';
  const fpB = 'fingerprint-b';

  it('passes when there is no recorded start sha to compare against', () => {
    expect(
      checkBuildDidNotMove({
        startSha: null,
        currentSha: sha,
        blockingDirtNow: true,
        allowDirty: false,
        startDirtFingerprint: null,
        currentDirtFingerprint: fpA,
      }),
    ).toEqual({ ok: true, message: null });
  });

  it('passes when HEAD is unchanged and there is no new blocking dirt', () => {
    expect(
      checkBuildDidNotMove({
        startSha: sha,
        currentSha: sha,
        blockingDirtNow: false,
        allowDirty: false,
        startDirtFingerprint: null,
        currentDirtFingerprint: fpA,
      }),
    ).toEqual({ ok: true, message: null });
  });

  it('refuses when HEAD moved since the recorded start sha', () => {
    const result = checkBuildDidNotMove({
      startSha: sha,
      currentSha: otherSha,
      blockingDirtNow: false,
      allowDirty: false,
      startDirtFingerprint: null,
      currentDirtFingerprint: fpA,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('HEAD moved during the build');
    expect(result.message).toContain(sha);
    expect(result.message).toContain(otherSha);
  });

  it('refuses when new blocking dirt appeared and it was not allowed via BUILD_ALLOW_DIRTY', () => {
    const result = checkBuildDidNotMove({
      startSha: sha,
      currentSha: sha,
      blockingDirtNow: true,
      allowDirty: false,
      startDirtFingerprint: null,
      currentDirtFingerprint: fpA,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('HEAD moved during the build');
  });

  it('does not refuse for dirt that was already allowed via BUILD_ALLOW_DIRTY, with a matching fingerprint', () => {
    expect(
      checkBuildDidNotMove({
        startSha: sha,
        currentSha: sha,
        blockingDirtNow: true,
        allowDirty: true,
        startDirtFingerprint: fpA,
        currentDirtFingerprint: fpA,
      }),
    ).toEqual({ ok: true, message: null });
  });

  // Codex review finding on #328: BUILD_ALLOW_DIRTY must waive the refusal
  // for exactly the dirt present at prebuild time, not for any blocking dirt
  // whatsoever — otherwise a peer's mid-build edit to an already-dirty (or
  // newly dirty) file would slip through unnoticed.
  it('refuses under BUILD_ALLOW_DIRTY when the allowed dirt fingerprint has drifted', () => {
    const result = checkBuildDidNotMove({
      startSha: sha,
      currentSha: sha,
      blockingDirtNow: true,
      allowDirty: true,
      startDirtFingerprint: fpA,
      currentDirtFingerprint: fpB,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('HEAD moved during the build');
    expect(result.message).toContain('BUILD_ALLOW_DIRTY');
  });

  it('does not refuse under BUILD_ALLOW_DIRTY when no fingerprint was recorded at all', () => {
    // Defensive fallback for mixed script versions (prebuild ran an older
    // build that never wrote the fingerprint file) — best-effort, matching
    // the startSha === null fallback above.
    expect(
      checkBuildDidNotMove({
        startSha: sha,
        currentSha: sha,
        blockingDirtNow: true,
        allowDirty: true,
        startDirtFingerprint: null,
        currentDirtFingerprint: fpA,
      }),
    ).toEqual({ ok: true, message: null });
  });
});

/**
 * The guard's expensive compiler and lint steps are injected here. The Git
 * fixture still exercises its real dirt and postbuild contracts, while a
 * single smoke below runs the executable with every production default.
 */
describe('scripts/check-build-clean.ts and scripts/write-build-info.ts', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const checkScript = path.join(repoRoot, 'scripts', 'check-build-clean.ts');
  const writeInfoScript = path.join(repoRoot, 'scripts', 'write-build-info.ts');
  const tsx = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

  let dir: string;
  let originDir: string;

  beforeEach(() => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'check-build-clean-test-')));
    originDir = path.join(root, 'origin.git');
    dir = path.join(root, 'repo');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', originDir]);

    fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
    execFileSync('git', ['remote', 'add', 'origin', originDir], { cwd: dir });
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.gitignore'), 'dist/\n');
    fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
    // docs/ must already be a tracked directory (as it is in the real repo)
    // so a later new file inside it shows up as its own porcelain line
    // instead of git collapsing the whole untracked dir into one "docs/" entry.
    fs.writeFileSync(path.join(dir, 'docs', 'existing.md'), 'existing\n');
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const x = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
    // origin/main starts in sync with HEAD, matching the common case; tests
    // that need a mismatch move HEAD locally without pushing.
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: dir });
  });

  afterEach(() => {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  function commit(message: string): string {
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', message], { cwd: dir });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  }

  function headSha(): string {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  }

  function inFixture<T>(fn: () => T): T {
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      return fn();
    } finally {
      process.chdir(originalCwd);
    }
  }

  function runCheck(env: NodeJS.ProcessEnv = {}): { status: number; stdout: string; stderr: string } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const status = inFixture(() =>
      runCheckBuildClean({
        env,
        log: {
          warn: (...messages: unknown[]) => stderr.push(messages.map(String).join(' ')),
          error: (...messages: unknown[]) => stderr.push(messages.map(String).join(' ')),
        },
        steps: {
          typecheck: () => ({ ok: true }),
          lint: () => ({ ok: true }),
        },
      }),
    );
    return { status, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  }

  function runWriteInfo(env: NodeJS.ProcessEnv = {}): void {
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    execFileSync(tsx, [writeInfoScript], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  }

  function readBuildInfo(): { dirty: boolean } {
    return JSON.parse(fs.readFileSync(path.join(dir, 'dist', 'BUILD_INFO.json'), 'utf8'));
  }

  it.each([
    ['typecheck', ['typecheck']],
    ['lint', ['typecheck', 'lint']],
  ] as const)('returns an injected %s failure without running later steps', (failedStep, expectedCalls) => {
    const calls: string[] = [];
    const errors: string[] = [];
    const status = runCheckBuildClean({
      log: { warn: () => undefined, error: (...messages: unknown[]) => errors.push(messages.map(String).join(' ')) },
      steps: {
        typecheck: () => {
          calls.push('typecheck');
          return failedStep === 'typecheck'
            ? { ok: false, message: 'BUILD REFUSED: synthetic typecheck failure.' }
            : { ok: true };
        },
        lint: () => {
          calls.push('lint');
          return failedStep === 'lint'
            ? { ok: false, message: 'BUILD REFUSED: synthetic lint failure.' }
            : { ok: true };
        },
        status: () => {
          calls.push('status');
          return [];
        },
        freshness: () => {
          calls.push('freshness');
          return { head: 'a'.repeat(40), originMain: 'a'.repeat(40) };
        },
        fingerprint: () => '',
        recordBuildStart: () => calls.push('record'),
      },
    });

    expect(status).toBe(1);
    expect(calls).toEqual(expectedCalls);
    expect(errors).toEqual([`BUILD REFUSED: synthetic ${failedStep} failure.`]);
  });

  it('reports an injected status error before freshness can run', () => {
    const calls: string[] = [];
    const errors: string[] = [];
    const status = runCheckBuildClean({
      log: { warn: () => undefined, error: (...messages: unknown[]) => errors.push(messages.map(String).join(' ')) },
      steps: {
        typecheck: () => {
          calls.push('typecheck');
          return { ok: true };
        },
        lint: () => {
          calls.push('lint');
          return { ok: true };
        },
        status: () => {
          calls.push('status');
          throw new Error('synthetic status error');
        },
        freshness: () => {
          calls.push('freshness');
          return { head: 'a'.repeat(40), originMain: 'a'.repeat(40) };
        },
      },
    });

    expect(status).toBe(1);
    expect(calls).toEqual(['typecheck', 'lint', 'status']);
    expect(errors).toEqual(['BUILD REFUSED: could not read working tree status.', 'synthetic status error']);
  });

  it('uses injected status, freshness, and record steps without spawning build gates', () => {
    const calls: string[] = [];
    const recorded: Array<{ head: string; fingerprint: string }> = [];
    const sha = 'a'.repeat(40);
    const status = runCheckBuildClean({
      log: { warn: () => undefined, error: () => undefined },
      steps: {
        typecheck: () => {
          calls.push('typecheck');
          return { ok: true };
        },
        lint: () => {
          calls.push('lint');
          return { ok: true };
        },
        status: () => {
          calls.push('status');
          return [];
        },
        freshness: () => {
          calls.push('freshness');
          return { head: sha, originMain: sha };
        },
        fingerprint: (lines) => {
          calls.push('fingerprint');
          expect(lines).toEqual([]);
          return 'synthetic-fingerprint';
        },
        recordBuildStart: (head, fingerprint) => {
          calls.push('record');
          recorded.push({ head, fingerprint });
        },
      },
    });

    expect(status).toBe(0);
    expect(calls).toEqual(['typecheck', 'lint', 'status', 'freshness', 'fingerprint', 'record']);
    expect(recorded).toEqual([{ head: sha, fingerprint: 'synthetic-fingerprint' }]);
  });

  it('allows a build when only docs/** and root markdown are dirty', () => {
    fs.writeFileSync(path.join(dir, 'docs', 'plan.md'), 'plan\n');
    fs.appendFileSync(path.join(dir, 'README.md'), 'more\n');

    const result = runCheck();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('ignoring docs-only dirt');
    expect(result.stderr).toContain('docs/plan.md');
  });

  it('refuses a build when src/ is dirty, listing only the non-ignored path', () => {
    fs.writeFileSync(path.join(dir, 'docs', 'plan.md'), 'plan\n');
    fs.appendFileSync(path.join(dir, 'src', 'index.ts'), '\nexport const y = 2;\n');

    const result = runCheck();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ignoring docs-only dirt: docs/plan.md');
    expect(result.stderr).toContain('BUILD REFUSED');
    // Only the non-ignored path appears in the "Dirty paths" refusal listing.
    const dirtyPathsSection = result.stderr.slice(result.stderr.indexOf('Dirty paths'));
    expect(dirtyPathsSection).toContain('src/index.ts');
    expect(dirtyPathsSection).not.toContain('docs/plan.md');
  });

  it('BUILD_ALLOW_DIRTY=1 still overrides unchanged, warning on every dirty path', () => {
    fs.writeFileSync(path.join(dir, 'docs', 'plan.md'), 'plan\n');
    fs.appendFileSync(path.join(dir, 'src', 'index.ts'), '\nexport const y = 2;\n');

    const result = runCheck({ BUILD_ALLOW_DIRTY: '1' });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('BUILD_ALLOW_DIRTY=1');
    expect(result.stderr).toContain('src/index.ts');
    expect(result.stderr).toContain('docs/plan.md');
  });

  it('stamps dirty:false in BUILD_INFO.json when only docs-only dirt is present', () => {
    fs.writeFileSync(path.join(dir, 'docs', 'plan.md'), 'plan\n');

    runWriteInfo();
    expect(readBuildInfo().dirty).toBe(false);
  });

  it('stamps dirty:true in BUILD_INFO.json when blocking dirt was let through via BUILD_ALLOW_DIRTY', () => {
    fs.writeFileSync(path.join(dir, 'docs', 'plan.md'), 'plan\n');
    fs.appendFileSync(path.join(dir, 'src', 'index.ts'), '\nexport const y = 2;\n');

    runWriteInfo({ BUILD_ALLOW_DIRTY: '1' });
    expect(readBuildInfo().dirty).toBe(true);
  });

  it('stamps dirty:false in BUILD_INFO.json on a fully clean tree', () => {
    runWriteInfo();
    expect(readBuildInfo().dirty).toBe(false);
  });

  describe('HEAD-freshness guard', () => {
    it('allows a build and records dist/.build-start-sha when HEAD matches origin/main', () => {
      const result = runCheck();
      expect(result.status).toBe(0);
      const startSha = fs.readFileSync(path.join(dir, 'dist', '.build-start-sha'), 'utf8').trim();
      expect(startSha).toBe(headSha());
    });

    it('refuses when HEAD is ahead of origin/main and does not write dist/', () => {
      fs.appendFileSync(path.join(dir, 'src', 'index.ts'), '\nexport const y = 2;\n');
      commit('local-only commit'); // never pushed

      const result = runCheck();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('BUILD REFUSED');
      expect(result.stderr).toContain('does not match origin/main');
      expect(fs.existsSync(path.join(dir, 'dist'))).toBe(false);
    });

    it('BUILD_ALLOW_LOCAL=1 overrides a local-ahead-of-origin HEAD', () => {
      fs.appendFileSync(path.join(dir, 'src', 'index.ts'), '\nexport const y = 2;\n');
      const sha = commit('local-only commit'); // never pushed

      const result = runCheck({ BUILD_ALLOW_LOCAL: '1' });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('BUILD_ALLOW_LOCAL=1');
      expect(fs.readFileSync(path.join(dir, 'dist', '.build-start-sha'), 'utf8').trim()).toBe(sha);
    });
  });

  describe('mid-build move detection (write-build-info.ts)', () => {
    it('refuses and deletes a stale BUILD_INFO.json when HEAD moved since the prebuild check ran', () => {
      // Mirrors the production incident: a peer committed and then reset
      // local main mid-build, so the sha postbuild would stamp no longer
      // matches the tree tsc actually compiled from.
      const startResult = runCheck();
      expect(startResult.status).toBe(0);
      const startSha = headSha();

      fs.appendFileSync(path.join(dir, 'src', 'index.ts'), '\nexport const y = 2;\n');
      const peerSha = commit('peer mid-build commit');
      execFileSync('git', ['reset', '-q', '--hard', 'origin/main'], { cwd: dir }); // "reset local main" — back to a THIRD sha
      execFileSync('git', ['commit', '--allow-empty', '-qm', 'post-reset commit'], { cwd: dir });
      expect(headSha()).not.toBe(startSha);
      expect(headSha()).not.toBe(peerSha);

      fs.writeFileSync(path.join(dir, 'dist', 'BUILD_INFO.json'), '{"stale":true}');
      const writeResult = spawnSync(tsx, [writeInfoScript], { cwd: dir, encoding: 'utf8' });
      expect(writeResult.status).toBe(1);
      expect(writeResult.stderr).toContain('HEAD moved during the build');
      expect(fs.existsSync(path.join(dir, 'dist', 'BUILD_INFO.json'))).toBe(false);
    });

    it('refuses when new build-blocking dirt appears without BUILD_ALLOW_DIRTY between the two steps', () => {
      const startResult = runCheck();
      expect(startResult.status).toBe(0);

      fs.appendFileSync(path.join(dir, 'src', 'index.ts'), '\nexport const y = 2;\n'); // uncommitted, mid-build

      const writeResult = spawnSync(tsx, [writeInfoScript], { cwd: dir, encoding: 'utf8' });
      expect(writeResult.status).toBe(1);
      expect(writeResult.stderr).toContain('HEAD moved during the build');
      expect(fs.existsSync(path.join(dir, 'dist', 'BUILD_INFO.json'))).toBe(false);
    });

    it('does not refuse a deliberate BUILD_ALLOW_DIRTY build whose dirt is unchanged', () => {
      fs.appendFileSync(path.join(dir, 'src', 'index.ts'), '\nexport const y = 2;\n');

      const startResult = runCheck({ BUILD_ALLOW_DIRTY: '1' });
      expect(startResult.status).toBe(0);

      runWriteInfo({ BUILD_ALLOW_DIRTY: '1' });
      expect(readBuildInfo().dirty).toBe(true);
    });

    it('refuses a BUILD_ALLOW_DIRTY build when the ALLOWED dirt changes content mid-build', () => {
      // Codex review finding on #328: BUILD_ALLOW_DIRTY must not waive the
      // refusal for a peer's mid-build edit to the already-permitted file —
      // only the dirt actually present at prebuild time is allowed through.
      fs.appendFileSync(path.join(dir, 'src', 'index.ts'), '\nexport const y = 2;\n');

      const startResult = runCheck({ BUILD_ALLOW_DIRTY: '1' });
      expect(startResult.status).toBe(0);

      fs.appendFileSync(path.join(dir, 'src', 'index.ts'), '\nexport const z = 3;\n'); // mid-build edit

      const writeResult = spawnSync(tsx, [writeInfoScript], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, BUILD_ALLOW_DIRTY: '1' },
      });
      expect(writeResult.status).toBe(1);
      expect(writeResult.stderr).toContain('HEAD moved during the build');
      expect(writeResult.stderr).toContain('BUILD_ALLOW_DIRTY');
      expect(fs.existsSync(path.join(dir, 'dist', 'BUILD_INFO.json'))).toBe(false);
    });

    it('refuses a BUILD_ALLOW_DIRTY build when a NEW blocking file appears mid-build', () => {
      fs.appendFileSync(path.join(dir, 'src', 'index.ts'), '\nexport const y = 2;\n');

      const startResult = runCheck({ BUILD_ALLOW_DIRTY: '1' });
      expect(startResult.status).toBe(0);

      fs.writeFileSync(path.join(dir, 'src', 'new-file.ts'), 'export const brandNew = true;\n'); // mid-build addition

      const writeResult = spawnSync(tsx, [writeInfoScript], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, BUILD_ALLOW_DIRTY: '1' },
      });
      expect(writeResult.status).toBe(1);
      expect(writeResult.stderr).toContain('HEAD moved during the build');
      expect(fs.existsSync(path.join(dir, 'dist', 'BUILD_INFO.json'))).toBe(false);
    });
  });

  // This is the only real tsc + eslint smoke; under host contention it can
  // exceed Vitest's five-second default even though the fixture is minimal.
  it('runs the actual guard once in a self-contained fixture', () => {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(checkScript, path.join(dir, 'scripts', 'check-build-clean.ts'));
    fs.copyFileSync(path.join(repoRoot, 'eslint.config.js'), path.join(dir, 'eslint.config.js'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ type: 'module', scripts: { typecheck: 'tsc --noEmit' } }),
    );
    fs.writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          types: ['node'],
        },
        include: ['src/**/*.ts', 'scripts/**/*.ts'],
      }),
    );
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'));
    commit('add guard smoke fixture');
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: dir });

    const result = spawnSync(tsx, [path.join(dir, 'scripts', 'check-build-clean.ts')], {
      cwd: dir,
      encoding: 'utf8',
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'dist', '.build-start-sha'), 'utf8').trim()).toBe(headSha());
  }, 60_000);
});
