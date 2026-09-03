import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it, afterEach, beforeEach } from 'vitest';

import { isIgnorableDirtPath, partitionDirt } from './check-build-clean.js';

/**
 * check-build-clean.ts refuses `pnpm run build` on a dirty tree because
 * dist/ is compiled from the working tree, not HEAD. Docs-only dirt
 * (docs/**, root-level markdown) can't affect dist/, so it must not block a
 * build — but any dirt under src/, container/, scripts/, etc. still must.
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

/**
 * Integration coverage: run the actual scripts against a throwaway git repo
 * so the exit code / stderr contract and the BUILD_INFO dirty stamp are
 * checked end to end, not just the pure partition helper.
 */
describe('scripts/check-build-clean.ts and scripts/write-build-info.ts (integration)', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const checkScript = path.join(repoRoot, 'scripts', 'check-build-clean.ts');
  const writeInfoScript = path.join(repoRoot, 'scripts', 'write-build-info.ts');
  const tsx = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

  let dir: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'check-build-clean-test-')));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
    // docs/ must already be a tracked directory (as it is in the real repo)
    // so a later new file inside it shows up as its own porcelain line
    // instead of git collapsing the whole untracked dir into one "docs/" entry.
    fs.writeFileSync(path.join(dir, 'docs', 'existing.md'), 'existing\n');
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const x = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function runCheck(env: NodeJS.ProcessEnv = {}): { status: number; stdout: string; stderr: string } {
    const result = spawnSync(tsx, [checkScript], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  function runWriteInfo(env: NodeJS.ProcessEnv = {}): void {
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    execFileSync(tsx, [writeInfoScript], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  }

  function readBuildInfo(): { dirty: boolean } {
    return JSON.parse(fs.readFileSync(path.join(dir, 'dist', 'BUILD_INFO.json'), 'utf8'));
  }

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
});
