/**
 * Tests for handleCreateAgent — host-side persistence.
 *
 * S9 / D5: admin enforcement for create_agent is unenforced in current
 * trunk (see agents.ts:8 stale comment + missing user_roles check).
 * Explicitly waived for this PR per D5. When the follow-up issue closes
 * the gate, replace this with a real test suite.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi, test } from 'vitest';

// S9 / D5: admin enforcement gap — deferred to follow-up issue per design decision D5
test.todo('admin enforcement — tracked in followup issue for C2 gate (see design decision D5)');

// ── Test fixtures (S4: must include claude and codex) ────────────────────────
const FIXTURES = {
  agentWithClaude: {
    id: 'ag-parent',
    name: 'Parent Agent',
    folder: 'parent-agent',
    agent_provider: 'claude' as string | null,
    created_at: new Date().toISOString(),
  },
  agentWithCodex: {
    id: 'ag-codex',
    name: 'Codex Agent',
    folder: 'codex-agent',
    agent_provider: 'codex' as string | null,
    created_at: new Date().toISOString(),
  },
};

// ── Directory constants ──────────────────────────────────────────────────────
const { TEST_ROOT } = vi.hoisted(() => ({ TEST_ROOT: uniqueTmpRoot('test-create-agent') }));
const TEST_GROUPS_DIR = `${TEST_ROOT}/groups`;
const TEST_DATA_DIR = `${TEST_ROOT}/data`;

// ── Mocks ────────────────────────────────────────────────────────────────────
vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    GROUPS_DIR: `${TEST_ROOT}/groups`,
    DATA_DIR: `${TEST_ROOT}/data`,
  };
});

// Mock writeDestinations — it requires a full session inbound.db; not in scope here
vi.mock('./write-destinations.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./write-destinations.js')>()),
  writeDestinations: vi.fn(),
}));

// Mock writeSessionMessage + getSession so notifyAgent doesn't need a real inbound DB
vi.mock('../../session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session-manager.js')>()),
  writeSessionMessage: vi.fn(),
  initSessionFolder: vi.fn(),
  sessionDir: vi.fn(),
  inboundDbPath: vi.fn(),
  outboundDbPath: vi.fn(),
  resolveSession: vi.fn(),
  openInboundDb: vi.fn(),
}));

// Capture requestApproval calls so each test can choose to trigger the
// post-approval execution path. handleCreateAgent now requests approval
// instead of executing directly; envelope guards still run before the
// requestApproval call, so "rejected before creating any state" tests
// continue to assert correctly via capturedApprovalRequests.length.
const capturedApprovalRequests: Array<{ payload: Record<string, unknown>; session: unknown }> = [];

vi.mock('../approvals/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../approvals/index.js')>()),
  requestApproval: vi.fn(async (opts: { session: unknown; payload: Record<string, unknown> }) => {
    capturedApprovalRequests.push({ payload: opts.payload, session: opts.session });
  }),
  registerApprovalHandler: vi.fn(),
  notifyAgent: vi.fn(),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────
import { initTestDb, closeDb, runMigrations, createAgentGroup, getRawDb } from '../../db/index.js';
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { STANDING_INSTRUCTIONS_FILE } from '../../group-persona.js';
import { applyCreateAgent, handleCreateAgent } from './create-agent.js';
import type { PendingApproval, Session } from '../../types.js';

/**
 * Test helper: invokes handleCreateAgent (envelope guards), then if a
 * requestApproval was queued, drives the apply path with that payload.
 * Mirrors the production flow: request → admin approves → apply runs.
 */
async function runCreateAgent(content: Record<string, unknown>, session: Session): Promise<void> {
  capturedApprovalRequests.length = 0;
  await handleCreateAgent(content, session);
  if (capturedApprovalRequests.length > 0) {
    const req = capturedApprovalRequests[0];
    await applyCreateAgent({
      session: req.session as Session,
      payload: req.payload,
      approval: {
        approval_id: 'test-approval',
        session_id: (req.session as Session).id,
        request_id: 'test-request',
        action: 'create_agent',
        payload: JSON.stringify(req.payload),
        created_at: now(),
        agent_group_id: (req.session as Session).agent_group_id,
        channel_type: null,
        platform_id: null,
        instance: null,
        thread_id: null,
        platform_message_id: null,
        expires_at: null,
        status: 'pending',
        title: 'Create agent',
        question: 'Create this agent?',
        options_json: '[]',
        approver_user_id: 'test-admin',
      } satisfies PendingApproval,
      userId: 'test-admin',
      notify: async () => {},
    });
  }
}

function now(): string {
  return new Date().toISOString();
}

function makeSession(agentGroupId = 'ag-parent'): Session {
  return {
    id: `sess-${Date.now()}`,
    agent_group_id: agentGroupId,
    messaging_group_id: 'mg-1',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: null,
    created_at: now(),
  };
}

beforeEach(async () => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(TEST_GROUPS_DIR, { recursive: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

  await initTestDb();
  const db = getRawDb();
  runMigrations(db);

  // Insert the parent agent group
  await createAgentGroup({
    id: 'ag-parent',
    name: 'Parent Agent',
    folder: 'parent-agent',
    agent_provider: null,
    created_at: now(),
  });
});

afterEach(async () => {
  await closeDb();
  vi.clearAllMocks();
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
});

// ── S4: static fixture assertion ─────────────────────────────────────────────
describe('S4 fixture assertion', () => {
  it('test_create_agent_fixtures_include_nonnull_providers: fixtures include at least one claude and one codex agent_provider', () => {
    const providers = Object.values(FIXTURES).map((f) => f.agent_provider);
    expect(providers).toContain('claude');
    expect(providers).toContain('codex');
  });
});

// ── Legacy path (C3) ─────────────────────────────────────────────────────────
describe('legacy call — no provider, no provider_config', () => {
  it('test_create_agent_legacy_no_provider: creates agent with agent_provider null and no provider/providerConfig keys in container.json', async () => {
    const session = makeSession();
    await runCreateAgent({ requestId: 'r1', name: 'Legacy', instructions: 'be helpful' }, session);

    const row = await getAgentGroupByFolder('legacy');
    expect(row).toBeDefined();
    expect(row!.agent_provider).toBeNull();

    const containerJsonPath = path.join(TEST_GROUPS_DIR, 'legacy', 'container.json');
    expect(fs.existsSync(containerJsonPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(containerJsonPath, 'utf8'));
    expect(parsed).not.toHaveProperty('provider');
    expect(parsed).not.toHaveProperty('providerConfig');
    expect(fs.readFileSync(path.join(TEST_GROUPS_DIR, 'legacy', STANDING_INSTRUCTIONS_FILE), 'utf8')).toBe(
      'be helpful\n',
    );
    expect(fs.readFileSync(path.join(TEST_GROUPS_DIR, 'legacy', 'CLAUDE.local.md'), 'utf8')).toBe('');
    expect(
      fs.existsSync(path.join(TEST_DATA_DIR, 'workgroups', 'legacy', 'memory', 'memories', 'imported-agent-memory.md')),
    ).toBe(false);
  });
});

// ── Happy path with claude provider ─────────────────────────────────────────
describe('create with claude provider', () => {
  it('test_create_agent_with_claude_config_three_writes_consistent: writes agent_provider, container.json provider, and providerConfig consistently', async () => {
    const session = makeSession();
    await runCreateAgent(
      {
        requestId: 'r2',
        name: 'Coder',
        instructions: 'write code',
        provider: 'claude',
        provider_config: { model: 'claude-opus-4-7', effort: 'max' },
      },
      session,
    );

    const row = await getAgentGroupByFolder('coder');
    expect(row).toBeDefined();
    expect(row!.agent_provider).toBe('claude');

    const containerJsonPath = path.join(TEST_GROUPS_DIR, 'coder', 'container.json');
    const parsed = JSON.parse(fs.readFileSync(containerJsonPath, 'utf8'));
    expect(parsed.provider).toBe('claude');
    expect(parsed.providerConfig).toEqual({ model: 'claude-opus-4-7', effort: 'max' });
  });
});

// ── Happy path with codex provider ──────────────────────────────────────────
describe('create with codex provider', () => {
  it('test_create_agent_with_codex_config_three_writes_consistent: writes agent_provider codex, container.json provider codex, and providerConfig', async () => {
    const session = makeSession();
    await runCreateAgent(
      {
        requestId: 'r3',
        name: 'CodexCoder',
        provider: 'codex',
        provider_config: { model: 'gpt-5.5', reasoning_effort: 'high' },
      },
      session,
    );

    const row = await getAgentGroupByFolder('codexcoder');
    expect(row).toBeDefined();
    expect(row!.agent_provider).toBe('codex');

    const containerJsonPath = path.join(TEST_GROUPS_DIR, 'codexcoder', 'container.json');
    const parsed = JSON.parse(fs.readFileSync(containerJsonPath, 'utf8'));
    expect(parsed.provider).toBe('codex');
    expect(parsed.providerConfig).toEqual({ model: 'gpt-5.5', reasoning_effort: 'high' });
  });
});

// ── Folder-residue dedupe (theme T1 PR 2, re-derived from upstream 92a3518b7) ─
describe('folder-residue dedupe', () => {
  it('skips a leftover real folder on disk with no claiming DB row, mints the next suffix', async () => {
    // groups/scout exists on disk (e.g. left behind by `ncl groups delete`)
    // but no agent_groups row claims it — the loop must treat disk presence
    // as taken and mint scout-2 rather than adopting the residue.
    fs.mkdirSync(path.join(TEST_GROUPS_DIR, 'scout'), { recursive: true });

    const session = makeSession();
    await runCreateAgent({ requestId: 'r4', name: 'Scout', instructions: 'help' }, session);

    expect(await getAgentGroupByFolder('scout')).toBeUndefined();
    const row = await getAgentGroupByFolder('scout-2');
    expect(row).toBeDefined();
  });

  it('skips a dangling symlink occupying the folder name, mints the next suffix', async () => {
    // A dangling symlink reads as absent under existsSync but still occupies
    // the name; groupFolderExistsOnDisk uses lstat so it must be treated as
    // taken, exactly like a real leftover directory.
    fs.symlinkSync(path.join(TEST_GROUPS_DIR, 'does-not-exist-target'), path.join(TEST_GROUPS_DIR, 'ghost'));

    const session = makeSession();
    await runCreateAgent({ requestId: 'r5', name: 'Ghost', instructions: 'help' }, session);

    expect(await getAgentGroupByFolder('ghost')).toBeUndefined();
    const row = await getAgentGroupByFolder('ghost-2');
    expect(row).toBeDefined();
  });

  // A folder already claimed by a DB row is unaffected by this change: the
  // `getAgentGroupByFolder(folder)` disjunct alone is already true, so
  // `groupFolderExistsOnDisk` never runs. That path (and the existing
  // scoped-env prefix-collision guard it feeds into) is already pinned by
  // "concurrent approvals" above and is left unmodified here.
});

// ── Write sequence ordering (FS before DB) ───────────────────────────────────
describe('write sequence ordering', () => {
  it('test_create_agent_step_ordering_fs_before_db: calls initGroupFilesystem before updateContainerConfig before createAgentGroup', async () => {
    const callOrder: string[] = [];

    const groupInitModule = await import('../../group-init.js');
    const containerConfigModule = await import('../../container-config.js');
    const agentGroupsModule = await import('../../db/agent-groups.js');

    const origInit = groupInitModule.initGroupFilesystem;
    const origUpdate = containerConfigModule.updateContainerConfig;
    const origCreate = agentGroupsModule.createAgentGroup;

    const initSpy = vi.spyOn(groupInitModule, 'initGroupFilesystem').mockImplementation((...args) => {
      callOrder.push('initGroupFilesystem');
      return origInit(...args);
    });
    const updateSpy = vi.spyOn(containerConfigModule, 'updateContainerConfig').mockImplementation((...args) => {
      callOrder.push('updateContainerConfig');
      return origUpdate(...args);
    });
    const createSpy = vi.spyOn(agentGroupsModule, 'createAgentGroup').mockImplementation((...args) => {
      callOrder.push('createAgentGroup');
      return origCreate(...args);
    });

    const session = makeSession();
    await runCreateAgent(
      {
        requestId: 'r-order',
        name: 'OrderTest',
        provider: 'claude',
        provider_config: { effort: 'high' },
      },
      session,
    );

    // Expected ordering (Codex F9 fix — single updateContainerConfig that
    // persists agentGroupId + provider + providerConfig in one shot,
    // BEFORE the DB insert, so a DB failure rolls back via safeRemoveFolder
    // and we never end up with a DB row whose container.json lacks
    // agentGroupId):
    //   1. initGroupFilesystem  — creates folder + writes empty container.json
    //   2. updateContainerConfig — writes agentGroupId + provider/providerConfig
    //   3. createAgentGroup     — DB insert (failure rolls back via safeRemoveFolder)
    expect(callOrder).toEqual(['initGroupFilesystem', 'updateContainerConfig', 'createAgentGroup']);

    initSpy.mockRestore();
    updateSpy.mockRestore();
    createSpy.mockRestore();
  });
});

// ── DB failure rollback ───────────────────────────────────────────────────────
describe('DB failure rollback', () => {
  it('test_create_agent_db_failure_rolls_back_folder: removes full folder when createAgentGroup throws, notifies agent, does not propagate', async () => {
    const agentGroupsModule = await import('../../db/agent-groups.js');
    const createSpy = vi.spyOn(agentGroupsModule, 'createAgentGroup').mockImplementation(() => {
      throw new Error('simulated DB failure');
    });

    const { writeSessionMessage } = await import('../../session-manager.js');
    const session = makeSession();

    await expect(
      runCreateAgent(
        {
          requestId: 'r-dbfail',
          name: 'DbFail',
          provider: 'claude',
          provider_config: { effort: 'low' },
        },
        session,
      ),
    ).resolves.toBeUndefined(); // must not throw

    expect(fs.existsSync(path.join(TEST_GROUPS_DIR, 'dbfail'))).toBe(false);
    expect(await getAgentGroupByFolder('dbfail')).toBeUndefined();

    const calls = (writeSessionMessage as ReturnType<typeof vi.fn>).mock.calls;
    const notifyCall = calls.find((c) => {
      const content = JSON.parse(c[2].content as string);
      return (content.text as string).includes('failed');
    });
    expect(notifyCall).toBeDefined();

    createSpy.mockRestore();
  });
});

// ── updateContainerConfig failure rollback ────────────────────────────────────
describe('updateContainerConfig failure rollback', () => {
  it('removes folder when updateContainerConfig throws before DB insert', async () => {
    const containerConfigModule = await import('../../container-config.js');
    const updateSpy = vi.spyOn(containerConfigModule, 'updateContainerConfig').mockImplementation(() => {
      throw new Error('simulated FS failure');
    });

    const agentGroupsModule = await import('../../db/agent-groups.js');
    const createSpy = vi.spyOn(agentGroupsModule, 'createAgentGroup');

    const { writeSessionMessage } = await import('../../session-manager.js');
    const session = makeSession();

    await expect(
      runCreateAgent(
        {
          requestId: 'r-fsfail',
          name: 'FsFail',
          provider: 'claude',
          provider_config: {},
        },
        session,
      ),
    ).resolves.toBeUndefined();

    expect(fs.existsSync(path.join(TEST_GROUPS_DIR, 'fsfail'))).toBe(false);
    // DB insert must NOT have been called
    expect(createSpy).not.toHaveBeenCalled();

    const calls = (writeSessionMessage as ReturnType<typeof vi.fn>).mock.calls;
    const notifyCall = calls.find((c) => {
      const content = JSON.parse(c[2].content as string);
      return (content.text as string).includes('failed');
    });
    expect(notifyCall).toBeDefined();

    updateSpy.mockRestore();
    createSpy.mockRestore();
  });
});

// ── Rollback failure (both DB and fs.rmSync fail) ────────────────────────────
describe('rollback failure — orphan notification', () => {
  it('test_create_agent_rollback_failure_notifies_orphan: notifies agent with orphan-cleanup message when rmSync also fails, does not propagate', async () => {
    const agentGroupsModule = await import('../../db/agent-groups.js');
    const createSpy = vi.spyOn(agentGroupsModule, 'createAgentGroup').mockImplementation(() => {
      throw new Error('simulated DB failure');
    });

    const fsSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw new Error('simulated FS rmSync failure');
    });

    const { writeSessionMessage } = await import('../../session-manager.js');
    const session = makeSession();

    await expect(
      runCreateAgent(
        {
          requestId: 'r-orphan',
          name: 'OrphanTest',
          provider: 'claude',
          provider_config: {},
        },
        session,
      ),
    ).resolves.toBeUndefined();

    const calls = (writeSessionMessage as ReturnType<typeof vi.fn>).mock.calls;
    const notifyCall = calls.find((c) => {
      const content = JSON.parse(c[2].content as string);
      const text = content.text as string;
      return text.includes('create_agent failed') && text.includes('OrphanTest');
    });
    expect(notifyCall).toBeDefined();

    // When rmSync also fails, the user-facing message must surface the orphan
    // risk so the user knows manual cleanup may be needed. Without this, the
    // orphan signal lives only in host logs and the user has no signal.
    const notifyText = JSON.parse((notifyCall as NonNullable<typeof notifyCall>)[2].content as string).text as string;
    expect(notifyText).toMatch(/orphan folder at groups\/orphantest/i);
    expect(notifyText.toLowerCase()).toMatch(/manual cleanup/);

    createSpy.mockRestore();
    fsSpy.mockRestore();
  });
});

// ── Envelope guard tests ──────────────────────────────────────────────────────
describe('envelope guard — non-string provider', () => {
  it('test_create_agent_envelope_guard_nonstring_provider: rejects provider=123 before creating any state', async () => {
    const { writeSessionMessage } = await import('../../session-manager.js');
    const session = makeSession();

    await runCreateAgent({ requestId: 'r4', name: 'X', provider: 123 as unknown as string }, session);

    const calls = (writeSessionMessage as ReturnType<typeof vi.fn>).mock.calls;
    const notifyCall = calls.find((c) => {
      const content = JSON.parse(c[2].content as string);
      const text = content.text as string;
      return text.includes('provider') && text.includes('string');
    });
    expect(notifyCall).toBeDefined();

    expect(await getAgentGroupByFolder('x')).toBeUndefined();
    expect(fs.existsSync(path.join(TEST_GROUPS_DIR, 'x'))).toBe(false);
  });
});

describe('envelope guard — array provider_config', () => {
  it('test_create_agent_envelope_guard_array_provider_config: rejects provider_config=[1,2,3] before creating any state', async () => {
    const { writeSessionMessage } = await import('../../session-manager.js');
    const session = makeSession();

    await runCreateAgent(
      {
        requestId: 'r5',
        name: 'X',
        provider: 'claude',
        provider_config: [1, 2, 3] as unknown as Record<string, unknown>,
      },
      session,
    );

    const calls = (writeSessionMessage as ReturnType<typeof vi.fn>).mock.calls;
    const notifyCall = calls.find((c) => {
      const content = JSON.parse(c[2].content as string);
      const text = content.text as string;
      return text.includes('provider_config') && text.includes('object');
    });
    expect(notifyCall).toBeDefined();

    expect(await getAgentGroupByFolder('x')).toBeUndefined();
    expect(fs.existsSync(path.join(TEST_GROUPS_DIR, 'x'))).toBe(false);
  });
});

describe('envelope guard — null provider_config', () => {
  it('rejects provider_config=null before creating any state', async () => {
    const { writeSessionMessage } = await import('../../session-manager.js');
    const session = makeSession();

    await runCreateAgent(
      { requestId: 'r6', name: 'X', provider: 'claude', provider_config: null as unknown as Record<string, unknown> },
      session,
    );

    const calls = (writeSessionMessage as ReturnType<typeof vi.fn>).mock.calls;
    const notifyCall = calls.find((c) => {
      const content = JSON.parse(c[2].content as string);
      const text = content.text as string;
      return text.includes('provider_config') && text.includes('object');
    });
    expect(notifyCall).toBeDefined();

    expect(await getAgentGroupByFolder('x')).toBeUndefined();
    expect(fs.existsSync(path.join(TEST_GROUPS_DIR, 'x'))).toBe(false);
  });
});

describe('envelope guard — undefined provider_config is OK', () => {
  it('accepts absent provider_config and creates agent normally', async () => {
    const session = makeSession();
    await runCreateAgent({ requestId: 'r7', name: 'ValidProviderOnly', provider: 'claude' }, session);

    const row = await getAgentGroupByFolder('validprovideronly');
    expect(row).toBeDefined();
    expect(row!.agent_provider).toBe('claude');
  });
});

describe('concurrent approvals (seam 3: every lookup yields)', () => {
  it('two approved requests for the same name are serialized: one agent, the other refused, the winner untouched', async () => {
    // Two PARENTS: a same-parent repeat is refused earlier by the creator's
    // destination-name check, so it never reaches folder allocation. The
    // helper's capture array is shared, so the approved handler is driven
    // directly here.
    await createAgentGroup({
      id: 'ag-parent-2',
      name: 'Second Parent',
      folder: 'second-parent',
      agent_provider: null,
      created_at: now(),
    });
    const apply = (parent: string, requestId: string) => {
      const session = makeSession(parent);
      const payload = {
        name: 'Twin',
        localPreview: 'twin',
        instructions: null,
        provider: null,
        providerConfig: null,
        requestId,
      };
      return applyCreateAgent({
        session,
        payload,
        approval: {
          approval_id: `approval-${requestId}`,
          session_id: session.id,
          request_id: requestId,
          action: 'create_agent',
          payload: JSON.stringify(payload),
          created_at: now(),
          agent_group_id: parent,
          channel_type: null,
          platform_id: null,
          instance: null,
          thread_id: null,
          platform_message_id: null,
          expires_at: null,
          status: 'pending',
          title: 'Create agent',
          question: 'Create this agent?',
          options_json: '[]',
          approver_user_id: 'test-admin',
        } satisfies PendingApproval,
        userId: 'test-admin',
        notify: async () => {},
      });
    };
    await Promise.all([apply('ag-parent', 'twin-1'), apply('ag-parent-2', 'twin-2')]);

    // Serialized: the second attempt sees the first's row, derives `twin-2`,
    // and the scoped-env prefix rule refuses it (TWIN_2 starts with TWIN_).
    // Unserialized, both derive `twin`, the loser's insert fails on the
    // unique folder, and its rollback deletes the WINNER's directory.
    const winner = await getAgentGroupByFolder('twin');
    expect(winner).toBeDefined();
    expect(await getAgentGroupByFolder('twin-2')).toBeUndefined();
    const cfg = JSON.parse(fs.readFileSync(path.join(TEST_GROUPS_DIR, 'twin', 'container.json'), 'utf8')) as {
      agentGroupId?: string;
    };
    expect(cfg.agentGroupId).toBe(winner!.id);
    expect(fs.existsSync(path.join(TEST_GROUPS_DIR, 'twin-2'))).toBe(false);
  });

  it('two approved requests from ONE parent for the same name: one agent, the other refused by the destination-name check', async () => {
    const apply = (requestId: string) => {
      const session = makeSession('ag-parent');
      const payload = {
        name: 'Solo',
        localPreview: 'solo',
        instructions: null,
        provider: null,
        providerConfig: null,
        requestId,
      };
      return applyCreateAgent({
        session,
        payload,
        approval: {
          approval_id: `approval-${requestId}`,
          session_id: session.id,
          request_id: requestId,
          action: 'create_agent',
          payload: JSON.stringify(payload),
          created_at: now(),
          agent_group_id: 'ag-parent',
          channel_type: null,
          platform_id: null,
          instance: null,
          thread_id: null,
          platform_message_id: null,
          expires_at: null,
          status: 'pending',
          title: 'Create agent',
          question: 'Create this agent?',
          options_json: '[]',
          approver_user_id: 'test-admin',
        } satisfies PendingApproval,
        userId: 'test-admin',
        notify: async () => {},
      });
    };
    // Unserialized, both pass the parent's destination-name check, the second
    // creates `solo-2` and then its grant hits the parent's primary key —
    // an orphaned agent group. Under the lock the second is refused up front.
    await Promise.all([apply('solo-1'), apply('solo-2')]);
    const rows = getRawDb()
      .prepare(`SELECT folder FROM agent_groups WHERE folder LIKE 'solo%' ORDER BY folder`)
      .all() as Array<{ folder: string }>;
    expect(rows.map((r) => r.folder)).toEqual(['solo']);
    expect(fs.existsSync(path.join(TEST_GROUPS_DIR, 'solo-2'))).toBe(false);
  });

  it('the lock is acquired BEFORE the parent invariants (destination name, child cap)', () => {
    // The interleaving Codex described — the first insert landing between the
    // second request's parent checks and its folder dedupe — cannot be forced
    // from outside the handler, so the ordering is pinned on the source: the
    // lock must precede both parent checks in applyCreateAgent.
    const source = fs.readFileSync(path.join(__dirname, 'create-agent.ts'), 'utf8');
    const handler = source.slice(source.indexOf('export const applyCreateAgent'));
    const lock = handler.indexOf('await acquireFolderAllocationLock()');
    const nameCheck = handler.indexOf('getDestinationByName(sourceGroup.id, localName)');
    const childCap = handler.indexOf('CHILDREN_PER_PARENT_CAP');
    expect(lock).toBeGreaterThan(-1);
    expect(nameCheck).toBeGreaterThan(lock);
    expect(childCap).toBeGreaterThan(lock);
  });
});

// ── Workgroup inheritance (T6 PR 1) ─────────────────────────────────────────
describe('workgroup inheritance', () => {
  /** Put the parent in a real workgroup. `agent_groups.workgroup_id` is a
   *  foreign key, so the `workgroups` row has to exist first. */
  function placeParentInWorkgroup(workgroupId: string): void {
    const db = getRawDb();
    db.prepare(`INSERT OR IGNORE INTO workgroups (id, onecli_secrets, created_at) VALUES (?, '[]', ?)`).run(
      workgroupId,
      now(),
    );
    db.prepare(`UPDATE agent_groups SET workgroup_id = ? WHERE id = 'ag-parent'`).run(workgroupId);
  }

  function containerConfig(folder: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(TEST_GROUPS_DIR, folder, 'container.json'), 'utf8'));
  }

  it('a child inherits the parent workgroup in the DB row and in container.json', async () => {
    placeParentInWorkgroup('parent-agent');

    await runCreateAgent({ requestId: 'wg1', name: 'Helper', instructions: null }, makeSession());

    const row = await getAgentGroupByFolder('helper');
    expect(row).toBeDefined();
    expect(row!.workgroup_id).toBe('parent-agent');
    expect(containerConfig('helper').workgroup_id).toBe('parent-agent');
  });

  it('writes the workgroup into container.json before the DB insert, so the first spawn sees it', async () => {
    // The spawn path reads container.json, not the agent_groups row. Pinned on
    // the source because the ordering cannot be observed from outside once the
    // handler has returned.
    const source = fs.readFileSync(path.join(__dirname, 'create-agent.ts'), 'utf8');
    const handler = source.slice(source.indexOf('export const applyCreateAgent'));
    const configWrite = handler.indexOf('c.workgroup_id = workgroupId');
    const dbInsert = handler.indexOf('await createAgentGroup(newGroup)');
    expect(configWrite).toBeGreaterThan(-1);
    expect(dbInsert).toBeGreaterThan(configWrite);
  });

  it('a grandchild inherits the same workgroup, so a chain stays in one data pool', async () => {
    placeParentInWorkgroup('parent-agent');
    await runCreateAgent({ requestId: 'wg2', name: 'Child', instructions: null }, makeSession());

    const child = await getAgentGroupByFolder('child');
    expect(child).toBeDefined();
    await runCreateAgent({ requestId: 'wg3', name: 'Grandchild', instructions: null }, makeSession(child!.id));

    const grandchild = await getAgentGroupByFolder('grandchild');
    expect(grandchild!.workgroup_id).toBe('parent-agent');
    expect(containerConfig('grandchild').workgroup_id).toBe('parent-agent');
  });

  it('a parent with no workgroup still produces a NULL child and no container.json key', async () => {
    // Unchanged behaviour for a pre-036 row that was never backfilled: NULL is
    // what the column held before it was named in the INSERT, and a fabricated
    // id would fail the foreign key.
    await runCreateAgent({ requestId: 'wg4', name: 'Orphan', instructions: null }, makeSession());

    const row = await getAgentGroupByFolder('orphan');
    expect(row!.workgroup_id ?? null).toBeNull();
    expect(containerConfig('orphan')).not.toHaveProperty('workgroup_id');
  });
});
