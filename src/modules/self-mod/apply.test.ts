/**
 * `applyAddMcpServer` — what an admin's approval actually persists.
 *
 * The spawn path reads MCP servers from `groups/<folder>/container.json`
 * (`readContainerConfig`), not from the `container_configs` row, and the
 * host-startup backfill syncs file → DB. So an approval that wrote only the
 * DB column restarted the container WITHOUT the server the admin approved,
 * and the next backfill erased the projection too. Both stores must be
 * written, the same way `ncl groups config add-mcp-server` does it.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Inlined, not a module-level const: vi.mock factories are hoisted above
// every declaration in the file, so referencing one here throws a TDZ error.
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-mcp-apply',
    GROUPS_DIR: '/tmp/nanoclaw-test-mcp-apply/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-mcp-apply';

vi.mock('../../container-runner.js', () => ({
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
  killContainer: vi.fn(),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});

import { readContainerConfig, writeContainerConfig } from '../../container-config.js';
import { writeSessionMessage } from '../../session-manager.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { ensureContainerConfig, getContainerConfig } from '../../db/container-configs.js';
import { createSession } from '../../db/sessions.js';
import type { Session } from '../../types.js';
import { applyAddMcpServer } from './apply.js';

function now(): string {
  return new Date().toISOString();
}

let session: Session;

beforeEach(() => {
  vi.clearAllMocks();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(`${TEST_DIR}/groups/agent`, { recursive: true });
  runMigrations(initTestDb());

  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  ensureContainerConfig('ag-1');
  session = {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  } as Session;
  createSession(session);

  writeContainerConfig('agent', {
    mcpServers: { existing: { command: 'mcp-existing', args: [], env: {} } },
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all',
    onecliSecrets: ['Keep-Me'],
  });
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('applyAddMcpServer', () => {
  it('writes a remote server to container.json AND the DB projection', async () => {
    await applyAddMcpServer(
      {
        name: 'datafold',
        type: 'http',
        url: 'https://app.datafold.com/mcp/',
        headers: { Authorization: 'Key onecli-managed' },
      },
      session,
    );

    const file = readContainerConfig('agent');
    expect(file.mcpServers.datafold).toEqual({
      type: 'http',
      url: 'https://app.datafold.com/mcp/',
      headers: { Authorization: 'Key onecli-managed' },
    });
    // Servers already in the file, and unrelated operator-owned fields, survive.
    expect(file.mcpServers.existing).toBeDefined();
    expect(file.onecliSecrets).toEqual(['Keep-Me']);
    expect(JSON.parse(getContainerConfig('ag-1')!.mcp_servers)).toEqual(file.mcpServers);
  });

  it('tells the agent how a 401 gets fixed when the server authenticates', async () => {
    // Declaring the placeholder wires the header; the gateway can only
    // substitute a secret ASSIGNED to the group, and auto-created agents
    // default to selective mode with nothing assigned.
    await applyAddMcpServer(
      {
        name: 'datafold',
        type: 'http',
        url: 'https://app.datafold.com/mcp/',
        headers: { Authorization: 'Key onecli-managed' },
      },
      session,
    );
    const note = vi.mocked(writeSessionMessage).mock.calls.at(-1)!;
    const text = (JSON.parse(note[2].content) as { text: string }).text;
    expect(text).toContain('401');
    expect(text).toContain('onecliSecrets');

    // A server that authenticates with nothing gets no such tail — including
    // one that carries only a configuration header. Claiming OneCLI auth there
    // would send an operator after a credential that does not exist.
    for (const server of [
      { name: 'deepwiki', type: 'http', url: 'https://mcp.deepwiki.com/mcp' },
      {
        name: 'plainheaders',
        type: 'http',
        url: 'https://mcp.deepwiki.com/mcp',
        headers: { 'Content-Type': 'application/json' },
      },
      { name: 'fs2', command: 'mcp-fs', args: [], env: {} },
    ]) {
      vi.mocked(writeSessionMessage).mockClear();
      await applyAddMcpServer(server, session);
      const plain = vi.mocked(writeSessionMessage).mock.calls.at(-1)!;
      expect((JSON.parse(plain[2].content) as { text: string }).text).not.toContain('401');
    }
  });

  it('writes a stdio server the same way', async () => {
    await applyAddMcpServer({ name: 'fs', command: 'mcp-fs', args: ['/data'], env: {} }, session);
    expect(readContainerConfig('agent').mcpServers.fs).toEqual({ command: 'mcp-fs', args: ['/data'], env: {} });
  });

  it('refuses an approved payload that no longer validates, leaving both stores untouched', async () => {
    await applyAddMcpServer({ name: 'leaky', url: 'https://example.com/mcp?api_key=abc' }, session);
    expect(readContainerConfig('agent').mcpServers.leaky).toBeUndefined();
    expect(JSON.parse(getContainerConfig('ag-1')!.mcp_servers).leaky).toBeUndefined();
  });
});
