/**
 * `insertOrAdopt` unit tests + the tripwire that keeps every central-DB
 * lookup-then-insert routed through it.
 *
 * The tripwire is the point of the primitive. Codex found seven hand-written
 * copies of the try/catch across three review rounds on PR 411; a scan that
 * fails on the eighth is what stops the ninth.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from './connection.js';
import { insertOrAdopt, isUniqueViolation } from './insert-or-adopt.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('insertOrAdopt', () => {
  it('returns the candidate with created=true when the insert lands', async () => {
    const insert = vi.fn().mockResolvedValue(undefined);
    const reload = vi.fn();
    const candidate = { id: 'a' };

    const result = await insertOrAdopt(candidate, insert, reload);

    expect(result).toEqual({ row: candidate, created: true });
    expect(insert).toHaveBeenCalledWith(candidate);
    expect(reload).not.toHaveBeenCalled();
  });

  it('adopts the winner with created=false on a unique violation', async () => {
    const winner = { id: 'winner' };
    const insert = vi.fn().mockRejectedValue({ code: 'SQLITE_CONSTRAINT_UNIQUE' });
    const reload = vi.fn().mockResolvedValue(winner);

    const result = await insertOrAdopt({ id: 'loser' }, insert, reload);

    expect(result).toEqual({ row: winner, created: false });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('adopts the winner with created=false on a PRIMARY KEY violation', async () => {
    // A natural key backed directly by a TEXT PRIMARY KEY (e.g. `users.id`)
    // fails the losing INSERT with SQLITE_CONSTRAINT_PRIMARYKEY, not _UNIQUE —
    // github Codex review, PR #437, src/cli/crud.ts:294.
    const winner = { id: 'winner' };
    const insert = vi.fn().mockRejectedValue({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' });
    const reload = vi.fn().mockResolvedValue(winner);

    const result = await insertOrAdopt({ id: 'loser' }, insert, reload);

    expect(result).toEqual({ row: winner, created: false });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  describe('against a real TEXT PRIMARY KEY table', () => {
    // Same shape as the mocked case above, but through the real driver and a
    // real schema — the mocked test only proves insertOrAdopt's own branching
    // is correct; this proves better-sqlite3 actually raises
    // SQLITE_CONSTRAINT_PRIMARYKEY (not _UNIQUE) for this exact constraint
    // shape, which is the fact the fix depends on.
    beforeEach(async () => {
      await initTestDb();
      // Async driver, not the raw sync handle — src/db/raw-db-ratchet.test.ts
      // pins the exact set of files allowed to import getRawDb and may only
      // shrink, never grow; this file has no business on that list.
      await getDb().exec('CREATE TABLE pk_race (id TEXT PRIMARY KEY, val TEXT NOT NULL)');
    });

    afterEach(async () => {
      await closeDb();
    });

    it('two overlapping inserts for the same id: one creates, one adopts', async () => {
      const reload = () => getDb().get<{ id: string; val: string }>('SELECT id, val FROM pk_race WHERE id = ?', 'r1');
      const insertRow = (row: { id: string; val: string }) =>
        getDb()
          .run('INSERT INTO pk_race (id, val) VALUES (?, ?)', row.id, row.val)
          .then(() => undefined);

      // The first insert lands normally.
      const first = await insertOrAdopt({ id: 'r1', val: 'from-first' }, insertRow, reload);
      expect(first).toEqual({ row: { id: 'r1', val: 'from-first' }, created: true });

      // A second caller racing for the same natural key sees the PRIMARYKEY
      // violation on its own INSERT and adopts the first caller's row instead
      // of throwing.
      const second = await insertOrAdopt({ id: 'r1', val: 'from-second' }, insertRow, reload);
      expect(second).toEqual({ row: { id: 'r1', val: 'from-first' }, created: false });

      // Exactly one row persisted, with the winner's value.
      const rows = await getDb().get<{ count: number }>('SELECT COUNT(*) as count FROM pk_race');
      expect(rows?.count).toBe(1);
    });
  });

  it('rethrows the ORIGINAL unique violation when reload finds no winner', async () => {
    // The constraint that fired is not the one `reload` looks up — a real bug,
    // and swallowing it would return a row nobody created.
    const original = { code: 'SQLITE_CONSTRAINT_UNIQUE', message: 'UNIQUE constraint failed: sessions.id' };
    const insert = vi.fn().mockRejectedValue(original);
    const reload = vi.fn().mockResolvedValue(undefined);

    await expect(insertOrAdopt({ id: 'loser' }, insert, reload)).rejects.toBe(original);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('rethrows a non-unique error without calling reload', async () => {
    const boom = new Error('disk I/O error');
    const insert = vi.fn().mockRejectedValue(boom);
    const reload = vi.fn();

    await expect(insertOrAdopt({ id: 'x' }, insert, reload)).rejects.toBe(boom);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('isUniqueViolation', () => {
  it('accepts the UNIQUE and PRIMARYKEY driver codes, nothing else', () => {
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_UNIQUE' })).toBe(true);
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' })).toBe(true);
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' })).toBe(false);
    expect(isUniqueViolation(new Error('UNIQUE constraint failed'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('SQLITE_CONSTRAINT_UNIQUE')).toBe(false);
  });
});

// ── Tripwire ──

/** The three central-DB inserts whose tables carry a racy unique key. */
/**
 * Derived from the migrated schema (sqlite_master, 2026-09-05), not from
 * memory: the inserts whose leaf is async-converted (or whose callers now yield
 * before it) AND whose table carries a unique key beyond a fresh primary key —
 *   sessions:               idx_sessions_active_triple, sessions_channel_root_unique
 *   messaging_groups:       UNIQUE(channel_type, platform_id, instance)
 *   messaging_group_agents: UNIQUE(messaging_group_id, agent_group_id)
 *   agent_groups:           folder UNIQUE
 * Not guarded, and why: pending_approvals / pending_questions / container_configs
 * key only on a fresh id (createPendingQuestion is INSERT OR IGNORE); the
 * permissions leaves (pending_sender_approvals, user_dms, users) are still
 * synchronous end to end, so no yield sits between their lookup and insert.
 */
const GUARDED_CALLS = ['createSession(', 'createMessagingGroup(', 'createAgentGroup(', 'createMessagingGroupAgent('];

/** Roots scanned for bare callers. Relative to the repo root. */
const SCAN_ROOTS = ['src', 'scripts', 'setup'];

/**
 * Files allowed to call a guarded insert directly. Every entry needs a reason,
 * and the reason has to be about the CALL, not about the inconvenience of
 * fixing it.
 */
const ALLOWLIST: Array<{ path: string; reason: string }> = [
  {
    path: 'src/templates/create-agent.ts',
    reason:
      'Not lookup-then-insert: folder uniqueness comes from a filesystem check plus a random suffix, never a DB read. ' +
      'A unique loss means another operator holds that folder with a DIFFERENT group, which is not adoptable — the ' +
      'insert is deliberately fail-loud and `ncl groups create --template` surfaces the error to the caller.',
  },
  {
    path: 'src/modules/agent-to-agent/create-agent.ts',
    reason:
      'Serialized by the in-process create lock, and the insert is deliberately fail-loud: its catch rolls back the ' +
      'group folder written in steps 1-2 and notifies the requesting agent. Adopting would hand the creator ' +
      'destination rows pointing at a DIFFERENT agent that merely normalized to the same folder.',
  },
  {
    path: 'scripts/init-first-agent.ts',
    reason: 'Single-process bootstrap script; no concurrent peer exists to race with.',
  },
  {
    path: 'scripts/init-cli-agent.ts',
    reason: 'Single-process bootstrap script; no concurrent peer exists to race with.',
  },
  {
    path: 'scripts/seed-discord.ts',
    reason: 'Single-process dev seed script; no concurrent peer exists to race with.',
  },
  {
    path: 'setup/register.ts',
    reason: 'Interactive single-process setup flow; the host is not running yet, so nothing can race it.',
  },
  {
    path: 'setup/migrate-v2/db.ts',
    reason: 'One-shot v1→v2 migration, run with the host stopped; nothing can race it.',
  },
];

/**
 * Byte ranges spanned by an `insertOrAdopt(...)` call expression, generics
 * included. Paren-counting rather than an AST: the argument lists at these
 * call sites hold no string literals, so a balance scan is exact and the test
 * carries no parser dependency.
 */
export function insertOrAdoptRegions(source: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  const call = /insertOrAdopt\s*(?:<[^>]*>)?\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = call.exec(source)) !== null) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let i = open;
    for (; i < source.length; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    regions.push([match.index, i]);
  }
  return regions;
}

/** Line offsets of guarded calls that are neither declarations nor comments. */
export function bareGuardedCalls(source: string): Array<{ line: number; index: number; token: string }> {
  const hits: Array<{ line: number; index: number; token: string }> = [];
  let offset = 0;
  for (const [lineNo, line] of source.split('\n').entries()) {
    const trimmed = line.trimStart();
    // Whole-line comments (including doc-comment continuations) are prose.
    if (!trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*')) {
      for (const token of GUARDED_CALLS) {
        let at = line.indexOf(token);
        while (at !== -1) {
          // `export async function createSession(` is the leaf's declaration.
          const before = line.slice(0, at);
          if (!/\bfunction\s+$/.test(before)) {
            hits.push({ line: lineNo + 1, index: offset + at, token });
          }
          at = line.indexOf(token, at + 1);
        }
      }
    }
    offset += line.length + 1;
  }
  return hits;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...listTsFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('the guarded-call scanner', () => {
  it('finds a bare call and ignores declarations and comments', () => {
    const source = [
      'export async function createSession(s: Session): Promise<void> {}',
      '// await createSession(x);',
      ' * `createSession(` in a doc comment',
      'await createSession(candidate);',
    ].join('\n');

    expect(bareGuardedCalls(source).map((h) => h.line)).toEqual([4]);
  });

  it('places a call inside the insertOrAdopt argument list within its region', () => {
    const source = 'await insertOrAdopt(candidate, (row) => createSession(row), () => lookup());';
    const hit = bareGuardedCalls(source)[0];
    const inside = insertOrAdoptRegions(source).some(([start, end]) => hit.index > start && hit.index < end);

    expect(inside).toBe(true);
  });

  it('does not place a call that follows the insertOrAdopt call inside its region', () => {
    const source = 'await insertOrAdopt(candidate, insert, reload);\nawait createSession(other);';
    const hit = bareGuardedCalls(source)[0];
    const inside = insertOrAdoptRegions(source).some(([start, end]) => hit.index > start && hit.index < end);

    expect(inside).toBe(false);
  });

  it('spans a generic call expression', () => {
    const source = 'await insertOrAdopt<AgentGroup>(candidate, (row) => createAgentGroup(row), reload);';
    const [region] = insertOrAdoptRegions(source);

    expect(region).toBeDefined();
    expect(source.slice(region[0], region[1] + 1)).toContain('createAgentGroup(row)');
  });
});

describe('every central-DB insert is routed through insertOrAdopt', () => {
  it('has no bare caller outside the allowlist', () => {
    const allowed = new Set(ALLOWLIST.map((entry) => entry.path));
    const offenders: string[] = [];

    for (const root of SCAN_ROOTS) {
      const rootDir = path.join(REPO_ROOT, root);
      if (!fs.existsSync(rootDir)) continue;
      for (const file of listTsFiles(rootDir)) {
        const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
        if (allowed.has(rel)) continue;
        const source = fs.readFileSync(file, 'utf8');
        const regions = insertOrAdoptRegions(source);
        for (const hit of bareGuardedCalls(source)) {
          const routed = regions.some(([start, end]) => hit.index > start && hit.index < end);
          if (!routed) offenders.push(`${rel}:${hit.line} — ${hit.token}`);
        }
      }
    }

    expect(
      offenders,
      'A central-DB insert must go through insertOrAdopt (src/db/insert-or-adopt.ts), or the file must be added to ' +
        'ALLOWLIST in this test with a reason explaining why a unique-key loss is not adoptable there.',
    ).toEqual([]);
  });

  it('keeps every allowlist entry pointing at a real file that still calls a guarded insert', () => {
    for (const entry of ALLOWLIST) {
      const full = path.join(REPO_ROOT, entry.path);
      expect(fs.existsSync(full), `${entry.path} is allowlisted but does not exist`).toBe(true);
      const source = fs.readFileSync(full, 'utf8');
      expect(bareGuardedCalls(source).length, `${entry.path} is allowlisted but no longer needs to be`).toBeGreaterThan(
        0,
      );
      expect(entry.reason.length, `${entry.path} needs a reason`).toBeGreaterThan(20);
    }
  });
});
