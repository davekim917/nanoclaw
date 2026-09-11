import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { DATA_DIR } = vi.hoisted(() => ({ DATA_DIR: `${uniqueTmpRoot('plugin-scopes-test')}/data` }));

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR,
}));

import {
  PLUGIN_SCOPES_POLICY_PATH,
  loadPluginScopes,
  parsePluginScopes,
  pluginAllowedForWorkgroup,
  scopedPluginNames,
} from './plugin-scopes.js';

function writePolicy(policy: unknown): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PLUGIN_SCOPES_POLICY_PATH, typeof policy === 'string' ? policy : JSON.stringify(policy));
}

beforeEach(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('loadPluginScopes', () => {
  it('scopes nothing when there is no policy file', () => {
    expect(PLUGIN_SCOPES_POLICY_PATH).toBe(path.join(DATA_DIR, 'plugin-scopes.json'));
    expect(loadPluginScopes().size).toBe(0);
  });

  it('reads plugin → workgroup lists', () => {
    writePolicy({ version: 1, plugins: { 'client-plugin': ['client-wg', 'client-dev'], retired: [] } });
    const scopes = loadPluginScopes();
    expect([...(scopes.get('client-plugin') ?? [])]).toEqual(['client-wg', 'client-dev']);
    expect([...(scopes.get('retired') ?? [])]).toEqual([]);
    expect([...scopedPluginNames(scopes)].sort()).toEqual(['client-plugin', 'retired']);
  });

  it('throws on a policy that does not parse rather than guessing', () => {
    writePolicy('{ not json');
    expect(() => loadPluginScopes()).toThrow('JSON parse failed');
  });

  it.each([
    ['a non-object top level', []],
    ['a wrong version', { version: 2, plugins: {} }],
    ['an unknown top-level key', { version: 1, plugins: {}, extra: true }],
    ['plugins that is not an object', { version: 1, plugins: ['client-plugin'] }],
    ['a plugin name with a separator', { version: 1, plugins: { 'a/b': ['client-wg'] } }],
    ['a plugin name of ..', { version: 1, plugins: { '..': ['client-wg'] } }],
    ['a workgroup list that is not an array', { version: 1, plugins: { 'client-plugin': 'client-wg' } }],
    ['a workgroup ID that is not a slug', { version: 1, plugins: { 'client-plugin': ['Client WG'] } }],
  ])('throws on %s', (_label, policy) => {
    expect(() => parsePluginScopes(JSON.stringify(policy))).toThrow('Invalid plugin scope policy');
  });
});

describe('pluginAllowedForWorkgroup', () => {
  const scopes = parsePluginScopes(
    JSON.stringify({ version: 1, plugins: { 'client-plugin': ['client-wg'], retired: [] } }),
  );

  it('delivers an unscoped plugin everywhere, as before', () => {
    expect(pluginAllowedForWorkgroup('shared-plugin', 'other-wg', scopes)).toBe(true);
    expect(pluginAllowedForWorkgroup('shared-plugin', undefined, scopes)).toBe(true);
  });

  it('delivers a scoped plugin only to its workgroups', () => {
    expect(pluginAllowedForWorkgroup('client-plugin', 'client-wg', scopes)).toBe(true);
    expect(pluginAllowedForWorkgroup('client-plugin', 'other-wg', scopes)).toBe(false);
  });

  it('withholds a scoped plugin when the workgroup is unknown', () => {
    expect(pluginAllowedForWorkgroup('client-plugin', undefined, scopes)).toBe(false);
    expect(pluginAllowedForWorkgroup('client-plugin', null, scopes)).toBe(false);
  });

  it('delivers a plugin scoped to an empty list nowhere', () => {
    expect(pluginAllowedForWorkgroup('retired', 'client-wg', scopes)).toBe(false);
  });
});
