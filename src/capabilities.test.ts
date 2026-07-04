import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dirs = vi.hoisted(() => {
  const testRoot = '/tmp/nanoclaw-capabilities-test';
  return {
    TEST_ROOT: testRoot,
    GROUPS_DIR: '/tmp/nanoclaw-capabilities-test/groups',
  };
});

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  GROUPS_DIR: dirs.GROUPS_DIR,
}));

import { buildSessionServicesSnapshot, renderSessionCapabilities } from './capabilities.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from './db/index.js';
import { writeContainerConfig } from './container-config.js';
import type { AgentGroup } from './types.js';

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

function insertWorkgroup(id: string, onecliSecrets: string[]): void {
  getDb()
    .prepare(
      `INSERT INTO workgroups (id, display_name, onecli_secrets, mnemon_store_id, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    )
    .run(id, id, JSON.stringify(onecliSecrets), `ag-${id}`);
}

function createGroupInWorkgroup(agentGroup: AgentGroup, workgroupId: string): void {
  createAgentGroup(agentGroup);
  getDb().prepare('UPDATE agent_groups SET workgroup_id = ? WHERE id = ?').run(workgroupId, agentGroup.id);
  writeContainerConfig(agentGroup.folder, {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all',
    tools: [],
  });
}

beforeEach(() => {
  fs.rmSync(dirs.TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(dirs.GROUPS_DIR, { recursive: true });
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
  fs.rmSync(dirs.TEST_ROOT, { recursive: true, force: true });
});

describe('buildSessionServicesSnapshot', () => {
  it('surfaces Profound when the workgroup declares the Profound OneCLI secret', () => {
    insertWorkgroup('madison-reed', ['Profound']);
    const ag = group('ag-mr', 'madison-reed');
    createGroupInWorkgroup(ag, 'madison-reed');

    const snapshot = buildSessionServicesSnapshot(ag.id);

    const service = snapshot.services.find((s) => s.name === 'Profound');
    expect(service).toBeDefined();
    expect(service?.cli).toBe('curl');
    expect(service?.scopes).toEqual(['madison-reed']);
    expect(service?.useFor).toContain('api.tryprofound.com');
    expect(service?.useFor).toContain('X-API-Key');
    expect(service?.useFor).not.toContain('/app/skills/profound/SKILL.md');

    const rendered = renderSessionCapabilities(snapshot);
    expect(rendered).toContain('**Profound**');
    expect(rendered).toContain('Madison Reed Profound REST/reporting API');
  });

  it('does not surface Profound without the Profound OneCLI secret', () => {
    insertWorkgroup('illysium', []);
    const ag = group('ag-illysium', 'illysium');
    createGroupInWorkgroup(ag, 'illysium');

    const snapshot = buildSessionServicesSnapshot(ag.id);

    expect(snapshot.services.some((s) => s.name === 'Profound')).toBe(false);
  });
});
