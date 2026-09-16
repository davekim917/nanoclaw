import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { copyOpenCodeSkills } from './opencode.js';

describe('copyOpenCodeSkills', () => {
  let root: string;
  let copyRoot: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-test-'));
    copyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-copy-test-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(copyRoot, { recursive: true, force: true });
  });

  it('filters dangling links only from the derived copy and preserves host authority', () => {
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

    const intentionalEmpty = path.join(root, 'intentional-empty');
    fs.mkdirSync(intentionalEmpty);
    const dst = path.join(copyRoot, 'skills');
    // `root` stands in for the one plugin repository this mirror was built
    // from, so an in-repo link is contained and a dangling one still is not.
    copyOpenCodeSkills(root, dst, { allowedRoots: [fs.realpathSync(root)] });

    // The host-owned source is untouched, including intentional empty dirs.
    expect(fs.lstatSync(path.join(stale, 'references')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(root, 'trimming.md')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(intentionalEmpty)).toBe(true);

    // The derived copy omits stale links but materializes live links as files.
    expect(fs.existsSync(path.join(dst, 'team-qa', 'references'))).toBe(false);
    expect(fs.existsSync(path.join(dst, 'trimming.md'))).toBe(false);
    expect(fs.readFileSync(path.join(dst, 'team-auto', 'SKILL.md'), 'utf8')).toBe('skill');
    expect(fs.lstatSync(path.join(dst, 'team-auto', 'references')).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(dst, 'team-auto', 'references'), 'utf8')).toBe('content');
    expect(fs.lstatSync(path.join(dst, 'intentional-empty')).isDirectory()).toBe(true);
  });
});
