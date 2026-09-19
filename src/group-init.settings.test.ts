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
import { CLAUDE_MAX_CONCURRENT_SUBAGENTS, CLAUDE_MAX_SUBAGENT_SPAWN_DEPTH } from './claude-spawn-defaults.js';
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

describe('quota env reconciliation (PR #810 F2)', () => {
  it('overwrites conflicting subagent caps and scrubs the compact-window pin', async () => {
    const ag = await makeGroup('ag-quota-env');
    initGroupFilesystem(ag, {});
    const file = path.join(TEST_ROOT, 'data', 'v2-sessions', ag.id, '.claude-shared', 'settings.json');

    // A fresh file carries the managed caps, equal to what claudeSpawnEnv sends.
    const fresh = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(fresh.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBe(CLAUDE_MAX_SUBAGENT_SPAWN_DEPTH);
    expect(fresh.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe(CLAUDE_MAX_CONCURRENT_SUBAGENTS);
    expect(fresh.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
    expect(fresh.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBeUndefined();

    // Seed the shadowing shape: a hand-edit (or a pre-#810 file) with values
    // that disagree with the spawn `-e`.
    fresh.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = '5';
    fresh.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = '20';
    fresh.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '1000000';
    // Every group initialized before 2026-09-19 carries this, because
    // REQUIRED_ENV pinned it. Removing it from REQUIRED_ENV alone would leave
    // the 80 in place in each existing file; only the DEPRECATED_ENV listing
    // scrubs it, and this is the assertion that holds that apart.
    fresh.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '80';
    fs.writeFileSync(file, JSON.stringify(fresh, null, 2) + '\n');

    initGroupFilesystem(ag, {}); // next spawn

    const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(after.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBe(CLAUDE_MAX_SUBAGENT_SPAWN_DEPTH);
    expect(after.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe(CLAUDE_MAX_CONCURRENT_SUBAGENTS);
    expect(after.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
    expect(after.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBeUndefined();
  });
});

describe('skillOverrides (listing diet)', () => {
  it('hides zero-use bundled skills but keeps them /name-invocable, on new and existing groups', async () => {
    const ag = await makeGroup('ag-skills');
    initGroupFilesystem(ag, {});
    const file = path.join(TEST_ROOT, 'data', 'v2-sessions', ag.id, '.claude-shared', 'settings.json');
    const fresh = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(fresh.skillOverrides['update-config']).toBe('user-invocable-only');
    expect(fresh.skillOverrides['claude-api']).toBe('name-only');
    // No entry may use 'off' — that would make a skill uninvocable even by name.
    expect(Object.values(fresh.skillOverrides)).not.toContain('off');

    // An existing group predating the key picks it up on the next spawn.
    delete fresh.skillOverrides;
    fs.writeFileSync(file, JSON.stringify(fresh, null, 2) + '\n');
    initGroupFilesystem(ag, {});
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).skillOverrides.loop).toBe('user-invocable-only');
  });

  it('does not rewrite settings.json on every spawn once the object setting already matches', async () => {
    const ag = await makeGroup('ag-stable');
    initGroupFilesystem(ag, {});
    const file = path.join(TEST_ROOT, 'data', 'v2-sessions', ag.id, '.claude-shared', 'settings.json');
    const spy = vi.spyOn(fs, 'writeFileSync');
    initGroupFilesystem(ag, {});
    expect(spy.mock.calls.filter(([target]) => target === file)).toHaveLength(0);
    spy.mockRestore();
  });

  it("keeps a group's own skill overrides when adding ours", async () => {
    const ag = await makeGroup('ag-own');
    initGroupFilesystem(ag, {});
    const file = path.join(TEST_ROOT, 'data', 'v2-sessions', ag.id, '.claude-shared', 'settings.json');
    const s = JSON.parse(fs.readFileSync(file, 'utf-8'));
    s.skillOverrides = { 'custom-skill': 'off', loop: 'on' };
    fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
    initGroupFilesystem(ag, {});
    const after = JSON.parse(fs.readFileSync(file, 'utf-8')).skillOverrides;
    expect(after['custom-skill']).toBe('off');
    expect(after.loop).toBe('user-invocable-only');
    expect(after['update-config']).toBe('user-invocable-only');
  });
});
