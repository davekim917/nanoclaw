import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pruneDanglingSymlinks } from './opencode.js';

describe('pruneDanglingSymlinks', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-test-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('test_removes_dangling_links_and_emptied_dirs_keeps_live_content', () => {
    // Live skill: real SKILL.md + valid symlink.
    const live = path.join(root, 'team-auto');
    fs.mkdirSync(live);
    const realTarget = path.join(root, 'real-target.md');
    fs.writeFileSync(realTarget, 'content');
    fs.writeFileSync(path.join(live, 'SKILL.md'), 'skill');
    fs.symlinkSync(realTarget, path.join(live, 'references'));

    // Retired skill: dir whose only child is a dangling link — the shape
    // that wedged spawns.
    const stale = path.join(root, 'team-qa');
    fs.mkdirSync(stale);
    fs.symlinkSync(path.join(root, 'gone', 'references'), path.join(stale, 'references'));

    // Top-level dangling file link.
    fs.symlinkSync(path.join(root, 'gone.md'), path.join(root, 'trimming.md'));

    pruneDanglingSymlinks(root);

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(path.join(root, 'trimming.md'))).toBe(false);
    expect(fs.existsSync(path.join(live, 'SKILL.md'))).toBe(true);
    expect(fs.readlinkSync(path.join(live, 'references'))).toBe(realTarget);
    // The dereferencing copy the spawn performs must now succeed.
    const dst = path.join(root, '..', path.basename(root) + '-copy');
    fs.cpSync(root, dst, { recursive: true, dereference: true, force: true });
    fs.rmSync(dst, { recursive: true, force: true });
  });
});
