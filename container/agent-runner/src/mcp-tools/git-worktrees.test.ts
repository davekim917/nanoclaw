import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
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
import { join } from 'path';

import { cloneRepoTool, createWorktreeTool, gitCommitTool, gitPushTool } from './git-worktrees';
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
  ] as const;
  let savedEnv: Record<string, string | undefined>;

  const git = (cwd: string, args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' })
      .toString()
      .trim();

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
    expect((await createWorktreeTool.handler({ repo: 'proj', branch: 'shared-feature' })).isError).toBeFalsy();
    const firstHead = git(join(firstTopic, 'proj'), ['rev-parse', 'HEAD']);
    const secondTopic = useTopic('topic-two', 'thread:slack:C1:2.2');

    const response = await createWorktreeTool.handler({ repo: 'proj', branch: 'shared-feature' });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('already checked out');
    expect(existsSync(join(secondTopic, 'proj'))).toBe(false);
    expect(git(join(firstTopic, 'proj'), ['rev-parse', 'HEAD'])).toBe(firstHead);
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
    expect(handler).toContain('capturedIdentity(worktree)');
    expect(handler).not.toContain("'branch', '--show-current'");
    expect(handler).not.toContain("'rev-parse', 'HEAD'");
    expect(source).toContain("['status', '--porcelain=v2', '--branch', '--untracked-files=no']");
  });

  test('opens the PR for the branch it captured, not the current checkout', async () => {
    // `gh pr create` defaults --head to whatever is checked out, so a sibling
    // switching branches mid-call would open the PR for their branch.
    const source = readFileSync(fileURLToPath(new URL('./git-worktrees.ts', import.meta.url)), 'utf8');
    const openPr = source.slice(source.indexOf("name: 'open_pr'"));
    expect(openPr).toContain('capturedIdentity(resolved.context.worktree)');
    expect(openPr).toContain("'--head', identity.branch");
  });

  test('still refuses a detached HEAD', async () => {
    expect((await createWorktreeTool.handler({ repo: 'proj' })).isError).toBeFalsy();
    const worktree = join(firstTopic, 'proj');
    git(worktree, ['checkout', '-q', '--detach']);
    const response = await gitPushTool.handler({ repo: 'proj' });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('detached HEAD');
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
});
