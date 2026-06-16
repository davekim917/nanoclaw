import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import BetterSQLite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';

import {
  dockerResourceLimitArgs,
  resolveAnthropicAuth,
  resolveCodexAuthFallbacks,
  resolveProviderName,
  reconcileWorkgroupAtSpawn,
  resolveMnemonStore,
} from './container-runner.js';
import { mergeWorkgroupAndGroupSecrets } from './onecli-secrets.js';
import { getProviderContainerConfig } from './providers/provider-container-registry.js';

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('dockerResourceLimitArgs', () => {
  it('adds install-wide default resource ceilings', () => {
    expect(dockerResourceLimitArgs()).toEqual([
      '--memory',
      '3g',
      '--memory-reservation',
      '2g',
      '--memory-swap',
      '3g',
      '--pids-limit',
      '512',
    ]);
  });
});

describe('resolveAnthropicAuth', () => {
  it('returns globals when no per-group token is set', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_2: 'global-oauth-2',
      CLAUDE_CODE_OAUTH_TOKEN_3: 'global-oauth-3',
      ANTHROPIC_API_KEY: 'global-key',
      ANTHROPIC_API_KEY_5: 'global-key-5',
    };
    const auth = resolveAnthropicAuth('any-folder', env);
    expect(auth.oauthPrimary).toBe('global-oauth');
    expect(auth.oauthFallbacks).toEqual([
      { index: 2, value: 'global-oauth-2' },
      { index: 3, value: 'global-oauth-3' },
    ]);
    expect(auth.apiKeyPrimary).toBe('global-key');
    expect(auth.apiKeyFallbacks).toEqual([{ index: 5, value: 'global-key-5' }]);
  });

  it('returns nothing when neither global nor per-group is set', () => {
    expect(resolveAnthropicAuth('madison-reed', {})).toEqual({
      oauthPrimary: undefined,
      oauthFallbacks: [],
      apiKeyPrimary: undefined,
      apiKeyFallbacks: [],
    });
  });

  it('per-group OAuth wins for the matching folder, ignoring globals entirely', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_2: 'global-oauth-2',
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED: 'mr-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED_2: 'mr-oauth-2',
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED_3: 'mr-oauth-3',
    };
    const auth = resolveAnthropicAuth('madison-reed', env);
    expect(auth.oauthPrimary).toBe('mr-oauth');
    // critical: no leakage from global rotation siblings into the workplace set
    expect(auth.oauthFallbacks).toEqual([
      { index: 2, value: 'mr-oauth-2' },
      { index: 3, value: 'mr-oauth-3' },
    ]);
  });

  it('filters the OneCLI "placeholder" sentinel from globals', () => {
    // When the host service is wrapped in `onecli run --`, the wrapper
    // injects CLAUDE_CODE_OAUTH_TOKEN=placeholder as a sentinel that its
    // own proxy substitutes at request time. The literal string is never
    // a real bearer credential — forwarding it into a container that
    // takes the Claude Max OAuth-bypass path strips OneCLI's
    // container-side substitution and emits `401 Invalid bearer token`.
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'placeholder',
      ANTHROPIC_API_KEY: 'placeholder',
    };
    const auth = resolveAnthropicAuth('any-folder', env);
    // Placeholder filtered; nothing real to promote → both fully empty.
    expect(auth.oauthPrimary).toBeUndefined();
    expect(auth.apiKeyPrimary).toBeUndefined();
    expect(auth.oauthFallbacks).toEqual([]);
    expect(auth.apiKeyFallbacks).toEqual([]);
  });

  it('promotes first real fallback to primary when global slot is placeholder', () => {
    // Production layout when host service is wrapped in `onecli run --`:
    // the wrapper sets CLAUDE_CODE_OAUTH_TOKEN=placeholder; real values
    // for `_2`/`_3` come from .env. Without promotion, container-runner's
    // `if (hostOauth)` gate would skip forwarding the fallbacks entirely,
    // collapsing non-scoped groups' rotation pool to zero.
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'placeholder',
      CLAUDE_CODE_OAUTH_TOKEN_2: 'real-rotation-2',
      CLAUDE_CODE_OAUTH_TOKEN_3: 'real-rotation-3',
    };
    const auth = resolveAnthropicAuth('illysium', env);
    expect(auth.oauthPrimary).toBe('real-rotation-2');
    expect(auth.oauthFallbacks).toEqual([{ index: 3, value: 'real-rotation-3' }]);
  });

  it('placeholder in a scoped slot is also filtered', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_AXIE_DEV: 'placeholder',
    };
    const auth = resolveAnthropicAuth('axie-dev', env);
    // Scoped primary is sentinel → falls back to the global, which is real.
    expect(auth.oauthPrimary).toBe('global-oauth');
  });

  it('per-group token does not leak to other groups', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED: 'mr-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED_2: 'mr-oauth-2',
    };
    const auth = resolveAnthropicAuth('illysium', env);
    expect(auth.oauthPrimary).toBe('global-oauth');
    // illysium must not see madison-reed siblings
    expect(auth.oauthFallbacks).toEqual([]);
  });

  it('orphan per-group fallbacks (no per-group primary) fall through to global', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED_2: 'mr-fallback-only',
    };
    const auth = resolveAnthropicAuth('madison-reed', env);
    expect(auth.oauthPrimary).toBe('global-oauth');
    expect(auth.oauthFallbacks).toEqual([]);
  });

  it('hyphens in folder name normalise to underscores', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED: 'mr-oauth',
    };
    expect(resolveAnthropicAuth('madison-reed', env).oauthPrimary).toBe('mr-oauth');
    expect(resolveAnthropicAuth('Madison-Reed', env).oauthPrimary).toBe('mr-oauth');
  });

  it('digit-only folder name skips per-group resolution to avoid rotation collision', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      // ambiguous: is this folder=2 primary, or rotation slot _2? Treat as rotation.
      CLAUDE_CODE_OAUTH_TOKEN_2: 'ambiguous',
    };
    const auth = resolveAnthropicAuth('2', env);
    expect(auth.oauthPrimary).toBe('global-oauth');
    expect(auth.oauthFallbacks).toEqual([{ index: 2, value: 'ambiguous' }]);
  });

  it('OAuth and API key scope independently', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      ANTHROPIC_API_KEY_MADISON_REED: 'mr-key',
    };
    const auth = resolveAnthropicAuth('madison-reed', env);
    expect(auth.oauthPrimary).toBe('global-oauth');
    expect(auth.apiKeyPrimary).toBe('mr-key');
  });

  it('skips empty-string env values', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED: '',
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_2: '',
      CLAUDE_CODE_OAUTH_TOKEN_3: 'global-oauth-3',
    };
    const auth = resolveAnthropicAuth('madison-reed', env);
    // empty per-group falls through to global
    expect(auth.oauthPrimary).toBe('global-oauth');
    expect(auth.oauthFallbacks).toEqual([{ index: 3, value: 'global-oauth-3' }]);
  });

  it('fallbacks return sorted by index ascending', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'g',
      CLAUDE_CODE_OAUTH_TOKEN_5: 'g5',
      CLAUDE_CODE_OAUTH_TOKEN_2: 'g2',
      CLAUDE_CODE_OAUTH_TOKEN_10: 'g10',
    };
    const auth = resolveAnthropicAuth('any', env);
    expect(auth.oauthFallbacks.map((f) => f.index)).toEqual([2, 5, 10]);
  });
});

describe('codex provider host auth', () => {
  function makeHome(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-home-'));
  }

  function makeSessionDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-session-'));
  }

  function writeAuth(dir: string, value: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ account: value }));
  }

  function copiedAuth(sessionDir: string): unknown {
    return JSON.parse(fs.readFileSync(path.join(sessionDir, 'codex', 'auth.json'), 'utf-8'));
  }

  it('copies scoped Codex auth for the agent group folder without DB lookup', () => {
    const home = makeHome();
    const sessionDir = makeSessionDir();
    writeAuth(path.join(home, '.codex'), 'global');
    writeAuth(path.join(home, '.codex-madison-reed-codex'), 'madison-reed');

    const fn = getProviderContainerConfig('codex');
    expect(fn).toBeDefined();
    const contribution = fn!({
      sessionDir,
      agentGroupId: 'ag-does-not-match-folder',
      agentGroupFolder: 'madison-reed-codex',
      groupDir: sessionDir,
      selectedSkills: [],
      hostEnv: { HOME: home } as NodeJS.ProcessEnv,
    });

    expect(copiedAuth(sessionDir)).toEqual({ account: 'madison-reed' });
    expect(contribution.mounts?.[0]).toMatchObject({
      hostPath: path.join(sessionDir, 'codex'),
      containerPath: '/home/node/.codex',
      readonly: false,
    });
  });

  it('falls back to global Codex auth when no scoped auth exists', () => {
    const home = makeHome();
    const sessionDir = makeSessionDir();
    writeAuth(path.join(home, '.codex'), 'global');

    const fn = getProviderContainerConfig('codex');
    expect(fn).toBeDefined();
    fn!({
      sessionDir,
      agentGroupId: 'madison-reed-codex',
      agentGroupFolder: 'madison-reed-codex',
      groupDir: sessionDir,
      selectedSkills: [],
      hostEnv: { HOME: home } as NodeJS.ProcessEnv,
    });

    expect(copiedAuth(sessionDir)).toEqual({ account: 'global' });
  });
});

describe('resolveCodexAuthFallbacks', () => {
  function makeHome(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-fb-'));
  }

  function writeAuth(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'auth.json'), '{}');
  }

  it('returns [] when declarations is undefined or empty', () => {
    const home = makeHome();
    expect(resolveCodexAuthFallbacks(undefined, path.join(home, '.codex'), home)).toEqual([]);
    expect(resolveCodexAuthFallbacks([], path.join(home, '.codex'), home)).toEqual([]);
  });

  it('expands ~/ relative to provided homedir', () => {
    const home = makeHome();
    writeAuth(path.join(home, '.codex'));
    // Primary is some scoped dir; fallback is the global ~/.codex
    const out = resolveCodexAuthFallbacks(['~/.codex'], path.join(home, '.codex-mr'), home);
    expect(out).toEqual([{ hostPath: path.join(home, '.codex'), containerPath: '/home/node/.codex-fallback-1' }]);
  });

  it('skips entries without an auth.json (no false-positive mounts)', () => {
    const home = makeHome();
    writeAuth(path.join(home, '.codex'));
    // ~/.codex-missing has no auth.json — must be silently dropped
    const out = resolveCodexAuthFallbacks(['~/.codex-missing', '~/.codex'], path.join(home, '.codex-mr'), home);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      hostPath: path.join(home, '.codex'),
      containerPath: '/home/node/.codex-fallback-1',
    });
  });

  it('dedupes against the primary host path', () => {
    const home = makeHome();
    writeAuth(path.join(home, '.codex'));
    // Primary IS ~/.codex, so the same path in fallbacks must be dropped
    const out = resolveCodexAuthFallbacks(['~/.codex'], path.join(home, '.codex'), home);
    expect(out).toEqual([]);
  });

  it('dedupes within the declaration list (same path declared twice)', () => {
    const home = makeHome();
    writeAuth(path.join(home, '.codex'));
    const out = resolveCodexAuthFallbacks(['~/.codex', '~/.codex'], path.join(home, '.codex-mr'), home);
    expect(out).toHaveLength(1);
    expect(out[0].containerPath).toBe('/home/node/.codex-fallback-1');
  });

  it('preserves declared order and numbers container paths starting at 1', () => {
    const home = makeHome();
    writeAuth(path.join(home, '.codex-a'));
    writeAuth(path.join(home, '.codex-b'));
    writeAuth(path.join(home, '.codex-c'));
    const out = resolveCodexAuthFallbacks(
      ['~/.codex-b', '~/.codex-a', '~/.codex-c'],
      path.join(home, '.codex-mr'),
      home,
    );
    expect(out.map((e) => e.hostPath)).toEqual([
      path.join(home, '.codex-b'),
      path.join(home, '.codex-a'),
      path.join(home, '.codex-c'),
    ]);
    expect(out.map((e) => e.containerPath)).toEqual([
      '/home/node/.codex-fallback-1',
      '/home/node/.codex-fallback-2',
      '/home/node/.codex-fallback-3',
    ]);
  });

  it('ignores non-string and blank entries', () => {
    const home = makeHome();
    writeAuth(path.join(home, '.codex'));
    const messy = [null, '', '   ', '~/.codex'] as unknown as string[];
    const out = resolveCodexAuthFallbacks(messy, path.join(home, '.codex-mr'), home);
    expect(out).toHaveLength(1);
    expect(out[0].hostPath).toBe(path.join(home, '.codex'));
  });
});

// ── Workgroup reconciler tests (C1) ──────────────────────────────────────────

/** Create a minimal in-memory DB with the workgroup schema (migration 036). */
function makeWorkgroupDb(): Database.Database {
  const db = new BetterSQLite3(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE agent_groups (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      folder       TEXT NOT NULL UNIQUE,
      workgroup_id TEXT,
      created_at   TEXT NOT NULL
    );
    CREATE TABLE workgroups (
      id              TEXT PRIMARY KEY,
      display_name    TEXT,
      onecli_secrets  TEXT NOT NULL DEFAULT '[]',
      mnemon_store_id TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT
    );
  `);
  return db;
}

function insertGroup(db: Database.Database, id: string, folder: string, workgroupId?: string): void {
  db.prepare(
    `INSERT INTO agent_groups (id, name, folder, workgroup_id, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  ).run(id, folder, folder, workgroupId ?? null);
}

function insertWorkgroup(db: Database.Database, id: string, mnemonStoreId: string, onecliSecrets = '[]'): void {
  db.prepare(
    `INSERT INTO workgroups (id, display_name, onecli_secrets, mnemon_store_id, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  ).run(id, id, onecliSecrets, mnemonStoreId);
}

describe('reconcileWorkgroupAtSpawn — C1', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeWorkgroupDb();
  });

  it('test_reconciler_uses_parent_folder_for_mnemon_store_id', () => {
    // Seed illie (parent) and illie-codex (sibling)
    insertGroup(db, 'ag-illie', 'illysium');
    insertGroup(db, 'ag-illie-codex', 'illysium-codex');

    // Spawn illie-codex with workgroup_id pointing to the parent folder
    const agentGroup = { id: 'ag-illie-codex', folder: 'illysium-codex' };
    const containerConfig = { workgroup_id: 'illysium' };

    reconcileWorkgroupAtSpawn(db, agentGroup, containerConfig);

    // workgroup row should exist with mnemon_store_id = illie's agent_groups.id
    const wg = db.prepare('SELECT mnemon_store_id FROM workgroups WHERE id = ?').get('illysium') as {
      mnemon_store_id: string;
    };
    expect(wg).toBeDefined();
    expect(wg.mnemon_store_id).toBe('ag-illie');

    // agent_groups.workgroup_id should be updated
    const ag = db.prepare('SELECT workgroup_id FROM agent_groups WHERE id = ?').get('ag-illie-codex') as {
      workgroup_id: string;
    };
    expect(ag.workgroup_id).toBe('illysium');
  });

  it('test_reconciler_preserves_existing_workgroup_row', () => {
    // Pre-seed workgroup with custom mnemon_store_id
    const customStoreId = 'ag-custom-store';
    insertGroup(db, 'ag-illie', 'illysium');
    insertGroup(db, 'ag-illie-codex', 'illysium-codex');
    insertWorkgroup(db, 'illysium', customStoreId);

    const agentGroup = { id: 'ag-illie-codex', folder: 'illysium-codex' };
    const containerConfig = { workgroup_id: 'illysium' };

    reconcileWorkgroupAtSpawn(db, agentGroup, containerConfig);

    // ON CONFLICT DO NOTHING: existing row preserved
    const wg = db.prepare('SELECT mnemon_store_id FROM workgroups WHERE id = ?').get('illysium') as {
      mnemon_store_id: string;
    };
    expect(wg.mnemon_store_id).toBe(customStoreId);
  });

  it('test_reconciler_standalone_fallback_to_self', () => {
    // Standalone group — no parent, no sibling
    insertGroup(db, 'ag-solo', 'solo-agent');

    const agentGroup = { id: 'ag-solo', folder: 'solo-agent' };
    const containerConfig = {}; // no workgroup_id declared

    reconcileWorkgroupAtSpawn(db, agentGroup, containerConfig);

    // workgroup id = own folder; mnemon_store_id = own agent_groups.id
    const wg = db.prepare('SELECT mnemon_store_id FROM workgroups WHERE id = ?').get('solo-agent') as {
      mnemon_store_id: string;
    };
    expect(wg).toBeDefined();
    expect(wg.mnemon_store_id).toBe('ag-solo');

    const ag = db.prepare('SELECT workgroup_id FROM agent_groups WHERE id = ?').get('ag-solo') as {
      workgroup_id: string;
    };
    expect(ag.workgroup_id).toBe('solo-agent');
  });

  it('test_reconciler_atomic_workgroup_id_update', () => {
    // Start with NULL workgroup_id; reconciler must set it
    insertGroup(db, 'ag-foo', 'foo');

    reconcileWorkgroupAtSpawn(db, { id: 'ag-foo', folder: 'foo' }, {});

    const ag = db.prepare('SELECT workgroup_id FROM agent_groups WHERE id = ?').get('ag-foo') as {
      workgroup_id: string;
    };
    expect(ag.workgroup_id).toBe('foo');
  });

  it('test_reconciler_noop_when_unchanged', () => {
    // Pre-set workgroup_id correctly
    insertGroup(db, 'ag-bar', 'bar', 'bar');
    insertWorkgroup(db, 'bar', 'ag-bar');

    // Spy on prepare to check that UPDATE runs but updates 0 rows
    const before = db.prepare('SELECT workgroup_id FROM agent_groups WHERE id = ?').get('ag-bar') as {
      workgroup_id: string;
    };
    expect(before.workgroup_id).toBe('bar');

    reconcileWorkgroupAtSpawn(db, { id: 'ag-bar', folder: 'bar' }, {});

    // workgroup_id unchanged after noop
    const after = db.prepare('SELECT workgroup_id FROM agent_groups WHERE id = ?').get('ag-bar') as {
      workgroup_id: string;
    };
    expect(after.workgroup_id).toBe('bar');
  });
});

// ── MNEMON_STORE resolver tests (C2) ─────────────────────────────────────────

describe('resolveMnemonStore — C2', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeWorkgroupDb();
  });

  it('test_mnemon_store_from_workgroups_when_no_env_override', () => {
    insertGroup(db, 'ag-illie-codex', 'illysium-codex', 'illysium');
    insertWorkgroup(db, 'illysium', 'ag-illie'); // parent's id

    const result = resolveMnemonStore(db, { id: 'ag-illie-codex', folder: 'illysium-codex' }, {});
    expect(result).toBe('ag-illie');
  });

  it('test_pr_105_env_override_takes_precedence', () => {
    insertGroup(db, 'ag-illie-codex', 'illysium-codex', 'illysium');
    insertWorkgroup(db, 'illysium', 'ag-illie');

    // Env override should win over workgroups.mnemon_store_id
    const env = { MNEMON_STORE_illysium_codex: 'env-override-store' };
    const result = resolveMnemonStore(db, { id: 'ag-illie-codex', folder: 'illysium-codex' }, env);
    expect(result).toBe('env-override-store');
  });

  it('test_uppercase_env_override_fallback_preserved', () => {
    insertGroup(db, 'ag-foo', 'foo', 'foo');
    insertWorkgroup(db, 'foo', 'ag-foo');

    // Uppercase variant should also be honored (PR #105 case-insensitive fallback)
    const env = { MNEMON_STORE_FOO: 'uppercase-override' };
    const result = resolveMnemonStore(db, { id: 'ag-foo', folder: 'foo' }, env);
    expect(result).toBe('uppercase-override');
  });

  it('test_fallback_to_agent_group_id_when_workgroups_row_missing', () => {
    // No workgroups row and no workgroup_id on agent_groups
    insertGroup(db, 'ag-orphan', 'orphan');

    const result = resolveMnemonStore(db, { id: 'ag-orphan', folder: 'orphan' }, {});
    expect(result).toBe('ag-orphan');
  });

  // ── Codex P2: path-traversal validation ────────────────────────────────────

  it('test_rejects_env_override_with_path_traversal', () => {
    insertGroup(db, 'ag-illie-codex', 'illysium-codex', 'illysium');
    insertWorkgroup(db, 'illysium', 'ag-illie');

    // An operator typo (or attacker who controls .env) sets a traversal value.
    // Must throw rather than silently mount ~/.ssh or similar.
    const env = { MNEMON_STORE_illysium_codex: '../../.ssh' };
    expect(() => resolveMnemonStore(db, { id: 'ag-illie-codex', folder: 'illysium-codex' }, env)).toThrow(
      /not a valid store id/,
    );
  });

  it('test_rejects_env_override_with_slash', () => {
    insertGroup(db, 'ag-illie-codex', 'illysium-codex', 'illysium');
    insertWorkgroup(db, 'illysium', 'ag-illie');

    const env = { MNEMON_STORE_illysium_codex: 'subdir/store' };
    expect(() => resolveMnemonStore(db, { id: 'ag-illie-codex', folder: 'illysium-codex' }, env)).toThrow(
      /not a valid store id/,
    );
  });

  it('test_rejects_env_override_with_dot_character', () => {
    insertGroup(db, 'ag-illie-codex', 'illysium-codex', 'illysium');
    insertWorkgroup(db, 'illysium', 'ag-illie');

    // The host-side pattern aligns with the container wrapper's
    // `^[a-zA-Z0-9_-]+$` regex (`container/mnemon-wrapper.sh:12`), which
    // disallows `.` entirely. A value the container would later reject
    // must also fail at the host so we don't mount-then-fail silently.
    const env = { MNEMON_STORE_illysium_codex: 'foo.bar' };
    expect(() => resolveMnemonStore(db, { id: 'ag-illie-codex', folder: 'illysium-codex' }, env)).toThrow(
      /not a valid store id/,
    );
  });

  it('test_rejects_empty_env_override_falls_through_to_workgroup', () => {
    // Empty string is falsy → falls through to workgroup lookup (not validated
    // because we never reach the validation path).
    insertGroup(db, 'ag-illie-codex', 'illysium-codex', 'illysium');
    insertWorkgroup(db, 'illysium', 'ag-illie');

    const env = { MNEMON_STORE_illysium_codex: '' };
    const result = resolveMnemonStore(db, { id: 'ag-illie-codex', folder: 'illysium-codex' }, env);
    expect(result).toBe('ag-illie'); // workgroups.mnemon_store_id wins
  });

  it('test_accepts_normal_store_ids', () => {
    // Sanity: don't break legitimate ids.
    insertGroup(db, 'ag-1776377699463-2axxhg', 'illysium');
    insertWorkgroup(db, 'illysium', 'ag-1776377699463-2axxhg');

    const result = resolveMnemonStore(db, { id: 'ag-1776377699463-2axxhg', folder: 'illysium' }, {});
    expect(result).toBe('ag-1776377699463-2axxhg');
  });

  // ── Codex P2 #3 (PR #107): honor recall_scope='self' at the mount path ─────

  it('test_self_scope_returns_agent_id_not_workgroup_canonical', () => {
    // A workgroup member explicitly opting out of shared recall via
    // recall_scope: 'self' must mount its OWN store, not the workgroup canonical
    // — otherwise the in-container `mnemon recall` reads the shared store and
    // bypasses the isolation contract.
    insertGroup(db, 'ag-illie-codex', 'illysium-codex', 'illysium');
    insertWorkgroup(db, 'illysium', 'ag-illie'); // canonical points at seed

    const result = resolveMnemonStore(db, { id: 'ag-illie-codex', folder: 'illysium-codex' }, {}, 'self');
    expect(result).toBe('ag-illie-codex'); // own id, NOT 'ag-illie'
  });

  it('test_workgroup_scope_falls_through_to_canonical', () => {
    // Default behavior preserved when scope is 'workgroup' (the new default).
    insertGroup(db, 'ag-illie-codex', 'illysium-codex', 'illysium');
    insertWorkgroup(db, 'illysium', 'ag-illie');

    const result = resolveMnemonStore(db, { id: 'ag-illie-codex', folder: 'illysium-codex' }, {}, 'workgroup');
    expect(result).toBe('ag-illie');
  });

  it('test_env_override_still_wins_over_self_scope', () => {
    // Operator-set env override is the most specific source and beats every
    // other selector, including a recall_scope='self' opt-out (otherwise an
    // operator could not redirect a self-scoped agent to a custom store).
    insertGroup(db, 'ag-foo', 'foo', 'foo');
    insertWorkgroup(db, 'foo', 'ag-foo');

    const env = { MNEMON_STORE_foo: 'custom-store' };
    const result = resolveMnemonStore(db, { id: 'ag-foo', folder: 'foo' }, env, 'self');
    expect(result).toBe('custom-store');
  });
});

// ── reconcileWorkgroupAtSpawn — preserve migration 036 pairings ──────────────
// Codex P1 catch on PR #107 commit f166ae1: when container.json omits
// workgroup_id, the prior code defaulted to agentGroup.folder and overwrote
// the migration's pairing on first spawn. New behavior: preserve existing DB
// value when config is silent.

describe('reconcileWorkgroupAtSpawn — workgroup_id preservation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeWorkgroupDb();
  });

  it('test_preserves_migrated_workgroup_id_when_container_config_silent', () => {
    // Simulate post-migration-036 state for illie + illie-codex pair:
    // both agent_groups rows have workgroup_id='illysium' set by migration,
    // but illie-codex's container.json does not declare workgroup_id (FS
    // reconciler only wrote recall_scope).
    insertGroup(db, 'ag-illie', 'illysium', 'illysium');
    insertGroup(db, 'ag-illie-codex', 'illysium-codex', 'illysium');
    insertWorkgroup(db, 'illysium', 'ag-illie');

    // Spawn illie-codex with no workgroup_id in containerConfig — must preserve
    // the migrated pairing rather than overwriting to 'illysium-codex'.
    reconcileWorkgroupAtSpawn(db, { id: 'ag-illie-codex', folder: 'illysium-codex' }, {});

    const after = db.prepare('SELECT workgroup_id FROM agent_groups WHERE id = ?').get('ag-illie-codex') as {
      workgroup_id: string;
    };
    expect(after.workgroup_id).toBe('illysium'); // preserved, NOT overwritten to 'illysium-codex'

    // workgroups row for 'illysium' must still point at the seed sibling.
    const wg = db.prepare('SELECT mnemon_store_id FROM workgroups WHERE id = ?').get('illysium') as {
      mnemon_store_id: string;
    };
    expect(wg.mnemon_store_id).toBe('ag-illie');
  });

  it('test_explicit_config_workgroup_id_overrides_db_value', () => {
    // If container.json explicitly sets workgroup_id, operator intent wins
    // (e.g., operator moves a sibling to a different workgroup).
    insertGroup(db, 'ag-foo', 'foo', 'old-workgroup');

    reconcileWorkgroupAtSpawn(db, { id: 'ag-foo', folder: 'foo' }, { workgroup_id: 'new-workgroup' });

    const after = db.prepare('SELECT workgroup_id FROM agent_groups WHERE id = ?').get('ag-foo') as {
      workgroup_id: string;
    };
    expect(after.workgroup_id).toBe('new-workgroup'); // operator intent honored
  });

  it('test_defaults_to_own_folder_when_db_value_null', () => {
    // Fresh install: no migration ran, agent_groups.workgroup_id is NULL,
    // container.json silent → default to workgroup-of-1 (own folder).
    insertGroup(db, 'ag-fresh', 'fresh'); // no workgroup_id set

    reconcileWorkgroupAtSpawn(db, { id: 'ag-fresh', folder: 'fresh' }, {});

    const after = db.prepare('SELECT workgroup_id FROM agent_groups WHERE id = ?').get('ag-fresh') as {
      workgroup_id: string;
    };
    expect(after.workgroup_id).toBe('fresh'); // workgroup-of-1
  });
});

// ── Spawn merged-secrets tests (C3) ──────────────────────────────────────────
// These tests verify the merge logic by exercising mergeWorkgroupAndGroupSecrets
// (from onecli-secrets.ts) as it would be called from the spawn path.
// The full buildContainerArgs path uses live onecli shell calls — tested via
// the unit tests in onecli-secrets.test.ts instead.

describe('workgroup secrets merge at spawn (C3 contract verification)', () => {
  it('test_spawn_applies_merged_secrets — workgroup baseline union group additive', () => {
    // Directly verify the merge that buildContainerArgs performs:
    // workgroups.onecli_secrets ∪ containerConfig.onecliSecrets (additive, dedup)
    const workgroupSecrets = ['Anthropic', 'Exa'];
    const groupSecrets = ['Datafold-Illysium'];
    const merged = mergeWorkgroupAndGroupSecrets(workgroupSecrets, groupSecrets);

    expect(merged).toEqual(['Anthropic', 'Exa', 'Datafold-Illysium']);
  });

  it('dedup when group repeats workgroup secret', () => {
    const merged = mergeWorkgroupAndGroupSecrets(['Anthropic', 'Exa'], ['Anthropic', 'NewSecret']);
    expect(merged).toEqual(['Anthropic', 'Exa', 'NewSecret']);
  });

  it('empty workgroup secrets passes through group secrets only', () => {
    const merged = mergeWorkgroupAndGroupSecrets([], ['Datafold-Illysium']);
    expect(merged).toEqual(['Datafold-Illysium']);
  });
});
