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
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

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
import { HostInboundProvenanceError, SessionDbMissingError } from './errors.js';
import { openInboundDb } from './openers.js';
import { readSessionInbound } from './read-only.js';
import { INBOUND_SCHEMA } from '../../db/schema.js';
import { closeDb, initMigratedTestDb } from '../../db/index.js';
import {
  fileIdentityOf,
  readHostInboundProvenance,
  recordHostInboundProvenance,
} from '../../db/host-inbound-provenance.js';

const PAGE_SIZE = 4096;
const JOURNAL_MAGIC = 'd9d505f920a163d7';

const roots: string[] = [];

// The migration reads and writes the host's provenance record, which lives in
// the central DB (migration 077) — so these cases need a real one. A fresh
// in-memory DB per test also means one case's record can never answer another's
// question.
beforeEach(async () => {
  await initMigratedTestDb();
});

afterEach(async () => {
  await closeDb();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A session directory under a throwaway data root, pre-#749 shaped. */
function makeLegacySession(label: string): { dataDir: string; agentGroupId: string; sessionId: string; sess: string } {
  const dataDir = uniqueTmpRoot(label);
  roots.push(dataDir);
  const agentGroupId = 'ag-1';
  // The label, not a fixed id: provenance is keyed by (agent group, session),
  // so a shared id would let one case's record answer another case's question.
  const sessionId = label;
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
 * `migrateInboundDbToHostDir` for a fixture, with the session key derived from
 * the fixture's own path — `<data>/v2-sessions/<agent group>/<session>`.
 *
 * Keeps the cases reading as they did before the key became a parameter, and
 * keeps the key and the directory it names from drifting apart in a fixture.
 */
function migrate(sess: string): ReturnType<typeof migrateInboundDbToHostDir> {
  return migrateInboundDbToHostDir(sess, {
    agentGroupId: path.basename(path.dirname(sess)),
    sessionId: path.basename(sess),
  });
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
  it('moves a legacy session onto the host-owned path, keeping the legacy name as the SAME inode', async () => {
    const { sess } = makeLegacySession('hostinb-migrate');
    const result = await migrate(sess);

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

  it('is idempotent — a second call neither moves nor re-links anything', async () => {
    const { sess } = makeLegacySession('hostinb-idempotent');
    await migrate(sess);
    const inode = fs.statSync(hostInboundDbPathFor(sess)).ino;

    expect((await migrate(sess)).outcome).toBe('already-host-owned');
    expect(fs.statSync(hostInboundDbPathFor(sess)).ino).toBe(inode);
  });

  it('re-links a legacy name that has diverged from the live inode', async () => {
    const { sess } = makeLegacySession('hostinb-relink');
    await migrate(sess);
    // An older binary (or a rolled-back host) provisioning a fresh file over
    // the legacy name would otherwise leave the container reading a DIFFERENT
    // database than the host writes.
    fs.rmSync(legacyInboundDbPathFor(sess));
    fs.writeFileSync(legacyInboundDbPathFor(sess), 'not the live database');

    expect((await migrate(sess)).outcome).toBe('relinked');
    expect(fs.statSync(hostInboundDbPathFor(sess)).ino).toBe(fs.statSync(legacyInboundDbPathFor(sess)).ino);
    expect(rowIds(legacyInboundDbPathFor(sess), 'messages_in')).toEqual(['m-real']);
  });

  // ── a session reclaimed mid-migration ──────────────────────────────────────
  // `existsSync` says the file is there, and the reclaim deletes the whole
  // session directory from a worker thread before the link runs
  // (`src/storage-manager.ts:1543`). The stale answer is forced here with a spy
  // rather than by racing a real thread, so the assertion is deterministic —
  // the code path under test is identical either way. What matters is the
  // CLASS: callers branch on `SessionDbMissingError` to skip a dead session,
  // and a raw `ENOENT … link` fails their whole tick instead.

  it('reports a session reclaimed before the migrating link as missing, not a raw ENOENT', async () => {
    const { sess } = makeLegacySession('hostinb-vanish-migrate');
    const legacy = legacyInboundDbPathFor(sess);
    fs.rmSync(legacy);
    const realExists = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((target) => (String(target) === legacy ? true : realExists(target)));

    try {
      await expect(migrate(sess)).rejects.toThrow(SessionDbMissingError);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('reports a session reclaimed before the RE-LINK as missing too — the stat runs first', async () => {
    const { sess } = makeLegacySession('hostinb-vanish-relink');
    await migrate(sess);
    // Already host-owned, so the next call takes the re-link branch — which
    // stats BOTH names before it links. Losing the host-owned file there must
    // answer with the same class, not the errno the stat happens to raise.
    const hostPath = hostInboundDbPathFor(sess);
    fs.rmSync(hostPath);
    const realExists = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((target) =>
      String(target) === hostPath ? true : realExists(target),
    );

    try {
      await expect(migrate(sess)).rejects.toThrow(SessionDbMissingError);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('discards a legacy journal when the database is intact, without replaying it', async () => {
    const { sess } = makeLegacySession('hostinb-discard');
    const legacy = legacyInboundDbPathFor(sess);
    const poison = forgedImageOf(legacy, 'discard');
    fs.writeFileSync(`${legacy}-journal`, buildHotJournalRestoringTo(poison));

    const result = await migrate(sess);

    expect(result.replayedCrashJournal).toBe(false);
    expect(result.removedSidecars).toContain('-journal');
    expect(fs.existsSync(`${legacy}-journal`)).toBe(false);
    // The forgery never reached the database: an uncommitted transaction has
    // nothing anyone is owed, so discarding its journal loses nothing.
    expect(rowIds(hostInboundDbPathFor(sess), 'delivered')).toEqual([]);
    expect(rowIds(hostInboundDbPathFor(sess), 'messages_in')).toEqual(['m-real']);
  });

  it('REPLAYS a genuine crash journal when quick_check REPORTS the database torn', async () => {
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
    const result = await migrate(sess);

    expect(result.replayedCrashJournal).toBe(true);
    // Recovered, not discarded — the authoritative store is whole again.
    expect(rowIds(hostInboundDbPathFor(sess), 'messages_in')).toEqual(['m-real']);
    expect(quickCheckOf(hostInboundDbPathFor(sess))).toBe('ok');
  });

  it('REPLAYS a genuine crash journal when the torn database cannot be read at all', async () => {
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
    const result = await migrate(sess);

    expect(result.replayedCrashJournal).toBe(true);
    expect(rowIds(hostInboundDbPathFor(sess), 'messages_in')).toEqual(['m-real']);
    expect(quickCheckOf(hostInboundDbPathFor(sess))).toBe('ok');
  });
});

describe('a journal planted at the container-writable path is never applied — #749', () => {
  it('CONTROL: the hand-built journal is genuinely hot — an unguarded open replays it', async () => {
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

  it('openInboundDb never applies it — the host opens the host-owned path', async () => {
    const { sess } = makeLegacySession('hostinb-openinbound');
    const legacy = legacyInboundDbPathFor(sess);
    const poison = forgedImageOf(legacy, 'openinbound');
    await migrate(sess);
    // The container plants its journal AFTER the session is migrated — the
    // only path it can write, and the one the host no longer resolves.
    fs.writeFileSync(`${legacy}-journal`, buildHotJournalRestoringTo(poison));

    const db = openInboundDb(resolveInboundDbPath(sess));
    db.close();

    expect(rowIds(hostInboundDbPathFor(sess), 'delivered')).toEqual([]);
    expect(rowIds(hostInboundDbPathFor(sess), 'messages_in')).toEqual(['m-real']);
  });

  it('readSessionInbound with recoverJournal never applies it', async () => {
    const fixture = makeLegacySession('hostinb-readonly');
    const legacy = legacyInboundDbPathFor(fixture.sess);
    const poison = forgedImageOf(legacy, 'readonly');
    await migrate(fixture.sess);
    fs.writeFileSync(`${legacy}-journal`, buildHotJournalRestoringTo(poison));

    const seen = readSessionInbound(
      { agentGroupId: fixture.agentGroupId, sessionId: fixture.sessionId, dataDir: fixture.dataDir },
      (mailbox) => mailbox.inboundHasMessage('forged-wake'),
      { busyTimeoutMs: 5000, recoverJournal: true },
    );

    expect(seen).toBe(false);
    expect(rowIds(hostInboundDbPathFor(fixture.sess), 'messages_in')).toEqual(['m-real']);
  });

  it('sweeps the foreign sidecar, so it cannot wedge read-only openers either', async () => {
    const { sess } = makeLegacySession('hostinb-sweep');
    const legacy = legacyInboundDbPathFor(sess);
    await migrate(sess);
    fs.writeFileSync(`${legacy}-journal`, 'planted');
    fs.writeFileSync(`${legacy}-wal`, 'planted');

    expect(removeForeignInboundSidecars(sess).sort()).toEqual(['-journal', '-wal']);
    expect(fs.existsSync(`${legacy}-journal`)).toBe(false);
    expect(fs.existsSync(`${legacy}-wal`)).toBe(false);
  });
});

describe('a genuine host-crash journal at the host-owned path is still recovered — #749', () => {
  it('openInboundDb rolls it back, so the uncommitted write is undone rather than kept', async () => {
    const { sess } = makeLegacySession('hostinb-crash');
    await migrate(sess);
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
  it('overlays the host-owned DIRECTORY read-only, not merely the file', async () => {
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
  it('refuses a spawn while the database still sits where a container could plant a journal', async () => {
    const { sess } = makeLegacySession('hostinb-failclosed');

    // A container is the only thing that can plant a journal, so an
    // unmigrated session must never be the state one is handed.
    expect(() => assertHostOwnedInboundDb(sess, 'sess-1')).toThrow(/host-owned/);

    await migrate(sess);
    expect(() => assertHostOwnedInboundDb(sess, 'sess-1')).not.toThrow();
  });
});

describe('sessionDirForInboundDbPath — #749', () => {
  it('maps a host-owned path back to the SESSION root, where activity markers belong', async () => {
    const { sess } = makeLegacySession('hostinb-sessiondir');
    // Planting the reclaim-blocking marker on `.host` instead would leave it
    // somewhere resourceRoots() never reads (src/storage-activity.ts:493-496).
    expect(sessionDirForInboundDbPath(hostInboundDbPathFor(sess))).toBe(sess);
    expect(sessionDirForInboundDbPath(legacyInboundDbPathFor(sess))).toBe(sess);
  });
});

/**
 * A container's own `.host/inbound.db`, planted as a DISTINCT inode.
 *
 * This is what a container can actually do under a mount set built before
 * `.host` existed: `/workspace` is bind-mounted read-write and nothing is
 * overlaid over a directory that is not there yet, so `mkdir` and a write both
 * succeed and land host-side. A distinct inode is not an accident of the
 * fixture — it is the shape, and it is exactly what pushes the migration into
 * the re-link branch that would otherwise adopt it.
 */
function plantForeignHostDb(sess: string): string {
  const poison = forgedImageOf(legacyInboundDbPathFor(sess), 'planted');
  fs.mkdirSync(hostInboundDirFor(sess), { recursive: true });
  fs.copyFileSync(poison, hostInboundDbPathFor(sess));
  return hostInboundDbPathFor(sess);
}

describe('a host-owned database this host never created is refused — #749 round 2', () => {
  it('REFUSES a container-planted `.host/inbound.db` instead of adopting it', async () => {
    const { sess } = makeLegacySession('hostinb-planted');
    plantForeignHostDb(sess);
    const genuineInode = fs.statSync(legacyInboundDbPathFor(sess)).ino;

    await expect(migrate(sess)).rejects.toThrow(HostInboundProvenanceError);

    // The genuine database is untouched: still its own inode, still holding the
    // real row. Without the gate the re-link branch deletes this file and
    // re-points the legacy name at the planted inode, so these two assertions
    // are the difference between a refused spawn and a replaced mailbox.
    expect(fs.statSync(legacyInboundDbPathFor(sess)).ino).toBe(genuineInode);
    expect(rowIds(legacyInboundDbPathFor(sess), 'messages_in')).toEqual(['m-real']);
    expect(rowIds(legacyInboundDbPathFor(sess), 'delivered')).toEqual([]);
  });

  it('names the session and the override in the refusal, so a spawn failure is actionable', async () => {
    const { sess, sessionId } = makeLegacySession('hostinb-planted-message');
    plantForeignHostDb(sess);

    await expect(migrate(sess)).rejects.toThrow(new RegExp(sessionId));
    await expect(migrate(sess)).rejects.toThrow(/adopt-host-inbound-provenance/);
    await expect(migrate(sess)).rejects.toThrow(/quarantine-planted-host-dirs/);
  });

  it('records provenance for the file it creates, and passes its own gate next time', async () => {
    const { sess, agentGroupId, sessionId } = makeLegacySession('hostinb-records');

    expect((await migrate(sess)).outcome).toBe('migrated');

    const row = await readHostInboundProvenance(agentGroupId, sessionId);
    expect(row).not.toBeNull();
    // The record names the file that now exists, by identity rather than path.
    expect(row?.inode).toBe(String(fs.statSync(hostInboundDbPathFor(sess), { bigint: true }).ino));
    // And the gate it just satisfied lets the next spawn through.
    expect((await migrate(sess)).outcome).toBe('already-host-owned');
  });

  it('refuses when the record exists but names a DIFFERENT file — something replaced it', async () => {
    const { sess, agentGroupId, sessionId } = makeLegacySession('hostinb-stale-record');
    await migrate(sess);
    // A record that no longer describes the file on disk is the strongest
    // negative available: this host created something here, and it is not what
    // is here now.
    await recordHostInboundProvenance(agentGroupId, sessionId, { device: '1', inode: '999999999999999999' });

    await expect(migrate(sess)).rejects.toThrow(HostInboundProvenanceError);
  });

  it('the documented override lets a legitimate restore through', async () => {
    // A rescue-archive restore: the session directory came back, the central DB
    // did not. The files are this host's, but the record of creating them is
    // gone — which is indistinguishable, from the filesystem alone, from a
    // planted file. `scripts/adopt-host-inbound-provenance.ts` is where the
    // operator applies what only they can know, and this is what it does.
    const { sess, agentGroupId, sessionId } = makeLegacySession('hostinb-restore');
    await migrate(sess);
    const restored = fileIdentityOf(hostInboundDbPathFor(sess));
    await recordHostInboundProvenance(agentGroupId, sessionId, { device: '1', inode: '424242' });
    await expect(migrate(sess)).rejects.toThrow(HostInboundProvenanceError);

    await recordHostInboundProvenance(agentGroupId, sessionId, restored!);

    expect((await migrate(sess)).outcome).toBe('already-host-owned');
    expect(rowIds(hostInboundDbPathFor(sess), 'messages_in')).toEqual(['m-real']);
  });
});
