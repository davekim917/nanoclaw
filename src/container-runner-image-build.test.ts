/**
 * `buildAgentGroupImage` must record the tag where the spawn reads it: the
 * spawn picks its image from container.json's `imageTag`, never from the
 * `container_configs` projection.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: globalThis.uniqueTmpRoot('image-build') }));

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: TEST_DIR,
  GROUPS_DIR: `${TEST_DIR}/groups`,
}));

const built = vi.hoisted(() => ({ commands: [] as string[] }));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  exec: (command: string, _options: unknown, callback: (err: Error | null, stdout: string) => void) => {
    built.commands.push(command);
    callback(null, '');
  },
}));

import { CONTAINER_IMAGE_BASE } from './config.js';
import { readContainerConfig, writeContainerConfig } from './container-config.js';
import { buildAgentGroupImage } from './container-runner.js';
import { createAgentGroup } from './db/agent-groups.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigJson } from './db/container-configs.js';
import { closeDb, getRawDb, initTestDb, runMigrations } from './db/index.js';

beforeEach(async () => {
  built.commands = [];
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(`${TEST_DIR}/groups/agent`, { recursive: true });
  await initTestDb();
  runMigrations(getRawDb());
  await createAgentGroup({
    id: 'ag-1',
    name: 'Agent',
    folder: 'agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await ensureContainerConfig('ag-1');
  await updateContainerConfigJson('ag-1', 'packages_apt', ['jq']);
  writeContainerConfig('agent', {
    mcpServers: {},
    packages: { apt: ['jq'], npm: [] },
    additionalMounts: [],
    skills: 'all',
    onecliSecrets: ['Keep-Me'],
  });
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('buildAgentGroupImage', () => {
  it('records the built tag in container.json AND the DB projection', async () => {
    await buildAgentGroupImage('ag-1');

    const tag = `${CONTAINER_IMAGE_BASE}:ag-1`;
    expect(built.commands).toEqual([expect.stringContaining(`build -t ${tag} `)]);
    const file = readContainerConfig('agent');
    expect(file.imageTag).toBe(tag);
    expect(file.onecliSecrets).toEqual(['Keep-Me']);
    expect((await getContainerConfig('ag-1'))!.image_tag).toBe(tag);
  });
});
