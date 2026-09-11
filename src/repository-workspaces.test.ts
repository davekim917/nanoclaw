import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  canonicalGitDir,
  canonicalRepoDir,
  checkoutDirName,
  defaultTopicBranch,
  discoverCanonicalRepositories,
  ensureRepositoryLock,
  isWorkgroupRepositoryMountClaimed,
  listTopicCheckouts,
  originPinPath,
  parseCheckoutDirName,
  readOriginPin,
  repositoryLockPath,
  resolveRepositoryWorkUnit,
  topicWorktreesDir,
  withWorkgroupRepositoryMountClaim,
  writeOriginPin,
} from './repository-workspaces.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-workspaces-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('canonical repository layout', () => {
  it('keeps canonicals and coordination state outside agent-writable workgroup files', () => {
    expect(canonicalRepoDir('wg-a', 'dbt', root)).toBe(path.join(root, 'repositories', 'wg-a', 'dbt'));
    expect(canonicalGitDir('wg-a', 'dbt', root)).toBe(path.join(root, 'repositories', 'wg-a', 'dbt', '.git'));
    expect(repositoryLockPath('wg-a', 'dbt', root)).toBe(
      path.join(root, 'repository-state', 'wg-a', 'dbt', 'repository.lock'),
    );
  });

  it('creates one stable non-symlink lock inode per canonical', () => {
    const first = ensureRepositoryLock('wg-a', 'dbt', root);
    const firstStat = fs.lstatSync(first);
    const second = ensureRepositoryLock('wg-a', 'dbt', root);
    const secondStat = fs.lstatSync(second);

    expect(firstStat.isFile()).toBe(true);
    expect(firstStat.isSymbolicLink()).toBe(false);
    expect(secondStat.ino).toBe(firstStat.ino);
    expect(secondStat.dev).toBe(firstStat.dev);
  });

  it('rejects invalid names and symlink escapes fail closed', () => {
    expect(() => canonicalRepoDir('../other', 'dbt', root)).toThrow(/Invalid workgroup/);
    expect(() => canonicalRepoDir('wg-a', '../dbt', root)).toThrow(/Invalid repository/);

    const repositories = path.join(root, 'repositories', 'wg-a');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: outside });
    fs.mkdirSync(repositories, { recursive: true });
    fs.symlinkSync(outside, path.join(repositories, 'dbt'));

    expect(() => discoverCanonicalRepositories('wg-a', root)).toThrow(/invalid entry|not a real directory/);
  });

  it('fails closed when an existing canonical namespace contains a bare or malformed entry', () => {
    const dbt = canonicalRepoDir('wg-a', 'dbt', root);
    const bare = canonicalRepoDir('wg-a', 'bare', root);
    fs.mkdirSync(dbt, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: dbt });
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', bare]);

    expect(() => discoverCanonicalRepositories('wg-a', root)).toThrow(/Git metadata|not a normal clone/);
  });
});

describe('canonical work-unit resolver', () => {
  it('origin-pin-drift-symlink-escape-cross-workgroup-and-invalid-name-fail-closed', () => {
    const repoA = canonicalRepoDir('wg-a', 'dbt', root);
    const repoB = canonicalRepoDir('wg-b', 'dbt', root);
    fs.mkdirSync(repoA, { recursive: true });
    fs.mkdirSync(repoB, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repoA });
    execFileSync('git', ['init', '-q'], { cwd: repoB });
    writeOriginPin(
      'wg-a',
      'dbt',
      { origin: 'https://github.com/acme-a/dbt.git', repositoryId: 'github.com/acme-a/dbt' },
      root,
    );
    writeOriginPin(
      'wg-b',
      'dbt',
      { origin: 'https://github.com/acme-b/dbt.git', repositoryId: 'github.com/acme-b/dbt' },
      root,
    );

    const input = {
      sessionId: 'same-session-label',
      platformId: 'slack:C123',
      messagingGroupId: 'mg-shared-label',
      threadId: 'slack:C123:171234.567',
    };
    const unitA = resolveRepositoryWorkUnit({ workgroupId: 'wg-a', ...input });
    const unitB = resolveRepositoryWorkUnit({ workgroupId: 'wg-b', ...input });
    const topicA = topicWorktreesDir(unitA, root);
    const topicB = topicWorktreesDir(unitB, root);
    const repositoriesA = discoverCanonicalRepositories('wg-a', root);
    const repositoriesB = discoverCanonicalRepositories('wg-b', root);

    expect(unitA.id).not.toBe(unitB.id);
    expect(topicA).not.toBe(topicB);
    expect(topicA.startsWith(path.join(root, 'v2-topics', 'wg-a') + path.sep)).toBe(true);
    expect(topicB.startsWith(path.join(root, 'v2-topics', 'wg-b') + path.sep)).toBe(true);
    expect(repositoriesA).toHaveLength(1);
    expect(repositoriesB).toHaveLength(1);
    expect(repositoriesA[0]?.gitDir).toBe(path.join(repoA, '.git'));
    expect(repositoriesB[0]?.gitDir).toBe(path.join(repoB, '.git'));

    const mountInputsA = [
      topicA,
      ...repositoriesA.flatMap((repository) => [
        repository.path,
        repository.gitDir,
        repository.lockPath,
        repository.originPinPath,
      ]),
    ];
    const workgroupBNamespaces = ['repositories', 'repository-state', 'v2-topics'].map(
      (namespace) => path.join(root, namespace, 'wg-b') + path.sep,
    );
    expect(mountInputsA.some((candidate) => workgroupBNamespaces.some((scope) => candidate.startsWith(scope)))).toBe(
      false,
    );
    expect(readOriginPin('wg-a', 'dbt', root)?.repositoryId).toBe('github.com/acme-a/dbt');
    expect(readOriginPin('wg-b', 'dbt', root)?.repositoryId).toBe('github.com/acme-b/dbt');

    expect(() =>
      writeOriginPin(
        'wg-a',
        'dbt',
        { origin: 'https://github.com/other/dbt.git', repositoryId: 'github.com/other/dbt' },
        root,
      ),
    ).toThrow(/origin pin conflict/);
    expect(() => canonicalRepoDir('../wg-b', 'dbt', root)).toThrow(/Invalid workgroup/);
    expect(() => canonicalRepoDir('wg-a', '../dbt', root)).toThrow(/Invalid repository/);

    const outside = path.join(root, 'outside-repository');
    fs.mkdirSync(outside, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: outside });
    fs.symlinkSync(outside, path.join(root, 'repositories', 'wg-a', 'escape'));
    expect(() => discoverCanonicalRepositories('wg-a', root)).toThrow(/invalid entry|not a real directory/);
  });

  it('same-topic siblings share one worktree while different topics do not', () => {
    const a = resolveRepositoryWorkUnit({
      workgroupId: 'wg-a',
      sessionId: 'sess-claude',
      platformId: 'slack:C123',
      messagingGroupId: 'mg-claude',
      threadId: 'slack:C123:171234.567',
    });
    const sibling = resolveRepositoryWorkUnit({
      workgroupId: 'wg-a',
      sessionId: 'sess-codex',
      platformId: 'slack:C123',
      messagingGroupId: 'mg-codex',
      threadId: 'slack:C123:171234.567',
    });
    const other = resolveRepositoryWorkUnit({
      workgroupId: 'wg-a',
      sessionId: 'sess-other',
      platformId: 'slack:C123',
      messagingGroupId: 'mg-claude',
      threadId: 'slack:C123:999999.000',
    });

    expect(sibling).toEqual(a);
    expect(other.key).not.toBe(a.key);
    expect(topicWorktreesDir(a, root)).toBe(topicWorktreesDir(sibling, root));
    expect(topicWorktreesDir(other, root)).not.toBe(topicWorktreesDir(a, root));
  });

  it('colon-bearing external identity tuples cannot collide in key, path, branch, or Git admin', () => {
    const first = resolveRepositoryWorkUnit({
      workgroupId: 'wg-a',
      sessionId: 'sess-first',
      platformId: 'slack:C',
      messagingGroupId: 'mg-first',
      threadId: 'T:1',
    });
    const firstSibling = resolveRepositoryWorkUnit({
      workgroupId: 'wg-a',
      sessionId: 'sess-first-sibling',
      platformId: 'slack:C',
      messagingGroupId: 'mg-first-sibling',
      threadId: 'T:1',
    });
    const second = resolveRepositoryWorkUnit({
      workgroupId: 'wg-a',
      sessionId: 'sess-second',
      platformId: 'slack:C:T',
      messagingGroupId: 'mg-second',
      threadId: '1',
    });

    // The previous delimiter-concatenated representation produced the same
    // `thread:slack:C:T:1` key for these two distinct tuples.
    expect(firstSibling).toEqual(first);
    expect(first.key).not.toBe(second.key);
    expect(first.id).not.toBe(second.id);

    const firstPath = path.join(topicWorktreesDir(first, root), 'dbt');
    const secondPath = path.join(topicWorktreesDir(second, root), 'dbt');
    const firstBranch = defaultTopicBranch(first, 'dbt');
    const secondBranch = defaultTopicBranch(second, 'dbt');
    expect(firstPath).not.toBe(secondPath);
    expect(firstBranch).not.toBe(secondBranch);

    const canonical = canonicalRepoDir('wg-a', 'dbt', root);
    fs.mkdirSync(canonical, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: canonical });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: canonical });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: canonical });
    fs.writeFileSync(path.join(canonical, 'tracked.txt'), 'base\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: canonical });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: canonical });
    fs.mkdirSync(path.dirname(firstPath), { recursive: true });
    fs.mkdirSync(path.dirname(secondPath), { recursive: true });
    execFileSync('git', ['worktree', 'add', '-q', '-b', firstBranch, firstPath, 'HEAD'], { cwd: canonical });
    execFileSync('git', ['worktree', 'add', '-q', '-b', secondBranch, secondPath, 'HEAD'], { cwd: canonical });

    const firstAdmin = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: firstPath, encoding: 'utf8' }).trim();
    const secondAdmin = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: secondPath, encoding: 'utf8' }).trim();
    expect(firstAdmin).not.toBe(secondAdmin);
  });

  it('threadless-task-and-private-sessions-resolve-distinct-work-units', () => {
    const conversation = resolveRepositoryWorkUnit({
      workgroupId: 'wg-a',
      sessionId: 'sess-chat',
      platformId: 'slack:D123',
      messagingGroupId: 'mg-chat',
      threadId: null,
    });
    const conversationSibling = resolveRepositoryWorkUnit({
      workgroupId: 'wg-a',
      sessionId: 'sess-chat-codex',
      platformId: 'slack:D123',
      messagingGroupId: 'mg-chat-codex',
      threadId: null,
    });
    const task = resolveRepositoryWorkUnit({
      workgroupId: 'wg-a',
      sessionId: 'sess-task',
      platformId: 'slack:C123',
      messagingGroupId: 'mg-task-output',
      threadId: 'system:tasks:weekly-forecast',
    });
    const privateSession = resolveRepositoryWorkUnit({
      workgroupId: 'wg-a',
      sessionId: 'sess-private',
      platformId: null,
      messagingGroupId: null,
      threadId: null,
    });

    expect(conversation.kind).toBe('conversation');
    expect(conversationSibling).toEqual(conversation);
    expect(task.kind).toBe('task');
    expect(task.key).toContain('weekly-forecast');
    expect(privateSession.kind).toBe('session');
    expect(new Set([conversation.key, task.key, privateSession.key]).size).toBe(3);
  });

  it('default branches derive from workgroup, work-unit, and repo rather than session identity', () => {
    const topic = resolveRepositoryWorkUnit({
      workgroupId: 'wg-a',
      sessionId: 'sess-a',
      platformId: 'slack:C123',
      messagingGroupId: 'mg-a',
      threadId: 'slack:C123:171234.567',
    });
    const siblingTopic = resolveRepositoryWorkUnit({
      workgroupId: 'wg-a',
      sessionId: 'sess-b',
      platformId: 'slack:C123',
      messagingGroupId: 'mg-b',
      threadId: 'slack:C123:171234.567',
    });

    expect(defaultTopicBranch(topic, 'dbt')).toBe(defaultTopicBranch(siblingTopic, 'dbt'));
    expect(defaultTopicBranch(topic, 'dbt')).toMatch(/^nc\/topic-[a-f0-9]{24}$/);
    expect(defaultTopicBranch(topic, 'looker')).not.toBe(defaultTopicBranch(topic, 'dbt'));
  });
});

describe('workgroup mount reconciliation claim', () => {
  it('blocks every work-unit in the workgroup until canonical mount publication finishes', async () => {
    expect(isWorkgroupRepositoryMountClaimed('wg-a')).toBe(false);
    await withWorkgroupRepositoryMountClaim('wg-a', async () => {
      expect(isWorkgroupRepositoryMountClaimed('wg-a')).toBe(true);
      expect(isWorkgroupRepositoryMountClaimed('wg-b')).toBe(false);
      await expect(withWorkgroupRepositoryMountClaim('wg-a', () => undefined)).rejects.toThrow(/already active/);
    });
    expect(isWorkgroupRepositoryMountClaimed('wg-a')).toBe(false);
  });
});

describe('host-only origin pins', () => {
  it('writes atomically and rejects drift without embedding credentials', () => {
    const url = 'https://github.com/acme/dbt.git';
    writeOriginPin('wg-a', 'dbt', { origin: url, repositoryId: 'github.com/acme/dbt' }, root);
    expect(readOriginPin('wg-a', 'dbt', root)).toEqual({
      origin: 'https://github.com/acme/dbt',
      repositoryId: 'github.com/acme/dbt',
    });
    expect(() =>
      writeOriginPin(
        'wg-a',
        'dbt',
        { origin: 'https://github.com/other/dbt.git', repositoryId: 'github.com/other/dbt' },
        root,
      ),
    ).toThrow(/origin pin conflict/);
    expect(() =>
      writeOriginPin('wg-a', 'bad', { origin: 'https://token@github.com/acme/bad.git', repositoryId: 'x' }, root),
    ).toThrow(/credentials/);
  });

  it('rejects query and fragment data on both pin write and persisted-pin read without rewriting it', () => {
    for (const [kind, suffix] of [
      ['query', '?access_token=QUERY_SYNTHETIC_SECRET'],
      ['fragment', '#FRAGMENT_SYNTHETIC_SECRET'],
    ] as const) {
      const repo = `${kind}-pin`;
      const rawOrigin = `https://github.com/acme/${repo}.git${suffix}`;
      const requestedPin = { origin: rawOrigin, repositoryId: `github.com/acme/${repo}` };
      const pinPath = originPinPath('wg-a', repo, root);

      expect(() => writeOriginPin('wg-a', repo, requestedPin, root)).toThrow(
        /origin pin must not include query parameters or fragments/,
      );
      expect(fs.existsSync(pinPath)).toBe(false);

      fs.mkdirSync(path.dirname(pinPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(pinPath, `${JSON.stringify(requestedPin, null, 2)}\n`, { mode: 0o600 });
      const bytesBefore = fs.readFileSync(pinPath);
      expect(() => readOriginPin('wg-a', repo, root)).toThrow(
        /origin pin must not include query parameters or fragments/,
      );
      expect(fs.readFileSync(pinPath)).toEqual(bytesBefore);
      expect(bytesBefore.toString('utf8')).toContain('SYNTHETIC_SECRET');
    }
  });

  it('records an explicit migration-only local repository without inventing a remote', () => {
    writeOriginPin('wg-a', 'scratch', { kind: 'local-only', origin: null, repositoryId: 'local-only:abc123' }, root);
    expect(readOriginPin('wg-a', 'scratch', root)).toEqual({
      kind: 'local-only',
      origin: null,
      repositoryId: 'local-only:abc123',
    });
    expect(() =>
      writeOriginPin(
        'wg-a',
        'bad-local',
        { kind: 'local-only', origin: null, repositoryId: 'github.com/acme/not-local' },
        root,
      ),
    ).toThrow(/malformed/);
  });
});

// ── Checkout layout primitive (plan §5.1) ────────────────────────────────────

describe('checkout layout', () => {
  // One vector file pins this copy and the container's (checkout-layout.ts).
  const fixtures = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), 'container/agent-runner/src/mcp-tools/checkout-layout.fixtures.json'),
      'utf8',
    ),
  ) as {
    checkoutDirName: Array<{ repo: string; branch: string | null; name: string }>;
    parseCheckoutDirName: Array<{ name: string; expected: { repo: string; slug: string | null } | null }>;
  };

  it('checkout names round-trip and never collide', () => {
    for (const vector of fixtures.checkoutDirName) {
      expect(checkoutDirName(vector.repo, vector.branch), `${vector.repo} + ${vector.branch}`).toBe(vector.name);
    }
    for (const vector of fixtures.parseCheckoutDirName) {
      expect(parseCheckoutDirName(vector.name), vector.name).toEqual(vector.expected);
    }
    expect(checkoutDirName('app', 'feat/x')).not.toBe(checkoutDirName('app', 'feat-x'));
    for (const name of ['.staging', '.pnpm-store', '.app.tmp-x']) expect(parseCheckoutDirName(name)).toBeNull();
  });

  it('lists only parsed checkout names, with the shape their .git gives them', () => {
    const topic = path.join(root, 'worktrees');
    fs.mkdirSync(path.join(topic, 'app', '.git'), { recursive: true });
    fs.mkdirSync(path.join(topic, 'app@feat-x'), { recursive: true });
    fs.writeFileSync(path.join(topic, 'app@feat-x', '.git'), 'gitdir: /somewhere\n');
    fs.mkdirSync(path.join(topic, 'app@bare'), { recursive: true });
    fs.mkdirSync(path.join(topic, '.staging', 'req-1', 'app@new'), { recursive: true });
    fs.mkdirSync(path.join(topic, '.pnpm-store'), { recursive: true });
    fs.writeFileSync(path.join(topic, 'app@file-not-dir'), '');

    expect(listTopicCheckouts(topic).map(({ name, repo, slug, shape }) => ({ name, repo, slug, shape }))).toEqual([
      { name: 'app', repo: 'app', slug: null, shape: 'clone' },
      { name: 'app@bare', repo: 'app', slug: 'bare', shape: 'unknown' },
      { name: 'app@feat-x', repo: 'app', slug: 'feat-x', shape: 'linked' },
    ]);
    expect(listTopicCheckouts(path.join(root, 'no-such-topic'))).toEqual([]);
  });
});
