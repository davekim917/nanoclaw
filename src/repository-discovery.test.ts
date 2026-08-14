import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  discoverPhysicalGitCheckouts,
  isLegacyCanonicalCheckout,
  isPhysicalGitCheckout,
  SESSION_RUNTIME_REPOSITORY_EXCLUSIONS,
} from './repository-discovery.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-repository-discovery-'));
  roots.push(root);
  return root;
}

function normalCheckout(directory: string): void {
  const git = path.join(directory, '.git');
  fs.mkdirSync(path.join(git, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(git, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(git, 'config'), '[core]\n\trepositoryformatversion = 0\n');
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('repository discovery', () => {
  it('excludes exact session runtime surfaces but preserves worktrees and unknown clone locations', () => {
    const root = tempRoot();
    normalCheckout(path.join(root, 'codex', 'memories'));
    normalCheckout(path.join(root, 'plugins', 'bootstrap'));
    normalCheckout(path.join(root, 'worktrees', 'customer-repo'));
    normalCheckout(path.join(root, 'ad-hoc-review'));
    fs.mkdirSync(path.join(root, 'unknown-mount-stub', '.git'), { recursive: true });

    expect(
      discoverPhysicalGitCheckouts(root, [root], {
        skipRootEntries: SESSION_RUNTIME_REPOSITORY_EXCLUSIONS,
      }),
    ).toEqual(
      [path.join(root, 'ad-hoc-review'), path.join(root, 'worktrees', 'customer-repo')].map((entry) =>
        fs.realpathSync(entry),
      ),
    );
  });

  it('checks cache-named directories for repositories before pruning non-repository cache contents', () => {
    const root = tempRoot();
    const groupRoot = path.join(root, 'group');
    const sessionRoot = path.join(root, 'session');
    const threadRoot = path.join(root, 'thread');
    normalCheckout(path.join(groupRoot, 'dist'));
    normalCheckout(path.join(groupRoot, 'dist', 'vendor', 'nested-repository'));
    normalCheckout(path.join(sessionRoot, 'build'));
    normalCheckout(path.join(threadRoot, 'build'));
    normalCheckout(path.join(groupRoot, 'target', 'nested-repository'));
    fs.symlinkSync(path.join(root, 'missing-node-modules-target'), path.join(groupRoot, 'node_modules'));

    expect(discoverPhysicalGitCheckouts(groupRoot, [groupRoot])).toEqual(
      [path.join(groupRoot, 'dist'), path.join(groupRoot, 'dist', 'vendor', 'nested-repository')]
        .map((entry) => fs.realpathSync(entry))
        .sort(),
    );
    expect(
      discoverPhysicalGitCheckouts(sessionRoot, [sessionRoot], {
        skipRootEntries: SESSION_RUNTIME_REPOSITORY_EXCLUSIONS,
      }),
    ).toEqual([fs.realpathSync(path.join(sessionRoot, 'build'))]);
    expect(discoverPhysicalGitCheckouts(threadRoot, [threadRoot])).toEqual([
      fs.realpathSync(path.join(threadRoot, 'build')),
    ]);
  });

  it('inventories retained request-specific repository staging clones instead of hiding them', () => {
    const root = tempRoot();
    const sessionRoot = path.join(root, 'session');
    const retained = path.join(sessionRoot, 'repository-staging', 'request-failed', 'customer-repo');
    normalCheckout(retained);

    expect(
      discoverPhysicalGitCheckouts(sessionRoot, [sessionRoot], {
        skipRootEntries: SESSION_RUNTIME_REPOSITORY_EXCLUSIONS,
      }),
    ).toEqual([fs.realpathSync(retained)]);
  });

  it('fails closed when a source-like pruned basename is a checkout symlink escaping the trusted root', () => {
    const root = tempRoot();
    const outside = tempRoot();
    normalCheckout(path.join(outside, 'external-repository'));
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(path.join(outside, 'external-repository'), path.join(root, 'dist'));

    expect(() => discoverPhysicalGitCheckouts(root, [root])).toThrow(/symlink escapes workgroup roots/);
  });

  it('accepts a broken linked-worktree pointer for explicit collision recovery', () => {
    const root = tempRoot();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: /workspace/agent/repo/.git/worktrees/topic\n');
    expect(isPhysicalGitCheckout(root)).toBe(true);
  });

  it('does not misclassify an immediate linked task worktree as a legacy canonical', () => {
    const root = tempRoot();
    const canonical = path.join(root, 'canonical');
    normalCheckout(canonical);
    const linked = path.join(root, 'topic-task');
    fs.mkdirSync(linked);
    fs.writeFileSync(path.join(linked, '.git'), 'gitdir: /missing/common/.git/worktrees/topic-task\n');
    const nested = path.join(root, 'reviews', 'nested');
    normalCheckout(nested);

    expect(isLegacyCanonicalCheckout(canonical, root)).toBe(true);
    expect(isLegacyCanonicalCheckout(linked, root)).toBe(false);
    expect(isLegacyCanonicalCheckout(nested, root)).toBe(false);
  });

  it('ignores only an empty mount stub and blocks non-empty malformed admin state', () => {
    const root = tempRoot();
    const empty = path.join(root, 'empty');
    fs.mkdirSync(path.join(empty, '.git'), { recursive: true });
    expect(isPhysicalGitCheckout(empty)).toBe(false);

    const malformed = path.join(root, 'malformed');
    fs.mkdirSync(path.join(malformed, '.git'), { recursive: true });
    fs.writeFileSync(path.join(malformed, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    expect(() => isPhysicalGitCheckout(malformed)).toThrow(/not a provable normal repository/);
  });

  it('ignores a directory-only malformed checkout skeleton but blocks one containing any file', () => {
    const root = tempRoot();
    const skeleton = path.join(root, 'skeleton');
    fs.mkdirSync(path.join(skeleton, '.git', 'objects', 'aa'), { recursive: true });
    fs.mkdirSync(path.join(skeleton, '.git', 'refs', 'heads'), { recursive: true });
    fs.mkdirSync(path.join(skeleton, 'empty', 'nested'), { recursive: true });
    const ignored: string[] = [];
    expect(
      isPhysicalGitCheckout(skeleton, {
        onIgnoredDirectoryOnlySkeleton: (directory) => ignored.push(directory),
      }),
    ).toBe(false);
    expect(ignored).toEqual([skeleton]);

    fs.writeFileSync(path.join(skeleton, 'empty', 'proof.txt'), 'must not be ignored\n');
    expect(() => isPhysicalGitCheckout(skeleton)).toThrow(/not a provable normal repository/);
  });

  it('fails closed on a symlinked repository marker', () => {
    const root = tempRoot();
    const target = path.join(root, 'target');
    normalCheckout(target);
    const checkout = path.join(root, 'checkout');
    fs.mkdirSync(checkout);
    fs.symlinkSync(path.join(target, '.git'), path.join(checkout, '.git'));
    expect(() => isPhysicalGitCheckout(checkout)).toThrow(/forbidden symlink/);
  });
});
