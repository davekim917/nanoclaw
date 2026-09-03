import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hostActionMocks = vi.hoisted(() => ({
  RepositoryMountQuiescenceError: class RepositoryMountQuiescenceError extends Error {
    constructor(
      readonly quiescence: { epoch: string; sessions: Session[]; barrierSessions: Session[] },
      readonly releaseWakeSessions: Session[],
      readonly barriersReleased: boolean,
    ) {
      super('partial repository quiescence failed');
    }
  },
  getAgentGroup: vi.fn(),
  getAllAgentGroups: vi.fn(),
  getSessionsByAgentGroup: vi.fn(),
  readSessionOutbound: vi.fn(),
  quiesceSessionsForRepositoryMounts: vi.fn(),
  releaseRepositoryMountQuiescence: vi.fn(),
  wakeRepositoryMountSessions: vi.fn(),
  writeSessionMessageIfNew: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: hostActionDataDir };
});

vi.mock('../../container-restart.js', () => ({
  RepositoryMountQuiescenceError: hostActionMocks.RepositoryMountQuiescenceError,
  quiesceSessionsForRepositoryMounts: hostActionMocks.quiesceSessionsForRepositoryMounts,
  releaseRepositoryMountQuiescence: hostActionMocks.releaseRepositoryMountQuiescence,
  wakeRepositoryMountSessions: hostActionMocks.wakeRepositoryMountSessions,
}));

vi.mock('../../db/agent-groups.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/agent-groups.js')>('../../db/agent-groups.js');
  return {
    ...actual,
    getAgentGroup: hostActionMocks.getAgentGroup,
    getAllAgentGroups: hostActionMocks.getAllAgentGroups,
  };
});

vi.mock('../../db/sessions.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/sessions.js')>('../../db/sessions.js');
  return { ...actual, getSessionsByAgentGroup: hostActionMocks.getSessionsByAgentGroup };
});

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return {
    ...actual,
    writeSessionMessageIfNew: hostActionMocks.writeSessionMessageIfNew,
  };
});

// The quiescence probe reads the source sessions' outbound state through the
// mailbox module's read-only seam (PR 6). Mocked at the seam rather than at a
// raw opener: these fixtures have no outbound.db on disk, and the real seam
// answers `undefined` for that, which the probe treats as ACTIVE (fail-closed).
vi.mock('../mailbox/read-only.js', async () => {
  const actual = await vi.importActual<typeof import('../mailbox/read-only.js')>('../mailbox/read-only.js');
  return { ...actual, readSessionOutbound: hostActionMocks.readSessionOutbound };
});

import {
  canonicalRepoDir,
  isWorkgroupRepositoryMountClaimed,
  readTransferTombstone,
  resolveRepositoryWorkUnit,
  topicWorktreesDir,
  withWorkgroupRepositoryMountClaim,
  writeTransferTombstone,
} from '../../repository-workspaces.js';
import { REPOSITORY_MOUNT_QUIESCENCE_TIMEOUT_MS } from '../../config.js';
import { sessionDir } from '../../session-manager.js';
import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import type { Session } from '../../types.js';
import {
  applyRepositoryPublishAction,
  applyRepositoryTransferAction,
  publishStagedCanonical,
  refreshCanonicalFromLocalRefs,
  resolveTransferSourceWorkUnit,
  transferRepositoryWorktree,
} from './index.js';

let root: string;
let remote: string;
const { hostActionDataDir } = vi.hoisted(() => ({ hostActionDataDir: uniqueTmpRoot('repository-action') }));

const git = (cwd: string, args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

function seedRemote(): string {
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  git(seed, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(seed, 'tracked.txt'), 'base\n');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'base']);
  remote = path.join(root, 'remote.git');
  execFileSync('git', ['clone', '-q', '--bare', seed, remote]);
  return remote;
}

function cloneTo(destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  execFileSync('git', ['clone', '-q', remote, destination]);
  git(destination, ['remote', 'set-head', 'origin', '--auto']);
}

beforeEach(() => {
  vi.clearAllMocks();
  hostActionMocks.getAgentGroup.mockReset();
  hostActionMocks.getAllAgentGroups.mockReset();
  hostActionMocks.getSessionsByAgentGroup.mockReset();
  hostActionMocks.readSessionOutbound.mockReset();
  hostActionMocks.quiesceSessionsForRepositoryMounts.mockReset();
  hostActionMocks.releaseRepositoryMountQuiescence.mockReset();
  hostActionMocks.wakeRepositoryMountSessions.mockReset();
  hostActionMocks.writeSessionMessageIfNew.mockReset();
  fs.rmSync(hostActionDataDir, { recursive: true, force: true });
  fs.mkdirSync(hostActionDataDir, { recursive: true, mode: 0o700 });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-actions-'));
  process.env.NANOCLAW_REPOSITORY_ALLOW_LOCAL_ORIGIN = '1';
  seedRemote();
  // Default: a readable, fully quiescent session. The real callback still runs,
  // so the probe's own derivation stays under test.
  hostActionMocks.readSessionOutbound.mockImplementation((_location: unknown, action: (m: unknown) => unknown) =>
    action({
      getProcessingClaimRows: () => [],
      getContainerState: () => null,
      hasWorkContinuation: () => false,
    }),
  );
});

afterEach(() => {
  closeDb();
  delete process.env.NANOCLAW_REPOSITORY_ALLOW_LOCAL_ORIGIN;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(hostActionDataDir, { recursive: true, force: true });
});

describe('durable canonical publication core', () => {
  it('rejects matching query/fragment origins before canonical or pin publication without leaking them', async () => {
    for (const [kind, suffix] of [
      ['query', '?access_token=QUERY_SYNTHETIC_SECRET'],
      ['fragment', '#FRAGMENT_SYNTHETIC_SECRET'],
    ] as const) {
      const repo = `${kind}-proj`;
      const stage = path.join(root, 'sessions', 'sess-a', 'repository-staging', `request-${kind}`, repo);
      cloneTo(stage);
      const rawOrigin = `https://github.com/example/${repo}.git${suffix}`;
      git(stage, ['remote', 'set-url', 'origin', rawOrigin]);

      const message = await publishStagedCanonical({
        workgroupId: 'wg-a',
        repo,
        origin: rawOrigin,
        repositoryId: `github.com/example/${repo}`,
        stagingPath: stage,
        dataDir: root,
      }).then(
        () => '',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(message).toMatch(/origin must not include query parameters or fragments/);
      expect(message).not.toContain('SYNTHETIC_SECRET');
      expect(message).not.toContain(rawOrigin);
      expect(fs.existsSync(path.join(stage, '.git'))).toBe(true);
      expect(fs.existsSync(canonicalRepoDir('wg-a', repo, root))).toBe(false);
      expect(fs.existsSync(path.join(root, 'repository-state', 'wg-a', repo, 'origin.json'))).toBe(false);
    }
  });

  it('rejects a forged durable repository identity before canonical or pin mutation', async () => {
    const repo = 'forged-identity';
    const stage = path.join(root, 'sessions', 'sess-a', 'repository-staging', 'request-forged', repo);
    cloneTo(stage);
    const origin = `https://github.com/example/${repo}.git`;
    git(stage, ['remote', 'set-url', 'origin', origin]);

    await expect(
      publishStagedCanonical({
        workgroupId: 'wg-a',
        repo,
        origin,
        repositoryId: 'github.com/attacker/forged-identity',
        stagingPath: stage,
        dataDir: root,
      }),
    ).rejects.toThrow(/repository identity does not match normalized origin/);
    expect(fs.existsSync(path.join(stage, '.git'))).toBe(true);
    expect(fs.existsSync(canonicalRepoDir('wg-a', repo, root))).toBe(false);
    expect(fs.existsSync(path.join(root, 'repository-state', 'wg-a', repo, 'origin.json'))).toBe(false);
  });

  it('rejects a forged repository identity carried by the durable host action', async () => {
    const requestId = 'repo-1776355200000-0123456789abcdef';
    const repo = 'forged-action';
    const origin = `https://github.com/example/${repo}.git`;
    const requester = {
      id: 'session-forged-action',
      agent_group_id: 'agent-forged-action',
      messaging_group_id: 'messaging-forged-action',
      thread_id: '171234.999',
      agent_provider: 'claude',
      status: 'active',
      container_status: 'running',
      last_active: null,
      created_at: new Date().toISOString(),
    } satisfies Session;
    const stage = path.join(sessionDir(requester.agent_group_id, requester.id), 'repository-staging', requestId, repo);
    cloneTo(stage);
    git(stage, ['remote', 'set-url', 'origin', origin]);

    hostActionMocks.getAgentGroup.mockReturnValue({
      id: requester.agent_group_id,
      folder: requester.agent_group_id,
      workgroup_id: 'wg-forged-action',
    });
    hostActionMocks.getAllAgentGroups.mockReturnValue([
      { id: requester.agent_group_id, folder: requester.agent_group_id, workgroup_id: 'wg-forged-action' },
    ]);
    hostActionMocks.getSessionsByAgentGroup.mockReturnValue([requester]);
    hostActionMocks.quiesceSessionsForRepositoryMounts.mockResolvedValue({
      epoch: `repository-publish:${requestId}`,
      sessions: [requester],
      barrierSessions: [requester],
    });
    hostActionMocks.releaseRepositoryMountQuiescence.mockReturnValue([requester]);
    const failureMessages: string[] = [];
    hostActionMocks.writeSessionMessageIfNew.mockImplementation(
      async (_agentGroupId: string, _sessionId: string, message: { content: string }) => {
        failureMessages.push(message.content);
        return true;
      },
    );

    await expect(
      applyRepositoryPublishAction(
        {
          requestId,
          repo,
          origin,
          repositoryId: 'github.com/attacker/forged-action',
        },
        requester,
      ),
    ).rejects.toThrow(/repository identity does not match normalized origin/);
    expect(hostActionMocks.releaseRepositoryMountQuiescence).toHaveBeenCalledTimes(1);
    expect(hostActionMocks.wakeRepositoryMountSessions).toHaveBeenCalledWith([requester]);
    expect(fs.existsSync(path.join(stage, '.git'))).toBe(true);
    expect(fs.existsSync(canonicalRepoDir('wg-forged-action', repo, hostActionDataDir))).toBe(false);
    expect(
      fs.existsSync(path.join(hostActionDataDir, 'repository-state', 'wg-forged-action', repo, 'origin.json')),
    ).toBe(false);
    expect(failureMessages.join('\n')).not.toContain(origin);
    expect(failureMessages.join('\n')).not.toContain('github.com/attacker/forged-action');
  });

  it('persists the normalized GitHub origin and host-derived repository identity', async () => {
    const repo = 'normalized-persist';
    const stage = path.join(root, 'sessions', 'sess-a', 'repository-staging', 'request-normalized', repo);
    cloneTo(stage);
    const requestedOrigin = `https://github.com/Example/${repo}.git`;
    git(stage, ['remote', 'set-url', 'origin', requestedOrigin]);

    await publishStagedCanonical({
      workgroupId: 'wg-a',
      repo,
      origin: requestedOrigin,
      repositoryId: `github.com/Example/${repo}`,
      stagingPath: stage,
      dataDir: root,
    });
    const canonical = canonicalRepoDir('wg-a', repo, root);
    const pin = JSON.parse(
      fs.readFileSync(path.join(root, 'repository-state', 'wg-a', repo, 'origin.json'), 'utf8'),
    ) as { origin: string; repositoryId: string };
    expect(git(canonical, ['config', '--get', 'remote.origin.url'])).toBe(`https://github.com/Example/${repo}`);
    expect(pin).toMatchObject({
      origin: `https://github.com/Example/${repo}`,
      repositoryId: `github.com/example/${repo}`,
    });
    expect(JSON.stringify(pin)).not.toContain('.git');
  });

  it('clone-is-idempotent-and-conflicting-origin-rejects', async () => {
    const stage = path.join(root, 'sessions', 'sess-a', 'repository-staging', 'request-a', 'proj');
    cloneTo(stage);
    const first = await publishStagedCanonical({
      workgroupId: 'wg-a',
      repo: 'proj',
      origin: remote,
      repositoryId: remote,
      stagingPath: stage,
      dataDir: root,
    });
    const canonical = canonicalRepoDir('wg-a', 'proj', root);

    expect(first.status).toBe('published');
    expect(fs.existsSync(path.join(canonical, '.git'))).toBe(true);
    expect(fs.existsSync(stage)).toBe(false);
    expect(git(canonical, ['config', 'gc.auto'])).toBe('0');
    expect(git(canonical, ['config', 'gc.worktreePruneExpire'])).toBe('never');
    expect(git(canonical, ['branch', '--show-current'])).toBe('');

    const retryStage = path.join(root, 'sessions', 'sess-a', 'repository-staging', 'request-b', 'proj');
    cloneTo(retryStage);
    const retry = await publishStagedCanonical({
      workgroupId: 'wg-a',
      repo: 'proj',
      origin: remote,
      repositoryId: remote,
      stagingPath: retryStage,
      dataDir: root,
    });

    expect(retry.status).toBe('existing');
    expect(fs.existsSync(path.join(canonical, '.git'))).toBe(true);
    // A proven clean, matching retry is redundant and is removed immediately;
    // absent staging remains the crash-after-rename idempotency case below.
    expect(fs.existsSync(retryStage)).toBe(false);

    const crashRetry = await publishStagedCanonical({
      workgroupId: 'wg-a',
      repo: 'proj',
      origin: remote,
      repositoryId: remote,
      stagingPath: path.join(root, 'already-renamed-away', 'proj'),
      dataDir: root,
    });
    expect(crashRetry.status).toBe('existing');

    const conflictStage = path.join(root, 'sessions', 'sess-a', 'repository-staging', 'request-c', 'proj');
    cloneTo(conflictStage);
    await expect(
      publishStagedCanonical({
        workgroupId: 'wg-a',
        repo: 'proj',
        origin: remote,
        repositoryId: `${remote}-different`,
        stagingPath: conflictStage,
        dataDir: root,
      }),
    ).rejects.toThrow(/origin pin conflict|repository identity/);
    expect(fs.existsSync(path.join(conflictStage, '.git'))).toBe(true);
  });

  it('rejects conflicting origin identity and a symlinked staging path without mutation', async () => {
    const stage = path.join(root, 'stage-a', 'proj');
    cloneTo(stage);
    await publishStagedCanonical({
      workgroupId: 'wg-a',
      repo: 'proj',
      origin: remote,
      repositoryId: remote,
      stagingPath: stage,
      dataDir: root,
    });
    const canonicalHead = git(canonicalRepoDir('wg-a', 'proj', root), ['rev-parse', 'HEAD']);

    const conflict = path.join(root, 'stage-conflict', 'proj');
    cloneTo(conflict);
    await expect(
      publishStagedCanonical({
        workgroupId: 'wg-a',
        repo: 'proj',
        origin: remote,
        repositoryId: `${remote}-different`,
        stagingPath: conflict,
        dataDir: root,
      }),
    ).rejects.toThrow(/origin pin conflict|repository identity/);
    expect(git(canonicalRepoDir('wg-a', 'proj', root), ['rev-parse', 'HEAD'])).toBe(canonicalHead);
    expect(fs.existsSync(path.join(conflict, '.git'))).toBe(true);

    const realStage = path.join(root, 'real-stage', 'other');
    cloneTo(realStage);
    const symlinkStage = path.join(root, 'symlink-stage');
    fs.symlinkSync(realStage, symlinkStage);
    await expect(
      publishStagedCanonical({
        workgroupId: 'wg-a',
        repo: 'other',
        origin: remote,
        repositoryId: remote,
        stagingPath: symlinkStage,
        dataDir: root,
      }),
    ).rejects.toThrow(/symlink/);
    expect(fs.existsSync(realStage)).toBe(true);
  });

  it('clone-publication-is-crash-resumable-and-workgroup-mounts-remain-consistent', async () => {
    const requestId = 'repo-1723600000000-0123456789abcdef';
    const requester = {
      id: 'session-requester',
      agent_group_id: 'agent-a',
      messaging_group_id: 'messaging-a',
      thread_id: '171234.567',
      agent_provider: 'claude',
      status: 'active',
      container_status: 'running',
      last_active: null,
      created_at: new Date().toISOString(),
    } satisfies Session;
    const sibling = { ...requester, id: 'session-sibling', agent_group_id: 'agent-b' } satisfies Session;
    const otherWorkgroup = { ...requester, id: 'session-other', agent_group_id: 'agent-other' } satisfies Session;
    const mountSessions = [requester, sibling];
    const lifecycle: string[] = [];
    const insertedIds = new Set<string>();

    hostActionMocks.getAgentGroup.mockReturnValue({ id: 'agent-a', folder: 'agent-a', workgroup_id: 'wg-a' });
    hostActionMocks.getAllAgentGroups.mockReturnValue([
      { id: 'agent-a', folder: 'agent-a', workgroup_id: 'wg-a' },
      { id: 'agent-b', folder: 'agent-b', workgroup_id: 'wg-a' },
      { id: 'agent-other', folder: 'agent-other', workgroup_id: 'wg-other' },
    ]);
    hostActionMocks.getSessionsByAgentGroup.mockImplementation((agentGroupId: string) => {
      if (agentGroupId === 'agent-a') return [requester];
      if (agentGroupId === 'agent-b') return [sibling];
      if (agentGroupId === 'agent-other') return [otherWorkgroup];
      return [];
    });
    hostActionMocks.quiesceSessionsForRepositoryMounts.mockImplementation(
      async (sessions: Session[], epoch: string, timeoutMs: number) => {
        expect(isWorkgroupRepositoryMountClaimed('wg-a')).toBe(true);
        expect(sessions).toEqual(mountSessions);
        expect(epoch).toBe(`repository-publish:${requestId}`);
        // Detached from the delivery drain, so the wait for siblings to reach a
        // safe point is the configured one (10 min), not container-restart's
        // 120s default that still governs every inline caller.
        expect(timeoutMs).toBe(REPOSITORY_MOUNT_QUIESCENCE_TIMEOUT_MS);
        expect(REPOSITORY_MOUNT_QUIESCENCE_TIMEOUT_MS).toBe(600_000);
        lifecycle.push('quiesce');
        return { epoch, sessions, barrierSessions: sessions };
      },
    );
    hostActionMocks.releaseRepositoryMountQuiescence.mockImplementation(
      (quiescence: { sessions: Session[]; barrierSessions: Session[] }) => {
        expect(isWorkgroupRepositoryMountClaimed('wg-a')).toBe(true);
        expect(quiescence.sessions).toEqual(mountSessions);
        expect(quiescence.barrierSessions).toEqual(mountSessions);
        lifecycle.push('release');
        return mountSessions;
      },
    );
    hostActionMocks.wakeRepositoryMountSessions.mockImplementation((sessions: Session[]) => {
      expect(isWorkgroupRepositoryMountClaimed('wg-a')).toBe(false);
      expect(sessions).toEqual(mountSessions);
      lifecycle.push('wake');
    });
    hostActionMocks.writeSessionMessageIfNew.mockImplementation(
      async (_agentGroupId: string, _sessionId: string, message: { id: string }) => {
        if (insertedIds.has(message.id)) return false;
        insertedIds.add(message.id);
        return true;
      },
    );

    const stage = path.join(
      sessionDir(requester.agent_group_id, requester.id),
      'repository-staging',
      requestId,
      'proj',
    );
    cloneTo(stage);
    const action = { requestId, repo: 'proj', origin: remote, repositoryId: remote };

    await applyRepositoryPublishAction(action, requester);
    const canonical = canonicalRepoDir('wg-a', 'proj', hostActionDataDir);
    expect(fs.existsSync(path.join(canonical, '.git'))).toBe(true);
    expect(fs.existsSync(stage)).toBe(false);
    expect(git(canonical, ['branch', '--show-current'])).toBe('');
    expect(lifecycle).toEqual(['quiesce', 'release', 'wake']);
    await expect(withWorkgroupRepositoryMountClaim('wg-a', async () => 'released')).resolves.toBe('released');

    // Crash replay: the durable action is retried after the staging checkout
    // was atomically renamed and after the deterministic confirmation landed.
    await applyRepositoryPublishAction(action, requester);
    expect(lifecycle).toEqual(['quiesce', 'release', 'wake', 'quiesce', 'release', 'wake']);
    expect(hostActionMocks.writeSessionMessageIfNew).toHaveBeenCalledTimes(2);
    expect(hostActionMocks.writeSessionMessageIfNew.mock.calls.map((call) => call[2].id)).toEqual([
      `repository-publish-complete-${requestId}`,
      `repository-publish-complete-${requestId}`,
    ]);
    expect(insertedIds).toEqual(new Set([`repository-publish-complete-${requestId}`]));
    expect(git(canonical, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('');
    await expect(withWorkgroupRepositoryMountClaim('wg-a', async () => 'released-again')).resolves.toBe(
      'released-again',
    );
  });

  it('recovers exact stopped and due sessions after a partial quiescence failure without waking under the claim', async () => {
    const requestId = 'repo-1723600000000-fedcba9876543210';
    const requester = {
      id: 'session-requester',
      agent_group_id: 'agent-a',
      messaging_group_id: 'messaging-a',
      thread_id: '171234.567',
      agent_provider: 'claude',
      status: 'active',
      container_status: 'running',
      last_active: null,
      created_at: new Date().toISOString(),
    } satisfies Session;
    const sibling = { ...requester, id: 'session-sibling', agent_group_id: 'agent-b' } satisfies Session;
    const mountSessions = [requester, sibling];
    const lifecycle: string[] = [];

    hostActionMocks.getAgentGroup.mockReturnValue({ id: 'agent-a', folder: 'agent-a', workgroup_id: 'wg-a' });
    hostActionMocks.getAllAgentGroups.mockReturnValue([
      { id: 'agent-a', folder: 'agent-a', workgroup_id: 'wg-a' },
      { id: 'agent-b', folder: 'agent-b', workgroup_id: 'wg-a' },
    ]);
    hostActionMocks.getSessionsByAgentGroup.mockImplementation((agentGroupId: string) =>
      agentGroupId === 'agent-a' ? [requester] : agentGroupId === 'agent-b' ? [sibling] : [],
    );
    hostActionMocks.quiesceSessionsForRepositoryMounts.mockImplementation(
      async (_sessions: Session[], epoch: string) => {
        lifecycle.push('partial-kill');
        throw new hostActionMocks.RepositoryMountQuiescenceError(
          { epoch, sessions: mountSessions, barrierSessions: mountSessions },
          [sibling],
          true,
        );
      },
    );
    hostActionMocks.writeSessionMessageIfNew.mockImplementation(
      async (_group: string, _id: string, message: { onWake?: number }) => {
        expect(isWorkgroupRepositoryMountClaimed('wg-a')).toBe(false);
        expect(message.onWake).toBe(1);
        lifecycle.push('failure-notice');
        return true;
      },
    );
    hostActionMocks.wakeRepositoryMountSessions.mockImplementation((sessions: Session[]) => {
      expect(isWorkgroupRepositoryMountClaimed('wg-a')).toBe(false);
      expect(sessions.map((candidate) => candidate.id)).toEqual(['session-requester', 'session-sibling']);
      lifecycle.push('wake');
    });

    const stage = path.join(
      sessionDir(requester.agent_group_id, requester.id),
      'repository-staging',
      requestId,
      'proj',
    );
    cloneTo(stage);
    await expect(
      applyRepositoryPublishAction({ requestId, repo: 'proj', origin: remote, repositoryId: remote }, requester),
    ).rejects.toThrow(/partial repository quiescence failed/);

    expect(hostActionMocks.releaseRepositoryMountQuiescence).not.toHaveBeenCalled();
    expect(lifecycle).toEqual(['partial-kill', 'failure-notice', 'wake']);
    expect(fs.existsSync(path.join(stage, '.git'))).toBe(true);
  });
});

describe('host local-only canonical refresh', () => {
  it('advances a clean canonical from already-fetched origin refs without network access', async () => {
    const canonical = canonicalRepoDir('wg-a', 'proj', root);
    cloneTo(canonical);

    const scratch = path.join(root, 'advance');
    cloneTo(scratch);
    fs.writeFileSync(path.join(scratch, 'fresh.txt'), 'fresh\n');
    git(scratch, ['add', '-A']);
    git(scratch, ['commit', '-q', '-m', 'advance']);
    git(scratch, ['push', '-q', 'origin', 'main']);
    const freshHead = git(scratch, ['rev-parse', 'HEAD']);

    // This models create_worktree's scoped container fetch. Delete the remote
    // afterward: the host refresh must still succeed from local refs alone.
    git(canonical, ['fetch', 'origin']);
    fs.rmSync(remote, { recursive: true, force: true });
    const result = await refreshCanonicalFromLocalRefs({ workgroupId: 'wg-a', repo: 'proj', dataDir: root });

    expect(result.oid).toBe(freshHead);
    expect(git(canonical, ['rev-parse', 'HEAD'])).toBe(freshHead);
    expect(git(canonical, ['branch', '--show-current'])).toBe('');
    expect(fs.existsSync(path.join(canonical, 'fresh.txt'))).toBe(true);
  });

  it('refuses to clobber a dirty canonical and reports the exact failure', async () => {
    const canonical = canonicalRepoDir('wg-a', 'proj', root);
    cloneTo(canonical);
    fs.writeFileSync(path.join(canonical, 'tracked.txt'), 'host work in progress\n');

    await expect(refreshCanonicalFromLocalRefs({ workgroupId: 'wg-a', repo: 'proj', dataDir: root })).rejects.toThrow(
      /local modifications/,
    );
    expect(fs.readFileSync(path.join(canonical, 'tracked.txt'), 'utf8')).toBe('host work in progress\n');
  });
});

describe('exact topic transfer', () => {
  function workUnit(threadId: string) {
    return resolveRepositoryWorkUnit({
      workgroupId: 'wg-a',
      sessionId: `session-${threadId}`,
      platformId: 'slack:C1',
      messagingGroupId: 'mg-a',
      threadId,
    });
  }

  it('preserves HEAD, index, staged/unstaged/untracked bytes, and modes while tombstoning the source', async () => {
    const canonical = canonicalRepoDir('wg-a', 'proj', root);
    cloneTo(canonical);
    const source = workUnit('slack:C1:1.1');
    const destination = workUnit('slack:C1:2.2');
    const sourcePath = path.join(topicWorktreesDir(source, root), 'proj');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    git(canonical, ['worktree', 'add', '-b', 'carry-work', sourcePath]);

    fs.writeFileSync(path.join(sourcePath, 'staged.txt'), 'staged\n');
    git(sourcePath, ['add', 'staged.txt']);
    fs.writeFileSync(path.join(sourcePath, 'tracked.txt'), 'unstaged\n');
    fs.writeFileSync(path.join(sourcePath, 'untracked.sh'), '#!/bin/sh\necho preserved\n');
    fs.chmodSync(path.join(sourcePath, 'untracked.sh'), 0o755);
    const beforeStatus = git(sourcePath, ['status', '--porcelain=v2', '--untracked-files=all']);
    const beforeHead = git(sourcePath, ['rev-parse', 'HEAD']);
    const beforeIndex = git(sourcePath, ['write-tree']);
    const beforeHash = createHash('sha256')
      .update(fs.readFileSync(path.join(sourcePath, 'untracked.sh')))
      .digest('hex');
    const destinationPath = path.join(topicWorktreesDir(destination, root), 'proj');

    const order: string[] = [];
    const result = await transferRepositoryWorktree({
      workgroupId: 'wg-a',
      repo: 'proj',
      source,
      destination,
      dataDir: root,
      loadSourceSessions: () => [],
      beforeMoveWhileClaimed: () => {
        expect(fs.existsSync(sourcePath)).toBe(true);
        expect(fs.existsSync(destinationPath)).toBe(false);
        order.push('destination-quiesced');
      },
      afterMoveWhileClaimed: () => {
        expect(fs.existsSync(sourcePath)).toBe(false);
        expect(fs.existsSync(destinationPath)).toBe(true);
        order.push('moved');
      },
    });
    expect(result.sourcePath).toBe(sourcePath);
    expect(result.destinationPath).toBe(destinationPath);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(git(destinationPath, ['status', '--porcelain=v2', '--untracked-files=all'])).toBe(beforeStatus);
    expect(git(destinationPath, ['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(git(destinationPath, ['write-tree'])).toBe(beforeIndex);
    expect(
      createHash('sha256')
        .update(fs.readFileSync(path.join(destinationPath, 'untracked.sh')))
        .digest('hex'),
    ).toBe(beforeHash);
    expect(fs.statSync(path.join(destinationPath, 'untracked.sh')).mode & 0o777).toBe(0o755);
    expect(readTransferTombstone(source, 'proj', root)?.destinationWorkUnitKey).toBe(destination.key);
    expect(order).toEqual(['destination-quiesced', 'moved']);
  });

  it('transfer-preserves-exact-state-and-active-source-rejects-without-mutation', async () => {
    const canonical = canonicalRepoDir('wg-a', 'proj', root);
    cloneTo(canonical);
    const source = workUnit('slack:C1:detached-source');
    const destination = workUnit('slack:C1:detached-destination');
    const sourcePath = path.join(topicWorktreesDir(source, root), 'proj');
    const destinationPath = path.join(topicWorktreesDir(destination, root), 'proj');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    git(canonical, ['worktree', 'add', '--detach', sourcePath, 'HEAD']);

    fs.writeFileSync(path.join(sourcePath, 'staged.txt'), 'detached staged\n');
    git(sourcePath, ['add', 'staged.txt']);
    fs.writeFileSync(path.join(sourcePath, 'tracked.txt'), 'detached unstaged\n');
    fs.writeFileSync(path.join(sourcePath, 'untracked.sh'), '#!/bin/sh\necho detached\n');
    fs.chmodSync(path.join(sourcePath, 'untracked.sh'), 0o751);
    const beforeHead = git(sourcePath, ['rev-parse', 'HEAD']);
    const beforeStatus = git(sourcePath, ['status', '--porcelain=v2', '--untracked-files=all']);
    const beforeIndexPath = git(sourcePath, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    const beforeIndexHash = createHash('sha256').update(fs.readFileSync(beforeIndexPath)).digest('hex');

    await expect(
      transferRepositoryWorktree({
        workgroupId: 'wg-a',
        repo: 'proj',
        source,
        destination,
        dataDir: root,
        loadSourceSessions: () => [
          {
            id: 'session-active',
            running: true,
            spawning: false,
            processing: false,
            activeTool: false,
            continuation: false,
          },
        ],
      }),
    ).rejects.toThrow(/source topic is active/);
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(destinationPath)).toBe(false);
    expect(readTransferTombstone(source, 'proj', root)).toBeNull();
    expect(git(sourcePath, ['branch', '--show-current'])).toBe('');
    expect(git(sourcePath, ['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(git(sourcePath, ['status', '--porcelain=v2', '--untracked-files=all'])).toBe(beforeStatus);
    expect(createHash('sha256').update(fs.readFileSync(beforeIndexPath)).digest('hex')).toBe(beforeIndexHash);

    await transferRepositoryWorktree({
      workgroupId: 'wg-a',
      repo: 'proj',
      source,
      destination,
      dataDir: root,
      loadSourceSessions: () => [],
    });

    const afterIndexPath = git(destinationPath, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    expect(git(destinationPath, ['branch', '--show-current'])).toBe('');
    expect(git(destinationPath, ['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(git(destinationPath, ['status', '--porcelain=v2', '--untracked-files=all'])).toBe(beforeStatus);
    expect(createHash('sha256').update(fs.readFileSync(afterIndexPath)).digest('hex')).toBe(beforeIndexHash);
    expect(fs.statSync(path.join(destinationPath, 'untracked.sh')).mode & 0o777).toBe(0o751);
    expect(readTransferTombstone(source, 'proj', root)?.phase).toBe('moved');
  });

  it('rejects spawning, processing, active-tool, and continuation sources without mutation', async () => {
    const canonical = canonicalRepoDir('wg-a', 'proj', root);
    cloneTo(canonical);
    const source = workUnit('slack:C1:blocked-source');
    const destination = workUnit('slack:C1:blocked-destination');
    const sourcePath = path.join(topicWorktreesDir(source, root), 'proj');
    const destinationPath = path.join(topicWorktreesDir(destination, root), 'proj');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    git(canonical, ['worktree', 'add', '-b', 'blocked-carry', sourcePath]);
    fs.writeFileSync(path.join(sourcePath, 'ongoing.txt'), 'must remain\n');
    git(sourcePath, ['add', 'ongoing.txt']);
    fs.writeFileSync(path.join(sourcePath, 'tracked.txt'), 'also remain unstaged\n');
    const beforeHead = git(sourcePath, ['rev-parse', 'HEAD']);
    const beforeStatus = git(sourcePath, ['status', '--porcelain=v2', '--untracked-files=all']);
    const beforeIndex = createHash('sha256')
      .update(fs.readFileSync(git(sourcePath, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])))
      .digest('hex');
    const beforePointer = fs.readFileSync(path.join(sourcePath, '.git'), 'utf8');
    const blockedStates = [
      { label: 'spawning', spawning: true, processing: false, activeTool: false, continuation: false },
      { label: 'processing', spawning: false, processing: true, activeTool: false, continuation: false },
      { label: 'active-tool', spawning: false, processing: false, activeTool: true, continuation: false },
      { label: 'continuation', spawning: false, processing: false, activeTool: false, continuation: true },
    ] as const;

    for (const blocked of blockedStates) {
      await expect(
        transferRepositoryWorktree({
          workgroupId: 'wg-a',
          repo: 'proj',
          source,
          destination,
          dataDir: root,
          loadSourceSessions: () => [
            {
              id: `session-${blocked.label}`,
              running: false,
              spawning: blocked.spawning,
              processing: blocked.processing,
              activeTool: blocked.activeTool,
              continuation: blocked.continuation,
            },
          ],
        }),
      ).rejects.toThrow(/source topic is active/);
      expect(fs.existsSync(sourcePath)).toBe(true);
      expect(fs.existsSync(destinationPath)).toBe(false);
      expect(readTransferTombstone(source, 'proj', root)).toBeNull();
      expect(git(sourcePath, ['rev-parse', 'HEAD'])).toBe(beforeHead);
      expect(git(sourcePath, ['status', '--porcelain=v2', '--untracked-files=all'])).toBe(beforeStatus);
      expect(
        createHash('sha256')
          .update(fs.readFileSync(git(sourcePath, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])))
          .digest('hex'),
      ).toBe(beforeIndex);
      expect(fs.readFileSync(path.join(sourcePath, '.git'), 'utf8')).toBe(beforePointer);
    }
  });

  it('rejects an active source or non-empty destination before mutation', async () => {
    const canonical = canonicalRepoDir('wg-a', 'proj', root);
    cloneTo(canonical);
    const source = workUnit('slack:C1:1.1');
    const destination = workUnit('slack:C1:2.2');
    const sourcePath = path.join(topicWorktreesDir(source, root), 'proj');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    git(canonical, ['worktree', 'add', '-b', 'carry-work', sourcePath]);

    await expect(
      transferRepositoryWorktree({
        workgroupId: 'wg-a',
        repo: 'proj',
        source,
        destination,
        dataDir: root,
        loadSourceSessions: () => [
          {
            id: 'sess-active',
            running: true,
            spawning: false,
            processing: false,
            activeTool: false,
            continuation: false,
          },
        ],
      }),
    ).rejects.toThrow(/source topic is active/);
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(readTransferTombstone(source, 'proj', root)).toBeNull();

    const destinationPath = path.join(topicWorktreesDir(destination, root), 'proj');
    fs.mkdirSync(destinationPath, { recursive: true });
    fs.writeFileSync(path.join(destinationPath, 'ONGOING.txt'), 'do not overwrite\n');
    await expect(
      transferRepositoryWorktree({
        workgroupId: 'wg-a',
        repo: 'proj',
        source,
        destination,
        dataDir: root,
        loadSourceSessions: () => [],
      }),
    ).rejects.toThrow(/destination is not empty/);
    expect(fs.readFileSync(path.join(destinationPath, 'ONGOING.txt'), 'utf8')).toBe('do not overwrite\n');
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it('recovers a crash between the durable prepared tombstone and moved acknowledgement', async () => {
    const canonical = canonicalRepoDir('wg-a', 'proj', root);
    cloneTo(canonical);
    const source = workUnit('slack:C1:crash-source');
    const destination = workUnit('slack:C1:crash-destination');
    const sourcePath = path.join(topicWorktreesDir(source, root), 'proj');
    const destinationPath = path.join(topicWorktreesDir(destination, root), 'proj');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    git(canonical, ['worktree', 'add', '-b', 'crash-carry', sourcePath]);
    writeTransferTombstone(
      source,
      'proj',
      {
        version: 1,
        phase: 'prepared',
        workgroupId: 'wg-a',
        repo: 'proj',
        sourceWorkUnitKey: source.key,
        destinationWorkUnitKey: destination.key,
        sourcePath,
        destinationPath,
        createdAt: new Date().toISOString(),
      },
      root,
    );
    git(canonical, ['worktree', 'move', sourcePath, destinationPath]);

    const result = await transferRepositoryWorktree({
      workgroupId: 'wg-a',
      repo: 'proj',
      source,
      destination,
      dataDir: root,
      loadSourceSessions: () => [],
    });
    expect(result).toEqual({ sourcePath, destinationPath });
    expect(readTransferTombstone(source, 'proj', root)?.phase).toBe('moved');
    expect(fs.existsSync(destinationPath)).toBe(true);
  });

  it('finishes reverse-transfer tombstone cleanup after a crash following the move', async () => {
    const canonical = canonicalRepoDir('wg-a', 'proj', root);
    cloneTo(canonical);
    const a = workUnit('slack:C1:reverse-a');
    const b = workUnit('slack:C1:reverse-b');
    const aPath = path.join(topicWorktreesDir(a, root), 'proj');
    const bPath = path.join(topicWorktreesDir(b, root), 'proj');
    fs.mkdirSync(path.dirname(aPath), { recursive: true });
    git(canonical, ['worktree', 'add', '-b', 'reverse-carry', aPath]);
    await transferRepositoryWorktree({
      workgroupId: 'wg-a',
      repo: 'proj',
      source: a,
      destination: b,
      dataDir: root,
      loadSourceSessions: () => [],
    });

    const reverse = {
      version: 1 as const,
      phase: 'moved' as const,
      workgroupId: 'wg-a',
      repo: 'proj',
      sourceWorkUnitKey: b.key,
      destinationWorkUnitKey: a.key,
      sourcePath: bPath,
      destinationPath: aPath,
      createdAt: new Date().toISOString(),
    };
    writeTransferTombstone(b, 'proj', { ...reverse, phase: 'prepared' }, root);
    git(canonical, ['worktree', 'move', bPath, aPath]);
    writeTransferTombstone(b, 'proj', reverse, root);
    expect(readTransferTombstone(a, 'proj', root)).not.toBeNull();

    await transferRepositoryWorktree({
      workgroupId: 'wg-a',
      repo: 'proj',
      source: b,
      destination: a,
      dataDir: root,
      loadSourceSessions: () => [],
    });
    expect(readTransferTombstone(a, 'proj', root)).toBeNull();
    expect(readTransferTombstone(b, 'proj', root)?.phase).toBe('moved');
    expect(fs.existsSync(aPath)).toBe(true);
  });

  it('replays a moved transfer with the same barrier epoch and releases queued destination ingress exactly once', async () => {
    const db = initTestDb();
    runMigrations(db);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO workgroups (id, onecli_secrets, created_at) VALUES ('wg-a', '[]', ?)").run(now);
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at, workgroup_id)
       VALUES (?, ?, ?, 'claude', ?, 'wg-a')`,
    ).run('agent-a', 'Agent A', 'agent-a', now);
    db.prepare(
      `INSERT INTO messaging_groups
         (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, 'slack', ?, 'slack', ?, 1, 'strict', ?)`,
    ).run('mg-source', 'C-source', 'source', now);
    db.prepare(
      `INSERT INTO messaging_groups
         (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, 'slack', ?, 'slack', ?, 1, 'strict', ?)`,
    ).run('mg-destination', 'C-destination', 'destination', now);
    const sourceSession = {
      id: 'session-source',
      agent_group_id: 'agent-a',
      messaging_group_id: 'mg-source',
      thread_id: '111.111',
      agent_provider: 'claude',
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now,
    } satisfies Session;
    const destinationSession = {
      ...sourceSession,
      id: 'session-destination',
      messaging_group_id: 'mg-destination',
      thread_id: '222.222',
    } satisfies Session;
    for (const candidate of [sourceSession, destinationSession]) {
      db.prepare(
        `INSERT INTO sessions
           (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
         VALUES (@id, @agent_group_id, @messaging_group_id, @thread_id, @agent_provider, @status, @container_status, @last_active, @created_at)`,
      ).run(candidate);
    }

    hostActionMocks.getAgentGroup.mockReturnValue({ id: 'agent-a', folder: 'agent-a', workgroup_id: 'wg-a' });
    hostActionMocks.getAllAgentGroups.mockReturnValue([{ id: 'agent-a', folder: 'agent-a', workgroup_id: 'wg-a' }]);
    hostActionMocks.getSessionsByAgentGroup.mockReturnValue([sourceSession, destinationSession]);

    const canonical = canonicalRepoDir('wg-a', 'proj', hostActionDataDir);
    cloneTo(canonical);
    const source = resolveRepositoryWorkUnit({
      workgroupId: 'wg-a',
      sessionId: sourceSession.id,
      platformId: 'C-source',
      messagingGroupId: sourceSession.messaging_group_id,
      threadId: sourceSession.thread_id,
    });
    const destination = resolveRepositoryWorkUnit({
      workgroupId: 'wg-a',
      sessionId: destinationSession.id,
      platformId: 'C-destination',
      messagingGroupId: destinationSession.messaging_group_id,
      threadId: destinationSession.thread_id,
    });
    const sourcePath = path.join(topicWorktreesDir(source, hostActionDataDir), 'proj');
    const destinationPath = path.join(topicWorktreesDir(destination, hostActionDataDir), 'proj');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    git(canonical, ['worktree', 'add', '-b', 'transfer-replay', sourcePath]);
    fs.writeFileSync(path.join(sourcePath, 'ongoing.txt'), 'preserve through replay\n');

    const requestId = 'repo-1723600000000-aabbccddeeff0011';
    const epoch = `repository-transfer:${requestId}`;
    let durableBarrier: 'none' | 'active' | 'released' = 'none';
    let releaseFailuresRemaining = 2;
    const observedEpochs: string[] = [];
    const delivered = new Set<string>();
    hostActionMocks.quiesceSessionsForRepositoryMounts.mockImplementation(
      async (sessions: Session[], requestedEpoch: string, timeoutMs: number) => {
        expect(sessions.map((candidate) => candidate.id)).toEqual([destinationSession.id]);
        expect(requestedEpoch).toBe(epoch);
        expect(timeoutMs).toBe(REPOSITORY_MOUNT_QUIESCENCE_TIMEOUT_MS);
        observedEpochs.push(requestedEpoch);
        if (durableBarrier === 'none') durableBarrier = 'active';
        else expect(durableBarrier).toBe('active');
        return { epoch: requestedEpoch, sessions: [], barrierSessions: sessions };
      },
    );
    hostActionMocks.releaseRepositoryMountQuiescence.mockImplementation(
      (quiescence: { epoch: string; barrierSessions: Session[] }) => {
        expect(quiescence.epoch).toBe(epoch);
        if (releaseFailuresRemaining > 0) {
          releaseFailuresRemaining -= 1;
          throw new Error('simulated crash before durable barrier release');
        }
        durableBarrier = 'released';
        return [destinationSession];
      },
    );
    hostActionMocks.writeSessionMessageIfNew.mockImplementation(
      async (_group: string, _session: string, message: { id: string }) => {
        if (delivered.has(message.id)) return false;
        delivered.add(message.id);
        return true;
      },
    );
    // `clearAllMocks` preserves implementations from prior cases; this replay
    // owns only the wake call record and must not inherit another fixture's
    // session assertions.
    hostActionMocks.wakeRepositoryMountSessions.mockImplementation(() => undefined);

    const action = {
      requestId,
      repo: 'proj',
      sourceThreadId: sourceSession.thread_id,
      destinationWorkUnitKey: destination.key,
    };
    await expect(applyRepositoryTransferAction(action, destinationSession)).rejects.toThrow(
      /ingress barrier could not be released/,
    );
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.readFileSync(path.join(destinationPath, 'ongoing.txt'), 'utf8')).toBe('preserve through replay\n');
    expect(readTransferTombstone(source, 'proj', hostActionDataDir)?.phase).toBe('moved');
    expect(durableBarrier).toBe('active');
    expect(hostActionMocks.wakeRepositoryMountSessions).not.toHaveBeenCalled();

    await applyRepositoryTransferAction(action, destinationSession);
    expect(observedEpochs).toEqual([epoch, epoch]);
    expect(durableBarrier).toBe('released');
    expect(fs.readFileSync(path.join(destinationPath, 'ongoing.txt'), 'utf8')).toBe('preserve through replay\n');
    expect(hostActionMocks.wakeRepositoryMountSessions).toHaveBeenCalledWith([destinationSession]);
  });
});

describe('transfer source thread resolution', () => {
  const row = (id: string, platformId: string, threadId: string, messagingGroupId: string) => ({
    id,
    platform_id: platformId,
    thread_id: threadId,
    messaging_group_id: messagingGroupId,
  });

  it('resolves a source in another conversation from raw or platform-qualified external thread ids', () => {
    const rows = [
      row('source', 'slack:C-source', '171234.567', 'mg-source'),
      row('destination', 'slack:C-destination', '999999.000', 'mg-destination'),
    ];
    const raw = resolveTransferSourceWorkUnit('wg-a', '171234.567', rows);
    const qualified = resolveTransferSourceWorkUnit('wg-a', 'slack:C-source:171234.567', rows);
    expect(raw).toEqual(qualified);
    expect(raw.key).toBe(
      resolveRepositoryWorkUnit({
        workgroupId: 'wg-a',
        sessionId: 'source',
        platformId: 'slack:C-source',
        messagingGroupId: 'mg-source',
        threadId: '171234.567',
      }).key,
    );

    const storedQualified = [row('source-qualified', 'slack:C-source', 'slack:C-source:171234.567', 'mg-source')];
    expect(resolveTransferSourceWorkUnit('wg-a', '171234.567', storedQualified).key).toBe(
      resolveRepositoryWorkUnit({
        workgroupId: 'wg-a',
        sessionId: 'source-qualified',
        platformId: 'slack:C-source',
        messagingGroupId: 'mg-source',
        threadId: 'slack:C-source:171234.567',
      }).key,
    );
  });

  it('rejects unknown and cross-conversation ambiguous raw thread ids', () => {
    const rows = [row('one', 'slack:C-one', '171234.567', 'mg-one'), row('two', 'slack:C-two', '171234.567', 'mg-two')];
    expect(() => resolveTransferSourceWorkUnit('wg-a', 'missing', rows)).toThrow(/unknown/);
    expect(() => resolveTransferSourceWorkUnit('wg-a', '171234.567', rows)).toThrow(/ambiguous/);
    expect(resolveTransferSourceWorkUnit('wg-a', 'slack:C-two:171234.567', rows).key).toBe(
      resolveRepositoryWorkUnit({
        workgroupId: 'wg-a',
        sessionId: 'two',
        platformId: 'slack:C-two',
        messagingGroupId: 'mg-two',
        threadId: '171234.567',
      }).key,
    );
  });
});
