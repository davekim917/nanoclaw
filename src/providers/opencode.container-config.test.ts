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
  fs.writeFileSync(path.join(shared, 'auth.json'), '{"opencode-go":{"type":"oauth"}}');
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

  it('creates a missing runtime parent chain, reconciles stale entries, and preserves opencode.db', () => {
    const fn = getProviderContainerConfig('opencode')!;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-opencode-stale-'));
    const ctx = makeCtx(root);
    const home = ctx.hostEnv.HOME!;
    const runtime = runtimeDir(ctx.sessionDir);
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

      expect(fs.readFileSync(path.join(runtime, 'auth.json'), 'utf8')).toBe('{"opencode-go":{"type":"oauth"}}');
      expect(fs.existsSync(path.join(runtime, 'agent', 'scoped.md'))).toBe(true);
      expect(fs.existsSync(path.join(runtime, 'agent', 'global.md'))).toBe(false);
      expect(fs.existsSync(path.join(runtime, 'skill', 'scoped-skill', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(runtime, 'skill', 'global-skill'))).toBe(false);
      expect(contribution.env?.NO_PROXY).not.toContain('opencode.ai');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps scoped auth authoritative when shared auth has a different provider', () => {
    const fn = getProviderContainerConfig('opencode')!;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-opencode-scoped-auth-'));
    const ctx = makeCtx(root);
    const home = ctx.hostEnv.HOME!;
    const scoped = path.join(home, '.local', 'share', 'opencode-example-opencode');
    const shared = path.join(home, '.local', 'share', 'opencode');
    writeGlobalSources(home);
    fs.writeFileSync(path.join(shared, 'auth.json'), '{"anthropic":{"type":"oauth"}}');
    fs.mkdirSync(scoped, { recursive: true });
    fs.writeFileSync(path.join(scoped, 'auth.json'), '{"opencode-go":{"type":"oauth"}}');

    try {
      fn(ctx);
      expect(fs.readFileSync(path.join(runtimeDir(ctx.sessionDir), 'auth.json'), 'utf8')).toBe(
        '{"opencode-go":{"type":"oauth"}}',
      );
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
      expect(fs.readFileSync(path.join(runtime, 'auth.json'), 'utf8')).toBe('{"opencode-go":{"type":"oauth"}}');
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

  it('leaves effective-model proxy routing to the container runtime', () => {
    const fn = getProviderContainerConfig('opencode')!;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-opencode-matching-auth-'));
    const ctx = makeCtx(root);
    writeGlobalSources(ctx.hostEnv.HOME!);

    try {
      const contribution = fn(ctx);
      expect(contribution.env?.OPENCODE_PROVIDER).toBe('opencode-go');
      expect(contribution.env?.NO_PROXY?.split(',')).not.toContain('opencode.ai');
      expect(contribution.env?.no_proxy?.split(',')).not.toContain('opencode.ai');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['unrelated auth', '{"nvidia":{"type":"api"}}'],
    ['malformed auth', '{not-json'],
  ])('keeps OneCLI active for %s', (_label, auth) => {
    const fn = getProviderContainerConfig('opencode')!;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-opencode-nonmatching-auth-'));
    const ctx = makeCtx(root);
    const home = ctx.hostEnv.HOME!;
    writeGlobalSources(home);
    fs.writeFileSync(path.join(home, '.local', 'share', 'opencode', 'auth.json'), auth);

    try {
      const contribution = fn(ctx);
      expect(contribution.env?.OPENCODE_PROVIDER).toBe('opencode-go');
      expect(contribution.env?.NO_PROXY?.split(',')).not.toContain('opencode.ai');
      expect(contribution.env?.no_proxy?.split(',')).not.toContain('opencode.ai');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('forwards model capability declarations only when the host env sets them', () => {
    const fn = getProviderContainerConfig('opencode')!;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-opencode-caps-'));
    const ctx = makeCtx(root);
    writeGlobalSources(ctx.hostEnv.HOME!);

    try {
      // Default: a group that declares nothing gets exactly the env it got before.
      const bare = fn(ctx);
      expect(bare.env?.OPENCODE_MODEL_CONTEXT_LIMIT).toBeUndefined();
      expect(bare.env?.OPENCODE_MODEL_OUTPUT_LIMIT).toBeUndefined();
      expect(bare.env?.OPENCODE_MODEL_INPUT_MODALITIES).toBeUndefined();

      const declared = fn(
        makeCtx(root, {
          hostEnv: {
            HOME: ctx.hostEnv.HOME,
            OPENCODE_MODEL_CONTEXT_LIMIT: '128000',
            OPENCODE_MODEL_OUTPUT_LIMIT: '8192',
            OPENCODE_MODEL_INPUT_MODALITIES: 'image,pdf',
          } as NodeJS.ProcessEnv,
        }),
      );
      expect(declared.env?.OPENCODE_MODEL_CONTEXT_LIMIT).toBe('128000');
      expect(declared.env?.OPENCODE_MODEL_OUTPUT_LIMIT).toBe('8192');
      expect(declared.env?.OPENCODE_MODEL_INPUT_MODALITIES).toBe('image,pdf');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers the folder-scoped capability var over the bare one, and drops blanks', () => {
    const fn = getProviderContainerConfig('opencode')!;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-opencode-caps-scoped-'));
    const base = makeCtx(root);
    writeGlobalSources(base.hostEnv.HOME!);

    try {
      // agentGroupFolder is 'example-opencode' -> EXAMPLE_OPENCODE.
      const contribution = fn(
        makeCtx(root, {
          hostEnv: {
            HOME: base.hostEnv.HOME,
            OPENCODE_MODEL_CONTEXT_LIMIT: '64000',
            OPENCODE_MODEL_CONTEXT_LIMIT_EXAMPLE_OPENCODE: '256000',
            OPENCODE_MODEL_OUTPUT_LIMIT: '   ',
          } as NodeJS.ProcessEnv,
        }),
      );
      expect(contribution.env?.OPENCODE_MODEL_CONTEXT_LIMIT).toBe('256000');
      // A blank value is not a declaration — it must not reach the container as
      // one, since the container side treats blank as invalid anyway.
      expect(contribution.env?.OPENCODE_MODEL_OUTPUT_LIMIT).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps OneCLI active when auth is absent', () => {
    const fn = getProviderContainerConfig('opencode')!;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-opencode-no-auth-'));
    const ctx = makeCtx(root);
    const home = ctx.hostEnv.HOME!;
    writeGlobalSources(home);
    fs.rmSync(path.join(home, '.local', 'share', 'opencode', 'auth.json'));

    try {
      const contribution = fn(ctx);
      expect(contribution.env?.NO_PROXY?.split(',')).not.toContain('opencode.ai');
      expect(contribution.env?.no_proxy?.split(',')).not.toContain('opencode.ai');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
