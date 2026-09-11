import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { DATA_DIR, warn } = vi.hoisted(() => ({
  DATA_DIR: `${uniqueTmpRoot('plugin-scopes-test')}/data`,
  warn: vi.fn(),
}));

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR,
}));

// NOT spread: log.ts installs process-wide handlers at module scope.
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));

import {
  PLUGIN_SCOPES_POLICY_PATH,
  loadPluginScopes,
  parsePluginScopes,
  pluginAllowedForWorkgroup,
  scopedPluginNames,
  warnUnmatchedPluginScopes,
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

describe('warnUnmatchedPluginScopes', () => {
  it('warns once for a scoped name that matches no plugin directory, and never for one that does', () => {
    warn.mockClear();
    const scopes = parsePluginScopes(
      JSON.stringify({ version: 1, plugins: { 'typo-plugin': ['client-wg'], 'real-plugin': ['client-wg'] } }),
    );
    warnUnmatchedPluginScopes(scopes, ['real-plugin', 'shared-plugin']);
    warnUnmatchedPluginScopes(scopes, ['real-plugin', 'shared-plugin']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({ plugin: 'typo-plugin' });
  });
});
