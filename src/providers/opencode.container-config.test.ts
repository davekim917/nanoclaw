/**
 * Regression tests for the OpenCode provider's host-side container config.
 *
 * The XDG mount is writable by a running container. Each later spawn must
 * reconcile only its managed entries without following container-planted
 * links, while preserving OpenCode's per-session database.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { getProviderContainerConfig, type ProviderContainerContext } from './provider-container-registry.js';
// Importing the module registers the host config callback.
import './opencode.js';

function makeCtx(root: string, overrides: Partial<ProviderContainerContext> = {}): ProviderContainerContext {
  return {
    sessionDir: path.join(root, 'session'),
    agentGroupId: 'group-1',
    agentGroupFolder: 'example-opencode',
    groupDir: path.join(root, 'group'),
    selectedSkills: [],
    hostEnv: { HOME: path.join(root, 'home') } as NodeJS.ProcessEnv,
    ...overrides,
  };
}

function runtimeDir(sessionDir: string): string {
  return path.join(sessionDir, 'opencode-xdg', 'opencode');
}

function writeGlobalSources(home: string): void {
  const shared = path.join(home, '.local', 'share', 'opencode');
  const config = path.join(home, '.config', 'opencode');
  fs.mkdirSync(path.join(config, 'agent'), { recursive: true });
  fs.mkdirSync(path.join(config, 'skill', 'global-skill'), { recursive: true });
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(shared, 'auth.json'), '{"global":true}');
  fs.writeFileSync(path.join(config, 'agent', 'global.md'), '# global agent\n');
  fs.writeFileSync(path.join(config, 'skill', 'global-skill', 'SKILL.md'), '# global skill\n');
}

describe('opencode provider container-config reconciliation', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
  });

  afterEach(() => {
    closeDb();
  });

  it('reconciles stale entries on a second spawn and preserves opencode.db', () => {
    const fn = getProviderContainerConfig('opencode')!;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-opencode-stale-'));
    const ctx = makeCtx(root);
    const home = ctx.hostEnv.HOME!;
    const runtime = runtimeDir(ctx.sessionDir);
    fs.mkdirSync(ctx.sessionDir, { recursive: true });
    writeGlobalSources(home);

    try {
      fn(ctx);
      fs.writeFileSync(path.join(runtime, 'opencode.db'), 'session-state');
      expect(fs.existsSync(path.join(runtime, 'auth.json'))).toBe(true);
      expect(fs.existsSync(path.join(runtime, 'agent', 'global.md'))).toBe(true);
      expect(fs.existsSync(path.join(runtime, 'skill', 'global-skill', 'SKILL.md'))).toBe(true);

      fs.rmSync(path.join(home, '.local', 'share', 'opencode', 'auth.json'));
      fs.rmSync(path.join(home, '.config', 'opencode', 'agent'), { recursive: true });
      fs.rmSync(path.join(home, '.config', 'opencode', 'skill'), { recursive: true });
      fn(ctx);

      expect(fs.existsSync(path.join(runtime, 'auth.json'))).toBe(false);
      expect(fs.existsSync(path.join(runtime, 'agent'))).toBe(false);
      expect(fs.existsSync(path.join(runtime, 'skill'))).toBe(false);
      expect(fs.readFileSync(path.join(runtime, 'opencode.db'), 'utf8')).toBe('session-state');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses scoped definitions without requiring scoped auth', () => {
    const fn = getProviderContainerConfig('opencode')!;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-opencode-scoped-defs-'));
    const ctx = makeCtx(root);
    const home = ctx.hostEnv.HOME!;
    const scoped = path.join(home, '.local', 'share', 'opencode-example-opencode');
    const runtime = runtimeDir(ctx.sessionDir);
    fs.mkdirSync(ctx.sessionDir, { recursive: true });
    writeGlobalSources(home);
    fs.mkdirSync(path.join(scoped, 'agent'), { recursive: true });
    fs.mkdirSync(path.join(scoped, 'skill', 'scoped-skill'), { recursive: true });
    fs.writeFileSync(path.join(scoped, 'agent', 'scoped.md'), '# scoped agent\n');
    fs.writeFileSync(path.join(scoped, 'skill', 'scoped-skill', 'SKILL.md'), '# scoped skill\n');

    try {
      const contribution = fn(ctx);

      expect(fs.readFileSync(path.join(runtime, 'auth.json'), 'utf8')).toBe('{"global":true}');
      expect(fs.existsSync(path.join(runtime, 'agent', 'scoped.md'))).toBe(true);
      expect(fs.existsSync(path.join(runtime, 'agent', 'global.md'))).toBe(false);
      expect(fs.existsSync(path.join(runtime, 'skill', 'scoped-skill', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(runtime, 'skill', 'global-skill'))).toBe(false);
      expect(contribution.env?.NO_PROXY).toContain('opencode.ai');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('replaces poisoned managed entries without following their links', () => {
    const fn = getProviderContainerConfig('opencode')!;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-opencode-poisoned-'));
    const ctx = makeCtx(root);
    const home = ctx.hostEnv.HOME!;
    const runtime = runtimeDir(ctx.sessionDir);
    const outside = path.join(root, 'outside');
    writeGlobalSources(home);
    fs.mkdirSync(runtime, { recursive: true });
    fs.mkdirSync(path.join(outside, 'agent'), { recursive: true });
    fs.mkdirSync(path.join(outside, 'skill'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'auth-sentinel'), 'keep');
    fs.writeFileSync(path.join(outside, 'agent', 'sentinel'), 'keep');
    fs.writeFileSync(path.join(outside, 'skill', 'sentinel'), 'keep');
    fs.symlinkSync(path.join(outside, 'auth-sentinel'), path.join(runtime, 'auth.json'));
    fs.symlinkSync(path.join(outside, 'agent'), path.join(runtime, 'agent'), 'dir');
    fs.symlinkSync(path.join(outside, 'skill'), path.join(runtime, 'skill'), 'dir');

    try {
      fn(ctx);

      expect(fs.readFileSync(path.join(outside, 'auth-sentinel'), 'utf8')).toBe('keep');
      expect(fs.readFileSync(path.join(outside, 'agent', 'sentinel'), 'utf8')).toBe('keep');
      expect(fs.readFileSync(path.join(outside, 'skill', 'sentinel'), 'utf8')).toBe('keep');
      expect(fs.lstatSync(path.join(runtime, 'auth.json')).isFile()).toBe(true);
      expect(fs.lstatSync(path.join(runtime, 'agent')).isDirectory()).toBe(true);
      expect(fs.lstatSync(path.join(runtime, 'skill')).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(runtime, 'auth.json'), 'utf8')).toBe('{"global":true}');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the OpenCode runtime root is a symlink', () => {
    const fn = getProviderContainerConfig('opencode')!;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-opencode-root-link-'));
    const ctx = makeCtx(root);
    const outside = path.join(root, 'outside');
    fs.mkdirSync(ctx.sessionDir, { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(ctx.sessionDir, 'opencode-xdg'), 'dir');

    try {
      expect(() => fn(ctx)).toThrow(/Unsafe runtime directory/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the OpenCode runtime subdirectory is a symlink', () => {
    const fn = getProviderContainerConfig('opencode')!;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-opencode-subdir-link-'));
    const ctx = makeCtx(root);
    const outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(ctx.sessionDir, 'opencode-xdg'), { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, runtimeDir(ctx.sessionDir), 'dir');

    try {
      expect(() => fn(ctx)).toThrow(/Unsafe runtime directory/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
