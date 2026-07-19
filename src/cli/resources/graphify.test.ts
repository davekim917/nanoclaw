import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendGraphifyRequest = vi.hoisted(() => vi.fn(async (request: unknown, _options?: unknown) => ({ request })));

vi.mock('../../graphify/client.js', () => ({
  DEFAULT_GRAPHIFY_TIMEOUT_MS: 30_000,
  sendGraphifyRequest,
}));

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import type { CallerContext } from '../frame.js';
import { lookup } from '../registry.js';
import './graphify.js';

const HOST: CallerContext = { caller: 'host' };
const AGENT: CallerContext = {
  caller: 'agent',
  sessionId: 'sess-a',
  agentGroupId: 'ag-a',
  messagingGroupId: 'mg-a',
};

function addGroup(id: string, workgroupId: string | null): void {
  createAgentGroup({
    id,
    name: id,
    folder: id.replace(/^ag-/, ''),
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  if (workgroupId) {
    getDb()
      .prepare(`INSERT OR IGNORE INTO workgroups (id, onecli_secrets, created_at) VALUES (?, '[]', ?)`)
      .run(workgroupId, new Date().toISOString());
    getDb().prepare('UPDATE agent_groups SET workgroup_id = ? WHERE id = ?').run(workgroupId, id);
  } else {
    getDb().prepare('UPDATE agent_groups SET workgroup_id = NULL WHERE id = ?').run(id);
  }
}

async function invoke(verb: string, raw: Record<string, unknown>, ctx: CallerContext = AGENT): Promise<unknown> {
  const command = lookup(`graphify-${verb}`);
  if (!command) throw new Error(`missing graphify-${verb}`);
  return command.handler(command.parseArgs(raw), ctx);
}

describe('ncl graphify workgroup isolation', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    addGroup('ag-a', 'wg-a');
    addGroup('ag-b', 'wg-b');
    sendGraphifyRequest.mockClear();
  });

  afterEach(() => closeDb());

  it('test_graphify_cli_agent_scope_derives_workgroup_from_caller', async () => {
    await invoke('query', { query: 'customer retention', group: 'ag-a' });

    expect(sendGraphifyRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        workgroupId: 'wg-a',
        agentGroupId: 'ag-a',
        sessionId: 'sess-a',
        command: 'query',
      }),
      expect.any(Object),
    );
  });

  it('test_graphify_cli_rejects_agent_group_without_workgroup', async () => {
    addGroup('ag-unbound', null);
    const unbound: CallerContext = { ...AGENT, agentGroupId: 'ag-unbound' };

    await expect(invoke('status', {}, unbound)).rejects.toThrow(/has no workgroup/i);
    expect(sendGraphifyRequest).not.toHaveBeenCalled();
  });

  it('test_graphify_cli_host_requires_group', async () => {
    await expect(invoke('status', {}, HOST)).rejects.toThrow(/--group is required/i);
    expect(sendGraphifyRequest).not.toHaveBeenCalled();
  });

  it('test_graphify_cli_never_accepts_cross_workgroup_override', async () => {
    const query = lookup('graphify-query')!;
    expect(() => query.parseArgs({ query: 'secrets', workgroup: 'wg-b' })).toThrow(/unknown flag --workgroup/i);

    await invoke('query', { query: 'secrets', group: 'ag-b' });
    expect(sendGraphifyRequest).toHaveBeenCalledWith(
      expect.objectContaining({ workgroupId: 'wg-a', agentGroupId: 'ag-a', sessionId: 'sess-a' }),
      expect.any(Object),
    );
  });

  it('test_graphify_cli_maintenance_commands_are_approval_gated', () => {
    for (const verb of ['reindex', 'pause', 'resume']) {
      expect(lookup(`graphify-${verb}`)?.access).toBe('approval');
    }
    for (const verb of ['query', 'path', 'explain', 'affected', 'status', 'ensure-fresh']) {
      expect(lookup(`graphify-${verb}`)?.access).toBe('open');
    }
  });

  it('test_graphify_cli_read_commands_forward_selected_workgroup', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['query', { query: 'orders', limit: 5 }],
      ['path', { from: 'conversation:1', to: 'model:orders', max_depth: 7 }],
      ['explain', { node: 'model:orders', depth: 2 }],
      ['affected', { node: 'model:orders', depth: 4, limit: 25 }],
      ['status', {}],
      ['ensure-fresh', { timeout_ms: 45_000 }],
    ];

    for (const [verb, args] of calls) await invoke(verb, { ...args, group: 'ag-a' }, HOST);

    expect(sendGraphifyRequest).toHaveBeenCalledTimes(calls.length);
    for (const [index, [command]] of calls.entries()) {
      const [request] = sendGraphifyRequest.mock.calls[index] as [
        {
          workgroupId: string;
          command: string;
          agentGroupId?: string;
          sessionId?: string;
        },
      ];
      expect(request).toMatchObject({ workgroupId: 'wg-a', command });
      expect(request.agentGroupId).toBeUndefined();
      expect(request.sessionId).toBeUndefined();
    }
    expect(sendGraphifyRequest.mock.calls[0][0]).toMatchObject({ args: { query: 'orders', limit: 5 } });
    expect(sendGraphifyRequest.mock.calls[1][0]).toMatchObject({
      args: { from: 'conversation:1', to: 'model:orders', maxDepth: 7 },
    });
    expect(sendGraphifyRequest.mock.calls[5][1]).toEqual({ timeoutMs: 45_000 });
  });

  it('rejects out-of-range depths, limits, and timeouts before calling the daemon', async () => {
    await expect(invoke('query', { query: 'orders', limit: 0 })).rejects.toThrow(/--limit must be an integer/);
    await expect(invoke('path', { from: 'a', to: 'b', max_depth: 99 })).rejects.toThrow(
      /--max-depth must be an integer/,
    );
    await expect(invoke('status', { timeout_ms: 999 })).rejects.toThrow(/--timeout-ms must be an integer/);
    expect(sendGraphifyRequest).not.toHaveBeenCalled();
  });
});
