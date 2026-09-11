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

import { syncOpenCodePluginSkills } from './opencode-sync.js';

const HOME = path.join(TEST_ROOT, 'home');
const GLOBAL_SKILLS = path.join(HOME, '.config', 'opencode', 'skill');

function pluginSkill(plugin: string, name: string): void {
  const dir = path.join(HOME, 'plugins', plugin, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill ${name}.\n---\n\nBody.\n`);
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
