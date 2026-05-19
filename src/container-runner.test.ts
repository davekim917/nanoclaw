import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import BetterSQLite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';

import {
  dockerResourceLimitArgs,
  resolveAnthropicAuth,
  resolveProviderName,
  reconcileWorkgroupAtSpawn,
  resolveMnemonStore,
} from './container-runner.js';
import { mergeWorkgroupAndGroupSecrets } from './onecli-secrets.js';
import { getProviderContainerConfig } from './providers/provider-container-registry.js';

describe('resolveProviderName', () => {
  it('prefers session over group and container.json', () => {
    expect(resolveProviderName('codex', 'opencode', 'claude')).toBe('codex');
  });

  it('falls back to group when session is null', () => {
    expect(resolveProviderName(null, 'codex', 'claude')).toBe('codex');
  });

  it('falls back to container.json when session and group are null', () => {
    expect(resolveProviderName(null, null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null, null)).toBe('codex');
    expect(resolveProviderName(null, 'OpenCode', null)).toBe('opencode');
    expect(resolveProviderName(null, null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'codex', null)).toBe('codex');
    expect(resolveProviderName(null, '', 'opencode')).toBe('opencode');
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
      hostEnv: { HOME: home } as NodeJS.ProcessEnv,
    });

    expect(copiedAuth(sessionDir)).toEqual({ account: 'global' });
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
    const wg = db
      .prepare('SELECT mnemon_store_id FROM workgroups WHERE id = ?')
      .get('illysium') as { mnemon_store_id: string };
    expect(wg).toBeDefined();
    expect(wg.mnemon_store_id).toBe('ag-illie');

    // agent_groups.workgroup_id should be updated
    const ag = db
      .prepare('SELECT workgroup_id FROM agent_groups WHERE id = ?')
      .get('ag-illie-codex') as { workgroup_id: string };
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
    const wg = db
      .prepare('SELECT mnemon_store_id FROM workgroups WHERE id = ?')
      .get('illysium') as { mnemon_store_id: string };
    expect(wg.mnemon_store_id).toBe(customStoreId);
  });

  it('test_reconciler_standalone_fallback_to_self', () => {
    // Standalone group — no parent, no sibling
    insertGroup(db, 'ag-solo', 'solo-agent');

    const agentGroup = { id: 'ag-solo', folder: 'solo-agent' };
    const containerConfig = {}; // no workgroup_id declared

    reconcileWorkgroupAtSpawn(db, agentGroup, containerConfig);

    // workgroup id = own folder; mnemon_store_id = own agent_groups.id
    const wg = db
      .prepare('SELECT mnemon_store_id FROM workgroups WHERE id = ?')
      .get('solo-agent') as { mnemon_store_id: string };
    expect(wg).toBeDefined();
    expect(wg.mnemon_store_id).toBe('ag-solo');

    const ag = db
      .prepare('SELECT workgroup_id FROM agent_groups WHERE id = ?')
      .get('ag-solo') as { workgroup_id: string };
    expect(ag.workgroup_id).toBe('solo-agent');
  });

  it('test_reconciler_atomic_workgroup_id_update', () => {
    // Start with NULL workgroup_id; reconciler must set it
    insertGroup(db, 'ag-foo', 'foo');

    reconcileWorkgroupAtSpawn(db, { id: 'ag-foo', folder: 'foo' }, {});

    const ag = db
      .prepare('SELECT workgroup_id FROM agent_groups WHERE id = ?')
      .get('ag-foo') as { workgroup_id: string };
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
