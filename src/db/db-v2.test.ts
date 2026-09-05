import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { getRawDb } from './connection.js';
import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  getAgentGroup,
  getAgentGroupByFolder,
  getAllAgentGroups,
  updateAgentGroup,
  deleteAgentGroup,
  createMessagingGroup,
  getMessagingGroup,
  getMessagingGroupByPlatform,
  updateMessagingGroup,
  deleteMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgents,
  getMessagingGroupAgent,
  updateMessagingGroupAgent,
  deleteMessagingGroupAgent,
  createSession,
  getSession,
  findSession,
  getSessionsByAgentGroup,
  getActiveSessions,
  getRunningSessions,
  updateSession,
  deleteSession,
  resetPhantomContainerStatus,
  createPendingQuestion,
  getPendingQuestion,
  deletePendingQuestion,
  ensureContainerConfig,
  getContainerConfig,
} from './index.js';

function now() {
  return new Date().toISOString();
}

beforeEach(async () => {
  await initTestDb();
  const db = getRawDb();
  runMigrations(db);
});

afterEach(async () => {
  await closeDb();
});

// ── Migrations ──

describe('migrations', () => {
  it('should be idempotent', async () => {
    await initTestDb();
    const db = getRawDb();
    runMigrations(db);
    // Running again should not throw
    runMigrations(db);
  });

  it('adds messaging_group_agents.threads as a nullable, default-free override column (019)', async () => {
    await initTestDb();
    const db = getRawDb();
    runMigrations(db);
    const col = db
      .prepare(
        `SELECT type, "notnull", dflt_value FROM pragma_table_info('messaging_group_agents') WHERE name = 'threads'`,
      )
      .get() as { type: string; notnull: number; dflt_value: unknown } | undefined;
    expect(col).toBeDefined();
    // NULL must remain expressible (= inherit the adapter declaration) with
    // no default — a backfill would freeze today's behavior into rows.
    expect(col!.type).toBe('INTEGER');
    expect(col!.notnull).toBe(0);
    expect(col!.dflt_value).toBeNull();
  });
});

// ── Agent Groups ──

describe('agent groups', () => {
  const ag = () => ({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });

  it('should create and retrieve', async () => {
    await createAgentGroup(ag());
    const result = await getAgentGroup('ag-1');
    expect(result).toBeDefined();
    expect(result!.name).toBe('Test Agent');
    expect(result!.folder).toBe('test-agent');
  });

  it('should find by folder', async () => {
    await createAgentGroup(ag());
    const result = await getAgentGroupByFolder('test-agent');
    expect(result).toBeDefined();
    expect(result!.id).toBe('ag-1');
  });

  it('should list all', async () => {
    await createAgentGroup(ag());
    await createAgentGroup({ ...ag(), id: 'ag-2', name: 'Another', folder: 'another' });
    expect(await getAllAgentGroups()).toHaveLength(2);
  });

  it('should update', async () => {
    await createAgentGroup(ag());
    await updateAgentGroup('ag-1', { name: 'Updated' });
    expect((await getAgentGroup('ag-1'))!.name).toBe('Updated');
  });

  it('should delete', async () => {
    await createAgentGroup(ag());
    await deleteAgentGroup('ag-1');
    expect(await getAgentGroup('ag-1')).toBeUndefined();
  });

  it('should enforce unique folder', async () => {
    await createAgentGroup(ag());
    await expect(createAgentGroup({ ...ag(), id: 'ag-dup' })).rejects.toThrow();
  });
});

// ── Messaging Groups ──

describe('messaging groups', () => {
  const mg = () => ({
    id: 'mg-1',
    channel_type: 'discord',
    platform_id: 'chan-123',
    name: 'General',
    is_group: 1,
    unknown_sender_policy: 'strict' as const,
    created_at: now(),
  });

  it('should create and retrieve', async () => {
    await createMessagingGroup(mg());
    const result = await getMessagingGroup('mg-1');
    expect(result).toBeDefined();
    expect(result!.channel_type).toBe('discord');
  });

  it('should find by platform', async () => {
    await createMessagingGroup(mg());
    const result = await getMessagingGroupByPlatform('discord', 'chan-123');
    expect(result).toBeDefined();
    expect(result!.id).toBe('mg-1');
  });

  it('should enforce unique channel_type + platform_id', async () => {
    await createMessagingGroup(mg());
    await expect(createMessagingGroup({ ...mg(), id: 'mg-dup' })).rejects.toThrow();
  });

  it('should update', async () => {
    await createMessagingGroup(mg());
    await updateMessagingGroup('mg-1', { name: 'Updated', name_source: 'slack:classified' });
    const updated = (await getMessagingGroup('mg-1'))!;
    expect(updated.name).toBe('Updated');
    // A name write carries its provenance (migration 069) — the pair is what
    // a later metadata refresh consults before overwriting.
    expect(updated.name_source).toBe('slack:classified');
  });

  it('should delete', async () => {
    await createMessagingGroup(mg());
    await deleteMessagingGroup('mg-1');
    expect(await getMessagingGroup('mg-1')).toBeUndefined();
  });
});

// ── Messaging Group Agents ──

describe('messaging group agents', () => {
  beforeEach(async () => {
    await createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      agent_provider: null,
      created_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'chan-1',
      name: 'Gen',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
  });

  const mga = () => ({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'pattern' as const,
    engage_pattern: '.',
    sender_scope: 'all' as const,
    ignored_message_policy: 'drop' as const,
    session_mode: 'shared' as const,
    priority: 0,
    default_model: null,
    default_effort: null,
    default_tone: null,
    instructions_profile: null,
    created_at: now(),
  });

  it('should create and list by messaging group', async () => {
    await createMessagingGroupAgent(mga());
    const results = await getMessagingGroupAgents('mg-1');
    expect(results).toHaveLength(1);
    expect(results[0].agent_group_id).toBe('ag-1');
  });

  it('should order by priority descending', async () => {
    await createMessagingGroupAgent(mga());
    await createAgentGroup({
      id: 'ag-2',
      name: 'Agent2',
      folder: 'agent2',
      agent_provider: null,
      created_at: now(),
    });
    // Same-workgroup siblings — cross-workgroup wiring is rejected by
    // assertSameWorkgroupWiring, which is not this test's subject.
    getRawDb()
      .prepare(
        `INSERT OR IGNORE INTO workgroups (id, display_name, onecli_secrets, mnemon_store_id, created_at)
         VALUES ('wg-prio', 'wg-prio', '[]', 'ag-1', datetime('now'))`,
      )
      .run();
    getRawDb().prepare("UPDATE agent_groups SET workgroup_id = 'wg-prio' WHERE id IN ('ag-1','ag-2')").run();
    await createMessagingGroupAgent({ ...mga(), id: 'mga-2', agent_group_id: 'ag-2', priority: 10 });
    const results = await getMessagingGroupAgents('mg-1');
    expect(results[0].agent_group_id).toBe('ag-2');
    expect(results[1].agent_group_id).toBe('ag-1');
  });

  it('should enforce unique messaging_group + agent_group', async () => {
    await createMessagingGroupAgent(mga());
    await expect(createMessagingGroupAgent({ ...mga(), id: 'mga-dup' })).rejects.toThrow();
  });

  it('should update', async () => {
    await createMessagingGroupAgent(mga());
    await updateMessagingGroupAgent('mga-1', { priority: 5 });
    expect((await getMessagingGroupAgent('mga-1'))!.priority).toBe(5);
  });

  it('should delete', async () => {
    await createMessagingGroupAgent(mga());
    await deleteMessagingGroupAgent('mga-1');
    expect(await getMessagingGroupAgents('mg-1')).toHaveLength(0);
  });

  it('should enforce foreign key on agent_group_id', async () => {
    await expect(createMessagingGroupAgent({ ...mga(), agent_group_id: 'nonexistent' })).rejects.toThrow();
  });

  it('auto-creates an agent_destinations row for the wiring', async () => {
    const { getDestinationByTarget, getDestinations } =
      await import('../modules/agent-to-agent/db/agent-destinations.js');
    await createMessagingGroupAgent(mga());

    const dest = await getDestinationByTarget('ag-1', 'channel', 'mg-1');
    expect(dest).toBeDefined();
    expect(dest!.local_name).toBe('gen'); // normalized from mg.name='Gen'
    expect(await getDestinations('ag-1')).toHaveLength(1);
  });

  it('does not duplicate destination row on re-wiring', async () => {
    const { getDestinations } = await import('../modules/agent-to-agent/db/agent-destinations.js');
    await createMessagingGroupAgent(mga());
    // Re-create the same wiring throws (PK unique), but even if we got the
    // row in some other way (e.g. via createDestination directly followed
    // by createMessagingGroupAgent), we should not end up with two rows.
    await deleteMessagingGroupAgent('mga-1');
    await createMessagingGroupAgent(mga());
    expect(await getDestinations('ag-1')).toHaveLength(1);
  });

  it('breaks local_name collisions within an agent group', async () => {
    const { getDestinations } = await import('../modules/agent-to-agent/db/agent-destinations.js');
    // Two messaging groups with the same `name` wired to the same agent
    // should get distinct local_names (gen, gen-2).
    await createMessagingGroupAgent(mga());
    await createMessagingGroup({
      id: 'mg-2',
      channel_type: 'discord',
      platform_id: 'chan-2',
      name: 'Gen',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await createMessagingGroupAgent({ ...mga(), id: 'mga-2', messaging_group_id: 'mg-2' });

    const dests = (await getDestinations('ag-1')).map((d) => d.local_name).sort();
    expect(dests).toEqual(['gen', 'gen-2']);
  });
});

describe('getChannelPeers — sibling-adapter awareness', () => {
  beforeEach(async () => {
    // Two siblings (Example Assistant / Example Assistant Codex) on the SAME Slack channel are modeled as
    // two messaging_groups sharing platform_id but with channel_type that
    // differs per bot adapter. A third unrelated agent is wired to a totally
    // separate channel to confirm cross-channel isolation. All three share
    // workgroup_id so the workgroup-scoping filter doesn't drop them. The
    // cross-workgroup collision case is exercised in a separate describe
    // block below.
    getRawDb()
      .prepare(`INSERT INTO workgroups (id, display_name, created_at) VALUES ('wg-retail', 'Example Retail', ?)`)
      .run(now());
    await createAgentGroup({
      id: 'primary',
      name: 'Example Assistant',
      folder: 'primary',
      agent_provider: null,
      created_at: now(),
    });
    await createAgentGroup({
      id: 'example-assistant-codex',
      name: 'Example Assistant Codex',
      folder: 'example-assistant-codex',
      agent_provider: null,
      created_at: now(),
    });
    await createAgentGroup({
      id: 'unrelated',
      name: 'Unrelated',
      folder: 'unrelated',
      agent_provider: null,
      created_at: now(),
    });
    getRawDb()
      .prepare(
        `UPDATE agent_groups SET workgroup_id = 'wg-retail' WHERE id IN ('primary','example-assistant-codex','unrelated')`,
      )
      .run();
    await createMessagingGroup({
      id: 'mg-primary',
      channel_type: 'slack-retail',
      platform_id: 'C123CHANNEL',
      name: 'general',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-example-assistant-codex',
      channel_type: 'slack-retail-codex',
      platform_id: 'C123CHANNEL',
      name: 'general',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-other',
      channel_type: 'slack-retail',
      platform_id: 'C999OTHER',
      name: 'other-channel',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    const base = {
      engage_mode: 'mention' as const,
      engage_pattern: null,
      sender_scope: 'all' as const,
      ignored_message_policy: 'accumulate' as const,
      session_mode: 'per-thread' as const,
      priority: 0,
      default_model: null,
      default_effort: null,
      default_tone: null,
      instructions_profile: null,
      created_at: now(),
    };
    await createMessagingGroupAgent({
      ...base,
      id: 'mga-primary',
      messaging_group_id: 'mg-primary',
      agent_group_id: 'primary',
    });
    await createMessagingGroupAgent({
      ...base,
      id: 'mga-example-assistant-codex',
      messaging_group_id: 'mg-example-assistant-codex',
      agent_group_id: 'example-assistant-codex',
    });
    await createMessagingGroupAgent({
      ...base,
      id: 'mga-unrelated',
      messaging_group_id: 'mg-other',
      agent_group_id: 'unrelated',
    });
  });

  it('returns sibling on same platform_id but different channel_type adapter', async () => {
    const { getChannelPeers } = await import('./messaging-groups.js');
    const peers = await getChannelPeers('mg-primary', 'primary');
    expect(peers).toHaveLength(1);
    expect(peers[0].agent_group_id).toBe('example-assistant-codex');
    expect(peers[0].name).toBe('Example Assistant Codex');
    expect(peers[0].channel_type).toBe('slack-retail-codex');
  });

  it('excludes self from peer list', async () => {
    const { getChannelPeers } = await import('./messaging-groups.js');
    const peers = await getChannelPeers('mg-primary', 'primary');
    expect(peers.map((p) => p.agent_group_id)).not.toContain('primary');
  });

  it('excludes unrelated agents on different platform_id', async () => {
    const { getChannelPeers } = await import('./messaging-groups.js');
    const peers = await getChannelPeers('mg-primary', 'primary');
    expect(peers.map((p) => p.agent_group_id)).not.toContain('unrelated');
  });

  it('returns empty when the agent has no siblings on the channel', async () => {
    const { getChannelPeers } = await import('./messaging-groups.js');
    const peers = await getChannelPeers('mg-other', 'unrelated');
    expect(peers).toHaveLength(0);
  });
});

describe('getChannelPeers — workgroup tenant boundary', () => {
  beforeEach(async () => {
    // Two workgroups exist on the host. By engineered coincidence two
    // independent Slack workspaces wire a channel that ends up storing the
    // SAME platform_id `slack:C123COLLIDE`. Without workgroup scoping the
    // peer query would cross-pollinate (return the wrong-workgroup agent
    // as a "peer"). With workgroup scoping it must not.
    getRawDb()
      .prepare(`INSERT INTO workgroups (id, display_name, created_at) VALUES ('retail', 'Example Retail', ?)`)
      .run(now());
    getRawDb()
      .prepare(`INSERT INTO workgroups (id, display_name, created_at) VALUES ('example-labs', 'Example Labs', ?)`)
      .run(now());
    await createAgentGroup({
      id: 'primary',
      name: 'Example Assistant',
      folder: 'primary',
      agent_provider: null,
      created_at: now(),
    });
    await createAgentGroup({ id: 'helper', name: 'Helper', folder: 'helper', agent_provider: null, created_at: now() });
    getRawDb().prepare(`UPDATE agent_groups SET workgroup_id = 'retail' WHERE id = 'primary'`).run();
    getRawDb().prepare(`UPDATE agent_groups SET workgroup_id = 'example-labs' WHERE id = 'helper'`).run();
    await createMessagingGroup({
      id: 'mg-primary-collide',
      channel_type: 'slack-retail',
      platform_id: 'slack:C123COLLIDE',
      name: 'general',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-helper-collide',
      channel_type: 'slack-example-labs',
      platform_id: 'slack:C123COLLIDE',
      name: 'general',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    const base = {
      engage_mode: 'mention' as const,
      engage_pattern: null,
      sender_scope: 'all' as const,
      ignored_message_policy: 'accumulate' as const,
      session_mode: 'per-thread' as const,
      priority: 0,
      default_model: null,
      default_effort: null,
      default_tone: null,
      instructions_profile: null,
      created_at: now(),
    };
    await createMessagingGroupAgent({
      ...base,
      id: 'mga-primary-collide',
      messaging_group_id: 'mg-primary-collide',
      agent_group_id: 'primary',
    });
    await createMessagingGroupAgent({
      ...base,
      id: 'mga-helper-collide',
      messaging_group_id: 'mg-helper-collide',
      agent_group_id: 'helper',
    });
  });

  it('does not surface cross-workgroup agents even on identical platform_id (Slack workspace-id collision guard)', async () => {
    const { getChannelPeers } = await import('./messaging-groups.js');
    const peers = await getChannelPeers('mg-primary-collide', 'primary');
    expect(peers.map((p) => p.agent_group_id)).not.toContain('helper');
    expect(peers).toHaveLength(0);
  });

  it('excludes agents with NULL workgroup_id when caller has a workgroup', async () => {
    // Migrate an agent into the same platform_id but leave it with no
    // workgroup. Should be excluded (NULL workgroup is never "same as" a
    // real workgroup id).
    await createAgentGroup({
      id: 'orphan',
      name: 'Orphan',
      folder: 'orphan',
      agent_provider: null,
      created_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-orphan',
      channel_type: 'slack-retail-codex',
      platform_id: 'slack:C123COLLIDE',
      name: 'general',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await createMessagingGroupAgent({
      id: 'mga-orphan',
      messaging_group_id: 'mg-orphan',
      agent_group_id: 'orphan',
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'accumulate',
      session_mode: 'per-thread',
      priority: 0,
      default_model: null,
      default_effort: null,
      default_tone: null,
      instructions_profile: null,
      created_at: now(),
    });
    const { getChannelPeers } = await import('./messaging-groups.js');
    const peers = await getChannelPeers('mg-primary-collide', 'primary');
    expect(peers.map((p) => p.agent_group_id)).not.toContain('orphan');
  });
});

// ── Sessions ──

describe('sessions', () => {
  beforeEach(async () => {
    await createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      agent_provider: null,
      created_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'chan-1',
      name: 'Gen',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
  });

  const sess = () => ({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: null,
    agent_provider: null,
    status: 'active' as const,
    container_status: 'stopped' as const,
    last_active: null,
    created_at: now(),
  });

  it('should create and retrieve', async () => {
    await createSession(sess());
    const result = await getSession('sess-1');
    expect(result).toBeDefined();
    expect(result!.agent_group_id).toBe('ag-1');
  });

  it('should find by messaging group (shared, no thread)', async () => {
    await createSession(sess());
    const result = await findSession('mg-1', null);
    expect(result).toBeDefined();
    expect(result!.id).toBe('sess-1');
  });

  it('should find by messaging group + thread', async () => {
    await createSession({ ...sess(), thread_id: 'thread-1' });
    expect(await findSession('mg-1', 'thread-1')).toBeDefined();
    expect(await findSession('mg-1', 'thread-2')).toBeUndefined();
    expect(await findSession('mg-1', null)).toBeUndefined();
  });

  it('should only find active sessions', async () => {
    await createSession({ ...sess(), status: 'closed' });
    expect(await findSession('mg-1', null)).toBeUndefined();
  });

  it('should list by agent group', async () => {
    await createSession(sess());
    await createSession({ ...sess(), id: 'sess-2', thread_id: 'thread-1' });
    expect(await getSessionsByAgentGroup('ag-1')).toHaveLength(2);
  });

  it('should list active sessions', async () => {
    await createSession(sess());
    await createSession({ ...sess(), id: 'sess-closed', status: 'closed', thread_id: 'thread-x' });
    expect(await getActiveSessions()).toHaveLength(1);
  });

  it('should list running sessions', async () => {
    await createSession({ ...sess(), container_status: 'running' });
    await createSession({ ...sess(), id: 'sess-idle', container_status: 'idle', thread_id: 'thread-1' });
    await createSession({ ...sess(), id: 'sess-stopped', container_status: 'stopped', thread_id: 'thread-2' });
    expect(await getRunningSessions()).toHaveLength(2);
  });

  it('resetPhantomContainerStatus: flips running+idle to stopped, leaves stopped alone', async () => {
    await createSession({ ...sess(), id: 'a', container_status: 'running' });
    await createSession({ ...sess(), id: 'b', container_status: 'idle', thread_id: 't1' });
    await createSession({ ...sess(), id: 'c', container_status: 'stopped', thread_id: 't2' });

    expect(await resetPhantomContainerStatus()).toBe(2);
    expect(await getRunningSessions()).toHaveLength(0);
    expect((await getSession('a'))!.container_status).toBe('stopped');
    expect((await getSession('b'))!.container_status).toBe('stopped');
    expect((await getSession('c'))!.container_status).toBe('stopped');
  });

  it('resetPhantomContainerStatus: idempotent — second call expires zero', async () => {
    await createSession({ ...sess(), container_status: 'running' });
    expect(await resetPhantomContainerStatus()).toBe(1);
    expect(await resetPhantomContainerStatus()).toBe(0);
  });

  it('should update', async () => {
    await createSession(sess());
    await updateSession('sess-1', { container_status: 'running', last_active: now() });
    const result = (await getSession('sess-1'))!;
    expect(result.container_status).toBe('running');
    expect(result.last_active).not.toBeNull();
  });

  it('should delete', async () => {
    await createSession(sess());
    await deleteSession('sess-1');
    expect(await getSession('sess-1')).toBeUndefined();
  });
});

// ── Pending Questions ──

describe('pending questions', () => {
  beforeEach(async () => {
    await createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      agent_provider: null,
      created_at: now(),
    });
    await createSession({
      id: 'sess-1',
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });
  });

  it('should create and retrieve', async () => {
    await createPendingQuestion({
      question_id: 'q-1',
      session_id: 'sess-1',
      message_out_id: 'msg-out-1',
      platform_id: 'chan-1',
      channel_type: 'discord',
      thread_id: null,
      title: 'Test',
      question: 'Choose an answer',
      options: [{ label: 'Yes', selectedLabel: 'Yes', value: 'yes' }],
      created_at: now(),
    });
    const result = await getPendingQuestion('q-1');
    expect(result).toBeDefined();
    expect(result!.session_id).toBe('sess-1');
    expect(result!.title).toBe('Test');
    expect(result!.question).toBe('Choose an answer');
    expect(result!.options[0].value).toBe('yes');
  });

  it('should delete', async () => {
    await createPendingQuestion({
      question_id: 'q-1',
      session_id: 'sess-1',
      message_out_id: 'msg-out-1',
      platform_id: null,
      channel_type: null,
      thread_id: null,
      title: 'Test',
      question: 'Choose an answer',
      options: [{ label: 'Yes', selectedLabel: 'Yes', value: 'yes' }],
      created_at: now(),
    });
    await deletePendingQuestion('q-1');
    expect(await getPendingQuestion('q-1')).toBeUndefined();
  });
});

// ── Wiring workgroup guard ──

describe('assertSameWorkgroupWiring (via createMessagingGroupAgent)', () => {
  const mgaRow = (id: string, agId: string) => ({
    id,
    messaging_group_id: 'mg-wg',
    agent_group_id: agId,
    engage_mode: 'mention' as const,
    engage_pattern: null,
    sender_scope: 'all' as const,
    ignored_message_policy: 'drop' as const,
    session_mode: 'shared' as const,
    priority: 0,
    default_model: null,
    default_effort: null,
    default_tone: null,
    instructions_profile: null,
    created_at: now(),
  });

  beforeEach(async () => {
    await createMessagingGroup({
      id: 'mg-wg',
      channel_type: 'slack',
      platform_id: 'C-wg-guard',
      name: 'wg-guard',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    for (const [id, folder] of [
      ['ag-a', 'alpha'],
      ['ag-b', 'beta'],
      ['ag-c', 'gamma'],
    ] as const) {
      await createAgentGroup({ id, name: id, folder, agent_provider: null, created_at: now() });
    }
  });

  const makeWorkgroup = (id: string) =>
    getRawDb()
      .prepare(
        `INSERT OR IGNORE INTO workgroups (id, display_name, onecli_secrets, mnemon_store_id, created_at)
         VALUES (?, ?, '[]', ?, datetime('now'))`,
      )
      .run(id, id, id);

  it('allows wiring agents that share a workgroup', async () => {
    makeWorkgroup('wg-1');
    getRawDb().prepare("UPDATE agent_groups SET workgroup_id = 'wg-1' WHERE id IN ('ag-a','ag-b')").run();
    await createMessagingGroupAgent(mgaRow('mga-a', 'ag-a'));
    await createMessagingGroupAgent(mgaRow('mga-b', 'ag-b'));
    expect(await getMessagingGroupAgents('mg-wg')).toHaveLength(2);
  });

  it('rejects wiring an agent from a different workgroup', async () => {
    makeWorkgroup('wg-1');
    makeWorkgroup('wg-2');
    getRawDb().prepare("UPDATE agent_groups SET workgroup_id = 'wg-1' WHERE id = 'ag-a'").run();
    getRawDb().prepare("UPDATE agent_groups SET workgroup_id = 'wg-2' WHERE id = 'ag-c'").run();
    await createMessagingGroupAgent(mgaRow('mga-a', 'ag-a'));
    await expect(createMessagingGroupAgent(mgaRow('mga-c', 'ag-c'))).rejects.toThrow(/same workgroup/);
    expect(await getMessagingGroupAgents('mg-wg')).toHaveLength(1);
  });

  it('permits cross-workgroup rows on a colliding platform_id (isolation is by path namespace)', async () => {
    // Same platform_id via a SECOND adapter row can be a workspace-id
    // collision from an unrelated tenant (see getChannelPeers
    // tenant-boundary tests) — wiring must not reject it. Isolation comes
    // from workgroup-namespaced thread paths (session-manager.ts), not from
    // wiring rejection.
    await createMessagingGroup({
      id: 'mg-wg-sibling',
      channel_type: 'slack-other-tenant',
      platform_id: 'C-wg-guard',
      name: 'wg-guard-colliding-tenant',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    makeWorkgroup('wg-1');
    makeWorkgroup('wg-2');
    getRawDb().prepare("UPDATE agent_groups SET workgroup_id = 'wg-1' WHERE id = 'ag-a'").run();
    getRawDb().prepare("UPDATE agent_groups SET workgroup_id = 'wg-2' WHERE id = 'ag-c'").run();
    await createMessagingGroupAgent(mgaRow('mga-a', 'ag-a'));
    await expect(
      createMessagingGroupAgent({ ...mgaRow('mga-c', 'ag-c'), messaging_group_id: 'mg-wg-sibling' }),
    ).resolves.toBeUndefined();
  });

  it('falls back to folder identity when workgroup_id is null', async () => {
    // Pre-workgroup rows: identity = folder, matching container-runner's
    // shared-dir resolution. Different folders → different data pools → reject.
    await createMessagingGroupAgent(mgaRow('mga-a', 'ag-a'));
    await expect(createMessagingGroupAgent(mgaRow('mga-b', 'ag-b'))).rejects.toThrow(/same workgroup/);
  });
});

// ── Container Configs ──

describe('container configs', () => {
  it('container_configs has nullable security_json column defaulting to null', async () => {
    await createAgentGroup({ id: 'ag-sec', name: 'Sec', folder: 'sec', agent_provider: null, created_at: now() });
    await ensureContainerConfig('ag-sec');
    const row = await getContainerConfig('ag-sec');
    expect(row).toBeDefined();
    expect(row!.security_json).toBeNull();
  });
});
