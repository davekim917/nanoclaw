import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const { TEST_ROOT } = vi.hoisted(() => ({ TEST_ROOT: uniqueTmpRoot('opencode-sync-test') }));

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: `${TEST_ROOT}/data`,
}));

// NOT spread: log.ts installs process-wide handlers at module scope.
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));

import { syncOpenCodePluginSkills, syncOpenCodeSubagents } from './opencode-sync.js';

const HOME = path.join(TEST_ROOT, 'home');
const GLOBAL_SKILLS = path.join(HOME, '.config', 'opencode', 'skill');
const GLOBAL_AGENTS = path.join(HOME, '.config', 'opencode', 'agent');

function pluginSkill(plugin: string, name: string): void {
  const dir = path.join(HOME, 'plugins', plugin, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill ${name}.\n---\n\nBody.\n`);
}

function pluginAgent(plugin: string, name: string): void {
  const dir = path.join(HOME, 'plugins', plugin, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: Test agent ${name}.\n---\n\nYou are ${name}.\n`,
  );
}

function scopePlugins(plugins: Record<string, string[]>): void {
  fs.mkdirSync(path.join(TEST_ROOT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(TEST_ROOT, 'data', 'plugin-scopes.json'), JSON.stringify({ version: 1, plugins }));
}

let homedirSpy: MockInstance<typeof os.homedir>;

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(HOME);
  pluginSkill('client-plugin', 'client-skill');
  pluginSkill('shared-plugin', 'shared-skill');
});

afterEach(() => {
  homedirSpy.mockRestore();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('syncOpenCodePluginSkills with workgroup-scoped plugins (src/plugin-scopes.ts)', () => {
  it('mirrors every portable skill when nothing is scoped', () => {
    syncOpenCodePluginSkills();
    expect(fs.existsSync(path.join(GLOBAL_SKILLS, 'client-skill'))).toBe(true);
    expect(fs.existsSync(path.join(GLOBAL_SKILLS, 'shared-skill'))).toBe(true);
  });

  it('never mirrors a scoped plugin skill, and prunes one mirrored before it was scoped', () => {
    syncOpenCodePluginSkills();
    expect(fs.existsSync(path.join(GLOBAL_SKILLS, 'client-skill'))).toBe(true);

    scopePlugins({ 'client-plugin': ['client-wg'] });
    syncOpenCodePluginSkills();

    expect(fs.existsSync(path.join(GLOBAL_SKILLS, 'client-skill'))).toBe(false);
    expect(fs.existsSync(path.join(GLOBAL_SKILLS, 'shared-skill'))).toBe(true);
  });

  it('lets an unscoped plugin keep a skill name a scoped plugin also uses', () => {
    pluginSkill('a-client', 'dup-skill');
    pluginSkill('b-shared', 'dup-skill');
    fs.appendFileSync(path.join(HOME, 'plugins', 'b-shared', 'skills', 'dup-skill', 'SKILL.md'), 'FROM_B_SHARED\n');
    scopePlugins({ 'a-client': ['client-wg'] });

    syncOpenCodePluginSkills();

    expect(fs.readFileSync(path.join(GLOBAL_SKILLS, 'dup-skill', 'SKILL.md'), 'utf-8')).toContain('FROM_B_SHARED');
  });

  it('keeps a scoped plugin skill out of per-sibling targets too', () => {
    const sibling = path.join(HOME, '.local', 'share', 'opencode-client-wg-opencode');
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'auth.json'), '{}');
    scopePlugins({ 'client-plugin': ['client-wg'] });

    const result = syncOpenCodePluginSkills();

    expect(result.targets).toContain(path.join(sibling, 'skill'));
    expect(fs.existsSync(path.join(sibling, 'skill', 'client-skill'))).toBe(false);
    expect(fs.existsSync(path.join(sibling, 'skill', 'shared-skill'))).toBe(true);
  });
});

describe('syncOpenCodePluginSkills containment (#829)', () => {
  it('mirrors an in-repo support dir but refuses a child linked out of the plugin', () => {
    // A support dir is a non-skill sibling of a skills root (e.g.
    // workflow-agents/skills/shared/), mirrored as per-child symlinks the
    // session copy later DEREFERENCES into a container. So a child linked out
    // of the plugin would move host-only state across that boundary.
    const support = path.join(HOME, 'plugins', 'shared-plugin', 'skills', 'shared');
    fs.mkdirSync(support, { recursive: true });
    fs.writeFileSync(path.join(support, 'primitives.md'), 'in-repo primitives');
    const secret = path.join(TEST_ROOT, 'host-only-auth.json');
    fs.writeFileSync(secret, 'HOST-ONLY-SECRET');
    fs.symlinkSync(secret, path.join(support, 'stolen.md'));
    // And a child linked into a DIFFERENT plugin, which a union-of-roots
    // boundary would admit.
    fs.symlinkSync(
      path.join(HOME, 'plugins', 'client-plugin', 'skills', 'client-skill', 'SKILL.md'),
      path.join(support, 'cross.md'),
    );

    const result = syncOpenCodePluginSkills();

    const mirrored = path.join(GLOBAL_SKILLS, 'shared');
    expect(fs.existsSync(path.join(mirrored, 'primitives.md'))).toBe(true);
    expect(fs.existsSync(path.join(mirrored, 'stolen.md'))).toBe(false);
    expect(fs.existsSync(path.join(mirrored, 'cross.md'))).toBe(false);
    expect(result.refused).toEqual(expect.arrayContaining(['shared/stolen.md', 'shared/cross.md']));
  });

  it('records the source repository in each mirror dir marker', () => {
    syncOpenCodePluginSkills();
    const marker = fs.readFileSync(path.join(GLOBAL_SKILLS, 'shared-skill', '.nanoclaw-managed'), 'utf-8');
    expect(marker).toContain(
      `source-root: ${JSON.stringify(fs.realpathSync(path.join(HOME, 'plugins', 'shared-plugin')))}`,
    );
  });
});

describe('syncOpenCodeSubagents with workgroup-scoped plugins (src/plugin-scopes.ts)', () => {
  it('never mirrors a scoped plugin agent, and prunes one mirrored before it was scoped', () => {
    pluginAgent('client-plugin', 'client-agent');
    pluginAgent('shared-plugin', 'shared-agent');
    syncOpenCodeSubagents();
    expect(fs.existsSync(path.join(GLOBAL_AGENTS, 'client-agent.md'))).toBe(true);

    scopePlugins({ 'client-plugin': ['client-wg'] });
    syncOpenCodeSubagents();

    expect(fs.existsSync(path.join(GLOBAL_AGENTS, 'client-agent.md'))).toBe(false);
    expect(fs.existsSync(path.join(GLOBAL_AGENTS, 'shared-agent.md'))).toBe(true);
  });
});
