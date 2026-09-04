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
 * How `messages_archive` can legally be named in SQL.
 *
 * Quoting and schema qualification are the reason this is a shared fragment
 * rather than a literal: `UPDATE "messages_archive" SET ...`,
 * `UPDATE [messages_archive]`, `` UPDATE `messages_archive` `` and
 * `UPDATE main.messages_archive` are all the same statement to SQLite, and a
 * tripwire that only recognised the bare form would wave three of them through.
 *
 * The bare arm ends in a negative lookahead rather than a consumed character,
 * so `messages_archive_fts` is excluded without eating the delimiter. `\b`
 * cannot do that job — `_` is a word character, so there is no word boundary
 * between `archive` and `_fts`. The quoted arms need no lookahead because the
 * closing quote already ends the identifier.
 */
const ARCHIVE_TABLE_REF =
  '(?:[A-Za-z_]\\w*\\s*\\.\\s*)?(?:"messages_archive"|`messages_archive`|\\[messages_archive\\]|messages_archive(?![_A-Za-z0-9]))';

/**
 * Write statements against the archive's base table, whitespace-tolerant and
 * case-insensitive.
 *
 * Used for BOTH the repo-wide scan and the owner-file count, so the two cannot
 * drift: a form recognised in one is recognised in the other. `CREATE TRIGGER
 * ... AFTER UPDATE ON messages_archive` does not match, because these require
 * the table to follow the verb directly rather than after `ON`.
 */
const WRITE_PATTERNS: Array<{ label: string; re: () => RegExp }> = [
  { label: 'UPDATE messages_archive', re: () => new RegExp(`\\bUPDATE\\s+${ARCHIVE_TABLE_REF}`, 'gi') },
  { label: 'DELETE FROM messages_archive', re: () => new RegExp(`\\bDELETE\\s+FROM\\s+${ARCHIVE_TABLE_REF}`, 'gi') },
  { label: 'INSERT INTO messages_archive', re: () => new RegExp(`\\bINSERT\\s+INTO\\s+${ARCHIVE_TABLE_REF}`, 'gi') },
  {
    label: 'INSERT OR <verb> INTO messages_archive',
    re: () => new RegExp(`\\bINSERT\\s+OR\\s+\\w+\\s+INTO\\s+${ARCHIVE_TABLE_REF}`, 'gi'),
  },
  { label: 'REPLACE INTO messages_archive', re: () => new RegExp(`\\bREPLACE\\s+INTO\\s+${ARCHIVE_TABLE_REF}`, 'gi') },
  {
    label: 'DROP TABLE messages_archive',
    re: () => new RegExp(`\\bDROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${ARCHIVE_TABLE_REF}`, 'gi'),
  },
];

/**
 * `VACUUM`, but only where it could plausibly be aimed at the archive.
 *
 * A bare repository-wide keyword scan is wrong: `centralDb.exec('VACUUM')` has
 * nothing to do with this invariant, and neither does the word in a comment
 * about some other database. So a VACUUM is reported only in a file that also
 * names the archive, which is the closest a static check gets to "on the
 * archive connection".
 *
 * Worth flagging at all because SQLite's docs permit VACUUM to change the
 * ROWIDs of any table without an INTEGER PRIMARY KEY, and `messages_archive`'s
 * key is TEXT. The stamp's watermark is a rowid. Today's SQLite happens to
 * preserve them (checked against the pinned better-sqlite3: a VACUUM after a
 * delete left rowids 1, 3, 5 intact), and a compaction that did renumber could
 * only lower `MAX(rowid)`, which the decrease rule already rebuilds on. So this
 * guards the ASSUMPTION rather than a live corruption — but it is an assumption
 * the design is stated in terms of, and it should not be silently taken away.
 */
const VACUUM_RE = () => /\bVACUUM\b/gi;
const ARCHIVE_MENTION_RE = () => /messages_archive|archive\.db|ARCHIVE_PATH/i;

function writeFormsIn(source: string): string[] {
  const found: string[] = [];
  for (const { label, re } of WRITE_PATTERNS) {
    if (re().test(source)) found.push(label);
  }
  return found;
}

describe('#360 — the archive has one write path', () => {
  it('finds no write against messages_archive outside its two owners', () => {
    const offenders: string[] = [];
    for (const relative of [...listTsFiles('src'), ...listTsFiles('scripts')]) {
      if (WRITERS.has(relative)) continue;
      const source = fs.readFileSync(path.join(REPO_ROOT, relative), 'utf-8');
      for (const label of writeFormsIn(source)) offenders.push(`${relative}: ${label}`);
      if (VACUUM_RE().test(source) && ARCHIVE_MENTION_RE().test(source)) {
        offenders.push(`${relative}: VACUUM in a file that also names the archive`);
      }
    }
    expect(offenders, `${offenders.join('; ')}\n\n${WHY}`).toEqual([]);
  });

  it('recognises quoted, bracketed and schema-qualified table names', () => {
    // The forms a future mutation could take without ever writing the bare
    // name. Asserted directly rather than by planting code, so the coverage
    // cannot rot: if a reader tightens ARCHIVE_TABLE_REF, this fails.
    for (const statement of [
      'UPDATE messages_archive SET sent_at = ?',
      'UPDATE "messages_archive" SET sent_at = ?',
      'UPDATE [messages_archive] SET sent_at = ?',
      'UPDATE `messages_archive` SET sent_at = ?',
      'UPDATE main.messages_archive SET sent_at = ?',
      'UPDATE main . "messages_archive" SET sent_at = ?',
      'delete   from   messages_archive where id = ?',
      'REPLACE INTO messages_archive (id) VALUES (?)',
      'INSERT OR REPLACE INTO messages_archive (id) VALUES (?)',
      'DROP TABLE IF EXISTS messages_archive',
    ]) {
      expect(writeFormsIn(statement), `not recognised as a write: ${statement}`).not.toEqual([]);
    }

    // The FTS shadow table and the marks table are different tables, and the
    // trigger DDL names the base table after ON rather than after the verb.
    for (const statement of [
      'INSERT INTO messages_archive_fts(rowid, text) VALUES (?, ?)',
      "INSERT INTO messages_archive_fts(messages_archive_fts, rowid) VALUES ('delete', ?)",
      'INSERT INTO "messages_archive_fts" (rowid) VALUES (?)',
      'INSERT INTO archive_row_marks (agent_group_id, mutations) VALUES (?, 1)',
      'CREATE TRIGGER x AFTER UPDATE ON messages_archive BEGIN SELECT 1; END',
      'CREATE TRIGGER y AFTER DELETE ON messages_archive BEGIN SELECT 1; END',
      'SELECT * FROM messages_archive WHERE id = ?',
    ]) {
      expect(writeFormsIn(statement), `wrongly flagged as a write: ${statement}`).toEqual([]);
    }
  });

  it('does not flag a VACUUM of some other database', () => {
    // The false positive the scan must not produce: unrelated maintenance code
    // vacuuming the central DB, in a file that never mentions the archive.
    const unrelated = "centralDb.exec('VACUUM');";
    expect(VACUUM_RE().test(unrelated) && ARCHIVE_MENTION_RE().test(unrelated)).toBe(false);
    // ...and the one it must still catch.
    const archiveVacuum = "const db = new Database(ARCHIVE_PATH); db.exec('VACUUM');";
    expect(VACUUM_RE().test(archiveVacuum) && ARCHIVE_MENTION_RE().test(archiveVacuum)).toBe(true);
  });

  it('keeps message-archive.ts down to the single upsert', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/message-archive.ts'), 'utf-8');

    // The base table is written in exactly one place, and that place is the
    // exported constant. The trigger BODIES in this file write
    // `messages_archive_fts` and `archive_row_marks`, never the base table.
    // The SAME quote-aware patterns the repo-wide scan uses. An owner-specific
    // regex here was the gap Codex found: a future
    // `UPDATE "messages_archive" SET ...` inside this file matched neither the
    // general scan (which skips owners) nor the narrower local pattern.
    const baseTableWrites: string[] = [];
    for (const { label, re } of WRITE_PATTERNS) {
      for (const match of source.matchAll(re())) baseTableWrites.push(`${label} @ ${match.index}`);
    }
    expect(
      baseTableWrites,
      `message-archive.ts must contain exactly one write to messages_archive, found ${baseTableWrites.length}: ${baseTableWrites.join(', ')}.\n\n${WHY}`,
    ).toHaveLength(1);
    expect(VACUUM_RE().test(source), `message-archive.ts gained a VACUUM.\n\n${WHY}`).toBe(false);
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

  it('walks scripts/ as well as src/', () => {
    // Stated as its own assertion because the reviewer could not verify it by
    // reading: a migration or backfill script writing messages_archive outside
    // the upsert would bypass the marks triggers just as surely as host code.
    const scanned = [...listTsFiles('src'), ...listTsFiles('scripts')];
    expect(scanned.some((f) => f.startsWith('src/'))).toBe(true);
    expect(
      scanned.some((f) => f.startsWith('scripts/')),
      'scripts/ was not scanned',
    ).toBe(true);
  });

  it('materializes the archive schema before anything that can spawn', () => {
    // The marks table is created by the archive's lazy open, on the first
    // WRITE. Until it exists every projection stamp fails closed and every
    // spawn does the full rebuild this release removes — so the eager call has
    // to precede every startup step that can reach wakeContainer, not merely
    // the sweep. startDashboard() exposes a scheduled task's run-now;
    // channel recovery archives messages and would otherwise steal the
    // one-time creation log line that serves as the deploy gate fact.
    // Comment lines stripped first — the prose above the call names
    // startDashboard() on purpose, to say what it is ordered against, and an
    // index over the raw source would compare against that mention.
    const main = fs
      .readFileSync(path.join(REPO_ROOT, 'src/main.ts'), 'utf-8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    const at = (needle: string): number => {
      const index = main.indexOf(needle);
      expect(index, `src/main.ts no longer contains a call to ${needle}`).toBeGreaterThan(-1);
      return index;
    };

    const archive = at('ensureArchiveSchema()');
    for (const laterStep of ['startDashboard()', 'recoverAllChannelsAfterStartup(', 'startHostSweep()']) {
      expect(archive, `ensureArchiveSchema() must run before ${laterStep}`).toBeLessThan(at(laterStep));
    }
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
