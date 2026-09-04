/**
 * The archive has exactly ONE write path, and the projection depends on it.
 *
 * `data/archive.db` carries `archive_row_marks` plus an `AFTER UPDATE` and an
 * `AFTER DELETE` trigger on `messages_archive`. The archive projection's
 * freshness stamp (#360) is sound only because those counters see every change
 * a watermark cannot: `COUNT(*)`/`MAX(rowid)` catch rows arriving, the marks
 * catch rows being rewritten or removed, and between them they cover
 * everything the single upsert in `src/message-archive.ts` can do. A second
 * write path that bypassed the triggers — a raw `UPDATE`, a
 * `DELETE`/`REPLACE`, a bulk import — would let an edited message go
 * unprojected indefinitely, not merely until the next spawn.
 *
 * So the invariant is not "the archive is append-only" (it is not — the one
 * statement is an upsert). It is "there is only that one statement". This file
 * holds that, structurally, because no runtime test can.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ARCHIVE_UPSERT_SQL } from './message-archive.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const WHY =
  'a new write path must keep the archive_row_marks triggers correct — ' +
  'the incremental projection append (#360) reads those counters to decide ' +
  'that nothing was edited, so a mutation that bypasses them serves a ' +
  'container stale history forever. Route the write through ' +
  'ARCHIVE_UPSERT_SQL, or bump ARCHIVE_PROJECTION_STAMP_VERSION and add a ' +
  'full-rebuild path that can see it.';

/**
 * Files allowed to contain a write against a table named `messages_archive`.
 *
 * `message-archive.ts` owns the canonical archive and its one statement.
 * `db/per-agent-projections.ts` writes the per-session PROJECTION, a different
 * file with its own schema that no host writer and no container ever mutates;
 * its inserts are how a projection gets built at all.
 */
const WRITERS = new Set(['src/message-archive.ts', 'src/db/per-agent-projections.ts']);

/** Every non-test `.ts` file under `root`, as REPO_ROOT-relative posix paths. */
function listTsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        out.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
      }
    }
  };
  walk(path.join(REPO_ROOT, root));
  return out;
}

/**
 * Write statements against `messages_archive`, whitespace-tolerant and
 * case-insensitive.
 *
 * `messages_archive_fts` is excluded by the trailing boundary: the FTS shadow
 * table is maintained by `INSERT INTO messages_archive_fts(...)` inside the
 * sync triggers in both writer files, and those are not writes to the base
 * table. `\b` alone would not do it — `_` is a word character, so
 * `messages_archive_fts` contains no boundary after `archive`; the explicit
 * `[^_a-zA-Z0-9]` is what separates them.
 */
const WRITE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'UPDATE messages_archive', re: /\bUPDATE\s+["'`]?messages_archive(?:["'`]|[^_a-zA-Z0-9]|$)/gi },
  { label: 'DELETE FROM messages_archive', re: /\bDELETE\s+FROM\s+["'`]?messages_archive(?:["'`]|[^_a-zA-Z0-9]|$)/gi },
  { label: 'REPLACE INTO messages_archive', re: /\bREPLACE\s+INTO\s+["'`]?messages_archive(?:["'`]|[^_a-zA-Z0-9]|$)/gi },
  {
    label: 'INSERT OR REPLACE INTO messages_archive',
    re: /\bINSERT\s+OR\s+\w+\s+INTO\s+["'`]?messages_archive(?:["'`]|[^_a-zA-Z0-9]|$)/gi,
  },
  { label: 'INSERT INTO messages_archive', re: /\bINSERT\s+INTO\s+["'`]?messages_archive(?:["'`]|[^_a-zA-Z0-9]|$)/gi },
  { label: 'DROP TABLE messages_archive', re: /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?messages_archive(?:["'`]|[^_a-zA-Z0-9]|$)/gi },
  { label: 'VACUUM', re: /\bVACUUM\b/gi },
];

describe('#360 — the archive has one write path', () => {
  it('finds no write against messages_archive outside its two owners', () => {
    const offenders: string[] = [];
    for (const relative of [...listTsFiles('src'), ...listTsFiles('scripts')]) {
      if (WRITERS.has(relative)) continue;
      const source = fs.readFileSync(path.join(REPO_ROOT, relative), 'utf-8');
      for (const { label, re } of WRITE_PATTERNS) {
        re.lastIndex = 0;
        if (re.test(source)) offenders.push(`${relative}: ${label}`);
      }
    }
    expect(offenders, `${offenders.join('; ')}\n\n${WHY}`).toEqual([]);
  });

  it('keeps message-archive.ts down to the single upsert', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/message-archive.ts'), 'utf-8');

    // The base table is written in exactly one place, and that place is the
    // exported constant. The trigger BODIES in this file write
    // `messages_archive_fts` and `archive_row_marks`, never the base table.
    const baseTableWrites = [
      ...source.matchAll(/\b(?:INSERT\s+INTO|INSERT\s+OR\s+\w+\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+messages_archive(?:[^_a-zA-Z0-9]|$)/gi),
    ];
    expect(baseTableWrites, `message-archive.ts gained a second write to messages_archive.\n\n${WHY}`).toHaveLength(1);
    expect(ARCHIVE_UPSERT_SQL).toMatch(/INSERT INTO messages_archive/);
    expect(ARCHIVE_UPSERT_SQL).toMatch(/ON CONFLICT\(id\) DO UPDATE SET/);
    expect(source).toContain('ARCHIVE_UPSERT_SQL');
  });

  it('creates the marks table and both triggers idempotently', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/message-archive.ts'), 'utf-8');
    // A re-run on every openDb() must be a no-op, so all three are IF NOT EXISTS.
    expect(source).toMatch(/CREATE TABLE IF NOT EXISTS archive_row_marks/);
    expect(source).toMatch(/CREATE TRIGGER IF NOT EXISTS messages_archive_mark_update/);
    expect(source).toMatch(/CREATE TRIGGER IF NOT EXISTS messages_archive_mark_delete/);
    // The UPDATE trigger is guarded, so an idempotent re-archive of identical
    // content does not invalidate every sibling's projection.
    expect(source).toMatch(/AFTER UPDATE ON messages_archive\s*\n\s*WHEN old\.text IS NOT new\.text/);
  });

  it('keeps the marks table out of the projection schema the container mounts', () => {
    // Containers read the projection and never write it, so counters there
    // would be dead weight and a new surface. The projection's schema is
    // deliberately unchanged by #360.
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/db/per-agent-projections.ts'), 'utf-8');
    const schema = source.slice(source.indexOf('const ARCHIVE_SCHEMA_SQL'), source.indexOf('const ARCHIVE_COLS'));
    expect(schema).not.toMatch(/archive_row_marks/);
    expect(schema).not.toMatch(/messages_archive_mark_/);
  });
});
