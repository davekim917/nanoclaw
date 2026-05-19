import fs from 'fs';
import path from 'path';
import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';

import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import type { RecallScope } from '../../container-config.js';

interface CacheEntry {
  groupIds: string[];
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const scopeCache = new Map<string, CacheEntry>();

let _groupsDirOverride: string | null = null;
export function setGroupsDirForTest(p: string | null): void {
  _groupsDirOverride = p;
}
export function clearScopeCacheForTest(): void {
  scopeCache.clear();
}

/**
 * Test injection point for the central DB. When set, scope-resolver uses
 * this instead of opening the on-disk v2.db. Must be closed by the caller
 * after the test.
 */
let _centralDbOverride: Database.Database | null = null;
export function setCentralDbForTest(db: Database.Database | null): void {
  _centralDbOverride = db;
}

function getGroupsDir(): string {
  return _groupsDirOverride ?? GROUPS_DIR;
}

function cacheKey(callingGroupId: string, scope: RecallScope): string {
  return `${callingGroupId}::${Array.isArray(scope) ? scope.join(',') : scope}`;
}

function readContainerJson(folder: string): { agentGroupId?: string; memory?: { enabled?: boolean } } | null {
  const p = path.join(getGroupsDir(), folder, 'container.json');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw) as { agentGroupId?: string; memory?: { enabled?: boolean } };
  } catch {
    return null;
  }
}

function getAllMemoryEnabledGroupIds(): string[] {
  const dir = getGroupsDir();
  let folders: string[] = [];
  try {
    folders = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const ids: string[] = [];
  for (const folder of folders) {
    const cfg = readContainerJson(folder);
    if (cfg?.memory?.enabled === true && cfg.agentGroupId) {
      ids.push(cfg.agentGroupId);
    }
  }
  return ids;
}

function getFolderGroupId(folder: string): string | null {
  const cfg = readContainerJson(folder);
  if (!cfg?.agentGroupId) {
    console.warn(`[scope-resolver] folder "${folder}" not found or has no agentGroupId — skipping`);
    return null;
  }
  return cfg.agentGroupId;
}

/**
 * Open (or reuse) the central DB connection. Returns the test override if
 * one is set; otherwise opens the on-disk v2.db from DATA_DIR. The returned
 * DB must NOT be closed by the caller when using the test override — the test
 * manages its lifecycle. For the on-disk path we open fresh per-call (the
 * central DB singleton lives in connection.ts and requires initDb() — we
 * can't rely on it being initialized inside unit tests, so open directly).
 */
function openCentralDb(): { db: Database.Database; owned: boolean } {
  if (_centralDbOverride) {
    return { db: _centralDbOverride, owned: false };
  }
  const dbPath = path.join(DATA_DIR, 'v2.db');
  const db = new BetterSqlite3(dbPath, { readonly: true });
  return { db, owned: true };
}

/**
 * Resolve the shared mnemon_store_id for callingGroupId's workgroup.
 * Returns the storeId (a single agent_groups.id) that is the canonical
 * mnemon store for the workgroup.
 *
 * Returns null for standalone agents (no workgroup_id) — callers must
 * decide how to handle that case. 'workgroup' recall mode falls back
 * to 'self'; mnemon write redirection falls back to writing to the
 * agent's own store.
 */
export function resolveWorkgroupStoreId(callingGroupId: string): string | null {
  let opened: { db: Database.Database; owned: boolean };
  try {
    opened = openCentralDb();
  } catch {
    // Central DB unavailable (fresh install, test scaffold without override,
    // permission error). Treat as "no workgroup info" — callers will fall back.
    return null;
  }
  const { db, owned } = opened;
  try {
    const agRow = db.prepare(`SELECT workgroup_id FROM agent_groups WHERE id = ? LIMIT 1`).get(callingGroupId) as
      | { workgroup_id: string | null }
      | undefined;

    if (!agRow || agRow.workgroup_id == null) {
      return null;
    }

    const wgRow = db.prepare(`SELECT mnemon_store_id FROM workgroups WHERE id = ? LIMIT 1`).get(agRow.workgroup_id) as
      | { mnemon_store_id: string | null }
      | undefined;

    if (!wgRow || wgRow.mnemon_store_id == null) {
      return null;
    }

    return wgRow.mnemon_store_id;
  } catch {
    // Schema mismatch or query error (e.g., workgroups table absent on a
    // pre-migration DB). Fall back to "no workgroup info".
    return null;
  } finally {
    if (owned) db.close();
  }
}

/**
 * Returns all agent_group IDs that belong to the same workgroup as
 * callingGroupId, with callingGroupId first (guaranteed by spec).
 */
export function resolveWorkgroupMembers(callingGroupId: string): string[] {
  let opened: { db: Database.Database; owned: boolean };
  try {
    opened = openCentralDb();
  } catch {
    return [callingGroupId];
  }
  const { db, owned } = opened;
  try {
    const agRow = db.prepare(`SELECT workgroup_id FROM agent_groups WHERE id = ? LIMIT 1`).get(callingGroupId) as
      | { workgroup_id: string | null }
      | undefined;

    if (!agRow || agRow.workgroup_id == null) {
      // Standalone / unmatched: treat as single-member group
      return [callingGroupId];
    }

    const members = db.prepare(`SELECT id FROM agent_groups WHERE workgroup_id = ?`).all(agRow.workgroup_id) as Array<{
      id: string;
    }>;

    const memberIds = members.map((r) => r.id);
    // calling group first, then others
    const set = new Set([callingGroupId, ...memberIds]);
    return Array.from(set);
  } catch {
    return [callingGroupId];
  } finally {
    if (owned) db.close();
  }
}

/** Exhaustiveness check — TypeScript asserts this is unreachable at compile time. */
function assertNever(x: never): never {
  throw new Error(`[scope-resolver] Unhandled RecallScope value: ${JSON.stringify(x)}`);
}

export function resolveRecallScope(callingGroupId: string, scope: RecallScope): string[] {
  if (scope === 'self') {
    return [callingGroupId];
  }

  if (scope === 'workgroup') {
    // Return [callingGroupId, canonicalStoreId] deduped — workgroup-canonical
    // FIRST when calling group is NOT the seed, calling group only when it is.
    //
    // Including the caller's own store preserves historical facts written
    // before the workgroup default applied (e.g., non-seed siblings whose
    // env override was silently broken pre-PR#105 wrote to their own per-agent
    // store). Without this, the new default would orphan those facts on first
    // spawn after deploy. Self-heals over time as new writes accumulate in
    // the canonical store. (Codex P2 catch on PR #107.)
    //
    // Standalone agents (no workgroup_id) silently fall back to caller-only.
    const storeId = resolveWorkgroupStoreId(callingGroupId);
    if (storeId == null || storeId === callingGroupId) {
      return [callingGroupId];
    }
    return [callingGroupId, storeId];
  }

  const key = cacheKey(callingGroupId, scope);
  const cached = scopeCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.groupIds;
  }

  let groupIds: string[];

  if (scope === 'all-groups') {
    const all = getAllMemoryEnabledGroupIds();
    // Deduplicate and ensure callingGroupId is first
    const set = new Set([callingGroupId, ...all]);
    groupIds = Array.from(set);
  } else if (Array.isArray(scope)) {
    // string[] — folder names to resolve.
    //
    // Targets that belong to a workgroup are CANONICALIZED through their
    // workgroup's mnemon_store_id. Writes from any sibling in that workgroup
    // are redirected to the canonical store, so a folder-targeted read must
    // follow the same mapping or it would see stale per-sibling history and
    // miss the new redirected facts. Folders outside any workgroup resolve
    // to their own agent_group_id as before. (Codex P2 catch on PR #107.)
    const resolved: string[] = [];
    for (const folder of scope) {
      const id = getFolderGroupId(folder);
      if (!id) continue;
      const canonical = resolveWorkgroupStoreId(id);
      resolved.push(canonical ?? id);
    }
    // Deduplicate and ensure callingGroupId is first
    const set = new Set([callingGroupId, ...resolved]);
    groupIds = Array.from(set);
  } else {
    // This branch is unreachable if RecallScope is exhaustive. assertNever
    // causes a compile-time error if a new variant is added without updating
    // this switch chain, and a runtime error if someone casts to any.
    assertNever(scope);
  }

  scopeCache.set(key, { groupIds, expiresAt: Date.now() + CACHE_TTL_MS });
  return groupIds;
}
