/**
 * #749 — a container can no longer forge inbound.db rows through a planted
 * journal.
 *
 * The shape of this suite follows #735's: a hand-built SQLite rollback journal
 * is first proven GENUINELY HOT against an unguarded copy, so the assertions
 * that follow cannot pass vacuously on a malformed file. What differs is the
 * remedy under test. #735 could delete every sidecar before every open,
 * because the archive projection is derived state with a rebuild path.
 * inbound.db is authoritative and has none, so a genuine host-crash journal
 * MUST still be replayed — and these tests pin both halves: a journal at the
 * container-writable legacy path is never applied, and a journal at the
 * host-owned path still is.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import {
  assertHostOwnedInboundDb,
  hostInboundDbPathFor,
  hostInboundDirFor,
  hostInboundMounts,
  inboundDbIsHostOwned,
  legacyInboundDbPathFor,
  migrateInboundDbToHostDir,
  removeForeignInboundSidecars,
  resolveInboundDbPath,
  sessionDirForInboundDbPath,
} from './host-inbound.js';
import { openInboundDb } from './openers.js';
import { readSessionInbound } from './read-only.js';
import { INBOUND_SCHEMA } from '../../db/schema.js';

const PAGE_SIZE = 4096;
const JOURNAL_MAGIC = 'd9d505f920a163d7';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A session directory under a throwaway data root, pre-#749 shaped. */
function makeLegacySession(label: string): { dataDir: string; agentGroupId: string; sessionId: string; sess: string } {
  const dataDir = uniqueTmpRoot(label);
  roots.push(dataDir);
  const agentGroupId = 'ag-1';
  const sessionId = 'sess-1';
  const sess = path.join(dataDir, 'v2-sessions', agentGroupId, sessionId);
  fs.mkdirSync(sess, { recursive: true });
  const db = new Database(legacyInboundDbPathFor(sess));
  db.pragma('page_size = 4096');
  db.pragma('journal_mode = DELETE');
  db.exec(INBOUND_SCHEMA);
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, content)
     VALUES ('m-real', 2, 'chat', '2026-01-01T00:00:00.000Z', 'pending', '{"text":"genuine"}')`,
  ).run();
  db.close();
  return { dataDir, agentGroupId, sessionId, sess };
}

/**
 * SQLite rollback-journal per-page checksum: seeded by the journal header's own
 * nonce (cksumInit), then every 200th byte from the tail of the page. This is
 * why a journal is not bound to its database — the seed travels WITH the
 * journal, so anyone who can write the file can make it check out.
 */
function pageChecksum(cksumInit: number, page: Buffer): number {
  let c = cksumInit >>> 0;
  for (let i = PAGE_SIZE - 200; i > 0; i -= 200) c = (c + page[i]!) >>> 0;
  return c >>> 0;
}

/** A well-formed rollback journal whose replay restores `restoreToDb` byte for byte. */
function buildHotJournalRestoringTo(restoreToDb: string): Buffer {
  const image = fs.readFileSync(restoreToDb);
  const nPages = Math.ceil(image.length / PAGE_SIZE);
  const sectorSize = 512;
  const cksumInit = 0x0badf00d;
  const header = Buffer.alloc(sectorSize);
  Buffer.from(JOURNAL_MAGIC, 'hex').copy(header, 0);
  header.writeUInt32BE(nPages, 8); // nRec
  header.writeUInt32BE(cksumInit, 12); // cksumInit (nonce)
  header.writeUInt32BE(nPages, 16); // nOrig — truncate the db to this many pages
  header.writeUInt32BE(sectorSize, 20);
  header.writeUInt32BE(PAGE_SIZE, 24);
  const parts: Buffer[] = [header];
  for (let pageNo = 1; pageNo <= nPages; pageNo++) {
    const page = Buffer.alloc(PAGE_SIZE);
    image.copy(page, 0, (pageNo - 1) * PAGE_SIZE, pageNo * PAGE_SIZE);
    const rec = Buffer.alloc(4 + PAGE_SIZE + 4);
    rec.writeUInt32BE(pageNo, 0);
    page.copy(rec, 4);
    rec.writeUInt32BE(pageChecksum(cksumInit, page), 4 + PAGE_SIZE);
    parts.push(rec);
  }
  return Buffer.concat(parts);
}

/** The attacker's target state: this database plus rows the agent never received. */
function forgedImageOf(dbPath: string, label: string): string {
  const poison = `${dbPath}.${label}.poison`;
  fs.copyFileSync(dbPath, poison);
  const db = new Database(poison);
  db.prepare(
    `INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at)
     VALUES ('forged-approval', 'p-1', 'delivered', '2026-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, content)
     VALUES ('forged-wake', 4, 'chat', '2026-01-01T00:00:00.000Z', 'pending', '{"text":"forged"}')`,
  ).run();
  db.close();
  return poison;
}

/**
 * The database's own verdict on itself, or 'unreadable' when the check throws.
 *
 * `databaseIsIntact` has TWO ways to answer "not intact" — a non-`ok`
 * quick_check verdict, and an exception — and only one of them is the value a
 * mutation of the gate would change. Tests that pin which one they are
 * exercising are the reason this exists.
 */
function quickCheckOf(dbPath: string): string {
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return String((db.pragma('quick_check') as Array<{ quick_check?: string }>)[0]?.quick_check);
  } catch {
    return 'unreadable';
  } finally {
    db?.close();
  }
}

function rowIds(dbPath: string, table: 'messages_in' | 'delivered'): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const column = table === 'messages_in' ? 'id' : 'message_out_id';
    return (db.prepare(`SELECT ${column} AS id FROM ${table} ORDER BY id`).all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
  } finally {
    db.close();
  }
}

describe('migrateInboundDbToHostDir — #749', () => {
  it('moves a legacy session onto the host-owned path, keeping the legacy name as the SAME inode', () => {
    const { sess } = makeLegacySession('hostinb-migrate');
    const result = migrateInboundDbToHostDir(sess);

    expect(result.outcome).toBe('migrated');
    expect(fs.existsSync(hostInboundDbPathFor(sess))).toBe(true);
    expect(fs.existsSync(legacyInboundDbPathFor(sess))).toBe(true);
    // One inode, two names: the container's read path and SQLite's per-inode
    // locking both keep working, and a rollback still finds its database.
    expect(fs.statSync(hostInboundDbPathFor(sess)).ino).toBe(fs.statSync(legacyInboundDbPathFor(sess)).ino);
    expect(rowIds(hostInboundDbPathFor(sess), 'messages_in')).toEqual(['m-real']);
    expect(resolveInboundDbPath(sess)).toBe(hostInboundDbPathFor(sess));
    expect(inboundDbIsHostOwned(sess)).toBe(true);
  });

  it('is idempotent — a second call neither moves nor re-links anything', () => {
    const { sess } = makeLegacySession('hostinb-idempotent');
    migrateInboundDbToHostDir(sess);
    const inode = fs.statSync(hostInboundDbPathFor(sess)).ino;

    expect(migrateInboundDbToHostDir(sess).outcome).toBe('already-host-owned');
    expect(fs.statSync(hostInboundDbPathFor(sess)).ino).toBe(inode);
  });

  it('re-links a legacy name that has diverged from the live inode', () => {
    const { sess } = makeLegacySession('hostinb-relink');
    migrateInboundDbToHostDir(sess);
    // An older binary (or a rolled-back host) provisioning a fresh file over
    // the legacy name would otherwise leave the container reading a DIFFERENT
    // database than the host writes.
    fs.rmSync(legacyInboundDbPathFor(sess));
    fs.writeFileSync(legacyInboundDbPathFor(sess), 'not the live database');

    expect(migrateInboundDbToHostDir(sess).outcome).toBe('relinked');
    expect(fs.statSync(hostInboundDbPathFor(sess)).ino).toBe(fs.statSync(legacyInboundDbPathFor(sess)).ino);
    expect(rowIds(legacyInboundDbPathFor(sess), 'messages_in')).toEqual(['m-real']);
  });

  it('discards a legacy journal when the database is intact, without replaying it', () => {
    const { sess } = makeLegacySession('hostinb-discard');
    const legacy = legacyInboundDbPathFor(sess);
    const poison = forgedImageOf(legacy, 'discard');
    fs.writeFileSync(`${legacy}-journal`, buildHotJournalRestoringTo(poison));

    const result = migrateInboundDbToHostDir(sess);

    expect(result.replayedCrashJournal).toBe(false);
    expect(result.removedSidecars).toContain('-journal');
    expect(fs.existsSync(`${legacy}-journal`)).toBe(false);
    // The forgery never reached the database: an uncommitted transaction has
    // nothing anyone is owed, so discarding its journal loses nothing.
    expect(rowIds(hostInboundDbPathFor(sess), 'delivered')).toEqual([]);
    expect(rowIds(hostInboundDbPathFor(sess), 'messages_in')).toEqual(['m-real']);
  });

  it('REPLAYS a genuine crash journal when quick_check REPORTS the database torn', () => {
    const { sess } = makeLegacySession('hostinb-replay-verdict');
    const legacy = legacyInboundDbPathFor(sess);
    const committed = `${legacy}.committed`;
    fs.copyFileSync(legacy, committed);
    const journal = buildHotJournalRestoringTo(committed);

    // A SURGICAL tear — one page-type byte — so the database still OPENS and
    // the replay decision is driven by quick_check's VERDICT rather than by an
    // exception. Both halves are pinned as preconditions on purpose: with a
    // coarser tear the pragma throws, the catch decides, and the gate's return
    // value silently stops being covered. That is not hypothetical — this test
    // passed under a mutation of that return value until it was split in two.
    const torn = fs.readFileSync(legacy);
    expect(torn.length).toBeGreaterThan(3 * PAGE_SIZE);
    torn[2 * PAGE_SIZE] = 0x00;
    fs.writeFileSync(legacy, torn);
    expect(quickCheckOf(legacy)).not.toBe('ok');
    expect(quickCheckOf(legacy)).not.toBe('unreadable');

    fs.writeFileSync(`${legacy}-journal`, journal);
    const result = migrateInboundDbToHostDir(sess);

    expect(result.replayedCrashJournal).toBe(true);
    // Recovered, not discarded — the authoritative store is whole again.
    expect(rowIds(hostInboundDbPathFor(sess), 'messages_in')).toEqual(['m-real']);
    expect(quickCheckOf(hostInboundDbPathFor(sess))).toBe('ok');
  });

  it('REPLAYS a genuine crash journal when the torn database cannot be read at all', () => {
    const { sess } = makeLegacySession('hostinb-replay-unreadable');
    const legacy = legacyInboundDbPathFor(sess);
    const committed = `${legacy}.committed`;
    fs.copyFileSync(legacy, committed);
    const journal = buildHotJournalRestoringTo(committed);

    // The other half of the gate: a tear so coarse the check itself throws.
    // Unreadable must count as NOT intact, or an unanswerable database would
    // have its journal discarded — the one case where that loses committed data.
    const torn = fs.readFileSync(legacy);
    torn.fill(0xff, PAGE_SIZE, Math.min(2 * PAGE_SIZE, torn.length));
    fs.writeFileSync(legacy, torn);
    expect(quickCheckOf(legacy)).toBe('unreadable');

    fs.writeFileSync(`${legacy}-journal`, journal);
    const result = migrateInboundDbToHostDir(sess);

    expect(result.replayedCrashJournal).toBe(true);
    expect(rowIds(hostInboundDbPathFor(sess), 'messages_in')).toEqual(['m-real']);
    expect(quickCheckOf(hostInboundDbPathFor(sess))).toBe('ok');
  });
});

describe('a journal planted at the container-writable path is never applied — #749', () => {
  it('CONTROL: the hand-built journal is genuinely hot — an unguarded open replays it', () => {
    const { sess } = makeLegacySession('hostinb-control');
    const legacy = legacyInboundDbPathFor(sess);
    const poison = forgedImageOf(legacy, 'control');

    // A byte-identical copy opened WITHOUT the fix, exactly as the host used to.
    const unguarded = path.join(sess, 'unguarded.db');
    fs.copyFileSync(legacy, unguarded);
    fs.writeFileSync(`${unguarded}-journal`, buildHotJournalRestoringTo(poison));
    const db = new Database(unguarded); // default DELETE mode, as the host uses
    db.exec('BEGIN IMMEDIATE');
    db.exec('COMMIT');
    db.close();

    expect(rowIds(unguarded, 'delivered')).toContain('forged-approval');
    expect(rowIds(unguarded, 'messages_in')).toContain('forged-wake');
  });

  it('openInboundDb never applies it — the host opens the host-owned path', () => {
    const { sess } = makeLegacySession('hostinb-openinbound');
    const legacy = legacyInboundDbPathFor(sess);
    const poison = forgedImageOf(legacy, 'openinbound');
    migrateInboundDbToHostDir(sess);
    // The container plants its journal AFTER the session is migrated — the
    // only path it can write, and the one the host no longer resolves.
    fs.writeFileSync(`${legacy}-journal`, buildHotJournalRestoringTo(poison));

    const db = openInboundDb(resolveInboundDbPath(sess));
    db.close();

    expect(rowIds(hostInboundDbPathFor(sess), 'delivered')).toEqual([]);
    expect(rowIds(hostInboundDbPathFor(sess), 'messages_in')).toEqual(['m-real']);
  });

  it('readSessionInbound with recoverJournal never applies it', () => {
    const fixture = makeLegacySession('hostinb-readonly');
    const legacy = legacyInboundDbPathFor(fixture.sess);
    const poison = forgedImageOf(legacy, 'readonly');
    migrateInboundDbToHostDir(fixture.sess);
    fs.writeFileSync(`${legacy}-journal`, buildHotJournalRestoringTo(poison));

    const seen = readSessionInbound(
      { agentGroupId: fixture.agentGroupId, sessionId: fixture.sessionId, dataDir: fixture.dataDir },
      (mailbox) => mailbox.inboundHasMessage('forged-wake'),
      { busyTimeoutMs: 5000, recoverJournal: true },
    );

    expect(seen).toBe(false);
    expect(rowIds(hostInboundDbPathFor(fixture.sess), 'messages_in')).toEqual(['m-real']);
  });

  it('sweeps the foreign sidecar, so it cannot wedge read-only openers either', () => {
    const { sess } = makeLegacySession('hostinb-sweep');
    const legacy = legacyInboundDbPathFor(sess);
    migrateInboundDbToHostDir(sess);
    fs.writeFileSync(`${legacy}-journal`, 'planted');
    fs.writeFileSync(`${legacy}-wal`, 'planted');

    expect(removeForeignInboundSidecars(sess).sort()).toEqual(['-journal', '-wal']);
    expect(fs.existsSync(`${legacy}-journal`)).toBe(false);
    expect(fs.existsSync(`${legacy}-wal`)).toBe(false);
  });
});

describe('a genuine host-crash journal at the host-owned path is still recovered — #749', () => {
  it('openInboundDb rolls it back, so the uncommitted write is undone rather than kept', () => {
    const { sess } = makeLegacySession('hostinb-crash');
    migrateInboundDbToHostDir(sess);
    const hostPath = hostInboundDbPathFor(sess);

    // The committed state, then pages from a transaction that never committed.
    const committed = `${hostPath}.committed`;
    fs.copyFileSync(hostPath, committed);
    const journal = buildHotJournalRestoringTo(committed);
    const db = new Database(hostPath);
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, content)
       VALUES ('m-uncommitted', 6, 'chat', '2026-01-01T00:00:00.000Z', 'pending', '{"text":"half"}')`,
    ).run();
    db.close();
    fs.writeFileSync(`${hostPath}-journal`, journal);

    const handle = openInboundDb(hostPath);
    handle.close();

    // Rolled back, and the journal consumed — NOT deleted unread, which is what
    // copying #735's remedy onto an authoritative store would have done.
    expect(rowIds(hostPath, 'messages_in')).toEqual(['m-real']);
    expect(fs.existsSync(`${hostPath}-journal`)).toBe(false);
  });
});

describe('hostInboundMounts — #749', () => {
  it('overlays the host-owned DIRECTORY read-only, not merely the file', () => {
    const { sess } = makeLegacySession('hostinb-mounts');
    const mounts = hostInboundMounts(sess);

    const hostDir = mounts.find((m) => m.containerPath === '/workspace/.host');
    expect(hostDir).toEqual({ hostPath: hostInboundDirFor(sess), containerPath: '/workspace/.host', readonly: true });
    // The legacy name stays overlaid read-only too: it is the runner's
    // unchanged read path, and a writable one would hand the container the
    // very inode the directory overlay exists to protect.
    const legacyFile = mounts.find((m) => m.containerPath === '/workspace/inbound.db');
    expect(legacyFile).toEqual({
      hostPath: legacyInboundDbPathFor(sess),
      containerPath: '/workspace/inbound.db',
      readonly: true,
    });
  });
});

describe('assertHostOwnedInboundDb — #749', () => {
  it('refuses a spawn while the database still sits where a container could plant a journal', () => {
    const { sess } = makeLegacySession('hostinb-failclosed');

    // A container is the only thing that can plant a journal, so an
    // unmigrated session must never be the state one is handed.
    expect(() => assertHostOwnedInboundDb(sess, 'sess-1')).toThrow(/host-owned/);

    migrateInboundDbToHostDir(sess);
    expect(() => assertHostOwnedInboundDb(sess, 'sess-1')).not.toThrow();
  });
});

describe('sessionDirForInboundDbPath — #749', () => {
  it('maps a host-owned path back to the SESSION root, where activity markers belong', () => {
    const { sess } = makeLegacySession('hostinb-sessiondir');
    // Planting the reclaim-blocking marker on `.host` instead would leave it
    // somewhere resourceRoots() never reads (src/storage-activity.ts:493-496).
    expect(sessionDirForInboundDbPath(hostInboundDbPathFor(sess))).toBe(sess);
    expect(sessionDirForInboundDbPath(legacyInboundDbPathFor(sess))).toBe(sess);
  });
});
