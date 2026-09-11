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
  withExistingMailboxSession: vi.fn(),
  requestWake: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: hostActionDataDir };
});

vi.mock('../../container-restart.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-restart.js')>()),
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
    // Action responses and the job runner's delivery acks land in `fakeMailbox`.
    withExistingMailboxSession: hostActionMocks.withExistingMailboxSession,
  };
});

// Clone mode's precondition (plan §5.2). These fixtures stand in for a host
// whose containers run as the host uid, whatever uid runs the suite.
vi.mock('../../github-token-file.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../github-token-file.js')>()),
  containerRunsAsHostUser: () => true,
}));

vi.mock('../../request-wake.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../request-wake.js')>()),
  requestWake: hostActionMocks.requestWake,
}));

// The quiescence probe reads the source sessions' outbound state through the
// mailbox module's read-only seam (PR 6). Mocked at the seam rather than at a
// raw opener: these fixtures have no outbound.db on disk. Non-terminal source
// sessions treat that as ACTIVE (fail-closed); closed and non-running sources
// are terminal and do not require a mailbox to prove quiescence.
vi.mock('../mailbox/read-only.js', async () => {
  const actual = await vi.importActual<typeof import('../mailbox/read-only.js')>('../mailbox/read-only.js');
  return { ...actual, readSessionOutbound: hostActionMocks.readSessionOutbound };
});

import {
  canonicalRepoDir,
  checkoutDirName,
  checkoutStagingRoot,
  defaultTopicBranch,
  isWorkgroupRepositoryMountClaimed,
  listTopicCheckouts,
  readTransferTombstone,
  resolveRepositoryWorkUnit,
  topicWorktreesDir,
  withRepositoryLifecycleClaims,
  withWorkgroupRepositoryMountClaim,
  writeOriginPin,
  writeTransferTombstone,
  type RepositoryWorkUnit,
} from '../../repository-workspaces.js';
import { REPOSITORY_MOUNT_QUIESCENCE_TIMEOUT_MS } from '../../config.js';
import {
  DEPENDENCY_CACHE_DIRNAME,
  dependencyKey,
  envFingerprint,
  processPackageDir,
  startDependencyCachePass,
} from '../../dependency-cache.js';
import { log } from '../../log.js';
import { sessionDir } from '../../session-manager.js';
import { closeDb, initTestDb, getRawDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import type { Session } from '../../types.js';
import {
  _setRepositoryCheckoutHooksForTesting,
  applyRepositoryCheckoutAction,
  applyRepositoryPublishAction,
  applyRepositoryRefreshAction,
  applyRepositoryTransferAction,
  checkoutRepository,
  dispatchRepositoryCheckout,
  publishStagedCanonical,
  refreshCanonicalFromLocalRefs,
  repositoryCheckoutLane,
  resolveTopicCloneCheckout,
  resolveTransferSourceWorkUnit,
  transferRepositoryWorktree,
  type CheckoutFarmPolicy,
} from './index.js';
import {
  _repositoryActionChainForTesting,
  _resetRepositoryActionsForTesting,
  runRepositoryActionDetached,
} from './job-runner.js';

/** In-memory inbound for action responses, and the delivery acks the job runner writes. */
const mailboxInbound = new Map<string, { id: string; content: string }>();
const mailboxAcks: Array<{ kind: 'delivered' | 'failed'; id: string }> = [];

function fakeMailbox() {
  return {
    inboundHasMessage: (id: string) => mailboxInbound.has(id),
    insertMessage: async (message: { id: string; content: string }) => {
      mailboxInbound.set(message.id, message);
    },
    markDelivered: (id: string) => {
      mailboxAcks.push({ kind: 'delivered', id });
    },
    markDeliveryFailed: (id: string) => {
      mailboxAcks.push({ kind: 'failed', id });
    },
  };
}

function responseFor(requestId: string): Record<string, unknown> {
  const row = mailboxInbound.get(`repository-action-response-${requestId}`);
  if (!row) throw new Error(`no repository action response for ${requestId}`);
  return JSON.parse(row.content) as Record<string, unknown>;
}

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
  hostActionMocks.withExistingMailboxSession.mockReset();
  hostActionMocks.withExistingMailboxSession.mockImplementation(
    async (_agentGroupId: string, _sessionId: string, action: (mailbox: unknown) => unknown) => action(fakeMailbox()),
  );
  hostActionMocks.requestWake.mockReset();
  mailboxInbound.clear();
  mailboxAcks.length = 0;
  _resetRepositoryActionsForTesting();
  _setRepositoryCheckoutHooksForTesting(null);
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

afterEach(async () => {
  await closeDb();
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

    let sourceQuiesced = false;
    await transferRepositoryWorktree({
      workgroupId: 'wg-a',
      repo: 'proj',
      source,
      destination,
      dataDir: root,
      beforeSourceActivityCheckWhileClaimed: () => {
        sourceQuiesced = true;
      },
      loadSourceSessions: () => [
        {
          id: 'session-active',
          running: !sourceQuiesced,
          spawning: false,
          processing: false,
          activeTool: false,
          continuation: false,
        },
      ],
    });

    expect(sourceQuiesced).toBe(true);
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

  it('rejects a stale direct reversal after the recorded destination transfers onward', async () => {
    const canonical = canonicalRepoDir('wg-a', 'proj', root);
    cloneTo(canonical);
    const a = workUnit('slack:C1:chain-a');
    const b = workUnit('slack:C1:chain-b');
    const c = workUnit('slack:C1:chain-c');
    const aPath = path.join(topicWorktreesDir(a, root), 'proj');
    const bPath = path.join(topicWorktreesDir(b, root), 'proj');
    const cPath = path.join(topicWorktreesDir(c, root), 'proj');
    fs.mkdirSync(path.dirname(aPath), { recursive: true });
    git(canonical, ['worktree', 'add', '-b', 'chained-transfer', aPath]);
    fs.writeFileSync(path.join(aPath, 'preserved.txt'), 'owned by the latest destination\n');

    await transferRepositoryWorktree({
      workgroupId: 'wg-a',
      repo: 'proj',
      source: a,
      destination: b,
      dataDir: root,
      loadSourceSessions: () => [],
    });
    await transferRepositoryWorktree({
      workgroupId: 'wg-a',
      repo: 'proj',
      source: b,
      destination: c,
      dataDir: root,
      loadSourceSessions: () => [],
    });

    await expect(
      transferRepositoryWorktree({
        workgroupId: 'wg-a',
        repo: 'proj',
        source: b,
        destination: a,
        dataDir: root,
        loadSourceSessions: () => [],
      }),
    ).rejects.toThrow(/transferred onward to a different destination/);

    expect(fs.existsSync(aPath)).toBe(false);
    expect(fs.existsSync(bPath)).toBe(false);
    expect(fs.readFileSync(path.join(cPath, 'preserved.txt'), 'utf8')).toBe('owned by the latest destination\n');
    expect(readTransferTombstone(a, 'proj', root)?.destinationWorkUnitKey).toBe(b.key);
    expect(readTransferTombstone(b, 'proj', root)?.destinationWorkUnitKey).toBe(c.key);
  });

  it('replays a moved transfer with the same barrier epoch and releases queued destination ingress exactly once', async () => {
    await initTestDb();
    const db = getRawDb();
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
    const destinationEpoch = `repository-transfer:${requestId}`;
    const sourceEpoch = `repository-transfer-source:${requestId}`;
    const durableBarriers = new Set<string>();
    let releaseFailuresRemaining = 2;
    const observedEpochs: string[] = [];
    const delivered = new Set<string>();
    hostActionMocks.quiesceSessionsForRepositoryMounts.mockImplementation(
      async (sessions: Session[], requestedEpoch: string, timeoutMs: number) => {
        const expectedSession = requestedEpoch === sourceEpoch ? sourceSession.id : destinationSession.id;
        expect(sessions.map((candidate) => candidate.id)).toEqual([expectedSession]);
        expect([sourceEpoch, destinationEpoch]).toContain(requestedEpoch);
        expect(timeoutMs).toBe(REPOSITORY_MOUNT_QUIESCENCE_TIMEOUT_MS);
        observedEpochs.push(requestedEpoch);
        durableBarriers.add(requestedEpoch);
        return { epoch: requestedEpoch, sessions: [], barrierSessions: sessions };
      },
    );
    hostActionMocks.releaseRepositoryMountQuiescence.mockImplementation(
      (quiescence: { epoch: string; barrierSessions: Session[] }) => {
        expect([sourceEpoch, destinationEpoch]).toContain(quiescence.epoch);
        if (releaseFailuresRemaining > 0) {
          releaseFailuresRemaining -= 1;
          throw new Error('simulated crash before durable barrier release');
        }
        durableBarriers.delete(quiescence.epoch);
        return quiescence.barrierSessions;
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
    expect(durableBarriers).toEqual(new Set([sourceEpoch, destinationEpoch]));
    expect(hostActionMocks.wakeRepositoryMountSessions).not.toHaveBeenCalled();
    const sourceFailure = hostActionMocks.writeSessionMessageIfNew.mock.calls.find(
      (call) => (call[2] as { id: string }).id === `repository-transfer-source-failed-${requestId}`,
    )?.[2] as { content: string };
    const sourceFailureText = JSON.parse(sourceFailure.content).text as string;
    expect(sourceFailureText).toContain('handoff finalization');
    expect(sourceFailureText).not.toContain('remains with this topic');

    await applyRepositoryTransferAction(action, destinationSession);
    expect(observedEpochs).toEqual([sourceEpoch, destinationEpoch, sourceEpoch, destinationEpoch]);
    expect(durableBarriers.size).toBe(0);
    expect(fs.readFileSync(path.join(destinationPath, 'ongoing.txt'), 'utf8')).toBe('preserve through replay\n');
    const woken = hostActionMocks.wakeRepositoryMountSessions.mock.calls.at(-1)![0] as Session[];
    expect(woken.map((candidate) => candidate.id)).toEqual([destinationSession.id, sourceSession.id]);
  });

  it('delivers pre-quiescence failures and ignores stale mailbox residue once the source task closes', async () => {
    await initTestDb();
    const db = getRawDb();
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
    ).run('mg-destination', 'C-destination', 'destination', now);
    const sourceSession = {
      id: 'session-source-task',
      agent_group_id: 'agent-a',
      messaging_group_id: null,
      thread_id: 'system:tasks:resume-source-task',
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
      container_status: 'running',
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
    hostActionMocks.readSessionOutbound.mockReturnValue(undefined);
    let rejectBeforeStoppingSource = true;
    hostActionMocks.quiesceSessionsForRepositoryMounts.mockImplementation(
      async (sessions: Session[], epoch: string) => {
        if (rejectBeforeStoppingSource) {
          rejectBeforeStoppingSource = false;
          throw new Error('existing different ingress-fence epoch');
        }
        return { epoch, sessions: [], barrierSessions: sessions };
      },
    );
    hostActionMocks.releaseRepositoryMountQuiescence.mockReturnValue([destinationSession]);
    hostActionMocks.writeSessionMessageIfNew.mockResolvedValue(true);
    hostActionMocks.wakeRepositoryMountSessions.mockImplementation(() => undefined);

    const canonical = canonicalRepoDir('wg-a', 'proj', hostActionDataDir);
    cloneTo(canonical);
    const source = resolveRepositoryWorkUnit({
      workgroupId: 'wg-a',
      sessionId: sourceSession.id,
      platformId: null,
      messagingGroupId: null,
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
    git(canonical, ['worktree', 'add', '-b', 'closed-task-transfer', sourcePath]);
    fs.writeFileSync(path.join(sourcePath, 'ongoing.txt'), 'preserved from closed task\n');

    const preQuiescenceRequestId = 'repo-1723600000000-0000111122223333';
    await expect(
      applyRepositoryTransferAction(
        {
          requestId: preQuiescenceRequestId,
          repo: 'proj',
          sourceThreadId: sourceSession.thread_id,
          destinationWorkUnitKey: destination.key,
        },
        destinationSession,
      ),
    ).rejects.toThrow(/existing different ingress-fence epoch/);
    const immediateSourceNotice = hostActionMocks.writeSessionMessageIfNew.mock.calls.find(
      (call) => (call[2] as { id: string }).id === `repository-transfer-source-failed-${preQuiescenceRequestId}`,
    )?.[2] as { onWake: number };
    expect(immediateSourceNotice.onWake).toBe(0);
    hostActionMocks.writeSessionMessageIfNew.mockClear();
    hostActionMocks.wakeRepositoryMountSessions.mockClear();

    await expect(
      applyRepositoryTransferAction(
        {
          requestId: 'repo-1723600000000-1111222233334444',
          repo: 'proj',
          sourceThreadId: sourceSession.thread_id,
          destinationWorkUnitKey: destination.key,
        },
        destinationSession,
      ),
    ).rejects.toThrow(/source topic is active/);
    expect(hostActionMocks.readSessionOutbound).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(destinationPath)).toBe(false);
    const sourceNotice = hostActionMocks.writeSessionMessageIfNew.mock.calls.find(
      (call) =>
        (call[2] as { id: string }).id === 'repository-transfer-source-failed-repo-1723600000000-1111222233334444',
    )?.[2] as { content: string };
    expect(JSON.parse(sourceNotice.content).text).toContain('no host action is needed');

    db.prepare("UPDATE sessions SET status = 'closed' WHERE id = ?").run(sourceSession.id);
    hostActionMocks.readSessionOutbound.mockClear();
    hostActionMocks.readSessionOutbound.mockImplementation(
      (_location: unknown, action: (mailbox: unknown) => unknown) =>
        action({
          getProcessingClaimRows: () => [],
          getContainerState: () => null,
          hasWorkContinuation: () => true,
        }),
    );
    await applyRepositoryTransferAction(
      {
        requestId: 'repo-1723600000000-5555666677778888',
        repo: 'proj',
        sourceThreadId: sourceSession.thread_id,
        destinationWorkUnitKey: destination.key,
      },
      destinationSession,
    );

    expect(hostActionMocks.readSessionOutbound).not.toHaveBeenCalled();
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.readFileSync(path.join(destinationPath, 'ongoing.txt'), 'utf8')).toBe('preserved from closed task\n');
  });

  it('writes and wakes a durable failure when source resolution rejects before any Git mutation', async () => {
    await initTestDb();
    const db = getRawDb();
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
    ).run('mg-destination', 'C-destination', 'destination', now);
    const destinationSession = {
      id: 'session-destination',
      agent_group_id: 'agent-a',
      messaging_group_id: 'mg-destination',
      thread_id: '222.222',
      agent_provider: 'claude',
      status: 'active',
      container_status: 'running',
      last_active: null,
      created_at: now,
    } satisfies Session;
    db.prepare(
      `INSERT INTO sessions
         (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
       VALUES (@id, @agent_group_id, @messaging_group_id, @thread_id, @agent_provider, @status, @container_status, @last_active, @created_at)`,
    ).run(destinationSession);

    hostActionMocks.getAgentGroup.mockReturnValue({ id: 'agent-a', folder: 'agent-a', workgroup_id: 'wg-a' });
    hostActionMocks.getAllAgentGroups.mockReturnValue([{ id: 'agent-a', folder: 'agent-a', workgroup_id: 'wg-a' }]);
    hostActionMocks.getSessionsByAgentGroup.mockReturnValue([destinationSession]);
    hostActionMocks.writeSessionMessageIfNew.mockResolvedValue(true);
    hostActionMocks.wakeRepositoryMountSessions.mockImplementation(() => undefined);

    const destination = resolveRepositoryWorkUnit({
      workgroupId: 'wg-a',
      sessionId: destinationSession.id,
      platformId: 'C-destination',
      messagingGroupId: destinationSession.messaging_group_id,
      threadId: destinationSession.thread_id,
    });
    const requestId = 'repo-1723600000000-0011223344556677';
    await expect(
      applyRepositoryTransferAction(
        {
          requestId,
          repo: 'proj',
          sourceThreadId: 'thread-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          destinationWorkUnitKey: destination.key,
        },
        destinationSession,
      ),
    ).rejects.toThrow(/source thread is unknown/);

    expect(hostActionMocks.quiesceSessionsForRepositoryMounts).not.toHaveBeenCalled();
    expect(hostActionMocks.writeSessionMessageIfNew).toHaveBeenCalledTimes(1);
    const failure = hostActionMocks.writeSessionMessageIfNew.mock.calls[0]![2];
    expect(failure.id).toBe(`repository-transfer-failed-${requestId}`);
    expect(JSON.parse(failure.content).text).toContain('source thread is unknown');
    expect(hostActionMocks.wakeRepositoryMountSessions).toHaveBeenCalledWith([destinationSession]);
  });
});

describe('transfer source thread resolution', () => {
  const row = (id: string, platformId: string | null, threadId: string | null, messagingGroupId: string | null) => ({
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

  it('resolves a scheduled-task source from its stored system task thread id', () => {
    const threadId = 'system:tasks:push-xzo-pr-1355-5bb7';
    const source = resolveTransferSourceWorkUnit('wg-a', threadId, [row('scheduled-task', null, threadId, null)]);

    expect(source).toEqual(
      resolveRepositoryWorkUnit({
        workgroupId: 'wg-a',
        sessionId: 'scheduled-task',
        platformId: null,
        messagingGroupId: null,
        threadId,
      }),
    );
  });

  it('resolves a normal thread source from its managed topic locator', () => {
    const sourceRow = row('source', 'slack:C-source', '171234.567', 'mg-source');
    const expected = resolveRepositoryWorkUnit({
      workgroupId: 'wg-a',
      sessionId: sourceRow.id,
      platformId: sourceRow.platform_id,
      messagingGroupId: sourceRow.messaging_group_id,
      threadId: sourceRow.thread_id,
    });

    expect(resolveTransferSourceWorkUnit('wg-a', `${expected.kind}-${expected.id}`, [sourceRow])).toEqual(expected);
  });

  it('gives an exact managed locator precedence over a colliding external thread id', () => {
    const managedRow = row('managed', 'slack:C-managed', '171234.567', 'mg-managed');
    const expected = resolveRepositoryWorkUnit({
      workgroupId: 'wg-a',
      sessionId: managedRow.id,
      platformId: managedRow.platform_id,
      messagingGroupId: managedRow.messaging_group_id,
      threadId: managedRow.thread_id,
    });
    const locator = `${expected.kind}-${expected.id}`;
    const collidingExternalRow = row('external', 'slack:C-external', locator, 'mg-external');

    expect(resolveTransferSourceWorkUnit('wg-a', locator, [managedRow, collidingExternalRow])).toEqual(expected);
  });

  it('retains a locator-shaped external thread id when no managed locator matches it', () => {
    const externalId = `thread-${'a'.repeat(32)}`;
    const externalRow = row('external', 'slack:C-external', externalId, 'mg-external');
    const expected = resolveRepositoryWorkUnit({
      workgroupId: 'wg-a',
      sessionId: externalRow.id,
      platformId: externalRow.platform_id,
      messagingGroupId: externalRow.messaging_group_id,
      threadId: externalRow.thread_id,
    });

    expect(resolveTransferSourceWorkUnit('wg-a', externalId, [externalRow])).toEqual(expected);
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

// Real git work per case, run under `ionice -c3 nice` on the host: allow it time.
describe('repository_checkout host action (plan §5.2, Phase 2)', { timeout: 60_000 }, () => {
  const WG = 'wg-co';
  const FP = envFingerprint('22.23.2', process.arch);
  const OFF: CheckoutFarmPolicy = { mode: 'off' };
  let requestSeq = 0;
  const nextRequestId = (): string => `repo-1789000000000-${(++requestSeq).toString(16).padStart(16, '0')}`;
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function taskSession(id: string, anchor: string): Session {
    return {
      id,
      agent_group_id: 'agent-co',
      messaging_group_id: null,
      thread_id: `system:tasks:${anchor}`,
      agent_provider: 'claude',
      status: 'active',
      container_status: 'running',
      last_active: null,
      created_at: new Date().toISOString(),
    } satisfies Session;
  }

  function unitOf(session: Session): RepositoryWorkUnit {
    return resolveRepositoryWorkUnit({
      workgroupId: WG,
      sessionId: session.id,
      platformId: null,
      messagingGroupId: null,
      threadId: session.thread_id,
    });
  }

  function threadUnit(anchor: string): RepositoryWorkUnit {
    return unitOf(taskSession(`session-${anchor}`, anchor));
  }

  function mockAgentGroup(): void {
    hostActionMocks.getAgentGroup.mockReturnValue({ id: 'agent-co', folder: 'agent-co', workgroup_id: WG });
  }

  function tryGitOut(cwd: string, args: string[]): string | null {
    try {
      return git(cwd, args);
    } catch {
      return null;
    }
  }

  /** A workgroup canonical with a network pin, kept detached as the host keeps it (index.ts:302,338). */
  function networkCanonical(dataDir: string, repo = 'proj'): string {
    const canonical = canonicalRepoDir(WG, repo, dataDir);
    cloneTo(canonical);
    git(canonical, ['checkout', '-q', '--detach', 'HEAD']);
    writeOriginPin(WG, repo, { origin: remote, repositoryId: remote }, dataDir);
    return canonical;
  }

  /** A canonical that never had a remote, preserved under a local-only pin. */
  function localOnlyCanonical(dataDir: string, repo: string): string {
    const canonical = canonicalRepoDir(WG, repo, dataDir);
    fs.mkdirSync(canonical, { recursive: true });
    git(canonical, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(canonical, 'solo.txt'), 'solo\n');
    git(canonical, ['add', '-A']);
    git(canonical, ['commit', '-q', '-m', 'solo base']);
    git(canonical, ['checkout', '-q', '--detach', 'HEAD']);
    writeOriginPin(WG, repo, { kind: 'local-only', origin: null, repositoryId: `local-only:${repo}` }, dataDir);
    return canonical;
  }

  /** Committed-but-unpushed work on `refs/heads/<branch>`, made without touching the checkout. */
  function unpushedBranch(repoPath: string, branch: string, message: string): string {
    const tree = git(repoPath, ['rev-parse', 'HEAD^{tree}']);
    const commit = git(repoPath, ['commit-tree', tree, '-p', 'HEAD', '-m', message]);
    git(repoPath, ['update-ref', `refs/heads/${branch}`, commit]);
    return commit;
  }

  /** Push a commit on `branch` to the remote, then fetch it into `canonical` as a container would. */
  function pushToRemote(canonical: string, branch: string, files: Record<string, string | Buffer>): string {
    const scratch = fs.mkdtempSync(path.join(root, 'push-'));
    execFileSync('git', ['clone', '-q', remote, scratch]);
    const onRemote = git(scratch, ['branch', '-r', '--list', `origin/${branch}`]) !== '';
    git(scratch, ['checkout', '-q', '-B', branch, onRemote ? `origin/${branch}` : 'origin/main']);
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(scratch, rel)), { recursive: true });
      fs.writeFileSync(path.join(scratch, rel), body);
    }
    git(scratch, ['add', '-A']);
    git(scratch, ['commit', '-q', '-m', `${branch}: ${Object.keys(files).join(', ')}`]);
    git(scratch, ['push', '-q', 'origin', branch]);
    git(canonical, ['fetch', '-q', 'origin']);
    return git(scratch, ['rev-parse', 'HEAD']);
  }

  /** An npm project; with `tree`, installed the way `npm ci` leaves it (hidden lockfile written last). */
  function writeNpmProject(dir: string, options: { tree: boolean }): void {
    fs.mkdirSync(dir, { recursive: true });
    const dependencies = { 'left-pad': '^1.3.0' };
    const locked = {
      version: '1.3.0',
      resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
      integrity: 'sha512-leftpad',
    };
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      `${JSON.stringify({ name: 'app', version: '1.0.0', dependencies }, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(dir, 'package-lock.json'),
      `${JSON.stringify(
        {
          name: 'app',
          version: '1.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: { '': { name: 'app', version: '1.0.0', dependencies }, 'node_modules/left-pad': locked },
        },
        null,
        2,
      )}\n`,
    );
    if (!options.tree) return;
    const nm = path.join(dir, 'node_modules');
    fs.mkdirSync(path.join(nm, 'left-pad'), { recursive: true });
    fs.writeFileSync(path.join(nm, 'left-pad', 'package.json'), JSON.stringify({ name: 'left-pad', version: '1.3.0' }));
    fs.writeFileSync(path.join(nm, 'left-pad', 'index.js'), 'module.exports = (s) => s;\n');
    const hourAgo = (Date.now() - 60 * 60 * 1000) / 1000;
    for (const rel of ['left-pad/package.json', 'left-pad/index.js'])
      fs.utimesSync(path.join(nm, rel), hourAgo, hourAgo);
    fs.writeFileSync(
      path.join(nm, '.package-lock.json'),
      JSON.stringify({
        name: 'app',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: { 'node_modules/left-pad': locked },
      }),
    );
    fs.utimesSync(path.join(nm, '.package-lock.json'), hourAgo + 30, hourAgo + 30);
  }

  function checkout(
    unit: RepositoryWorkUnit,
    branch: string | null,
    dataDir: string,
    repo = 'proj',
    farms: CheckoutFarmPolicy = OFF,
  ) {
    return checkoutRepository({
      workgroupId: WG,
      workUnit: unit,
      repo,
      branch,
      requestId: nextRequestId(),
      dataDir,
      farms,
    });
  }

  function metadataOf(checkoutPath: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(checkoutPath, '.git', 'nanoclaw-checkout.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  }

  const remoteRefs = (repoPath: string): string =>
    git(repoPath, ['for-each-ref', '--format=%(refname) %(objectname) %(symref)', 'refs/remotes/origin']);

  it('repository_checkout publishes a fully initialized self-contained clone', async () => {
    const canonical = networkCanonical(root);
    // A canonical local branch: `git clone` would map it into origin/*.
    git(canonical, ['branch', 'canonical-only']);
    git(canonical, ['repack', '-a', '-d', '-q']);
    const unit = threadUnit('p2-2');
    const requestId = nextRequestId();

    const result = await checkoutRepository({
      workgroupId: WG,
      workUnit: unit,
      repo: 'proj',
      branch: 'feat-p22',
      requestId,
      dataDir: root,
      farms: OFF,
    });

    const topicRoot = topicWorktreesDir(unit, root);
    const clone = path.join(topicRoot, 'proj');
    expect(result).toMatchObject({
      dirName: 'proj',
      branch: 'feat-p22',
      created: true,
      shape: 'clone',
      startedFrom: 'origin-head',
      objectsLinked: true,
      farmsLinked: 0,
    });
    expect(fs.lstatSync(path.join(clone, '.git')).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(clone, '.git', 'objects', 'info', 'alternates'))).toBe(false);
    const packs = fs.readdirSync(path.join(clone, '.git', 'objects', 'pack')).filter((name) => name.endsWith('.pack'));
    expect(packs.length).toBeGreaterThan(0);
    expect(fs.statSync(path.join(clone, '.git', 'objects', 'pack', packs[0]!)).nlink).toBeGreaterThanOrEqual(2);
    expect(remoteRefs(clone)).toBe(remoteRefs(canonical));
    expect(remoteRefs(clone)).not.toContain('canonical-only');
    expect(git(clone, ['for-each-ref', '--format=%(refname)', 'refs/heads'])).toBe('refs/heads/feat-p22');
    expect(git(clone, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/feat-p22');
    expect(fs.readFileSync(path.join(clone, 'tracked.txt'), 'utf8')).toBe('base\n');
    expect(git(clone, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('');
    const head = git(clone, ['rev-parse', 'HEAD']);
    expect(head).toBe(git(canonical, ['rev-parse', 'refs/remotes/origin/HEAD']));
    expect(metadataOf(clone)).toEqual({
      version: 1,
      repo: 'proj',
      branch: 'feat-p22',
      startCommit: head,
      startedFrom: 'origin-head',
    });
    expect(git(clone, ['config', '--get', 'remote.origin.url'])).toBe(fs.realpathSync(remote));
    expect(git(clone, ['config', '--get', 'gc.auto'])).toBe('0');
    expect(listTopicCheckouts(topicRoot).map(({ name, shape }) => ({ name, shape }))).toEqual([
      { name: 'proj', shape: 'clone' },
    ]);
    expect(fs.existsSync(path.join(checkoutStagingRoot(topicRoot), requestId))).toBe(false);
  });

  it('a second branch in the same thread gets <repo>@<slug> and the primary is untouched', async () => {
    networkCanonical(root);
    const unit = threadUnit('p2-3');
    const topicRoot = topicWorktreesDir(unit, root);
    const primary = await checkout(unit, null, root);
    expect(primary).toMatchObject({ dirName: 'proj', branch: defaultTopicBranch(unit, 'proj'), created: true });
    const primaryPath = path.join(topicRoot, 'proj');
    fs.writeFileSync(path.join(primaryPath, 'staged.txt'), 'staged\n');
    git(primaryPath, ['add', 'staged.txt']);
    fs.writeFileSync(path.join(primaryPath, 'tracked.txt'), 'unstaged edit\n');
    fs.writeFileSync(path.join(primaryPath, 'untracked.txt'), 'untracked\n');
    const snapshot = () => ({
      head: git(primaryPath, ['rev-parse', 'HEAD']),
      branch: git(primaryPath, ['symbolic-ref', 'HEAD']),
      status: git(primaryPath, ['status', '--porcelain=v2', '--untracked-files=all']),
      index: git(primaryPath, ['ls-files', '--stage']),
      tracked: fs.readFileSync(path.join(primaryPath, 'tracked.txt'), 'utf8'),
      staged: fs.readFileSync(path.join(primaryPath, 'staged.txt'), 'utf8'),
      untracked: fs.readFileSync(path.join(primaryPath, 'untracked.txt'), 'utf8'),
      metadata: fs.readFileSync(path.join(primaryPath, '.git', 'nanoclaw-checkout.json'), 'utf8'),
    });
    const before = snapshot();

    const second = await checkout(unit, 'feat/second', root);

    expect(second).toMatchObject({
      dirName: checkoutDirName('proj', 'feat/second'),
      branch: 'feat/second',
      created: true,
    });
    expect(second.dirName).toMatch(/^proj@feat-second-[0-9a-f]{8}$/);
    expect(git(path.join(topicRoot, second.dirName), ['symbolic-ref', 'HEAD'])).toBe('refs/heads/feat/second');
    expect(snapshot()).toEqual(before);
    // No branch, or the primary's own branch, keeps serving the primary.
    await expect(checkout(unit, null, root)).resolves.toMatchObject({ dirName: 'proj', created: false });
    await expect(checkout(unit, defaultTopicBranch(unit, 'proj'), root)).resolves.toMatchObject({
      dirName: 'proj',
      created: false,
    });
    await expect(checkout(unit, 'feat/second', root)).resolves.toMatchObject({
      dirName: second.dirName,
      created: false,
    });
    expect(snapshot()).toEqual(before);
    expect(listTopicCheckouts(topicRoot).map((entry) => entry.name)).toEqual(['proj', second.dirName]);
  });

  it('two threads check out the same branch concurrently', async () => {
    networkCanonical(hostActionDataDir);
    mockAgentGroup();
    const sessions = [taskSession('session-p24-a', 'p2-4-a'), taskSession('session-p24-b', 'p2-4-b')];
    // Each job waits inside staging until the other has reached staging too, so
    // both are provably in flight at once rather than one after the other.
    const reached = new Set<string>();
    let bothReached!: () => void;
    const barrier = new Promise<void>((resolve) => {
      bothReached = resolve;
    });
    _setRepositoryCheckoutHooksForTesting({
      afterStagingPopulated: async (stagingCheckout) => {
        reached.add(stagingCheckout);
        if (reached.size === 2) bothReached();
        await withTimeout(barrier, 30_000, 'the other thread never reached staging');
      },
    });
    const requests = sessions.map((session) => ({ session, requestId: nextRequestId() }));

    for (const { session, requestId } of requests) {
      await expect(
        dispatchRepositoryCheckout(
          {
            action: 'repository_checkout',
            requestId,
            repo: 'proj',
            branch: 'shared-b',
            workUnitKey: unitOf(session).key,
          },
          session,
        ),
      ).resolves.toEqual({ deferAck: true });
    }
    await Promise.all(
      requests.map(({ session }) => _repositoryActionChainForTesting(repositoryCheckoutLane(WG, unitOf(session)))),
    );

    expect(reached.size).toBe(2);
    for (const { session, requestId } of requests) {
      expect(responseFor(requestId)).toMatchObject({
        type: 'repository_action_response',
        requestId,
        ok: true,
        dirName: 'proj',
        branch: 'shared-b',
        created: true,
        startedFrom: 'origin-head',
      });
      const clone = path.join(topicWorktreesDir(unitOf(session), hostActionDataDir), 'proj');
      expect(git(clone, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/shared-b');
    }
    expect(hostActionMocks.quiesceSessionsForRepositoryMounts).not.toHaveBeenCalled();
    expect(mailboxAcks).toEqual(
      expect.arrayContaining(requests.map(({ requestId }) => ({ kind: 'delivered', id: requestId }))),
    );
  });

  it('same-thread siblings get one path, including while the first checkout is still initializing', async () => {
    networkCanonical(hostActionDataDir);
    mockAgentGroup();
    const first = taskSession('session-p25-a', 'p2-5');
    const sibling = taskSession('session-p25-b', 'p2-5');
    const unit = unitOf(first);
    expect(unitOf(sibling).key).toBe(unit.key);
    const topicRoot = topicWorktreesDir(unit, hostActionDataDir);
    let pausedAt: string | null = null;
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    _setRepositoryCheckoutHooksForTesting({
      afterStagingPopulated: async (stagingCheckout) => {
        pausedAt = stagingCheckout;
        await resumed;
      },
    });
    const firstId = nextRequestId();
    const siblingId = nextRequestId();
    const request = (requestId: string) => ({
      action: 'repository_checkout',
      requestId,
      repo: 'proj',
      branch: 'feat-shared',
      workUnitKey: unit.key,
    });

    await dispatchRepositoryCheckout(request(firstId), first);
    await vi.waitFor(() => expect(pausedAt).not.toBeNull(), { timeout: 30_000 });
    await dispatchRepositoryCheckout(request(siblingId), sibling);
    await tick();
    await tick();

    // The sibling waits on the lane; the first checkout is not yet published.
    expect(mailboxInbound.has(`repository-action-response-${siblingId}`)).toBe(false);
    expect(listTopicCheckouts(topicRoot)).toEqual([]);
    expect(pausedAt!.startsWith(path.join(checkoutStagingRoot(topicRoot), firstId))).toBe(true);

    resume();
    await _repositoryActionChainForTesting(repositoryCheckoutLane(WG, unit));

    expect(responseFor(firstId)).toMatchObject({ ok: true, created: true, dirName: 'proj', branch: 'feat-shared' });
    expect(responseFor(siblingId)).toMatchObject({ ok: true, created: false, dirName: 'proj', branch: 'feat-shared' });
    expect(listTopicCheckouts(topicRoot).map((entry) => entry.name)).toEqual(['proj']);
    const clone = path.join(topicRoot, 'proj');
    expect(git(clone, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/feat-shared');
    expect(fs.readFileSync(path.join(clone, 'tracked.txt'), 'utf8')).toBe('base\n');
    expect(git(clone, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('');
  });

  it('start point prefers canonical refs/heads/B, then origin/B, then origin/HEAD, and the post-fetch step only moves pristine checkouts', async () => {
    // Host half of P2-6: the start point and its note. The post-fetch step
    // runs in the container (git-worktrees.test.ts).
    const canonical = networkCanonical(root);
    const remoteOnly = pushToRemote(canonical, 'feat-remote', { 'remote.txt': 'remote\n' });
    pushToRemote(canonical, 'dual', { 'dual.txt': 'remote\n' });
    const legacy = unpushedBranch(canonical, 'legacy-local', 'committed, never pushed');
    const dualLocal = unpushedBranch(canonical, 'dual', 'local work on a branch the remote also has');
    const originHead = git(canonical, ['rev-parse', 'refs/remotes/origin/HEAD']);
    const unit = threadUnit('p2-6');
    const topicRoot = topicWorktreesDir(unit, root);
    const cases = [
      { branch: 'legacy-local', startedFrom: 'canonical-local', head: legacy, upstream: null },
      { branch: 'dual', startedFrom: 'canonical-local', head: dualLocal, upstream: null },
      { branch: 'feat-remote', startedFrom: 'origin-branch', head: remoteOnly, upstream: 'origin/feat-remote' },
      { branch: 'brand-new', startedFrom: 'origin-head', head: originHead, upstream: null },
    ];

    for (const expected of cases) {
      const result = await checkout(unit, expected.branch, root);
      expect(result, expected.branch).toMatchObject({
        created: true,
        branch: expected.branch,
        startedFrom: expected.startedFrom,
      });
      const clone = path.join(topicRoot, result.dirName);
      expect(git(clone, ['rev-parse', 'HEAD']), expected.branch).toBe(expected.head);
      expect(metadataOf(clone), expected.branch).toMatchObject({
        branch: expected.branch,
        startCommit: expected.head,
        startedFrom: expected.startedFrom,
      });
      expect(tryGitOut(clone, ['rev-parse', '--abbrev-ref', `${expected.branch}@{upstream}`]), expected.branch).toBe(
        expected.upstream,
      );
    }
    // The canonical keeps its own refs exactly.
    expect(git(canonical, ['rev-parse', 'refs/heads/legacy-local'])).toBe(legacy);
    expect(git(canonical, ['rev-parse', 'refs/heads/dual'])).toBe(dualLocal);
  });

  it("refresh absorbs a clone's origin refs fast-forward only", async () => {
    const dataDir = hostActionDataDir;
    const canonical = networkCanonical(dataDir);
    const originRef = (): string => git(canonical, ['rev-parse', 'refs/remotes/origin/feat-9']);
    const v1 = pushToRemote(canonical, 'feat-9', { 'nine.txt': 'v1\n' });
    const sessionA = taskSession('session-p2-9-a', 'p2-9-a');
    const unitA = unitOf(sessionA);
    const unitB = threadUnit('p2-9-b');
    const a = await checkout(unitA, 'feat-9', dataDir);
    const b = await checkout(unitB, 'feat-9', dataDir);
    expect([a.startedFrom, b.startedFrom]).toEqual(['origin-branch', 'origin-branch']);
    const aPath = path.join(topicWorktreesDir(unitA, dataDir), a.dirName);

    fs.writeFileSync(path.join(aPath, 'nine.txt'), 'v2\n');
    git(aPath, ['commit', '-q', '-am', 'v2']);
    git(aPath, ['push', '-q', 'origin', 'feat-9']);
    const v2 = git(aPath, ['rev-parse', 'HEAD']);
    expect(git(aPath, ['rev-parse', 'refs/remotes/origin/feat-9'])).toBe(v2);
    expect(originRef()).toBe(v1);

    await refreshCanonicalFromLocalRefs({
      workgroupId: WG,
      repo: 'proj',
      dataDir,
      absorbFrom: resolveTopicCloneCheckout(unitA, 'proj', a.dirName, dataDir),
    });
    expect(originRef()).toBe(v2);

    // A clone whose origin/feat-9 is stale cannot rewind the canonical.
    const warn = vi.spyOn(log, 'warn');
    await refreshCanonicalFromLocalRefs({
      workgroupId: WG,
      repo: 'proj',
      dataDir,
      absorbFrom: resolveTopicCloneCheckout(unitB, 'proj', b.dirName, dataDir),
    });
    expect(originRef()).toBe(v2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/fast-forward/),
      expect.objectContaining({ rejected: [expect.stringContaining('feat-9')] }),
    );
    warn.mockRestore();

    // Only a clone in the caller's own topic can be named.
    const onlyB = await checkout(unitB, 'only-b', dataDir);
    const topicA = topicWorktreesDir(unitA, dataDir);
    fs.symlinkSync(path.join(topicWorktreesDir(unitB, dataDir), onlyB.dirName), path.join(topicA, 'proj@via-link'));
    git(canonical, ['worktree', 'add', '-q', '--detach', path.join(topicA, 'proj@linked'), 'HEAD']);
    for (const name of [
      onlyB.dirName,
      'proj@via-link',
      'proj@linked',
      '../proj',
      'proj/../../proj',
      '.staging',
      'other@feat-9',
      '',
    ]) {
      expect(() => resolveTopicCloneCheckout(unitA, 'proj', name, dataDir), name).toThrow();
    }

    mockAgentGroup();
    const refused = nextRequestId();
    await expect(
      applyRepositoryRefreshAction(
        { requestId: refused, repo: 'proj', workUnitKey: unitA.key, checkout: onlyB.dirName },
        sessionA,
      ),
    ).rejects.toThrow(/this topic/);
    expect(responseFor(refused)).toMatchObject({ ok: false });
    expect(originRef()).toBe(v2);

    // Through the action, the caller's own clone is absorbed.
    fs.writeFileSync(path.join(aPath, 'nine.txt'), 'v3\n');
    git(aPath, ['commit', '-q', '-am', 'v3']);
    git(aPath, ['push', '-q', 'origin', 'feat-9']);
    const v3 = git(aPath, ['rev-parse', 'HEAD']);
    await applyRepositoryRefreshAction(
      { requestId: nextRequestId(), repo: 'proj', workUnitKey: unitA.key, checkout: a.dirName },
      sessionA,
    );
    expect(originRef()).toBe(v3);
  });

  it('repository_checkout links node_modules farms for package dirs with a verified entry', async () => {
    const canonical = networkCanonical(root);
    const donor = path.join(root, 'donor', 'app');
    writeNpmProject(donor, { tree: true });
    pushToRemote(canonical, 'main', {
      'app/package.json': fs.readFileSync(path.join(donor, 'package.json')),
      'app/package-lock.json': fs.readFileSync(path.join(donor, 'package-lock.json')),
    });
    const cacheRoot = path.join(root, DEPENDENCY_CACHE_DIRNAME);
    const pass = startDependencyCachePass({
      mode: 'apply',
      cacheRoot,
      now: Date.now(),
      reclaimableBytes: () => 0,
      fingerprint: () => FP,
    });
    expect(processPackageDir(pass, WG, donor)).toBe('adopted');
    const entryNm = path.join(cacheRoot, WG, dependencyKey(donor, FP)!.key, 'node_modules');
    const farms: CheckoutFarmPolicy = { mode: 'apply', fingerprint: () => FP };
    const unit = threadUnit('p2-14');
    const clone = path.join(topicWorktreesDir(unit, root), 'proj');
    const sharesEntry = (): boolean => {
      const mine = fs.statSync(path.join(clone, 'app', 'node_modules', 'left-pad', 'index.js'));
      const theirs = fs.statSync(path.join(entryNm, 'left-pad', 'index.js'));
      return mine.dev === theirs.dev && mine.ino === theirs.ino;
    };

    await expect(checkout(unit, null, root, 'proj', farms)).resolves.toMatchObject({ created: true, farmsLinked: 1 });
    expect(sharesEntry()).toBe(true);
    // Every farm keeps its own hidden lockfile (npm rewrites it).
    expect(fs.statSync(path.join(clone, 'app', 'node_modules', '.package-lock.json')).ino).not.toBe(
      fs.statSync(path.join(entryNm, '.package-lock.json')).ino,
    );

    // Reuse links nothing. A published checkout is live and container-writable,
    // so the host writes no farm into it: a lost farm is reinstalled by npm and
    // later converted by the sweep.
    fs.rmSync(path.join(clone, 'app', 'node_modules'), { recursive: true, force: true });
    await expect(checkout(unit, null, root, 'proj', farms)).resolves.toMatchObject({ created: false, farmsLinked: 0 });
    expect(fs.existsSync(path.join(clone, 'app', 'node_modules'))).toBe(false);

    // With the cache flag off, a checkout shares nothing.
    const other = threadUnit('p2-14-off');
    await expect(checkout(other, null, root, 'proj', OFF)).resolves.toMatchObject({ created: true, farmsLinked: 0 });
    expect(fs.existsSync(path.join(topicWorktreesDir(other, root), 'proj', 'app', 'node_modules'))).toBe(false);
  });

  it('a crash before publication leaves no enumerated checkout and a retry creates normally', async () => {
    networkCanonical(root);
    const unit = threadUnit('p2-16');
    const topicRoot = topicWorktreesDir(unit, root);
    const stagingRoot = checkoutStagingRoot(topicRoot);
    const residue = path.join(root, 'killed-job-residue');
    const crashedId = nextRequestId();
    const request = {
      workgroupId: WG,
      workUnit: unit,
      repo: 'proj',
      branch: null,
      requestId: crashedId,
      dataDir: root,
      farms: OFF,
    };
    _setRepositoryCheckoutHooksForTesting({
      afterStagingPopulated: (stagingCheckout) => {
        // Capture exactly what a host killed at this point leaves on disk.
        fs.cpSync(path.dirname(stagingCheckout), residue, { recursive: true, verbatimSymlinks: true });
        throw new Error('simulated host kill');
      },
    });
    await expect(checkoutRepository(request)).rejects.toThrow(/simulated host kill/);
    _setRepositoryCheckoutHooksForTesting(null);
    fs.cpSync(residue, path.join(stagingRoot, crashedId), { recursive: true, verbatimSymlinks: true });
    expect(fs.existsSync(path.join(stagingRoot, crashedId, 'proj', '.git', 'nanoclaw-checkout.json'))).toBe(true);
    expect(listTopicCheckouts(topicRoot)).toEqual([]);

    // A host restart replays the undelivered row under the same request id.
    await expect(checkoutRepository(request)).resolves.toMatchObject({ dirName: 'proj', created: true });
    expect(listTopicCheckouts(topicRoot).map((entry) => entry.name)).toEqual(['proj']);
    expect(git(path.join(topicRoot, 'proj'), ['symbolic-ref', 'HEAD'])).toBe(
      `refs/heads/${defaultTopicBranch(unit, 'proj')}`,
    );
    expect(fs.existsSync(path.join(stagingRoot, crashedId))).toBe(false);

    // Other requests' residue: the next checkout on this lane removes what is
    // over an hour old and keeps what is younger.
    const staleId = nextRequestId();
    const freshId = nextRequestId();
    for (const id of [staleId, freshId]) {
      fs.cpSync(residue, path.join(stagingRoot, id), { recursive: true, verbatimSymlinks: true });
    }
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(path.join(stagingRoot, staleId), twoHoursAgo, twoHoursAgo);
    await checkout(unit, 'after-crash', root);
    expect(fs.existsSync(path.join(stagingRoot, staleId))).toBe(false);
    expect(fs.existsSync(path.join(stagingRoot, freshId))).toBe(true);
    expect(listTopicCheckouts(topicRoot).map((entry) => entry.name)).toEqual(['proj', 'proj@after-crash']);
  });

  it('stages outside the container-writable worktrees root, so a planted .staging is never followed', async () => {
    networkCanonical(root);
    const unit = threadUnit('staging-trust');
    const topicRoot = topicWorktreesDir(unit, root);
    fs.mkdirSync(topicRoot, { recursive: true });
    // An agent can write anything under worktrees/ (mounted read-write,
    // container-runner.ts:4386), including a `.staging` symlink to host data
    // whose entries are old enough to look like crash residue.
    const victim = path.join(root, 'host-data');
    fs.mkdirSync(path.join(victim, 'precious'), { recursive: true });
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(path.join(victim, 'precious'), twoHoursAgo, twoHoursAgo);
    fs.symlinkSync(victim, path.join(topicRoot, '.staging'));

    await expect(checkout(unit, null, root, 'proj', OFF)).resolves.toMatchObject({ dirName: 'proj', created: true });

    expect(fs.readdirSync(victim)).toEqual(['precious']);
    expect(path.relative(topicRoot, checkoutStagingRoot(topicRoot)).startsWith('..')).toBe(true);
  });

  it('local-only canonicals: clone has no origin, starts from preserved refs, skips fetch and refresh, refuses push/PR', async () => {
    // Host half of P2-17. The skipped fetch and the push/PR refusal are
    // container-side (git-worktrees.test.ts).
    const canonical = localOnlyCanonical(root, 'solo');
    const kept = unpushedBranch(canonical, 'keep-me', 'preserved local-only work');
    const head = git(canonical, ['rev-parse', 'HEAD^{commit}']);
    const unit = threadUnit('p2-17');
    const topicRoot = topicWorktreesDir(unit, root);

    const primary = await checkout(unit, null, root, 'solo');
    const preserved = await checkout(unit, 'keep-me', root, 'solo');
    const fresh = await checkout(unit, 'fresh-branch', root, 'solo');

    expect(primary).toMatchObject({
      dirName: 'solo',
      branch: defaultTopicBranch(unit, 'solo'),
      created: true,
      startedFrom: 'local-head',
    });
    expect(preserved).toMatchObject({ dirName: 'solo@keep-me', created: true, startedFrom: 'canonical-local' });
    expect(fresh).toMatchObject({ dirName: 'solo@fresh-branch', created: true, startedFrom: 'local-head' });
    for (const [result, expected] of [
      [primary, head],
      [preserved, kept],
      [fresh, head],
    ] as const) {
      const clone = path.join(topicRoot, result.dirName);
      expect(git(clone, ['rev-parse', 'HEAD']), result.dirName).toBe(expected);
      expect(git(clone, ['remote']), result.dirName).toBe('');
      expect(git(clone, ['for-each-ref', 'refs/remotes']), result.dirName).toBe('');
      expect(tryGitOut(clone, ['config', '--get', 'remote.origin.url']), result.dirName).toBeNull();
    }
    expect(git(canonical, ['rev-parse', 'refs/heads/keep-me'])).toBe(kept);

    await expect(checkout(unit, 'keep-me', root, 'solo')).resolves.toMatchObject({
      dirName: 'solo@keep-me',
      created: false,
    });
    await expect(checkout(unit, null, root, 'solo')).resolves.toMatchObject({ dirName: 'solo', created: false });
    await expect(
      refreshCanonicalFromLocalRefs({
        workgroupId: WG,
        repo: 'solo',
        dataDir: root,
        absorbFrom: resolveTopicCloneCheckout(unit, 'solo', 'solo@keep-me', root),
      }),
    ).rejects.toThrow(/local-only/);
    expect(git(canonical, ['for-each-ref', 'refs/remotes'])).toBe('');
  });

  it('a checkout is not delayed by an unrelated repository job', async () => {
    networkCanonical(hostActionDataDir);
    mockAgentGroup();
    const publisher = taskSession('session-p220-publisher', 'p2-20-publisher');
    const requester = taskSession('session-p220-requester', 'p2-20-requester');
    const order: string[] = [];
    let releasePublish!: () => void;
    await runRepositoryActionDetached(
      'repository_publish',
      async () => {
        order.push('publish:start');
        await new Promise<void>((resolve) => {
          releasePublish = resolve;
        });
        order.push('publish:end');
      },
      { requestId: nextRequestId() },
      publisher,
    );
    await tick();
    expect(order).toEqual(['publish:start']);

    const requestId = nextRequestId();
    await dispatchRepositoryCheckout(
      { action: 'repository_checkout', requestId, repo: 'proj', branch: null, workUnitKey: unitOf(requester).key },
      requester,
    );
    await _repositoryActionChainForTesting(repositoryCheckoutLane(WG, unitOf(requester)));
    order.push('checkout:answered');

    expect(responseFor(requestId)).toMatchObject({ ok: true, created: true, dirName: 'proj' });
    expect(order).toEqual(['publish:start', 'checkout:answered']);
    releasePublish();
    await _repositoryActionChainForTesting();
    expect(order).toEqual(['publish:start', 'checkout:answered', 'publish:end']);
  });

  it('a checkout switched off its recorded branch is refused, not reused, and nothing is mutated', async () => {
    networkCanonical(root);
    const unit = threadUnit('r3');
    const topicRoot = topicWorktreesDir(unit, root);
    await checkout(unit, null, root);
    const second = await checkout(unit, 'feat-r3', root);
    const secondPath = path.join(topicRoot, second.dirName);
    git(secondPath, ['switch', '-q', '-c', 'moved-elsewhere']);

    await expect(checkout(unit, 'feat-r3', root)).rejects.toThrow(/recorded/);
    expect(git(secondPath, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/moved-elsewhere');

    const primaryPath = path.join(topicRoot, 'proj');
    git(primaryPath, ['switch', '-q', '-c', 'primary-moved']);
    await expect(checkout(unit, null, root)).rejects.toThrow(/recorded/);
    expect(git(primaryPath, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/primary-moved');
    expect(listTopicCheckouts(topicRoot).map((entry) => entry.name)).toEqual(['proj', second.dirName]);
  });

  it("refuses a work unit that is not the session's own, and answers retryable while the lifecycle is claimed", async () => {
    networkCanonical(hostActionDataDir);
    mockAgentGroup();
    const session = taskSession('session-guard', 'guard');
    const unit = unitOf(session);
    const topicRoot = topicWorktreesDir(unit, hostActionDataDir);
    const request = (requestId: string, workUnitKey: string) => ({
      action: 'repository_checkout',
      requestId,
      repo: 'proj',
      branch: null,
      workUnitKey,
    });

    const forged = nextRequestId();
    await applyRepositoryCheckoutAction(request(forged, threadUnit('someone-else').key), session);
    expect(responseFor(forged)).toMatchObject({
      type: 'repository_action_response',
      requestId: forged,
      ok: false,
      retryable: false,
    });
    expect(listTopicCheckouts(topicRoot)).toEqual([]);

    const claimed = nextRequestId();
    await withRepositoryLifecycleClaims([unit], () =>
      applyRepositoryCheckoutAction(request(claimed, unit.key), session),
    );
    expect(responseFor(claimed)).toMatchObject({ ok: false, retryable: true });
    expect(listTopicCheckouts(topicRoot)).toEqual([]);

    const granted = nextRequestId();
    await applyRepositoryCheckoutAction(request(granted, unit.key), session);
    expect(responseFor(granted)).toMatchObject({
      ok: true,
      dirName: 'proj',
      branch: defaultTopicBranch(unit, 'proj'),
      created: true,
      startedFrom: 'origin-head',
      objectsLinked: true,
      farmsLinked: 0,
    });
  });

  it('extends the action response with structured fields for checkout only', async () => {
    mockAgentGroup();
    const session = taskSession('session-shape', 'shape');
    const requestId = nextRequestId();
    await expect(
      applyRepositoryRefreshAction({ requestId, repo: 'missing-repo', workUnitKey: unitOf(session).key }, session),
    ).rejects.toThrow();
    expect(Object.keys(responseFor(requestId))).toEqual(['type', 'requestId', 'ok', 'message']);
  });
});
