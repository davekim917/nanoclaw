/**
 * Tests for autoCommitDirtyWorktrees. Uses real git via execFileSync
 * against tmp dirs — no mocks. The production default scans
 * `/workspace/worktrees`; the helper accepts a `rootDir` override for
 * testing (and future fork-local callers that want a different scope).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { autoCommitDirtyWorktrees } from './worktree-autosave.js';

let tmpRoot: string;
let worktreesDir: string;

function gitInit(repoPath: string): void {
  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoPath });
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoPath });
}

function gitCount(repoPath: string): number {
  const out = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repoPath, encoding: 'utf-8' });
  return parseInt(out.trim(), 10);
}

function gitLastSubject(repoPath: string): string {
  return execFileSync('git', ['log', '-1', '--format=%s'], { cwd: repoPath, encoding: 'utf-8' }).trim();
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autosave-test-'));
  worktreesDir = path.join(tmpRoot, 'worktrees');
  fs.mkdirSync(worktreesDir);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('autoCommitDirtyWorktrees', () => {
  it('returns empty when the worktrees root does not exist', async () => {
    const result = await autoCommitDirtyWorktrees('test', path.join(tmpRoot, 'nonexistent'));
    expect(result).toEqual({ committed: [], skipped: [], failed: [] });
  });

  it('skips a clean worktree', async () => {
    const repo = path.join(worktreesDir, 'clean');
    gitInit(repo);
    const before = gitCount(repo);

    const result = await autoCommitDirtyWorktrees('turn end', worktreesDir);

    expect(result.skipped).toContain('clean');
    expect(result.committed).not.toContain('clean');
    expect(gitCount(repo)).toBe(before);
  });

  it('commits a worktree with uncommitted edits', async () => {
    const repo = path.join(worktreesDir, 'dirty');
    gitInit(repo);
    fs.writeFileSync(path.join(repo, 'new.txt'), 'hello\n');
    fs.appendFileSync(path.join(repo, 'README.md'), 'edit\n');
    const before = gitCount(repo);

    const result = await autoCommitDirtyWorktrees('turn end', worktreesDir);

    expect(result.committed).toContain('dirty');
    expect(gitCount(repo)).toBe(before + 1);
    expect(gitLastSubject(repo)).toBe('auto-save: turn end');
  });

  it('uses the reason string in the commit message', async () => {
    const repo = path.join(worktreesDir, 'reason');
    gitInit(repo);
    fs.writeFileSync(path.join(repo, 'x.txt'), 'x\n');

    await autoCommitDirtyWorktrees('pre-compact', worktreesDir);

    expect(gitLastSubject(repo)).toBe('auto-save: pre-compact');
  });

  it('ignores non-git subdirectories in the worktrees root', async () => {
    const plainDir = path.join(worktreesDir, 'not-a-repo');
    fs.mkdirSync(plainDir);
    fs.writeFileSync(path.join(plainDir, 'file.txt'), 'hi\n');

    const result = await autoCommitDirtyWorktrees('turn end', worktreesDir);

    expect(result.committed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it('handles a mix of clean, dirty, and non-repo entries', async () => {
    gitInit(path.join(worktreesDir, 'a-clean'));

    const dirty = path.join(worktreesDir, 'b-dirty');
    gitInit(dirty);
    fs.writeFileSync(path.join(dirty, 'x.txt'), 'x\n');

    fs.mkdirSync(path.join(worktreesDir, 'c-plain'));

    const result = await autoCommitDirtyWorktrees('turn end', worktreesDir);

    expect(result.committed).toEqual(['b-dirty']);
    expect(result.skipped).toEqual(['a-clean']);
    expect(result.failed).toEqual([]);
  });

  it('removes a stale index.lock before committing', async () => {
    const repo = path.join(worktreesDir, 'locked');
    gitInit(repo);
    fs.writeFileSync(path.join(repo, 'x.txt'), 'x\n');
    fs.writeFileSync(path.join(repo, '.git', 'index.lock'), '');

    const result = await autoCommitDirtyWorktrees('turn end', worktreesDir);

    expect(result.committed).toContain('locked');
    expect(fs.existsSync(path.join(repo, '.git', 'index.lock'))).toBe(false);
  });
});
