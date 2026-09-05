import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT } = vi.hoisted(() => ({ TEST_ROOT: uniqueTmpRoot('group-init-settings-test') }));

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: `${TEST_ROOT}/data`,
  GROUPS_DIR: `${TEST_ROOT}/groups`,
}));

// NOT spread: log.ts installs process-wide uncaughtException/unhandledRejection
// handlers (including process.exit(1)) at module scope — importOriginal() would
// install those in this test file's worker. Kept as a complete stub instead.
// (davekim917/nanoclaw#355 review thread)
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));

import { closeDb, createAgentGroup, initTestDb, runMigrations, getRawDb } from './db/index.js';
import { initGroupFilesystem } from './group-init.js';
import type { AgentGroup } from './types.js';

async function makeGroup(id: string): Promise<AgentGroup> {
  const ag = { id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
  await createAgentGroup(ag);
  return ag;
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await initTestDb();
  runMigrations(getRawDb());
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('default settings.json for new groups', () => {
  it('keeps the customized agent-teams and memory-boundary settings', async () => {
    const ag = await makeGroup('ag-lean');
    initGroupFilesystem(ag, {});

    const file = path.join(TEST_ROOT, 'data', 'v2-sessions', ag.id, '.claude-shared', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(file, 'utf-8'));

    expect(settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
    expect(settings.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe('1');
    expect(settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(settings.autoMemoryEnabled).toBe(false);
    expect(JSON.stringify(settings.hooks.PreCompact)).toContain('compact-instructions');
    expect(settings.hooks.PreToolUse).toBeUndefined();
  });

  it('never rewrites an existing settings.json — a hand-edited re-enable sticks', async () => {
    const ag = await makeGroup('ag-reenable');
    initGroupFilesystem(ag, {});
    const file = path.join(TEST_ROOT, 'data', 'v2-sessions', ag.id, '.claude-shared', 'settings.json');

    // Operator re-enables both features by editing the file (the documented path).
    const edited = JSON.parse(fs.readFileSync(file, 'utf-8'));
    delete edited.disableWorkflows;
    edited.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
    fs.writeFileSync(file, JSON.stringify(edited, null, 2) + '\n');

    initGroupFilesystem(ag, {}); // next spawn

    const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(after.disableWorkflows).toBeUndefined();
    expect(after.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
  });
});
