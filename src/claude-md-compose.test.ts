import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-claude-md-compose-test';
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-claude-md-compose-test/groups',
}));

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { composeGroupClaudeMd } from './claude-md-compose.js';
import { ensureContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { PERSONA_PREPEND_FILE } from './group-persona.js';
import type { AgentGroup } from './types.js';

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

function seed(ag: AgentGroup): void {
  createAgentGroup(ag);
  ensureContainerConfig(ag.id);
}

function writePersona(folder: string, text: string): void {
  const dir = path.join(GROUPS_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, PERSONA_PREPEND_FILE), text);
}

function importsOf(folder: string): string[] {
  const md = fs.readFileSync(path.join(GROUPS_DIR, folder, 'CLAUDE.md'), 'utf-8');
  return md.split('\n').filter((line) => line.startsWith('@'));
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('composeGroupClaudeMd persona prepend', () => {
  it('imports the persona fragment FIRST, before the shared base', () => {
    const ag = group('ag-persona', 'persona-group');
    seed(ag);
    writePersona(ag.folder, 'You are an SDR agent.\n');

    composeGroupClaudeMd(ag, 'claude');

    const imports = importsOf(ag.folder);
    expect(imports[0]).toBe('@./.claude-fragments/persona.md');
    expect(imports[1]).toBe('@./.claude-shared.md');
    expect(fs.readFileSync(path.join(GROUPS_DIR, ag.folder, '.claude-fragments', 'persona.md'), 'utf-8')).toBe(
      'You are an SDR agent.',
    );
  });

  it('keeps the persona across a second compose (not pruned)', () => {
    const ag = group('ag-persona-2', 'persona-group-2');
    seed(ag);
    writePersona(ag.folder, 'persona body');

    composeGroupClaudeMd(ag, 'claude');
    composeGroupClaudeMd(ag, 'claude');

    expect(fs.existsSync(path.join(GROUPS_DIR, ag.folder, '.claude-fragments', 'persona.md'))).toBe(true);
    expect(importsOf(ag.folder)[0]).toBe('@./.claude-fragments/persona.md');
  });

  it('is inert when no persona file is present (non-template groups)', () => {
    const ag = group('ag-no-persona', 'no-persona-group');
    seed(ag);

    composeGroupClaudeMd(ag, 'claude');

    const imports = importsOf(ag.folder);
    expect(imports[0]).toBe('@./.claude-shared.md');
    expect(imports).not.toContain('@./.claude-fragments/persona.md');
    expect(fs.existsSync(path.join(GROUPS_DIR, ag.folder, '.claude-fragments', 'persona.md'))).toBe(false);
  });
});

describe('composeGroupClaudeMd scheduling instructions through ncl tasks', () => {
  it('imports module-cli.md with ncl tasks guidance and never imports module-scheduling.md', () => {
    const ag = group('ag-sched', 'sched-group');
    seed(ag);

    composeGroupClaudeMd(ag, 'claude');

    const imports = importsOf(ag.folder);
    expect(imports).toContain('@./.claude-fragments/module-cli.md');
    expect(imports).not.toContain('@./.claude-fragments/module-scheduling.md');
    expect(
      fs.readFileSync(
        path.join(process.cwd(), 'container', 'agent-runner', 'src', 'mcp-tools', 'cli.instructions.md'),
        'utf-8',
      ),
    ).toContain('ncl tasks create');
  });

  it('excludes all scheduling guidance when cli_scope is disabled', () => {
    const ag = group('ag-sched-off', 'sched-group-off');
    seed(ag);
    updateContainerConfigScalars(ag.id, { cli_scope: 'disabled' });

    composeGroupClaudeMd(ag, 'claude');

    const imports = importsOf(ag.folder);
    expect(imports).not.toContain('@./.claude-fragments/module-cli.md');
    expect(imports).not.toContain('@./.claude-fragments/module-scheduling.md');
  });
});

describe('session capability authority', () => {
  it('does not bake a group-only capability snapshot into composed instructions', () => {
    const ag = group('ag-no-group-caps', 'no-group-caps');
    seed(ag);

    composeGroupClaudeMd(ag, 'claude');

    expect(importsOf(ag.folder)).not.toContain('@./.claude-fragments/session-capabilities.md');
    expect(fs.existsSync(path.join(GROUPS_DIR, ag.folder, '.claude-fragments', 'session-capabilities.md'))).toBe(false);
  });
});

describe('CLAUDE.local.md reach across providers', () => {
  // Regression: operator standing instructions used to be Claude-only. Claude
  // Code auto-discovers CLAUDE.local.md, but Codex and OpenCode read only the
  // project doc, so per-group rules silently reached one sibling of three —
  // including trust-boundary rules ("never permanently delete an email", a
  // client's "never name AI tooling in these repos"), each of which was
  // measured at 0 hits in both of its non-Claude siblings' AGENTS.md.
  const RULE = 'Never permanently delete an email.';

  function withLocal(folder: string, body: string): void {
    const dir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CLAUDE.local.md'), body);
  }

  for (const provider of ['claude', 'codex', 'opencode']) {
    it(`flattens local standing instructions into AGENTS.md for ${provider}`, () => {
      const ag = group(`ag-local-${provider}`, `local-${provider}`);
      seed(ag);
      withLocal(ag.folder, `# Group rules\n\n${RULE}\n`);

      composeGroupClaudeMd(ag, provider);

      const agents = fs.readFileSync(path.join(GROUPS_DIR, ag.folder, 'AGENTS.md'), 'utf-8');
      expect(agents).toContain(RULE);
    });
  }

  it('creates the local file before flattening so a first spawn is not missing it', () => {
    const ag = group('ag-local-first', 'local-first');
    seed(ag);

    expect(() => composeGroupClaudeMd(ag, 'codex')).not.toThrow();
    expect(fs.existsSync(path.join(GROUPS_DIR, ag.folder, 'CLAUDE.local.md'))).toBe(true);
  });

  it('omits the standing-instructions heading when the local file is empty', () => {
    const ag = group('ag-local-empty', 'local-empty');
    seed(ag);
    withLocal(ag.folder, '   \n');

    composeGroupClaudeMd(ag, 'codex');

    const agents = fs.readFileSync(path.join(GROUPS_DIR, ag.folder, 'AGENTS.md'), 'utf-8');
    expect(agents).not.toContain('## Standing instructions for this group');
  });
});
