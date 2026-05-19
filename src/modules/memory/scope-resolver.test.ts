import fs from 'fs';
import path from 'path';
import os from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

import {
  resolveRecallScope,
  resolveWorkgroupMembers,
  resolveWorkgroupStoreId,
  clearScopeCacheForTest,
  setGroupsDirForTest,
  setCentralDbForTest,
} from './scope-resolver.js';

function makeTempGroupsDir(groups: Array<{ folder: string; agentGroupId?: string; memoryEnabled?: boolean }>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-resolver-test-'));
  for (const g of groups) {
    const groupDir = path.join(dir, g.folder);
    fs.mkdirSync(groupDir, { recursive: true });
    const cfg: Record<string, unknown> = {};
    if (g.agentGroupId !== undefined) cfg.agentGroupId = g.agentGroupId;
    if (g.memoryEnabled !== undefined) cfg.memory = { enabled: g.memoryEnabled };
    fs.writeFileSync(path.join(groupDir, 'container.json'), JSON.stringify(cfg));
  }
  return dir;
}

/**
 * Create an in-memory central DB with the workgroups + agent_groups schema
 * matching what migration036 produces. Returns the DB for direct manipulation.
 */
function makeWorkgroupDb(
  fixtures: Array<{
    agId: string;
    folder: string;
    workgroupId: string;
    mnemonStoreId?: string;
    isParent?: boolean;
  }>,
): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE workgroups (
      id              TEXT PRIMARY KEY,
      display_name    TEXT,
      onecli_secrets  TEXT NOT NULL DEFAULT '[]',
      mnemon_store_id TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT
    );
    CREATE TABLE agent_groups (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      folder       TEXT NOT NULL UNIQUE,
      workgroup_id TEXT REFERENCES workgroups(id),
      created_at   TEXT NOT NULL
    );
  `);

  // Collect distinct workgroup ids
  const wgMap = new Map<string, string>(); // workgroup_id → mnemon_store_id
  for (const f of fixtures) {
    if (!wgMap.has(f.workgroupId)) {
      // Default store_id = the first fixture for this workgroup, or explicit
      wgMap.set(f.workgroupId, f.mnemonStoreId ?? f.agId);
    }
  }

  for (const [wgId, storeId] of wgMap) {
    db.prepare(`INSERT INTO workgroups (id, mnemon_store_id, created_at) VALUES (?, ?, '2026-01-01')`).run(
      wgId,
      storeId,
    );
  }

  for (const f of fixtures) {
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, workgroup_id, created_at) VALUES (?, ?, ?, ?, '2026-01-01')`,
    ).run(f.agId, f.agId, f.folder, f.workgroupId);
  }

  return db;
}

describe('resolveRecallScope', () => {
  let tmpDir: string;
  let centralDb: Database.Database | null = null;

  beforeEach(() => {
    clearScopeCacheForTest();
    setGroupsDirForTest(null);
    setCentralDbForTest(null);
  });

  afterEach(() => {
    clearScopeCacheForTest();
    setGroupsDirForTest(null);
    setCentralDbForTest(null);
    if (centralDb) {
      centralDb.close();
      centralDb = null;
    }
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true });
      } catch {
        // ignore cleanup errors
      }
    }
  });

  it('test_self_returns_single', () => {
    const result = resolveRecallScope('g1', 'self');
    expect(result).toEqual(['g1']);
  });

  it('test_all_groups_enumerates', () => {
    tmpDir = makeTempGroupsDir([
      { folder: 'group-a', agentGroupId: 'g1', memoryEnabled: true },
      { folder: 'group-b', agentGroupId: 'g2', memoryEnabled: true },
      { folder: 'group-c', agentGroupId: 'g3', memoryEnabled: false },
    ]);
    setGroupsDirForTest(tmpDir);

    const result = resolveRecallScope('g1', 'all-groups');

    expect(result).toContain('g1');
    expect(result).toContain('g2');
    expect(result).not.toContain('g3');
    expect(result.filter((id) => id === 'g1')).toHaveLength(1); // no duplicates
  });

  it('test_array_resolves_folder_names', () => {
    tmpDir = makeTempGroupsDir([{ folder: 'axie-dev', agentGroupId: 'ag-axie-dev-123', memoryEnabled: true }]);
    setGroupsDirForTest(tmpDir);

    const result = resolveRecallScope('g1', ['axie-dev']);

    expect(result).toEqual(expect.arrayContaining(['g1', 'ag-axie-dev-123']));
    expect(result[0]).toBe('g1'); // calling group first
  });

  it('test_array_drops_missing_folder', () => {
    tmpDir = makeTempGroupsDir([]);
    setGroupsDirForTest(tmpDir);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = resolveRecallScope('g1', ['nonexistent']);

    expect(result).toEqual(['g1']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('nonexistent'));
    warnSpy.mockRestore();
  });

  it('test_cache_amortizes_fs_reads', () => {
    tmpDir = makeTempGroupsDir([{ folder: 'group-a', agentGroupId: 'g1', memoryEnabled: true }]);
    setGroupsDirForTest(tmpDir);

    const readSpy = vi.spyOn(fs, 'readFileSync');
    clearScopeCacheForTest();

    resolveRecallScope('g1', 'all-groups');
    const countAfterFirst = readSpy.mock.calls.length;

    resolveRecallScope('g1', 'all-groups');
    const countAfterSecond = readSpy.mock.calls.length;

    // Second call should be a cache hit — no additional readFileSync calls
    expect(countAfterSecond).toBe(countAfterFirst);

    readSpy.mockRestore();
  });

  it('test_dedupes_calling_group', () => {
    tmpDir = makeTempGroupsDir([{ folder: 'group-a', agentGroupId: 'g1', memoryEnabled: true }]);
    setGroupsDirForTest(tmpDir);

    const result = resolveRecallScope('g1', 'all-groups');

    // g1 is both the calling group and the only memory-enabled group — must appear once
    expect(result.filter((id) => id === 'g1')).toHaveLength(1);
  });

  // ── B2: workgroup mode + new exports ───────────────────────────────────────

  it('test_workgroup_mode_returns_single_store_id', () => {
    // illie + illie-codex share workgroup "illie", mnemon_store_id = ag-illie-parent
    centralDb = makeWorkgroupDb([
      { agId: 'ag-illie-parent', folder: 'illie', workgroupId: 'illie', mnemonStoreId: 'ag-illie-parent' },
      { agId: 'ag-illie-codex', folder: 'illie-codex', workgroupId: 'illie', mnemonStoreId: 'ag-illie-parent' },
    ]);
    setCentralDbForTest(centralDb);

    const result = resolveRecallScope('ag-illie-codex', 'workgroup');

    // Should return a single-element array containing the shared store id
    expect(result).toEqual(['ag-illie-parent']);
  });

  it('test_workgroup_of_1_equivalent_to_self', () => {
    // Standalone agent — workgroup has only 1 member; should return [ownId]
    centralDb = makeWorkgroupDb([
      { agId: 'ag-standalone', folder: 'standalone', workgroupId: 'standalone', mnemonStoreId: 'ag-standalone' },
    ]);
    setCentralDbForTest(centralDb);

    const result = resolveRecallScope('ag-standalone', 'workgroup');
    // Single-element = same as 'self', triggers fast path in mnemon-impl
    expect(result).toEqual(['ag-standalone']);
  });

  it('test_self_mode_unchanged', () => {
    expect(resolveRecallScope('g-any', 'self')).toEqual(['g-any']);
  });

  it('test_all_groups_mode_unchanged', () => {
    tmpDir = makeTempGroupsDir([
      { folder: 'group-a', agentGroupId: 'g1', memoryEnabled: true },
      { folder: 'group-b', agentGroupId: 'g2', memoryEnabled: true },
    ]);
    setGroupsDirForTest(tmpDir);
    const result = resolveRecallScope('g1', 'all-groups');
    expect(result).toContain('g1');
    expect(result).toContain('g2');
  });

  it('test_folder_list_mode_unchanged', () => {
    tmpDir = makeTempGroupsDir([{ folder: 'axie-dev', agentGroupId: 'ag-axie', memoryEnabled: true }]);
    setGroupsDirForTest(tmpDir);
    const result = resolveRecallScope('g-caller', ['axie-dev']);
    expect(result[0]).toBe('g-caller'); // calling group first
    expect(result).toContain('ag-axie');
  });

  it('test_resolveWorkgroupMembers_preserves_calling_group_first', () => {
    centralDb = makeWorkgroupDb([
      { agId: 'ag-parent', folder: 'my-group', workgroupId: 'my-group', mnemonStoreId: 'ag-parent' },
      { agId: 'ag-codex', folder: 'my-group-codex', workgroupId: 'my-group', mnemonStoreId: 'ag-parent' },
    ]);
    setCentralDbForTest(centralDb);

    const result = resolveWorkgroupMembers('ag-codex');
    expect(result[0]).toBe('ag-codex'); // calling group MUST be first
    expect(result).toContain('ag-parent');
    expect(result).toHaveLength(2);
  });

  it('test_resolveWorkgroupStoreId_returns_single_id', () => {
    centralDb = makeWorkgroupDb([
      { agId: 'ag-parent', folder: 'my-group', workgroupId: 'my-group', mnemonStoreId: 'ag-parent' },
      { agId: 'ag-codex', folder: 'my-group-codex', workgroupId: 'my-group', mnemonStoreId: 'ag-parent' },
    ]);
    setCentralDbForTest(centralDb);

    const storeId = resolveWorkgroupStoreId('ag-codex');
    expect(storeId).toBe('ag-parent');
  });

  it('test_resolveWorkgroupStoreId_returns_null_for_standalone_agent', () => {
    // Agent exists but has no workgroup_id — represents a standalone agent
    // not yet wired into a workgroup. Must NOT throw; callers handle null.
    centralDb = makeWorkgroupDb([]);
    centralDb
      .prepare(
        `INSERT INTO agent_groups (id, name, folder, workgroup_id, created_at) VALUES (?, ?, ?, NULL, '2026-01-01')`,
      )
      .run('ag-standalone', 'standalone', 'standalone');
    setCentralDbForTest(centralDb);

    expect(resolveWorkgroupStoreId('ag-standalone')).toBeNull();
  });

  it('test_resolveWorkgroupStoreId_returns_null_for_unknown_agent', () => {
    centralDb = makeWorkgroupDb([]);
    setCentralDbForTest(centralDb);

    expect(resolveWorkgroupStoreId('ag-does-not-exist')).toBeNull();
  });

  it('test_workgroup_scope_falls_back_to_self_for_standalone_agent', () => {
    // 'workgroup' is the default scope — standalone agents (no workgroup_id)
    // must silently fall back to their own store rather than throw.
    centralDb = makeWorkgroupDb([]);
    centralDb
      .prepare(
        `INSERT INTO agent_groups (id, name, folder, workgroup_id, created_at) VALUES (?, ?, ?, NULL, '2026-01-01')`,
      )
      .run('ag-standalone', 'standalone', 'standalone');
    setCentralDbForTest(centralDb);

    const result = resolveRecallScope('ag-standalone', 'workgroup');
    expect(result).toEqual(['ag-standalone']);
  });

  it('test_assertNever_catches_future_scope', () => {
    // Casting an invalid scope value to 'any' and passing it should throw
    // (assertNever at end of switch triggers)
    expect(() => resolveRecallScope('g1', 'invalid-scope-value' as unknown as string[])).toThrow();
  });
});
