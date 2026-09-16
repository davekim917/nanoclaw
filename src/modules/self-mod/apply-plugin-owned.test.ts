/**
 * Fork-only: an approved `add_mcp_server` naming a plugin-owned server is
 * refused before either store is touched, and the refusal finalizes even
 * when the agent notification cannot be written (Codex on #486, rounds 2-3).
 * Setup mirrors apply.test.ts; kept apart so the upstream-owned file stays
 * byte-stable for the ratchet.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({
  TEST_DIR: globalThis.uniqueTmpRoot('self-mod-apply-plugin-owned'),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR, GROUPS_DIR: `${TEST_DIR}/groups` };
});

vi.mock('../../container-runner.js', () => ({
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
  killContainer: vi.fn(),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});

import { readContainerConfig, updateContainerConfig, writeContainerConfig } from '../../container-config.js';
import { writeSessionMessage } from '../../session-manager.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initMigratedTestDb } from '../../db/index.js';
import { ensureContainerConfig, getContainerConfig } from '../../db/container-configs.js';
import { createSession } from '../../db/sessions.js';
import type { Session } from '../../types.js';
import { applyAddMcpServer } from './apply.js';

function now(): string {
  return new Date().toISOString();
}

let session: Session;

beforeEach(async () => {
  vi.clearAllMocks();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(`${TEST_DIR}/groups/agent`, { recursive: true });
  await initMigratedTestDb();
  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  await ensureContainerConfig('ag-1');
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
  await createSession(session);
  writeContainerConfig('agent', {
    mcpServers: { existing: { command: 'mcp-existing', args: [], env: {} } },
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all',
    onecliSecrets: [],
  });
  await updateContainerConfig('agent', (cfg) => {
    // `plugin` is the provenance marker a template stamps; the runtime type
    // does not declare it, exactly as on disk.
    (cfg as { mcpServers?: Record<string, unknown> }).mcpServers = {
      ...(cfg.mcpServers ?? {}),
      owned: { command: 'plugin-owned', plugin: 'some-plugin' },
    };
  });
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

async function expectStoresUntouched(): Promise<void> {
  expect(readContainerConfig('agent').mcpServers.owned).toMatchObject({
    command: 'plugin-owned',
    plugin: 'some-plugin',
  });
  expect(JSON.parse((await getContainerConfig('ag-1'))!.mcp_servers).owned).toBeUndefined();
}

describe('applyAddMcpServer — plugin-owned servers', () => {
  it('refuses to overwrite a plugin-owned server, leaving both stores untouched (#486 round 2)', async () => {
    await applyAddMcpServer({ name: 'owned', command: 'mine', args: [], env: {} }, session);
    await expectStoresUntouched();
    const notes = vi.mocked(writeSessionMessage).mock.calls.map(([, , msg]) => JSON.parse(String(msg.content)).text);
    expect(notes.some((text: string) => /managed by plugin "some-plugin"/.test(text) && !/restamp/i.test(text))).toBe(
      true,
    );
  });

  it('finalizes the refusal even when the notification cannot be written (#486 round 3)', async () => {
    vi.mocked(writeSessionMessage).mockRejectedValueOnce(new Error('session DB unavailable'));
    // A rejected notify must not escape: the approval handler's catch would
    // otherwise retry the same dead session DB and leave the approval pending.
    await expect(
      applyAddMcpServer({ name: 'owned', command: 'mine', args: [], env: {} }, session),
    ).resolves.toBeUndefined();
    await expectStoresUntouched();
  });
});
