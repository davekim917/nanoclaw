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
const TEST_GROUPS_DIR = '/tmp/nanoclaw-test-create-agent/groups';
const TEST_DATA_DIR = '/tmp/nanoclaw-test-create-agent/data';
const TEST_ROOT = '/tmp/nanoclaw-test-create-agent';

// ── Mocks ────────────────────────────────────────────────────────────────────
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    GROUPS_DIR: '/tmp/nanoclaw-test-create-agent/groups',
    DATA_DIR: '/tmp/nanoclaw-test-create-agent/data',
  };
});

// Mock writeDestinations — it requires a full session inbound.db; not in scope here
vi.mock('./write-destinations.js', () => ({
  writeDestinations: vi.fn(),
}));

// Mock writeSessionMessage + getSession so notifyAgent doesn't need a real inbound DB
vi.mock('../../session-manager.js', () => ({
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

vi.mock('../approvals/index.js', () => ({
  requestApproval: vi.fn(async (opts: { session: unknown; payload: Record<string, unknown> }) => {
    capturedApprovalRequests.push({ payload: opts.payload, session: opts.session });
  }),
  registerApprovalHandler: vi.fn(),
  notifyAgent: vi.fn(),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────
import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { applyCreateAgent, handleCreateAgent } from './create-agent.js';
import type { Session } from '../../types.js';

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

beforeEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(TEST_GROUPS_DIR, { recursive: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

  const db = initTestDb();
  runMigrations(db);

  // Insert the parent agent group
  createAgentGroup({
    id: 'ag-parent',
    name: 'Parent Agent',
    folder: 'parent-agent',
    agent_provider: null,
    created_at: now(),
  });
});

afterEach(() => {
  closeDb();
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

    const row = getAgentGroupByFolder('legacy');
    expect(row).toBeDefined();
    expect(row!.agent_provider).toBeNull();

    const containerJsonPath = path.join(TEST_GROUPS_DIR, 'legacy', 'container.json');
    expect(fs.existsSync(containerJsonPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(containerJsonPath, 'utf8'));
    expect(parsed).not.toHaveProperty('provider');
    expect(parsed).not.toHaveProperty('providerConfig');
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

    const row = getAgentGroupByFolder('coder');
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

    const row = getAgentGroupByFolder('codexcoder');
    expect(row).toBeDefined();
    expect(row!.agent_provider).toBe('codex');

    const containerJsonPath = path.join(TEST_GROUPS_DIR, 'codexcoder', 'container.json');
    const parsed = JSON.parse(fs.readFileSync(containerJsonPath, 'utf8'));
    expect(parsed.provider).toBe('codex');
    expect(parsed.providerConfig).toEqual({ model: 'gpt-5.5', reasoning_effort: 'high' });
  });
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
    expect(getAgentGroupByFolder('dbfail')).toBeUndefined();

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

    expect(getAgentGroupByFolder('x')).toBeUndefined();
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

    expect(getAgentGroupByFolder('x')).toBeUndefined();
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

    expect(getAgentGroupByFolder('x')).toBeUndefined();
    expect(fs.existsSync(path.join(TEST_GROUPS_DIR, 'x'))).toBe(false);
  });
});

describe('envelope guard — undefined provider_config is OK', () => {
  it('accepts absent provider_config and creates agent normally', async () => {
    const session = makeSession();
    await runCreateAgent({ requestId: 'r7', name: 'ValidProviderOnly', provider: 'claude' }, session);

    const row = getAgentGroupByFolder('validprovideronly');
    expect(row).toBeDefined();
    expect(row!.agent_provider).toBe('claude');
  });
});
