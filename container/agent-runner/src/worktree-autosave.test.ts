import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { autoCommitDirtyWorktrees } from './worktree-autosave.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'autosave-retired-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('retired worktree autosave', () => {
  it('never changes a shared topic HEAD, index, dirty bytes, or live index lock', async () => {
    const repo = path.join(root, 'worktrees', 'repo');
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'sibling partial edit\n');
    fs.writeFileSync(path.join(repo, '.git', 'index.lock'), 'live sibling lock\n');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const index = fs.readFileSync(path.join(repo, '.git', 'index'));

    expect(await autoCommitDirtyWorktrees('turn end', path.dirname(repo))).toEqual({
      committed: [],
      skipped: [],
      failed: [],
    });
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()).toBe(head);
    expect(fs.readFileSync(path.join(repo, '.git', 'index'))).toEqual(index);
    expect(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('sibling partial edit\n');
    expect(fs.readFileSync(path.join(repo, '.git', 'index.lock'), 'utf8')).toBe('live sibling lock\n');
  });
});
