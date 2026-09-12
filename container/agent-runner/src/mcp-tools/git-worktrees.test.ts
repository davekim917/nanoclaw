import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import {
  cloneRepoTool,
  createWorktreeTool,
  gitCommitTool,
  gitPushTool,
  isScanPolicyRepositoryName,
  openPrTool,
  resetScanPolicyRepositoryNamesForTest,
} from './git-worktrees';
import { checkoutDirName } from './checkout-layout';
import { builtInNanoclawMcpEnv } from '../nanoclaw-mcp-env.js';
import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';
describe('topic-linked worktree topology', () => {
  let root: string;
  let dataDir: string;
  let canonical: string;
  let remote: string;
  let firstTopic: string;
  const ENV_KEYS = [
    'NANOCLAW_WORKTREES_DIR_OVERRIDE',
    'NANOCLAW_WORKGROUP_ID',
    'NANOCLAW_HOST_DATA_DIR',
    'NANOCLAW_HOST_TOPIC_WORKTREES_DIR',
    'NANOCLAW_WORK_UNIT_KEY',
    'NANOCLAW_REPOSITORY_ALLOW_LOCAL_ORIGIN',
    'NANOCLAW_REPOSITORY_ACTION_TRANSPORT',
    'NANOCLAW_REVIEW_CHURN_GATE_SCRIPT',
    'NANOCLAW_CHECKOUT_MODE',
    'NANOCLAW_REPOSITORY_CHECKOUT_TIMEOUT_MS',
    'NANOCLAW_REPOSITORY_CHECKOUT_RETRY_DELAY_MS',
    'PATH',
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
  ] as const;
  let savedEnv: Record<string, string | undefined>;

  const git = (cwd: string, args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' })
      .toString()
      .trim();

  const plainGit = (cwd: string, args: string[]) =>
    execFileSync('git', args, {
      cwd,
      env: process.env,
      stdio: 'pipe',
    })
      .toString()
      .trim();

  function fixtureGitIdentity(role: string): { name: string; email: string } {
    const suffix = randomBytes(6).toString('hex');
    const localPart = role.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return {
      name: `Fixture ${role} ${suffix}`,
      email: `fixture-${localPart}-${suffix}@example.invalid`,
    };
  }

  function setGitIdentity(identity: { name: string; email: string }): void {
    const forwarded = builtInNanoclawMcpEnv({
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    });
    for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'] as const) {
      process.env[key] = forwarded[key]!;
    }
  }

  function commitIdentity(cwd: string): { name: string; email: string; committerName: string; committerEmail: string } {
    const [name, email, committerName, committerEmail] = git(cwd, [
      'show',
      '-s',
      '--format=%an%n%ae%n%cn%n%ce',
      'HEAD',
    ]).split('\n');
    return { name, email, committerName, committerEmail };
  }

  function seedCanonical(): void {
    const seed = join(root, 'seed');
    mkdirSync(seed, { recursive: true });
    git(seed, ['init', '-q', '-b', 'main']);
    writeFileSync(join(seed, 'README.md'), 'base\n');
    git(seed, ['add', '-A']);
    git(seed, ['commit', '-q', '-m', 'base']);
    remote = join(root, 'remote.git');
    execFileSync('git', ['clone', '-q', '--bare', seed, remote]);
    canonical = join(dataDir, 'repositories', 'wg-a', 'proj');
    mkdirSync(join(dataDir, 'repositories', 'wg-a'), { recursive: true });
    execFileSync('git', ['clone', '-q', remote, canonical]);
    git(canonical, ['remote', 'set-head', 'origin', '--auto']);
    git(canonical, ['config', 'gc.auto', '0']);

    const state = join(dataDir, 'repository-state', 'wg-a', 'proj');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'origin.json'), JSON.stringify({ origin: remote, repositoryId: remote }));
    writeFileSync(join(state, 'repository.lock'), '');
  }

  /** Same shape as seedCanonical, for a second repository name — used by the #666-follow-up scan-policy tests. */
  function seedNamedCanonical(name: string): string {
    const named = join(dataDir, 'repositories', 'wg-a', name);
    execFileSync('git', ['clone', '-q', remote, named]);
    git(named, ['remote', 'set-head', 'origin', '--auto']);
    git(named, ['config', 'gc.auto', '0']);
    const state = join(dataDir, 'repository-state', 'wg-a', name);
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'origin.json'), JSON.stringify({ origin: remote, repositoryId: `${remote}#${name}` }));
    writeFileSync(join(state, 'repository.lock'), '');
    return named;
  }

  function useTopic(name: string, workUnitKey: string): string {
    const topic = join(dataDir, 'v2-topics', 'wg-a', name, 'worktrees');
    mkdirSync(topic, { recursive: true });
    process.env.NANOCLAW_WORKTREES_DIR_OVERRIDE = topic;
    process.env.NANOCLAW_HOST_TOPIC_WORKTREES_DIR = topic;
    process.env.NANOCLAW_WORK_UNIT_KEY = workUnitKey;
    return topic;
  }

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    root = mkdtempSync(join(tmpdir(), 'gw-topic-linked-'));
    dataDir = join(root, 'data');
    process.env.NANOCLAW_WORKGROUP_ID = 'wg-a';
    process.env.NANOCLAW_HOST_DATA_DIR = dataDir;
    process.env.NANOCLAW_REPOSITORY_ALLOW_LOCAL_ORIGIN = '1';
    process.env.NANOCLAW_REPOSITORY_ACTION_TRANSPORT = 'disabled';
    firstTopic = useTopic('topic-one', 'thread:slack:C1:1.1');
    seedCanonical();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test('same-topic-siblings-share-one-worktree', async () => {
    const first = await createWorktreeTool.handler({ repo: 'proj' });
    const second = await createWorktreeTool.handler({ repo: 'proj' });
    const worktree = join(firstTopic, 'proj');

    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    expect(lstatSync(join(worktree, '.git')).isFile()).toBe(true);
    expect(git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).toBe(join(canonical, '.git'));
    expect(second.content[0].text).toContain('Worktree ready');
  });

  test('host-list-move-remove-works-with-container-created-host-native-metadata', async () => {
    const created = await createWorktreeTool.handler({ repo: 'proj' });
    const worktree = join(firstTopic, 'proj');
    const moved = join(firstTopic, 'proj-moved-by-host');

    expect(created.isError).toBeFalsy();
    expect(git(canonical, ['worktree', 'list', '--porcelain'])).toContain(`worktree ${worktree}`);
    expect(git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).toBe(join(canonical, '.git'));

    git(canonical, ['worktree', 'move', worktree, moved]);
    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(moved)).toBe(true);
    expect(git(canonical, ['worktree', 'list', '--porcelain'])).toContain(`worktree ${moved}`);
    expect(git(moved, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).toBe(join(canonical, '.git'));

    git(canonical, ['worktree', 'remove', moved]);
    expect(existsSync(moved)).toBe(false);
    expect(git(canonical, ['worktree', 'list', '--porcelain'])).not.toContain(`worktree ${moved}`);
  });

  test('different-topics-have-distinct-path-head-index-and-admin-dir', async () => {
    expect((await createWorktreeTool.handler({ repo: 'proj' })).isError).toBeFalsy();
    const one = join(firstTopic, 'proj');
    const oneBranch = git(one, ['branch', '--show-current']);

    const secondTopic = useTopic('topic-two', 'thread:slack:C1:2.2');
    expect((await createWorktreeTool.handler({ repo: 'proj' })).isError).toBeFalsy();
    const two = join(secondTopic, 'proj');

    expect(two).not.toBe(one);
    expect(git(two, ['branch', '--show-current'])).not.toBe(oneBranch);
    expect(git(two, ['rev-parse', '--git-path', 'index'])).not.toBe(git(one, ['rev-parse', '--git-path', 'index']));
    expect(git(two, ['rev-parse', '--absolute-git-dir'])).not.toBe(git(one, ['rev-parse', '--absolute-git-dir']));

    writeFileSync(join(one, 'only-one.txt'), 'one\n');
    git(one, ['add', '-A']);
    git(one, ['commit', '-q', '-m', 'topic one']);
    expect(existsSync(join(two, 'only-one.txt'))).toBe(false);
    expect(git(two, ['status', '--porcelain'])).toBe('');
  });

  test('branch-switch-or-commit-in-one-topic-does-not-affect-another', async () => {
    expect((await createWorktreeTool.handler({ repo: 'proj' })).isError).toBeFalsy();
    const one = join(firstTopic, 'proj');
    const secondTopic = useTopic('topic-two', 'thread:slack:C1:2.2');
    expect((await createWorktreeTool.handler({ repo: 'proj' })).isError).toBeFalsy();
    const two = join(secondTopic, 'proj');
    const twoBranch = git(two, ['branch', '--show-current']);
    const twoHead = git(two, ['rev-parse', 'HEAD']);

    git(one, ['switch', '-q', '-c', 'topic-one-only']);
    writeFileSync(join(one, 'topic-one-only.txt'), 'isolated\n');
    git(one, ['add', '-A']);
    git(one, ['commit', '-q', '-m', 'topic one only']);

    expect(git(two, ['branch', '--show-current'])).toBe(twoBranch);
    expect(git(two, ['rev-parse', 'HEAD'])).toBe(twoHead);
    expect(git(two, ['status', '--porcelain'])).toBe('');
    expect(existsSync(join(two, 'topic-one-only.txt'))).toBe(false);
  });

  test('new-worktree-starts-at-fresh-origin-head-and-existing-worktree-is-untouched', async () => {
    expect((await createWorktreeTool.handler({ repo: 'proj' })).isError).toBeFalsy();
    const existing = join(firstTopic, 'proj');
    const existingHead = git(existing, ['rev-parse', 'HEAD']);

    const scratch = join(root, 'advance');
    execFileSync('git', ['clone', '-q', remote, scratch]);
    writeFileSync(join(scratch, 'fresh.txt'), 'fresh\n');
    git(scratch, ['add', '-A']);
    git(scratch, ['commit', '-q', '-m', 'fresh']);
    git(scratch, ['push', '-q', 'origin', 'main']);
    const freshHead = git(scratch, ['rev-parse', 'HEAD']);

    expect((await createWorktreeTool.handler({ repo: 'proj' })).isError).toBeFalsy();
    expect(git(existing, ['rev-parse', 'HEAD'])).toBe(existingHead);
    expect(git(existing, ['rev-parse', 'refs/remotes/origin/main'])).toBe(freshHead);

    const secondTopic = useTopic('topic-two', 'thread:slack:C1:2.2');
    expect((await createWorktreeTool.handler({ repo: 'proj' })).isError).toBeFalsy();
    const fresh = join(secondTopic, 'proj');

    expect(git(fresh, ['rev-parse', 'HEAD'])).toBe(freshHead);
    expect(git(existing, ['rev-parse', 'HEAD'])).toBe(existingHead);
    expect(existsSync(join(existing, 'fresh.txt'))).toBe(false);
  });

  test('an unexplained surviving topic ref is reattached and never reset to origin HEAD', async () => {
    expect((await createWorktreeTool.handler({ repo: 'proj' })).isError).toBeFalsy();
    const worktree = join(firstTopic, 'proj');
    writeFileSync(join(worktree, 'unpushed.txt'), 'must survive\n');
    git(worktree, ['add', '-A']);
    git(worktree, ['commit', '-q', '-m', 'unpushed local work']);
    const preservedHead = git(worktree, ['rev-parse', 'HEAD']);
    git(canonical, ['worktree', 'remove', worktree]);

    const scratch = join(root, 'advance-after-loss');
    execFileSync('git', ['clone', '-q', remote, scratch]);
    writeFileSync(join(scratch, 'remote-new.txt'), 'new remote work\n');
    git(scratch, ['add', '-A']);
    git(scratch, ['commit', '-q', '-m', 'advance remote']);
    git(scratch, ['push', '-q', 'origin', 'main']);

    const recreated = await createWorktreeTool.handler({ repo: 'proj' });
    expect(recreated.isError).toBeFalsy();
    expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(preservedHead);
    expect(existsSync(join(worktree, 'unpushed.txt'))).toBe(true);
    expect(existsSync(join(worktree, 'remote-new.txt'))).toBe(false);
  });

  test('migration local-only canonical preserves work and creates linked topics without fetching', async () => {
    git(canonical, ['remote', 'remove', 'origin']);
    writeFileSync(
      join(dataDir, 'repository-state', 'wg-a', 'proj', 'origin.json'),
      JSON.stringify({ kind: 'local-only', origin: null, repositoryId: 'local-only:wg-a-proj' }),
    );
    const canonicalHead = git(canonical, ['rev-parse', 'HEAD']);

    const created = await createWorktreeTool.handler({ repo: 'proj' });
    const worktree = join(firstTopic, 'proj');
    expect(created.isError).toBeFalsy();
    expect(created.content[0].text).toContain('preserved local-only canonical');
    expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(canonicalHead);
    expect(git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).toBe(join(canonical, '.git'));

    writeFileSync(join(worktree, 'ongoing.txt'), 'safe\n');
    expect((await gitCommitTool.handler({ repo: 'proj', message: 'keep local work' })).isError).toBeFalsy();
    const push = await gitPushTool.handler({ repo: 'proj' });
    expect(push.isError).toBe(true);
    expect(git(worktree, ['status', '--porcelain'])).toBe('');
  });

  test('explicit branch already owned by another worktree is rejected without mutation', async () => {
    const sourceLocator = `thread-${'a'.repeat(32)}`;
    const sourceTopic = useTopic(sourceLocator, 'thread:slack:C1:1.1');
    expect((await createWorktreeTool.handler({ repo: 'proj', branch: 'shared-feature' })).isError).toBeFalsy();
    const firstHead = git(join(sourceTopic, 'proj'), ['rev-parse', 'HEAD']);
    const secondTopic = useTopic('topic-two', 'thread:slack:C1:2.2');

    const response = await createWorktreeTool.handler({ repo: 'proj', branch: 'shared-feature' });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('already checked out');
    expect(response.content[0].text).toContain(`continueFromThreadId: '${sourceLocator}'`);
    expect(response.content[0].text).toContain('Do not delete or prune it');
    expect(existsSync(join(secondTopic, 'proj'))).toBe(false);
    expect(git(join(sourceTopic, 'proj'), ['rev-parse', 'HEAD'])).toBe(firstHead);
  });

  test('an explicit branch held by the canonical checkout gets a self-service alternative', async () => {
    const response = await createWorktreeTool.handler({ repo: 'proj', branch: 'main' });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('checked out by the canonical repository');
    expect(response.content[0].text).toContain('Retry without an explicit branch');
    expect(response.content[0].text).toContain('No prune or host cleanup is needed');
    expect(existsSync(join(firstTopic, 'proj'))).toBe(false);
    expect(git(canonical, ['branch', '--show-current'])).toBe('main');
  });

  test('an unmounted managed sibling is never deregistered and is routed through exact transfer', async () => {
    const sourceLocator = `thread-${'b'.repeat(32)}`;
    firstTopic = useTopic(sourceLocator, 'thread:slack:C1:1.1');
    expect((await createWorktreeTool.handler({ repo: 'proj', branch: 'surviving-feature' })).isError).toBeFalsy();
    const abandoned = join(firstTopic, 'proj');
    writeFileSync(join(abandoned, 'preserved.txt'), 'committed before directory loss\n');
    git(abandoned, ['add', '-A']);
    git(abandoned, ['commit', '-q', '-m', 'preserve local branch']);
    const preservedHead = git(abandoned, ['rev-parse', 'HEAD']);

    // Model a killed/removed topic directory whose canonical registration
    // survived. The branch ref is intact; only the linked checkout vanished.
    rmSync(abandoned, { recursive: true, force: true });
    const destinationTopic = useTopic('topic-two', 'thread:slack:C1:2.2');

    const response = await createWorktreeTool.handler({ repo: 'proj', branch: 'surviving-feature' });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain(`continueFromThreadId: '${sourceLocator}'`);
    expect(existsSync(join(destinationTopic, 'proj'))).toBe(false);
    expect(git(canonical, ['rev-parse', 'refs/heads/surviving-feature'])).toBe(preservedHead);
    expect(git(canonical, ['worktree', 'list', '--porcelain'])).toContain(`worktree ${abandoned}`);
  });

  test('the current topic self-heals its own missing registration', async () => {
    expect((await createWorktreeTool.handler({ repo: 'proj', branch: 'same-topic-feature' })).isError).toBeFalsy();
    const worktree = join(firstTopic, 'proj');
    writeFileSync(join(worktree, 'preserved.txt'), 'committed before same-topic directory loss\n');
    git(worktree, ['add', '-A']);
    git(worktree, ['commit', '-q', '-m', 'preserve same-topic branch']);
    const preservedHead = git(worktree, ['rev-parse', 'HEAD']);
    rmSync(worktree, { recursive: true, force: true });
    mkdirSync(worktree, { recursive: true });

    const response = await createWorktreeTool.handler({ repo: 'proj', branch: 'same-topic-feature' });
    expect(response.isError).toBeFalsy();
    expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(preservedHead);
    expect(readFileSync(join(worktree, 'preserved.txt'), 'utf8')).toBe('committed before same-topic directory loss\n');
  });

  test('a missing locked owner is preserved and remains blocked', async () => {
    expect((await createWorktreeTool.handler({ repo: 'proj', branch: 'locked-feature' })).isError).toBeFalsy();
    const locked = join(firstTopic, 'proj');
    git(canonical, ['worktree', 'lock', '--reason', 'operator hold', locked]);
    const preservedHead = git(locked, ['rev-parse', 'HEAD']);
    rmSync(locked, { recursive: true, force: true });
    const response = await createWorktreeTool.handler({ repo: 'proj', branch: 'locked-feature' });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('automatic cleanup refused');
    expect(response.content[0].text).toContain('is locked');
    expect(existsSync(locked)).toBe(false);
    expect(git(canonical, ['rev-parse', 'refs/heads/locked-feature'])).toBe(preservedHead);
  });

  test('a missing owner with staged state is never pruned', async () => {
    expect((await createWorktreeTool.handler({ repo: 'proj', branch: 'staged-feature' })).isError).toBeFalsy();
    const staged = join(firstTopic, 'proj');
    writeFileSync(join(staged, 'recoverable.txt'), 'recoverable only from the linked index\n');
    git(staged, ['add', 'recoverable.txt']);
    const adminDir = git(staged, ['rev-parse', '--absolute-git-dir']);
    const indexBefore = readFileSync(join(adminDir, 'index'));
    rmSync(staged, { recursive: true, force: true });
    const response = await createWorktreeTool.handler({ repo: 'proj', branch: 'staged-feature' });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('automatic cleanup refused');
    expect(response.content[0].text).toContain('has staged changes');
    expect(existsSync(staged)).toBe(false);
    expect(readFileSync(join(adminDir, 'index'))).toEqual(indexBefore);
    expect(git(canonical, ['worktree', 'list', '--porcelain'])).toContain(`worktree ${staged}`);
  });

  test('an unrelated missing staged owner does not block targeted recovery of a clean owner', async () => {
    expect((await createWorktreeTool.handler({ repo: 'proj', branch: 'staged-sibling' })).isError).toBeFalsy();
    const stagedSibling = join(firstTopic, 'proj');
    writeFileSync(join(stagedSibling, 'recoverable.txt'), 'keep this staged blob\n');
    git(stagedSibling, ['add', 'recoverable.txt']);
    const stagedAdmin = git(stagedSibling, ['rev-parse', '--absolute-git-dir']);
    const stagedIndex = readFileSync(join(stagedAdmin, 'index'));
    rmSync(stagedSibling, { recursive: true, force: true });

    const cleanTopic = useTopic('topic-two', 'thread:slack:C1:2.2');
    expect((await createWorktreeTool.handler({ repo: 'proj', branch: 'clean-sibling' })).isError).toBeFalsy();
    const cleanOwner = join(cleanTopic, 'proj');
    writeFileSync(join(cleanOwner, 'committed.txt'), 'keep this commit\n');
    git(cleanOwner, ['add', 'committed.txt']);
    git(cleanOwner, ['commit', '-q', '-m', 'clean branch commit']);
    const cleanHead = git(cleanOwner, ['rev-parse', 'HEAD']);
    rmSync(cleanOwner, { recursive: true, force: true });

    const response = await createWorktreeTool.handler({ repo: 'proj', branch: 'clean-sibling' });
    expect(response.isError).toBeFalsy();
    expect(git(cleanOwner, ['rev-parse', 'HEAD'])).toBe(cleanHead);
    expect(readFileSync(join(cleanOwner, 'committed.txt'), 'utf8')).toBe('keep this commit\n');
    expect(readFileSync(join(stagedAdmin, 'index'))).toEqual(stagedIndex);
    const worktrees = git(canonical, ['worktree', 'list', '--porcelain']);
    expect(worktrees).toContain(`worktree ${stagedSibling}`);
    expect(worktrees).toContain(`worktree ${cleanOwner}`);
  });

  test('linked-worktree-fetch-commit-push-works-through-scoped-git-metadata', async () => {
    expect((await createWorktreeTool.handler({ repo: 'proj' })).isError).toBeFalsy();
    const worktree = join(firstTopic, 'proj');
    writeFileSync(join(worktree, 'feature.txt'), 'feature\n');

    expect((await gitCommitTool.handler({ repo: 'proj', message: 'feature' })).isError).toBeFalsy();
    expect((await gitPushTool.handler({ repo: 'proj' })).isError).toBeFalsy();
    const branch = git(worktree, ['branch', '--show-current']);
    expect(git(remote, ['show-ref', '--verify', `refs/heads/${branch}`])).toContain(branch);
  });

  test('configured agents retain distinct identities for plain Git and the managed git_commit tool', async () => {
    const plainIdentity = fixtureGitIdentity('Plain Agent');
    setGitIdentity(plainIdentity);
    expect((await createWorktreeTool.handler({ repo: 'proj', branch: 'plain-identity' })).isError).toBeFalsy();
    const plainWorktree = join(firstTopic, 'proj');
    writeFileSync(join(plainWorktree, 'plain.txt'), 'plain git commit\n');
    plainGit(plainWorktree, ['add', '-A']);
    plainGit(plainWorktree, ['commit', '--no-verify', '-m', 'plain identity']);

    const managedIdentity = fixtureGitIdentity('Managed Agent');
    setGitIdentity(managedIdentity);
    const managedTopic = useTopic('topic-managed-identity', 'thread:slack:C1:identity');
    expect((await createWorktreeTool.handler({ repo: 'proj', branch: 'managed-identity' })).isError).toBeFalsy();
    const managedWorktree = join(managedTopic, 'proj');
    writeFileSync(join(managedWorktree, 'managed.txt'), 'managed git commit\n');
    expect((await gitCommitTool.handler({ repo: 'proj', message: 'managed identity' })).isError).toBeFalsy();

    expect(commitIdentity(plainWorktree)).toEqual({
      name: plainIdentity.name,
      email: plainIdentity.email,
      committerName: plainIdentity.name,
      committerEmail: plainIdentity.email,
    });
    expect(commitIdentity(managedWorktree)).toEqual({
      name: managedIdentity.name,
      email: managedIdentity.email,
      committerName: managedIdentity.name,
      committerEmail: managedIdentity.email,
    });
    expect(git(plainWorktree, ['rev-parse', '--git-common-dir'])).toBe(
      git(managedWorktree, ['rev-parse', '--git-common-dir']),
    );
  });

  test('push-is-refused-while-the-review-churn-gate-holds', async () => {
    // A container agent's push path is this tool, not `codex-review.sh push`,
    // so the gate has to hold here or container review loops never see it.
    expect((await createWorktreeTool.handler({ repo: 'proj' })).isError).toBeFalsy();
    const worktree = join(firstTopic, 'proj');
    writeFileSync(join(worktree, 'site.txt'), 'one more call site\n');
    expect((await gitCommitTool.handler({ repo: 'proj', message: 'patch another site' })).isError).toBeFalsy();
    const branch = git(worktree, ['branch', '--show-current']);

    const gateScript = join(root, 'refusing-gate.sh');
    // Exits 3 only when it is handed the pinned identity: --committed-only
    // (a push sends commits, not the working tree), --head <sha> and BRANCH.
    // So this also proves the gate is asked about what the push will send.
    writeFileSync(
      gateScript,
      '#!/usr/bin/env bash\n' +
        'case "$*" in *--committed-only*) ;; *) exit 0 ;; esac\n' +
        `case "$*" in *--head\\ ${'$'}(git rev-parse HEAD)*) ;; *) exit 0 ;; esac\n` +
        'test -n "$BRANCH" || exit 0\n' +
        'echo "REFRAME REQUIRED: inv:race @ src/mailbox/write.ts" >&2\nexit 3\n',
    );
    chmodSync(gateScript, 0o755);
    process.env.NANOCLAW_REVIEW_CHURN_GATE_SCRIPT = gateScript;

    const refused = await gitPushTool.handler({ repo: 'proj' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('REFRAME REQUIRED');
    expect(refused.content[0].text).toContain('not patch another call site');
    expect(() => git(remote, ['show-ref', '--verify', `refs/heads/${branch}`])).toThrow();

    // The commit is untouched: the gate refuses the push, it does not rewrite
    // the agent's work.
    expect(git(worktree, ['log', '-1', '--format=%s'])).toBe('patch another site');

    // And the same push goes through once the gate stops holding.
    const cleanGate = join(root, 'clean-gate.sh');
    writeFileSync(cleanGate, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(cleanGate, 0o755);
    process.env.NANOCLAW_REVIEW_CHURN_GATE_SCRIPT = cleanGate;
    expect((await gitPushTool.handler({ repo: 'proj' })).isError).toBeFalsy();
    expect(git(remote, ['show-ref', '--verify', `refs/heads/${branch}`])).toContain(branch);
  });

  test('captures the branch and its commit in one git invocation', async () => {
    // Two commands can straddle a sibling's checkout switch, leaving a branch
    // name from before it beside a commit from after — an identity that never
    // existed, which the gate would then judge and the refspec would push.
    const source = readFileSync(fileURLToPath(new URL('./git-worktrees.ts', import.meta.url)), 'utf8');
    const handler = source.slice(source.indexOf("name: 'git_push'"), source.indexOf("name: 'open_pr'"));
    expect(handler).toContain('capturedIdentity(resolved.context)');
    expect(handler).not.toContain("'branch', '--show-current'");
    expect(handler).not.toContain("'rev-parse', 'HEAD'");
    expect(source).toContain("['status', '--porcelain=v2', '--branch', '--untracked-files=no']");
  });

  test('captures the whole identity inside the repository lock', async () => {
    // The status read and the remote read describe one instant or they describe
    // nothing: a sibling's create_worktree runs its `fetch --prune` under this
    // same lock, so a capture straddling it would pair this checkout's commit
    // with a tracking ref the fetch had just advanced, and the lease would name
    // a commit this caller never integrated. The lock is taken by the capture
    // itself rather than by its callers, so there is no way to spell an
    // unlocked identity read.
    const source = readFileSync(fileURLToPath(new URL('./git-worktrees.ts', import.meta.url)), 'utf8');
    const captured = source.slice(
      source.indexOf('async function capturedIdentity('),
      source.indexOf('export const createWorktreeTool'),
    );
    expect(captured).toContain('withRepositoryLock(context, () => {');
    // Both reads, inside the closure the lock wraps.
    const locked = captured.slice(captured.indexOf('withRepositoryLock'));
    expect(locked).toContain("'status', '--porcelain=v2'");
    expect(locked).toContain('refs/remotes/origin/${head}');
  });

  test('a force push carries the lease it captured, not one inferred at push time', async () => {
    // A bare --force-with-lease expects whatever refs/remotes/origin/<branch>
    // says when the push runs, and any sibling topic's create_worktree
    // refreshes that ref with a shared fetch — so a commit that landed while
    // the gate was on the network would be adopted as the expectation and then
    // overwritten.
    const source = readFileSync(fileURLToPath(new URL('./git-worktrees.ts', import.meta.url)), 'utf8');
    expect(source).toContain('`--force-with-lease=refs/heads/${branch}:${identity.lease}`');
    expect(source).not.toContain("'--force-with-lease'");
    expect(source).toContain("tryGitAt(worktree, ['rev-parse', `refs/remotes/origin/${head}`])");

    // And it still pushes: force from a worktree whose branch is on the remote.
    expect((await createWorktreeTool.handler({ repo: 'proj' })).isError).toBeFalsy();
    const worktree = join(firstTopic, 'proj');
    writeFileSync(join(worktree, 'work.txt'), 'one\n');
    expect((await gitCommitTool.handler({ repo: 'proj', message: 'one' })).isError).toBeFalsy();
    expect((await gitPushTool.handler({ repo: 'proj' })).isError).toBeFalsy();
    git(worktree, ['commit', '-q', '--amend', '-m', 'one amended']);
    expect((await gitPushTool.handler({ repo: 'proj', force: true })).isError).toBeFalsy();
    const branch = git(worktree, ['branch', '--show-current']);
    expect(git(remote, ['rev-parse', branch])).toBe(git(worktree, ['rev-parse', 'HEAD']));
  });

  test('opens the PR for the branch it captured, not the current checkout', async () => {
    // `gh pr create` defaults --head to whatever is checked out, so a sibling
    // switching branches mid-call would open the PR for their branch.
    const source = readFileSync(fileURLToPath(new URL('./git-worktrees.ts', import.meta.url)), 'utf8');
    const openPr = source.slice(source.indexOf("name: 'open_pr'"));
    expect(openPr).toContain('capturedIdentity(resolved.context)');
    expect(openPr).toContain("'--head', head");
    // Never the raw checkout: --head comes from a named branch or from a
    // capture, and there is no path that lets `gh` pick it.
    expect(openPr).not.toContain("'--head', identity.branch");
  });

  test('opens the PR for a named branch when one is given', async () => {
    // The window between git_push returning and open_pr being called is
    // between two tool calls, so no locking inside either one reaches it. The
    // branch git_push reported is passed back, and this call describes that
    // push rather than the checkout as it now stands.
    const source = readFileSync(fileURLToPath(new URL('./git-worktrees.ts', import.meta.url)), 'utf8');
    const openPr = source.slice(source.indexOf("name: 'open_pr'"));
    expect(openPr).toContain("typeof args.branch === 'string'");
    // And git_push tells the caller what to pass.
    const push = source.slice(source.indexOf("name: 'git_push'"), source.indexOf("name: 'open_pr'"));
    expect(push).toContain('Pass branch=');
  });

  test('still refuses a detached HEAD', async () => {
    expect((await createWorktreeTool.handler({ repo: 'proj' })).isError).toBeFalsy();
    const worktree = join(firstTopic, 'proj');
    git(worktree, ['checkout', '-q', '--detach']);
    const response = await gitPushTool.handler({ repo: 'proj' });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('detached HEAD');
  });

  // Worktree mode (the default) keeps today's handling of a legacy linked
  // checkout: branchless tools still work on a detached HEAD, and a checkout
  // left as an empty directory by a crash is recovered.
  test('branchless git_commit still works on a detached linked checkout', async () => {
    expect((await createWorktreeTool.handler({ repo: 'proj' })).isError).toBeFalsy();
    const worktree = join(firstTopic, 'proj');
    git(worktree, ['checkout', '-q', '--detach']);
    writeFileSync(join(worktree, 'detached.txt'), 'detached\n');
    const response = await gitCommitTool.handler({ repo: 'proj', message: 'detached work' });
    expect(response.isError).toBeFalsy();
    expect(git(worktree, ['log', '-1', '--format=%s'])).toBe('detached work');
  });

  test('a bare create_worktree still recovers a linked checkout left as an empty directory', async () => {
    expect((await createWorktreeTool.handler({ repo: 'proj' })).isError).toBeFalsy();
    const worktree = join(firstTopic, 'proj');
    for (const name of readdirSync(worktree)) rmSync(join(worktree, name), { recursive: true, force: true });
    const response = await createWorktreeTool.handler({ repo: 'proj' });
    expect(response.isError).toBeFalsy();
    expect(existsSync(join(worktree, '.git'))).toBe(true);
  });

  test('a sibling committing under the gate cannot smuggle that commit into the push', async () => {
    // The gate runs outside the repository lock, and same-topic siblings share
    // this worktree, so the checkout can move after the verdict. The push names
    // the commit that was judged, so a sibling's commit simply is not pushed —
    // it gets its own verdict on its own push.
    expect((await createWorktreeTool.handler({ repo: 'proj' })).isError).toBeFalsy();
    const worktree = join(firstTopic, 'proj');
    writeFileSync(join(worktree, 'work.txt'), 'work\n');
    expect((await gitCommitTool.handler({ repo: 'proj', message: 'work' })).isError).toBeFalsy();
    const judged = git(worktree, ['rev-parse', 'HEAD']);
    const branch = git(worktree, ['branch', '--show-current']);

    // The gate script plays the sibling: it runs with the worktree as its cwd.
    const gateScript = join(root, 'committing-gate.sh');
    writeFileSync(
      gateScript,
      '#!/usr/bin/env bash\ngit -c user.email=s@s -c user.name=s commit -q --allow-empty -m "sibling commit"\nexit 0\n',
    );
    chmodSync(gateScript, 0o755);
    process.env.NANOCLAW_REVIEW_CHURN_GATE_SCRIPT = gateScript;

    expect((await gitPushTool.handler({ repo: 'proj' })).isError).toBeFalsy();
    expect(git(remote, ['rev-parse', branch])).toBe(judged);
    expect(git(worktree, ['rev-parse', 'HEAD'])).not.toBe(judged);
  });

  test('a sibling switching branches under the gate cannot redirect the push', async () => {
    // The sibling checks out a different branch at the SAME commit, so nothing
    // about HEAD changes. The push still goes to the branch that was judged,
    // because that is the branch it names.
    expect((await createWorktreeTool.handler({ repo: 'proj' })).isError).toBeFalsy();
    const worktree = join(firstTopic, 'proj');
    writeFileSync(join(worktree, 'work.txt'), 'work\n');
    expect((await gitCommitTool.handler({ repo: 'proj', message: 'work' })).isError).toBeFalsy();
    const judged = git(worktree, ['rev-parse', 'HEAD']);
    const branch = git(worktree, ['branch', '--show-current']);

    const gateScript = join(root, 'switching-gate.sh');
    writeFileSync(gateScript, '#!/usr/bin/env bash\ngit checkout -q -b smuggled\nexit 0\n');
    chmodSync(gateScript, 0o755);
    process.env.NANOCLAW_REVIEW_CHURN_GATE_SCRIPT = gateScript;

    expect((await gitPushTool.handler({ repo: 'proj' })).isError).toBeFalsy();
    expect(git(worktree, ['branch', '--show-current'])).toBe('smuggled');
    expect(git(remote, ['rev-parse', branch])).toBe(judged);
    expect(() => git(remote, ['show-ref', '--verify', 'refs/heads/smuggled'])).toThrow();
  });

  test('origin-pin-drift-and-corrupt-destination-fail-closed-without-loss', async () => {
    git(canonical, ['remote', 'set-url', 'origin', join(root, 'different.git')]);
    const drift = await createWorktreeTool.handler({ repo: 'proj' });
    expect(drift.isError).toBe(true);
    expect(drift.content[0].text).toContain('origin pin');
    expect(existsSync(join(firstTopic, 'proj'))).toBe(false);

    git(canonical, ['remote', 'set-url', 'origin', remote]);
    const destination = join(firstTopic, 'proj');
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'ONGOING-WORK.txt'), 'preserve me\n');
    const corrupt = await createWorktreeTool.handler({ repo: 'proj' });
    expect(corrupt.isError).toBe(true);
    expect(corrupt.content[0].text).toContain('left untouched');
    expect(existsSync(join(destination, 'ONGOING-WORK.txt'))).toBe(true);
  });

  test('clone_repo rejects authority, cross-host, and traversal before any network or host mutation', async () => {
    for (const input of [
      { url: 'https://token@github.com/acme/proj.git' },
      { url: 'https://gitlab.com/acme/proj.git' },
      { url: 'https://github.com/acme/proj.git', name: '../escape' },
    ]) {
      const response = await cloneRepoTool.handler(input);
      expect(response.isError).toBe(true);
    }
    expect(existsSync(join(root, 'escape'))).toBe(false);
  });

  test('clone_repo rejects query and fragment credentials before staging or durable action writes', async () => {
    const stagingRoot = '/workspace/repository-staging';
    const before = existsSync(stagingRoot) ? readdirSync(stagingRoot).sort() : [];
    const { outbound } = initTestSessionDb();
    delete process.env.NANOCLAW_REPOSITORY_ACTION_TRANSPORT;
    try {
      for (const rawOrigin of [
        'https://github.com/example/proj.git?access_token=QUERY_SYNTHETIC_SECRET',
        'https://github.com/example/proj.git#FRAGMENT_SYNTHETIC_SECRET',
      ]) {
        const response = await cloneRepoTool.handler({ url: rawOrigin });
        expect(response.isError).toBe(true);
        expect(response.content[0].text).toContain('must not include query parameters or fragments');
        expect(response.content[0].text).not.toContain('SYNTHETIC_SECRET');
        expect(response.content[0].text).not.toContain(rawOrigin);
      }
      const malformedOrigin = 'not-a-url?access_token=MALFORMED_SYNTHETIC_SECRET';
      const malformed = await cloneRepoTool.handler({ url: malformedOrigin });
      expect(malformed.isError).toBe(true);
      expect(malformed.content[0].text).toContain('Invalid repository URL');
      expect(malformed.content[0].text).not.toContain('MALFORMED_SYNTHETIC_SECRET');
      expect(malformed.content[0].text).not.toContain(malformedOrigin);
      expect(outbound.query('SELECT content FROM messages_out').all()).toEqual([]);
      expect(existsSync(stagingRoot) ? readdirSync(stagingRoot).sort() : []).toEqual(before);
    } finally {
      closeSessionDb();
    }
  });

  // ── Branch clones (docs/specs/repository-branch-clones/plan.md §5.2-§5.3) ──
  //
  // repository_checkout is a host action (owned by the lead / host builder,
  // src/modules/repository-workspaces/index.ts). These tests simulate the
  // host side of that round trip by hand: they write the inbound response row
  // directly and, for a "the host already published this" scenario, build the
  // clone directory on disk the same way §5.2 says the host would — a plain
  // `git clone` from the pin's origin (or the canonical, for a local-only
  // pin), checked out on the target branch, with `.git/nanoclaw-checkout.json`
  // written by hand. What's under test is the CONTAINER side: resolveCheckout,
  // the create_worktree poll/retry/timeout loop, and the post-fetch freshness
  // step — never the host's own directory creation or start-point selection.
  describe('branch clones (plan §5.2-§5.3)', () => {
    function tryPlainGit(cwd: string, args: string[]): string | null {
      try {
        return plainGit(cwd, args);
      } catch {
        return null;
      }
    }

    function createHostClone(
      sourceUrl: string,
      clonePath: string,
      opts: {
        repo: string;
        branch: string;
        startedFrom: 'canonical-local' | 'origin-branch' | 'origin-head' | 'local-head';
        localOnly?: boolean;
      },
    ): { startCommit: string } {
      execFileSync('git', ['clone', '-q', sourceUrl, clonePath], { stdio: 'pipe' });
      plainGit(clonePath, ['config', 'gc.auto', '0']);
      if (opts.localOnly) plainGit(clonePath, ['remote', 'remove', 'origin']);
      const localExists = tryPlainGit(clonePath, ['show-ref', '--verify', `refs/heads/${opts.branch}`]) !== null;
      if (localExists) {
        git(clonePath, ['checkout', '-q', opts.branch]);
      } else {
        const remoteExists =
          !opts.localOnly &&
          tryPlainGit(clonePath, ['show-ref', '--verify', `refs/remotes/origin/${opts.branch}`]) !== null;
        if (remoteExists) {
          git(clonePath, ['checkout', '-q', '-b', opts.branch, `origin/${opts.branch}`]);
        } else {
          git(clonePath, ['checkout', '-q', '-b', opts.branch]);
        }
      }
      const startCommit = git(clonePath, ['rev-parse', 'HEAD']);
      writeFileSync(
        join(clonePath, '.git', 'nanoclaw-checkout.json'),
        `${JSON.stringify({ version: 1, repo: opts.repo, branch: opts.branch, startCommit, startedFrom: opts.startedFrom }, null, 2)}\n`,
      );
      return { startCommit };
    }

    // container/agent-runner/src/mcp-tools/git-worktrees.test.ts ->
    // (mcp-tools, src, agent-runner, container) -> repo root, so this stays
    // correct regardless of the bun test process's own cwd.
    const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

    /**
     * Installs a byte-for-byte copy of the real host-managed scan hook
     * (scripts/wiki-pre-push-hook.sh + scripts/lib/secret-scan.sh, the same
     * two sources src/managed-git-hooks.ts's refreshManagedGitHooks installs
     * in production) as `canonicalPath`'s `core.hooksPath` — the #680
     * review-round fixtures below use the real hook, not a stand-in
     * directory, for the same reason the canonical always carries it in
     * production: a leftover CLONE's own independent `.git/config` has no
     * `core.hooksPath` at all (stageClone, src/modules/repository-workspaces/
     * index.ts:872-902), so it never reaches this hook either way — this is
     * what makes serving it unscanned a real gap, not merely a difference
     * from a stand-in.
     */
    function installManagedScanHook(canonicalPath: string): string {
      const hooksDir = join(dataDir, 'managed-git-hooks', 'scan');
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(join(hooksDir, 'nanoclaw-secret-patterns.sh'), readFileSync(join(REPO_ROOT, 'scripts', 'lib', 'secret-scan.sh')));
      writeFileSync(join(hooksDir, 'pre-push'), readFileSync(join(REPO_ROOT, 'scripts', 'wiki-pre-push-hook.sh')));
      chmodSync(join(hooksDir, 'pre-push'), 0o755);
      git(canonicalPath, ['config', 'core.hooksPath', hooksDir]);
      return hooksDir;
    }

    function writeRepositoryActionResponse(inbound: any, requestId: string, payload: Record<string, unknown>): void {
      inbound
        .query(
          `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, recurrence, series_id, tries, trigger, platform_id, channel_type, thread_id, content, on_wake)
           VALUES (?, NULL, 'system', ?, 'pending', NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, ?, 0)`,
        )
        .run(
          `repository-action-response-${requestId}`,
          new Date().toISOString(),
          JSON.stringify({ type: 'repository_action_response', requestId, ...payload }),
        );
    }

    async function waitForOutboundAction(
      outbound: any,
      action: string,
      seen: Set<string>,
      timeoutMs = 5000,
    ): Promise<{ requestId: string; [key: string]: unknown }> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const rows = outbound.query('SELECT content FROM messages_out ORDER BY seq ASC').all() as { content: string }[];
        for (const row of rows) {
          let parsed: { action?: string; requestId?: string; [key: string]: unknown };
          try {
            parsed = JSON.parse(row.content);
          } catch {
            continue;
          }
          if (parsed.action === action && typeof parsed.requestId === 'string' && !seen.has(parsed.requestId)) {
            seen.add(parsed.requestId);
            return parsed as { requestId: string; [key: string]: unknown };
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`timed out waiting for outbound ${action}`);
    }

    // Bun's execFileSync (no explicit `env`) resolves the executable through
    // a snapshot taken independently of later `process.env.PATH` mutations,
    // so a PATH-prepended stub script is never picked up — verified against
    // this Bun version. `mock.module` replaces `child_process` even for
    // `git-worktrees.ts`'s already-bound import (Bun supports retroactive
    // module replacement), so `gh` is faked here while `git` (and everything
    // else) passes through to the real implementation unchanged.
    const realChildProcess = require('child_process') as typeof import('child_process');
    const realExecFileSync = realChildProcess.execFileSync;

    /** Fakes only `gh pr create`, echoing back the `--head` value it was given. */
    function installFakeGh(): { restore: () => void } {
      mock.module('child_process', () => ({
        ...realChildProcess,
        execFileSync: (file: string, args: string[], opts?: Record<string, unknown>) => {
          if (file === 'gh') {
            const headIndex = args.indexOf('--head');
            const head = headIndex !== -1 ? args[headIndex + 1] : '';
            return `https://example.invalid/pr/fake?head=${head}\n`;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (realExecFileSync as any)(file, args, opts);
        },
      }));
      return {
        restore: () => {
          mock.module('child_process', () => realChildProcess);
        },
      };
    }

    test('start point prefers canonical refs/heads/B, then origin/B, then origin/HEAD, and the post-fetch step only moves pristine checkouts', async () => {
      // Container half only (P2-6): the host's own start-point SELECTION is
      // simulated by hand via createHostClone; what's asserted here is the
      // container's post-fetch pristine-move rule.
      process.env.NANOCLAW_CHECKOUT_MODE = 'clone';
      const { inbound, outbound } = initTestSessionDb();
      delete process.env.NANOCLAW_REPOSITORY_ACTION_TRANSPORT;
      try {
        const seen = new Set<string>();

        // Fixture 1: pristine, startedFrom origin-branch, origin/B advanced
        // as a descendant of startCommit -> fast-forward.
        {
          const branch = 'ff-branch';
          const seedScratch = join(root, 'ff-seed');
          execFileSync('git', ['clone', '-q', remote, seedScratch]);
          git(seedScratch, ['checkout', '-q', '-b', branch]);
          git(seedScratch, ['push', '-q', 'origin', branch]);

          const dirName = checkoutDirName('proj', branch);
          const clonePath = join(firstTopic, dirName);
          const { startCommit } = createHostClone(remote, clonePath, {
            repo: 'proj',
            branch,
            startedFrom: 'origin-branch',
          });

          writeFileSync(join(seedScratch, 'ff.txt'), 'ff\n');
          git(seedScratch, ['add', '-A']);
          git(seedScratch, ['commit', '-q', '-m', 'advance']);
          git(seedScratch, ['push', '-q', 'origin', branch]);
          const advanced = git(seedScratch, ['rev-parse', 'HEAD']);
          expect(advanced).not.toBe(startCommit);

          const callPromise = createWorktreeTool.handler({ repo: 'proj', branch });
          const request = await waitForOutboundAction(outbound, 'repository_checkout', seen);
          writeRepositoryActionResponse(inbound, request.requestId, {
            ok: true,
            dirName,
            branch,
            created: true,
            startedFrom: 'origin-branch',
          });
          const response = await callPromise;
          expect(response.isError).toBeFalsy();
          expect(response.content[0].text).toContain('moved-fast-forward');
          expect(git(clonePath, ['rev-parse', 'HEAD'])).toBe(advanced);
          expect(JSON.parse(readFileSync(join(clonePath, '.git', 'nanoclaw-checkout.json'), 'utf8')).startCommit).toBe(
            advanced,
          );
        }

        // Fixture 2: pristine, startedFrom origin-head -> reset --keep to a
        // fresh origin/HEAD.
        {
          const branch = 'reset-branch';
          const dirName = checkoutDirName('proj', branch);
          const clonePath = join(firstTopic, dirName);
          createHostClone(remote, clonePath, { repo: 'proj', branch, startedFrom: 'origin-head' });

          const scratch = join(root, 'reset-scratch');
          execFileSync('git', ['clone', '-q', remote, scratch]);
          writeFileSync(join(scratch, 'reset.txt'), 'reset\n');
          git(scratch, ['add', '-A']);
          git(scratch, ['commit', '-q', '-m', 'advance main']);
          git(scratch, ['push', '-q', 'origin', 'main']);
          const advanced = git(scratch, ['rev-parse', 'HEAD']);

          const callPromise = createWorktreeTool.handler({ repo: 'proj', branch });
          const request = await waitForOutboundAction(outbound, 'repository_checkout', seen);
          writeRepositoryActionResponse(inbound, request.requestId, {
            ok: true,
            dirName,
            branch,
            created: true,
            startedFrom: 'origin-head',
          });
          const response = await callPromise;
          expect(response.isError).toBeFalsy();
          expect(response.content[0].text).toContain('moved-reset');
          expect(git(clonePath, ['rev-parse', 'HEAD'])).toBe(advanced);
        }

        // Fixture 3: not pristine (dirty working tree) -> left-as-is, even
        // though origin has moved further.
        {
          const branch = 'dirty-branch';
          const dirName = checkoutDirName('proj', branch);
          const clonePath = join(firstTopic, dirName);
          const { startCommit } = createHostClone(remote, clonePath, {
            repo: 'proj',
            branch,
            startedFrom: 'origin-head',
          });
          writeFileSync(join(clonePath, 'dirty.txt'), 'dirty\n');

          const callPromise = createWorktreeTool.handler({ repo: 'proj', branch });
          const request = await waitForOutboundAction(outbound, 'repository_checkout', seen);
          writeRepositoryActionResponse(inbound, request.requestId, {
            ok: true,
            dirName,
            branch,
            created: false,
            startedFrom: 'origin-head',
          });
          const response = await callPromise;
          expect(response.isError).toBeFalsy();
          expect(response.content[0].text).toContain('left-as-is');
          expect(git(clonePath, ['rev-parse', 'HEAD'])).toBe(startCommit);
          expect(existsSync(join(clonePath, 'dirty.txt'))).toBe(true);
        }

        // Fixture 4: pristine, but startedFrom canonical-local (preserved
        // legacy work) -> never moved, even though it is pristine.
        {
          const branch = 'canonical-local-branch';
          git(canonical, ['branch', branch]);
          const dirName = checkoutDirName('proj', branch);
          const clonePath = join(firstTopic, dirName);
          const { startCommit } = createHostClone(remote, clonePath, {
            repo: 'proj',
            branch,
            startedFrom: 'canonical-local',
          });

          const callPromise = createWorktreeTool.handler({ repo: 'proj', branch });
          const request = await waitForOutboundAction(outbound, 'repository_checkout', seen);
          writeRepositoryActionResponse(inbound, request.requestId, {
            ok: true,
            dirName,
            branch,
            created: true,
            startedFrom: 'canonical-local',
          });
          const response = await callPromise;
          expect(response.isError).toBeFalsy();
          expect(response.content[0].text).toContain('left-as-is');
          expect(git(clonePath, ['rev-parse', 'HEAD'])).toBe(startCommit);
        }
      } finally {
        closeSessionDb();
      }
    });

    test('a checkout whose current branch differs from its recorded branch is refused, not reused', async () => {
      const branch = 'r3-branch';
      const dirName = checkoutDirName('proj', branch);
      const clonePath = join(firstTopic, dirName);
      createHostClone(remote, clonePath, { repo: 'proj', branch, startedFrom: 'origin-head' });
      // A manual `git switch` inside `<repo>@<slug>` breaks R3.
      git(clonePath, ['switch', '-q', '-c', 'switched-away']);
      const before = git(clonePath, ['rev-parse', 'HEAD']);
      const indexBefore = readFileSync(join(clonePath, '.git', 'index'));

      const createResp = await createWorktreeTool.handler({ repo: 'proj', branch });
      expect(createResp.isError).toBe(true);
      expect(createResp.content[0].text).toContain('not its recorded branch');

      const pushResp = await gitPushTool.handler({ repo: 'proj', branch });
      expect(pushResp.isError).toBe(true);
      expect(pushResp.content[0].text).toContain('not its recorded branch');

      expect(git(clonePath, ['rev-parse', 'HEAD'])).toBe(before);
      expect(readFileSync(join(clonePath, '.git', 'index'))).toEqual(indexBefore);
      expect(git(clonePath, ['branch', '--show-current'])).toBe('switched-away');
    });

    test('git_commit, git_push, and open_pr act on the checkout selected by branch and default to the primary', async () => {
      const { outbound } = initTestSessionDb();
      delete process.env.NANOCLAW_REPOSITORY_ACTION_TRANSPORT; // record the host actions asserted below
      expect((await createWorktreeTool.handler({ repo: 'proj' })).isError).toBeFalsy();
      const primary = join(firstTopic, 'proj');
      const primaryBranch = git(primary, ['branch', '--show-current']);

      const altBranch = 'alt-branch';
      const dirName = checkoutDirName('proj', altBranch);
      const altPath = join(firstTopic, dirName);
      createHostClone(remote, altPath, { repo: 'proj', branch: altBranch, startedFrom: 'origin-head' });

      writeFileSync(join(altPath, 'alt.txt'), 'alt\n');
      const altCommit = await gitCommitTool.handler({ repo: 'proj', message: 'alt work', branch: altBranch });
      expect(altCommit.isError).toBeFalsy();
      expect(git(altPath, ['log', '-1', '--format=%s'])).toBe('alt work');
      expect(git(primary, ['status', '--porcelain'])).toBe('');

      const altPush = await gitPushTool.handler({ repo: 'proj', branch: altBranch });
      expect(altPush.isError).toBeFalsy();
      expect(git(remote, ['show-ref', '--verify', `refs/heads/${altBranch}`])).toContain(altBranch);
      // A clone's push lands only in the clone, so the canonical fetches origin
      // itself (plan §5.5, rev 2.7). The refresh names no checkout: the host
      // never reads one.
      const refreshes = (): Array<Record<string, unknown>> =>
        (outbound.query('SELECT content FROM messages_out').all() as { content: string }[])
          .map((row) => JSON.parse(row.content) as Record<string, unknown>)
          .filter((content) => content.action === 'repository_refresh');
      expect(refreshes().length).toBeGreaterThan(0);
      expect(refreshes().at(-1)).not.toHaveProperty('checkout');
      expect(git(canonical, ['rev-parse', `refs/remotes/origin/${altBranch}`])).toBe(
        git(altPath, ['rev-parse', 'HEAD']),
      );

      writeFileSync(join(primary, 'primary.txt'), 'primary\n');
      const primaryCommit = await gitCommitTool.handler({ repo: 'proj', message: 'primary work' });
      expect(primaryCommit.isError).toBeFalsy();
      expect(git(primary, ['log', '-1', '--format=%s'])).toBe('primary work');
      expect(git(altPath, ['log', '-1', '--format=%s'])).toBe('alt work');

      const primaryPush = await gitPushTool.handler({ repo: 'proj' });
      expect(primaryPush.isError).toBeFalsy();
      expect(git(remote, ['show-ref', '--verify', `refs/heads/${primaryBranch}`])).toContain(primaryBranch);

      const fakeGh = installFakeGh();
      try {
        const altPr = await openPrTool.handler({ repo: 'proj', title: 'Alt PR', branch: altBranch });
        expect(altPr.isError).toBeFalsy();
        expect(altPr.content[0].text).toContain(`head=${altBranch}`);

        const primaryPr = await openPrTool.handler({ repo: 'proj', title: 'Primary PR' });
        expect(primaryPr.isError).toBeFalsy();
        expect(primaryPr.content[0].text).toContain(`head=${primaryBranch}`);
      } finally {
        fakeGh.restore();
      }
    });

    test('clone-mode create_worktree fetches the canonical before requesting the checkout', async () => {
      process.env.NANOCLAW_CHECKOUT_MODE = 'clone';
      const { inbound, outbound } = initTestSessionDb();
      delete process.env.NANOCLAW_REPOSITORY_ACTION_TRANSPORT;
      try {
        // Another thread pushed B after the canonical's last fetch.
        const branch = 'pushed-elsewhere';
        const scratch = join(root, 'elsewhere');
        execFileSync('git', ['clone', '-q', remote, scratch]);
        git(scratch, ['checkout', '-q', '-b', branch]);
        writeFileSync(join(scratch, 'elsewhere.txt'), 'elsewhere\n');
        git(scratch, ['add', '-A']);
        git(scratch, ['commit', '-q', '-m', 'elsewhere']);
        git(scratch, ['push', '-q', 'origin', branch]);
        const pushed = git(scratch, ['rev-parse', 'HEAD']);
        expect(tryPlainGit(canonical, ['rev-parse', '--verify', `refs/remotes/origin/${branch}`])).toBeNull();

        const seen = new Set<string>();
        const callPromise = createWorktreeTool.handler({ repo: 'proj', branch });
        await waitForOutboundAction(outbound, 'repository_checkout', seen);
        // Observed when the request is queued, before any host answer: the host
        // stages from these refs and so starts B from origin/B.
        expect(tryPlainGit(canonical, ['rev-parse', '--verify', `refs/remotes/origin/${branch}`])).toBe(pushed);

        const dirName = checkoutDirName('proj', branch);
        createHostClone(remote, join(firstTopic, dirName), { repo: 'proj', branch, startedFrom: 'origin-branch' });
        const request = await waitForOutboundAction(outbound, 'repository_checkout', new Set());
        writeRepositoryActionResponse(inbound, request.requestId, {
          ok: true,
          dirName,
          branch,
          created: true,
          startedFrom: 'origin-branch',
        });
        expect((await callPromise).isError).toBeFalsy();
        const refreshes = (outbound.query('SELECT content FROM messages_out').all() as { content: string }[])
          .map((row) => JSON.parse(row.content) as Record<string, unknown>)
          .filter((content) => content.action === 'repository_refresh');
        expect(refreshes.length).toBe(1);
        expect(refreshes[0]).not.toHaveProperty('checkout');
      } finally {
        closeSessionDb();
      }
    });

    test('open_pr opens the PR for a pushed branch that no checkout holds any more', async () => {
      expect((await createWorktreeTool.handler({ repo: 'proj' })).isError).toBeFalsy();
      const primary = join(firstTopic, 'proj');
      const pushed = git(primary, ['branch', '--show-current']);
      writeFileSync(join(primary, 'work.txt'), 'work\n');
      expect((await gitCommitTool.handler({ repo: 'proj', message: 'work' })).isError).toBeFalsy();
      expect((await gitPushTool.handler({ repo: 'proj' })).isError).toBeFalsy();
      // A same-topic sibling switches the shared checkout between the push and the PR.
      git(primary, ['checkout', '-q', '-b', 'sibling-branch']);

      const fakeGh = installFakeGh();
      try {
        const pr = await openPrTool.handler({ repo: 'proj', title: 'Pushed work', branch: pushed });
        expect(pr.isError).toBeFalsy();
        expect(pr.content[0].text).toContain(`head=${pushed}`);
      } finally {
        fakeGh.restore();
      }
    });

    test('create_worktree promises a checkout per branch only in clone mode', () => {
      // Worktree mode keeps one checkout per thread and repo: another branch is
      // refused (validateExistingWorktree), so its description must not offer one.
      process.env.NANOCLAW_CHECKOUT_MODE = 'worktree';
      const worktreeText = createWorktreeTool.tool.description ?? '';
      expect(worktreeText).not.toContain('@<branch>');
      expect(worktreeText).not.toContain('same branch at once');
      expect(worktreeText).toContain('never rebased or branch-switched');

      process.env.NANOCLAW_CHECKOUT_MODE = 'clone';
      const cloneText = createWorktreeTool.tool.description ?? '';
      expect(cloneText).toContain('/workspace/worktrees/<repo>@<branch>');
      expect(cloneText).toContain('Any number of threads may hold the same branch at once');
      // #680 review round 1, cosmetic: the clone-mode description must warn
      // that a scan-policy repo (wiki) never actually gets the clone-mode
      // behaviour just described.
      expect(cloneText).toContain('always gets a linked worktree');
    });

    test('clone mode plus a wiki repo still gives a linked worktree, with the canonical hooksPath visible (#666 follow-up)', async () => {
      // A `clone`-mode checkout is a full clone with its own independent
      // .git/config (stageClone, host src/modules/repository-workspaces/
      // index.ts:872-902) — it never inherits the canonical's
      // core.hooksPath, so a wiki push through it would go unscanned. A
      // scan-policy repo (isScanPolicyRepositoryName, git-worktrees.ts) must
      // always get a linked worktree instead, whatever the global mode, so
      // the host-managed hooks mount (whose eligibility is driven by
      // core.hooksPath on the shared canonical .git/config) still applies.
      const wikiCanonical = seedNamedCanonical('wiki');
      // Simulate what the host's managed-git-hooks refresh does at startup
      // for a scan-policy repo: point its core.hooksPath at the managed,
      // read-only-mounted scan directory.
      const managedHooksDir = join(dataDir, 'managed-git-hooks', 'scan');
      git(wikiCanonical, ['config', 'core.hooksPath', managedHooksDir]);

      process.env.NANOCLAW_CHECKOUT_MODE = 'clone';
      const { outbound } = initTestSessionDb();
      delete process.env.NANOCLAW_REPOSITORY_ACTION_TRANSPORT;
      try {
        const response = await createWorktreeTool.handler({ repo: 'wiki' });
        expect(response.isError).toBeFalsy();

        const worktree = join(firstTopic, 'wiki');
        // Linked worktree, not a clone: `.git` is a file (a gitdir pointer),
        // and it shares the canonical's own `.git` — exactly what a clone
        // (its own independent .git directory) would never do.
        expect(lstatSync(join(worktree, '.git')).isFile()).toBe(true);
        expect(git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).toBe(
          join(wikiCanonical, '.git'),
        );
        // The managed hooks mount's eligibility signal (core.hooksPath) is
        // therefore visible from inside the checkout too — this is the
        // actual mechanism that lets the host-managed pre-push hook apply.
        expect(git(worktree, ['config', '--get', 'core.hooksPath'])).toBe(managedHooksDir);

        // No repository_checkout host round-trip was ever requested — the
        // scan-policy override took the linked-worktree path directly,
        // never createCloneWorktree.
        const actions = (outbound.query('SELECT content FROM messages_out').all() as { content: string }[]).map(
          (row) => JSON.parse(row.content).action,
        );
        expect(actions).not.toContain('repository_checkout');
      } finally {
        closeSessionDb();
      }
    });

    test('a leftover wiki CLONE at the primary position is refused in both worktree and clone mode, and git_commit/git_push refuse too (#680 review round 1)', async () => {
      // The Opus review on #682 proved this end to end: a wiki CLONE left
      // over from a clone-mode period, still parked at the primary
      // position, was served as-is by create_worktree's reuse branch (the
      // ok() a few lines above the new guard in the source) and pushed from
      // by git_push -> worktreeForTool -> resolveCheckout, neither of which
      // knew the difference between it and any other repo's leftover clone
      // — and a token pushed through it reached the remote unscanned. Both
      // paths must now refuse for a scan-policy repo
      // (isScanPolicyRepositoryName), whatever NANOCLAW_CHECKOUT_MODE says
      // (effectiveCheckoutModeFor already pins the repo to `worktree`
      // regardless, so toggling the global setting below exercises the
      // description-only difference, not a different guard).
      const wikiCanonical = seedNamedCanonical('wiki');
      installManagedScanHook(wikiCanonical);
      const remoteRefsBefore = git(remote, ['for-each-ref', '--format=%(refname) %(objectname)']);

      const worktree = join(firstTopic, 'wiki');
      createHostClone(remote, worktree, { repo: 'wiki', branch: 'main', startedFrom: 'origin-head' });

      const { outbound } = initTestSessionDb();
      // #682 round 2: the beforeEach above sets TRANSPORT='disabled', under
      // which queueHostAction returns before ever calling writeMessageOut
      // (git-worktrees.ts ~:544) — so the `not.toContain('repository_checkout')`
      // assertion below would hold vacuously whether or not the refusal
      // actually stopped the code before queuing a host action. Deleting the
      // override here (same technique as the passing "clone mode plus a wiki
      // repo..." test above) makes writeMessageOut real again, so the
      // assertion proves something: no host action of any kind was queued.
      delete process.env.NANOCLAW_REPOSITORY_ACTION_TRANSPORT;
      try {
        for (const globalMode of ['worktree', 'clone'] as const) {
          if (globalMode === 'clone') process.env.NANOCLAW_CHECKOUT_MODE = 'clone';
          else delete process.env.NANOCLAW_CHECKOUT_MODE;

          const created = await createWorktreeTool.handler({ repo: 'wiki' });
          expect(created.isError).toBe(true);
          expect(created.content[0].text).toContain('left over from a clone-mode period');
          expect(created.content[0].text).toContain('not secret-scanned on push');
          // The real scan-policy-repos.json loaded fine here (no override is
          // active), so this is a genuine wiki refusal, not a fail-closed
          // guess — the #691 load-failure hint must not be tacked on.
          expect(created.content[0].text.toLowerCase()).not.toContain('failed to load');
        }

        // Still a clone (its own independent .git directory) at the primary
        // path — refusing it never touched or moved it.
        expect(lstatSync(join(worktree, '.git')).isDirectory()).toBe(true);

        const committed = await gitCommitTool.handler({ repo: 'wiki', message: 'should never land' });
        expect(committed.isError).toBe(true);

        const pushed = await gitPushTool.handler({ repo: 'wiki' });
        expect(pushed.isError).toBe(true);

        // No repository_checkout host round-trip was ever requested, in
        // either mode — the refusal never falls through to createCloneWorktree.
        const actions = (outbound.query('SELECT content FROM messages_out').all() as { content: string }[]).map(
          (row) => JSON.parse(row.content).action,
        );
        expect(actions).not.toContain('repository_checkout');

        // Nothing local moved (git_commit refused before its add/commit ever
        // ran) and nothing reached the remote either.
        expect(git(worktree, ['status', '--porcelain'])).toBe('');
        expect(git(remote, ['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(remoteRefsBefore);
      } finally {
        closeSessionDb();
      }
    });

    test('a leftover wiki@<branch> CLONE is refused the same way, and git_commit/git_push refuse for that branch too', async () => {
      const wikiCanonical = seedNamedCanonical('wiki');
      installManagedScanHook(wikiCanonical);
      const remoteRefsBefore = git(remote, ['for-each-ref', '--format=%(refname) %(objectname)']);

      const branch = 'topic-feature';
      const branchWorktree = join(firstTopic, checkoutDirName('wiki', branch));
      createHostClone(remote, branchWorktree, { repo: 'wiki', branch, startedFrom: 'origin-head' });

      const { outbound } = initTestSessionDb();
      // #682 round 2: same reasoning as the primary-position test above — make
      // the "no host action queued" assertion meaningful instead of vacuous
      // under TRANSPORT='disabled'.
      delete process.env.NANOCLAW_REPOSITORY_ACTION_TRANSPORT;
      try {
        const created = await createWorktreeTool.handler({ repo: 'wiki', branch });
        expect(created.isError).toBe(true);
        expect(created.content[0].text).toContain('left over from a clone-mode period');
        expect(created.content[0].text).toContain('not secret-scanned on push');

        const committed = await gitCommitTool.handler({ repo: 'wiki', branch, message: 'should never land' });
        expect(committed.isError).toBe(true);

        const pushed = await gitPushTool.handler({ repo: 'wiki', branch });
        expect(pushed.isError).toBe(true);

        const actions = (outbound.query('SELECT content FROM messages_out').all() as { content: string }[]).map(
          (row) => JSON.parse(row.content).action,
        );
        expect(actions).not.toContain('repository_checkout');

        expect(git(branchWorktree, ['status', '--porcelain'])).toBe('');
        expect(git(remote, ['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(remoteRefsBefore);
      } finally {
        closeSessionDb();
      }
    });

    test('open_pr refuses a wiki@<branch> leftover clone rather than silently falling back to the primary (#682 round 2 P3 fix)', async () => {
      // Before round 2, worktreeForTool's scan-policy refusal for the named
      // branch was indistinguishable from an ordinary "no checkout for that
      // branch" miss, so open_pr's fallback re-resolved the PRIMARY (valid,
      // linked) checkout instead — silently swallowing the refusal and
      // opening the PR from the wrong checkout rather than surfacing the
      // leftover clone.
      const wikiCanonical = seedNamedCanonical('wiki');
      installManagedScanHook(wikiCanonical);

      // A valid PRIMARY linked worktree, e.g. created before the clone-mode
      // period that left the `@<branch>` clone behind.
      expect((await createWorktreeTool.handler({ repo: 'wiki' })).isError).toBeFalsy();

      // A leftover clone at the `wiki@<branch>` position — the exact shape
      // create_worktree/git_commit/git_push already refuse.
      const branch = 'topic-feature';
      const branchWorktree = join(firstTopic, checkoutDirName('wiki', branch));
      createHostClone(remote, branchWorktree, { repo: 'wiki', branch, startedFrom: 'origin-head' });

      const fakeGh = installFakeGh();
      try {
        // gh is faked so a swallowed refusal cannot hide behind a real `gh`
        // failure of its own (missing binary, no network, etc.): if the
        // fallback fires at all, `gh pr create` succeeds and this test fails
        // loudly on `isError`/the message instead of ambiguously.
        const pr = await openPrTool.handler({ repo: 'wiki', title: 'should be refused', branch });
        expect(pr.isError).toBe(true);
        expect(pr.content[0].text).toContain('left over from a clone-mode period');
        expect(pr.content[0].text).toContain('not secret-scanned on push');
      } finally {
        fakeGh.restore();
      }
    });

    test('a non-wiki leftover-clone refusal names the load failure, not the wiki cause, when the scan-policy list fails to load (#691)', async () => {
      // 'proj' (the describe block's default seeded repo, see seedCanonical
      // in beforeEach) is NOT in the real scan-policy-repos.json — only
      // 'wiki' is. Forcing the list to fail to load makes
      // isScanPolicyRepositoryName fail closed for 'proj' too (every repo
      // name, not just 'wiki'), so its leftover clone at the primary position
      // is refused exactly the way a real scan-policy repo's would be.
      // Before this fix, that refusal reused the wiki-shaped wording
      // verbatim — naming a cause ('left over from a clone-mode period') that
      // is true of the checkout shape but not of *why* 'proj' was refused;
      // the real cause (the failed list load) was visible only in the MCP
      // server's stderr.
      const clonePath = join(firstTopic, 'proj');
      createHostClone(remote, clonePath, { repo: 'proj', branch: 'main', startedFrom: 'origin-head' });

      const scratchDir = mkdtempSync(join(tmpdir(), 'gw-scan-policy-hint-'));
      initTestSessionDb();
      try {
        resetScanPolicyRepositoryNamesForTest(join(scratchDir, 'does-not-exist.json'));
        expect(isScanPolicyRepositoryName('proj')).toBe(true); // fail-closed sanity check

        const created = await createWorktreeTool.handler({ repo: 'proj' });
        expect(created.isError).toBe(true);
        const text = created.content[0].text;
        // The shape-level wording is unchanged...
        expect(text).toContain('left over from a clone-mode period');
        expect(text).toContain('not secret-scanned on push');
        // ...but the real cause is now named, with a pointer at the host.
        expect(text.toLowerCase()).toContain('scan-policy repository list failed');
        expect(text.toLowerCase()).toContain('failed');
        expect(text.toLowerCase()).toContain('to load');
        expect(text.toLowerCase()).toContain('restart the host');
      } finally {
        // Restore the real list before this describe block's later tests run
        // — several of them (the wiki tests above aside) rely on 'proj' NOT
        // being scan-policy under the real scan-policy-repos.json.
        resetScanPolicyRepositoryNamesForTest();
        rmSync(scratchDir, { recursive: true, force: true });
        closeSessionDb();
      }
    });

    test('clone mode plus an ordinary code repo still gives a clone (#666 follow-up: unaffected)', async () => {
      process.env.NANOCLAW_CHECKOUT_MODE = 'clone';
      const { inbound, outbound } = initTestSessionDb();
      delete process.env.NANOCLAW_REPOSITORY_ACTION_TRANSPORT;
      try {
        const seen = new Set<string>();
        const branch = 'still-a-clone-branch';
        const dirName = checkoutDirName('proj', branch);
        const clonePath = join(firstTopic, dirName);
        createHostClone(remote, clonePath, { repo: 'proj', branch, startedFrom: 'origin-head' });

        const callPromise = createWorktreeTool.handler({ repo: 'proj', branch });
        // A non-scan-policy repo still goes through the host repository_checkout
        // round-trip — the scan-policy override only pins 'wiki'.
        const request = await waitForOutboundAction(outbound, 'repository_checkout', seen);
        writeRepositoryActionResponse(inbound, request.requestId, {
          ok: true,
          dirName,
          branch,
          created: true,
          startedFrom: 'origin-head',
        });
        const response = await callPromise;
        expect(response.isError).toBeFalsy();
        // A clone has its own independent `.git` directory, never a gitdir pointer file.
        expect(lstatSync(join(clonePath, '.git')).isDirectory()).toBe(true);
      } finally {
        closeSessionDb();
      }
    });

    test('worktree mode creates linked worktrees exactly as today', async () => {
      process.env.NANOCLAW_CHECKOUT_MODE = 'worktree';
      const first = await createWorktreeTool.handler({ repo: 'proj' });
      const second = await createWorktreeTool.handler({ repo: 'proj' });
      const worktree = join(firstTopic, 'proj');

      expect(first.isError).toBeFalsy();
      expect(second.isError).toBeFalsy();
      expect(lstatSync(join(worktree, '.git')).isFile()).toBe(true);
      expect(git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).toBe(join(canonical, '.git'));
      expect(second.content[0].text).toContain('Worktree ready');
    });

    test('legacy linked checkouts are reused in clone mode and transfer still works for them', async () => {
      expect((await createWorktreeTool.handler({ repo: 'proj' })).isError).toBeFalsy();
      const worktree = join(firstTopic, 'proj');
      const branch = git(worktree, ['branch', '--show-current']);
      const headBefore = git(worktree, ['rev-parse', 'HEAD']);

      process.env.NANOCLAW_CHECKOUT_MODE = 'clone';
      const reused = await createWorktreeTool.handler({ repo: 'proj' });
      expect(reused.isError).toBeFalsy();
      // Still a linked worktree — clone mode never converts an existing one.
      expect(lstatSync(join(worktree, '.git')).isFile()).toBe(true);
      expect(git(worktree, ['branch', '--show-current'])).toBe(branch);
      expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(headBefore);

      const transferResp = await createWorktreeTool.handler({
        repo: 'proj',
        continueFromThreadId: 'topic-source-locator',
      });
      expect(transferResp.isError).toBeFalsy();
      expect(transferResp.content[0].text).toContain('Repository transfer queued durably');
    });

    test('create_worktree waits for the host response, retries a retryable error once, and times out cleanly', async () => {
      process.env.NANOCLAW_CHECKOUT_MODE = 'clone';
      process.env.NANOCLAW_REPOSITORY_CHECKOUT_RETRY_DELAY_MS = '50';
      const { inbound, outbound } = initTestSessionDb();
      delete process.env.NANOCLAW_REPOSITORY_ACTION_TRANSPORT;
      try {
        const seen = new Set<string>();

        // A response well inside the poll window resolves the tool.
        {
          const branch = 'resolves-branch';
          const dirName = checkoutDirName('proj', branch);
          const clonePath = join(firstTopic, dirName);
          createHostClone(remote, clonePath, { repo: 'proj', branch, startedFrom: 'origin-head' });

          const callPromise = createWorktreeTool.handler({ repo: 'proj', branch });
          const request = await waitForOutboundAction(outbound, 'repository_checkout', seen);
          writeRepositoryActionResponse(inbound, request.requestId, {
            ok: true,
            dirName,
            branch,
            created: true,
            startedFrom: 'origin-head',
          });
          const response = await callPromise;
          expect(response.isError).toBeFalsy();
        }

        // A retryable error is retried exactly once, against a NEW request id.
        {
          const branch = 'retry-branch';
          const dirName = checkoutDirName('proj', branch);
          const clonePath = join(firstTopic, dirName);
          createHostClone(remote, clonePath, { repo: 'proj', branch, startedFrom: 'origin-head' });

          const callPromise = createWorktreeTool.handler({ repo: 'proj', branch });
          const firstRequest = await waitForOutboundAction(outbound, 'repository_checkout', seen);
          writeRepositoryActionResponse(inbound, firstRequest.requestId, {
            ok: false,
            message: 'repository lifecycle is claimed',
            retryable: true,
          });
          const secondRequest = await waitForOutboundAction(outbound, 'repository_checkout', seen);
          expect(secondRequest.requestId).not.toBe(firstRequest.requestId);
          writeRepositoryActionResponse(inbound, secondRequest.requestId, {
            ok: true,
            dirName,
            branch,
            created: true,
            startedFrom: 'origin-head',
          });
          const response = await callPromise;
          expect(response.isError).toBeFalsy();
        }

        // No response within the injected timeout returns an error naming the request id.
        {
          process.env.NANOCLAW_REPOSITORY_CHECKOUT_TIMEOUT_MS = '150';
          const response = await createWorktreeTool.handler({ repo: 'proj', branch: 'timeout-branch' });
          expect(response.isError).toBe(true);
          expect(response.content[0].text).toMatch(/repo-\d+-[0-9a-f]{16}/);
        }
      } finally {
        closeSessionDb();
      }
    });

    test('local-only canonicals: clone has no origin, starts from preserved refs, skips fetch and refresh, refuses push/PR', async () => {
      git(canonical, ['remote', 'remove', 'origin']);
      writeFileSync(
        join(dataDir, 'repository-state', 'wg-a', 'proj', 'origin.json'),
        JSON.stringify({ kind: 'local-only', origin: null, repositoryId: 'local-only:wg-a-proj' }),
      );
      const canonicalHead = git(canonical, ['rev-parse', 'HEAD']);

      process.env.NANOCLAW_CHECKOUT_MODE = 'clone';
      const { inbound, outbound } = initTestSessionDb();
      delete process.env.NANOCLAW_REPOSITORY_ACTION_TRANSPORT;
      try {
        const branch = 'local-only-branch';
        const dirName = checkoutDirName('proj', branch);
        const clonePath = join(firstTopic, dirName);
        createHostClone(canonical, clonePath, { repo: 'proj', branch, startedFrom: 'local-head', localOnly: true });
        expect(git(clonePath, ['rev-parse', 'HEAD'])).toBe(canonicalHead);
        expect(tryPlainGit(clonePath, ['remote', 'get-url', 'origin'])).toBeNull();

        const seen = new Set<string>();
        const callPromise = createWorktreeTool.handler({ repo: 'proj', branch });
        const request = await waitForOutboundAction(outbound, 'repository_checkout', seen);
        writeRepositoryActionResponse(inbound, request.requestId, {
          ok: true,
          dirName,
          branch,
          created: true,
          startedFrom: 'local-head',
        });
        const response = await callPromise;
        expect(response.isError).toBeFalsy();
        expect(response.content[0].text).toContain('preserved local-only canonical');

        // No fetch, no refresh (today's rule for linked worktrees, carried over).
        const outboundActions = (outbound.query('SELECT content FROM messages_out').all() as { content: string }[]).map(
          (row) => JSON.parse(row.content).action,
        );
        expect(outboundActions).not.toContain('repository_refresh');
        expect(existsSync(join(clonePath, '.git', 'FETCH_HEAD'))).toBe(false);

        writeFileSync(join(clonePath, 'local.txt'), 'local work\n');
        expect((await gitCommitTool.handler({ repo: 'proj', message: 'local work', branch })).isError).toBeFalsy();

        const pushResp = await gitPushTool.handler({ repo: 'proj', branch });
        expect(pushResp.isError).toBe(true);

        const prResp = await openPrTool.handler({ repo: 'proj', title: 'Local only', branch });
        expect(prResp.isError).toBe(true);
      } finally {
        closeSessionDb();
      }
    });

    test('clones stay usable after rollback to worktree mode', async () => {
      process.env.NANOCLAW_CHECKOUT_MODE = 'clone';
      const { inbound, outbound } = initTestSessionDb();
      delete process.env.NANOCLAW_REPOSITORY_ACTION_TRANSPORT;
      try {
        const seen = new Set<string>();
        const primaryPath = join(firstTopic, 'proj');
        const primaryStartBranch = 'nc/topic-rollback';
        const secondaryBranch = 'rollback-secondary';
        const secondaryDirName = checkoutDirName('proj', secondaryBranch);
        const secondaryPath = join(firstTopic, secondaryDirName);

        {
          createHostClone(remote, primaryPath, {
            repo: 'proj',
            branch: primaryStartBranch,
            startedFrom: 'origin-head',
          });
          const callPromise = createWorktreeTool.handler({ repo: 'proj' });
          const request = await waitForOutboundAction(outbound, 'repository_checkout', seen);
          writeRepositoryActionResponse(inbound, request.requestId, {
            ok: true,
            dirName: 'proj',
            branch: primaryStartBranch,
            created: true,
            startedFrom: 'origin-head',
          });
          expect((await callPromise).isError).toBeFalsy();
        }

        {
          createHostClone(remote, secondaryPath, { repo: 'proj', branch: secondaryBranch, startedFrom: 'origin-head' });
          const callPromise = createWorktreeTool.handler({ repo: 'proj', branch: secondaryBranch });
          const request = await waitForOutboundAction(outbound, 'repository_checkout', seen);
          writeRepositoryActionResponse(inbound, request.requestId, {
            ok: true,
            dirName: secondaryDirName,
            branch: secondaryBranch,
            created: true,
            startedFrom: 'origin-head',
          });
          expect((await callPromise).isError).toBeFalsy();
        }

        writeFileSync(join(secondaryPath, 'dirty.txt'), 'dirty bytes\n');
        writeFileSync(join(secondaryPath, 'stash-me.txt'), 'stash me\n');
        git(secondaryPath, ['add', 'stash-me.txt']);
        git(secondaryPath, ['stash', 'push', '-m', 'rollback stash']);
        const dirtyBefore = readFileSync(join(secondaryPath, 'dirty.txt'), 'utf8');
        const stashListBefore = git(secondaryPath, ['stash', 'list']);
        expect(stashListBefore).toContain('rollback stash');

        // Roll back to worktree mode.
        process.env.NANOCLAW_CHECKOUT_MODE = 'worktree';

        const primaryReuse = await createWorktreeTool.handler({ repo: 'proj' });
        expect(primaryReuse.isError).toBeFalsy();
        expect(lstatSync(join(primaryPath, '.git')).isDirectory()).toBe(true);

        const secondaryReuse = await createWorktreeTool.handler({ repo: 'proj', branch: secondaryBranch });
        expect(secondaryReuse.isError).toBeFalsy();
        expect(lstatSync(join(secondaryPath, '.git')).isDirectory()).toBe(true);

        const commitResp = await gitCommitTool.handler({
          repo: 'proj',
          message: 'rollback commit',
          branch: secondaryBranch,
        });
        expect(commitResp.isError).toBeFalsy();
        const pushResp = await gitPushTool.handler({ repo: 'proj', branch: secondaryBranch });
        expect(pushResp.isError).toBeFalsy();
        expect(git(remote, ['show-ref', '--verify', `refs/heads/${secondaryBranch}`])).toContain(secondaryBranch);

        const fakeGh = installFakeGh();
        try {
          const prResp = await openPrTool.handler({ repo: 'proj', title: 'Rollback PR', branch: secondaryBranch });
          expect(prResp.isError).toBeFalsy();
        } finally {
          fakeGh.restore();
        }

        expect(readFileSync(join(secondaryPath, 'dirty.txt'), 'utf8')).toBe(dirtyBefore);
        expect(git(secondaryPath, ['stash', 'list'])).toBe(stashListBefore);
      } finally {
        closeSessionDb();
      }
    });

    test('a host completion after the tool timed out is served on the next call', async () => {
      process.env.NANOCLAW_CHECKOUT_MODE = 'clone';
      process.env.NANOCLAW_REPOSITORY_CHECKOUT_TIMEOUT_MS = '150';
      const { inbound, outbound } = initTestSessionDb();
      delete process.env.NANOCLAW_REPOSITORY_ACTION_TRANSPORT;
      try {
        const branch = 'late-completion-branch';
        const dirName = checkoutDirName('proj', branch);
        const clonePath = join(firstTopic, dirName);
        const seen = new Set<string>();

        const timedOutPromise = createWorktreeTool.handler({ repo: 'proj', branch });
        // Mark the first (never-answered) request seen so the second call's
        // wait below can't mistake it for its own request.
        await waitForOutboundAction(outbound, 'repository_checkout', seen);
        const timedOut = await timedOutPromise;
        expect(timedOut.isError).toBe(true);
        expect(timedOut.content[0].text).toMatch(/Timed out/);

        // The host finishes the job late and publishes the checkout — harmless,
        // since nothing is still polling the first request's response.
        const { startCommit } = createHostClone(remote, clonePath, {
          repo: 'proj',
          branch,
          startedFrom: 'origin-head',
        });
        const indexBefore = readFileSync(join(clonePath, '.git', 'index'));

        process.env.NANOCLAW_REPOSITORY_CHECKOUT_TIMEOUT_MS = '120000';
        const callPromise = createWorktreeTool.handler({ repo: 'proj', branch });
        const request = await waitForOutboundAction(outbound, 'repository_checkout', seen);
        writeRepositoryActionResponse(inbound, request.requestId, {
          ok: true,
          dirName,
          branch,
          created: false,
          startedFrom: 'origin-head',
        });
        const response = await callPromise;

        expect(response.isError).toBeFalsy();
        expect(git(clonePath, ['rev-parse', 'HEAD'])).toBe(startCommit);
        expect(readFileSync(join(clonePath, '.git', 'index'))).toEqual(indexBefore);
        expect(existsSync(join(clonePath, 'README.md'))).toBe(true);
      } finally {
        closeSessionDb();
      }
    });
  });
});

describe('isScanPolicyRepositoryName fail-closed behavior (#682 round 2 blocking fix)', () => {
  // scan-policy-repos.test.ts covers loadScanPolicyRepositoryNames itself
  // (every malformed shape, and that importing the loader module never
  // throws). These tests cover the CALLER side that lives in this file:
  // isScanPolicyRepositoryName's memoization and its fail-closed behavior
  // when the load fails, via the resetScanPolicyRepositoryNamesForTest seam.
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'gw-scan-policy-'));
  });

  afterEach(() => {
    // Always clear the cache AND restore the real data path — later tests in
    // this file (the wiki leftover-clone tests above, which rely on the
    // real scan-policy-repos.json saying 'wiki' is scan-policy) must never
    // see a fixture path or a stale cached decision left behind here.
    resetScanPolicyRepositoryNamesForTest();
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function fixture(name: string, content: string): string {
    const filePath = join(scratchDir, name);
    writeFileSync(filePath, content);
    return filePath;
  }

  const badShapes: Array<[string, string]> = [
    ['malformed JSON', '{ this is not valid json'],
    ['an empty array', '[]'],
    ['an object', '{"wiki":true}'],
    ['a bare string', '"wiki"'],
  ];

  test('fails closed for a missing scan-policy-repos.json — every repo name is treated as scan-policy', () => {
    const missingPath = join(scratchDir, 'does-not-exist.json');
    resetScanPolicyRepositoryNamesForTest(missingPath);
    expect(isScanPolicyRepositoryName('proj')).toBe(true);
    expect(isScanPolicyRepositoryName('wiki')).toBe(true);
    expect(isScanPolicyRepositoryName('anything-at-all')).toBe(true);
  });

  for (const [label, content] of badShapes) {
    test(`fails closed for ${label} — every repo name is treated as scan-policy`, () => {
      const filePath = fixture('scan-policy-repos.json', content);
      resetScanPolicyRepositoryNamesForTest(filePath);
      expect(isScanPolicyRepositoryName('proj')).toBe(true);
      expect(isScanPolicyRepositoryName('wiki')).toBe(true);
      expect(isScanPolicyRepositoryName('anything-at-all')).toBe(true);
    });
  }

  test('logs the load failure exactly once, even across many calls', () => {
    const filePath = fixture('scan-policy-repos.json', '{ this is not valid json');
    resetScanPolicyRepositoryNamesForTest(filePath);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(isScanPolicyRepositoryName('proj')).toBe(true);
      expect(isScanPolicyRepositoryName('wiki')).toBe(true);
      expect(isScanPolicyRepositoryName('another-repo')).toBe(true);
      const failureLogs = errorSpy.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('scan-policy-repos.json failed to load'),
      );
      expect(failureLogs.length).toBe(1);
      // #691: the list file is the host's read-only boot snapshot of this
      // very source (src/agent-runner-source.ts), so a container restart
      // alone re-reads the same broken file — the log must point at
      // restarting the HOST, not the container.
      expect(String(failureLogs[0]?.[0])).toContain('restart the host');
      expect(String(failureLogs[0]?.[0])).not.toContain('container restarts');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('a valid custom list is read from the overridden path, and the decision is memoized', () => {
    const filePath = fixture('scan-policy-repos.json', JSON.stringify(['only-this-repo']));
    resetScanPolicyRepositoryNamesForTest(filePath);
    expect(isScanPolicyRepositoryName('only-this-repo')).toBe(true);
    expect(isScanPolicyRepositoryName('wiki')).toBe(false);

    // Memoized: removing the file after the first read must not flip the
    // decision back to fail-closed — the cached list, not the file, governs
    // every call after the first.
    rmSync(filePath);
    expect(isScanPolicyRepositoryName('only-this-repo')).toBe(true);
    expect(isScanPolicyRepositoryName('wiki')).toBe(false);
  });

  test('clearing the override restores the real scan-policy-repos.json (wiki)', () => {
    resetScanPolicyRepositoryNamesForTest(join(scratchDir, 'does-not-exist.json'));
    expect(isScanPolicyRepositoryName('wiki')).toBe(true); // fail-closed under the bad override

    resetScanPolicyRepositoryNamesForTest(); // clears both the cache and the override
    expect(isScanPolicyRepositoryName('wiki')).toBe(true); // true for the real reason this time
    expect(isScanPolicyRepositoryName('some-other-repo')).toBe(false);
  });
});
