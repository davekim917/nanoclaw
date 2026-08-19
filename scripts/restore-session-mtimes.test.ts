/**
 * T7 (SR7) — the one-off mtime recovery is selective, manifest-bound and
 * reversible. Every timestamp here is fixed; nothing touches live data.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  chooseRestoreTarget,
  executeRestore,
  parseWindow,
  planRestore,
  readManifest,
  type BurstWindow,
} from './restore-session-mtimes.js';

const BURST_CENTER = Date.parse('2026-08-15T20:21:00.000Z');
const APRIL = Date.parse('2026-04-21T06:10:58.000Z');
const JUNE = Date.parse('2026-06-02T09:00:00.000Z');

describe('restore-session-mtimes', () => {
  let tmpRoot: string;
  let sessionsRoot: string;
  let centralDb: Database.Database;
  const windows: BurstWindow[] = [parseWindow('2026-08-15T20:21:00.000Z±10')];

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-mtimes-'));
    sessionsRoot = path.join(tmpRoot, 'v2-sessions');
    centralDb = new Database(':memory:');
    centralDb.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      status TEXT DEFAULT 'active',
      last_active TEXT,
      created_at TEXT NOT NULL
    )`);
  });

  afterEach(() => {
    centralDb.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  interface SessionOptions {
    inboundMtimeMs: number;
    outboundMtimeMs?: number;
    heartbeatMtimeMs?: number;
    lastActive?: string | null;
    createdAt?: string;
    pending?: boolean;
    activeMarker?: boolean;
    centralRow?: boolean;
  }

  function makeSession(id: string, options: SessionOptions): string {
    const dir = path.join(sessionsRoot, 'ag-1', id);
    fs.mkdirSync(dir, { recursive: true });

    const inbound = new Database(path.join(dir, 'inbound.db'));
    inbound.exec("CREATE TABLE messages_in (status TEXT NOT NULL DEFAULT 'completed')");
    if (options.pending) inbound.prepare("INSERT INTO messages_in VALUES ('pending')").run();
    inbound.close();

    if (options.outboundMtimeMs !== undefined) {
      const outbound = new Database(path.join(dir, 'outbound.db'));
      outbound.exec('CREATE TABLE processing_ack (message_id TEXT, status TEXT)');
      outbound.exec('CREATE TABLE session_state (key TEXT PRIMARY KEY, value TEXT)');
      outbound.close();
      const seconds = options.outboundMtimeMs / 1000;
      fs.utimesSync(path.join(dir, 'outbound.db'), seconds, seconds);
    }
    if (options.heartbeatMtimeMs !== undefined) {
      fs.writeFileSync(path.join(dir, '.heartbeat'), '');
      const seconds = options.heartbeatMtimeMs / 1000;
      fs.utimesSync(path.join(dir, '.heartbeat'), seconds, seconds);
    }
    if (options.activeMarker) {
      fs.mkdirSync(path.join(dir, '.nanoclaw-storage-active'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.nanoclaw-storage-active', 'holder'), '1');
    }
    if (options.centralRow !== false) {
      centralDb
        .prepare('INSERT INTO sessions (id, status, last_active, created_at) VALUES (?, ?, ?, ?)')
        .run(
          id,
          'active',
          options.lastActive === undefined ? new Date(APRIL).toISOString() : options.lastActive,
          options.createdAt ?? new Date(APRIL).toISOString(),
        );
    }

    const seconds = options.inboundMtimeMs / 1000;
    fs.utimesSync(path.join(dir, 'inbound.db'), seconds, seconds);
    return dir;
  }

  function plan() {
    return planRestore({ dataDir: tmpRoot, windows, centralDb });
  }

  function skipReason(manifest: ReturnType<typeof plan>, id: string): string | undefined {
    return manifest.skipped.find((s) => s.sessionId === id)?.reason;
  }

  it('parses a window spec and its radius', () => {
    const parsed = parseWindow('2026-08-15T20:21:00.000Z±10');
    expect(parsed.startMs).toBe(BURST_CENTER - 10 * 60 * 1000);
    expect(parsed.endMs).toBe(BURST_CENTER + 10 * 60 * 1000);
    expect(parseWindow('2026-08-15T20:21:00.000Z').endMs).toBe(BURST_CENTER + 10 * 60 * 1000);
  });

  it('selects only burst-window sessions whose central activity predates the burst', () => {
    makeSession('sess-burst', { inboundMtimeMs: BURST_CENTER + 60_000, outboundMtimeMs: JUNE });
    makeSession('sess-outside-window', { inboundMtimeMs: Date.parse('2026-08-18T12:00:00Z'), outboundMtimeMs: JUNE });
    makeSession('sess-recent-activity', {
      inboundMtimeMs: BURST_CENTER + 60_000,
      outboundMtimeMs: JUNE,
      lastActive: '2026-08-16T09:00:00.000Z',
    });

    const manifest = plan();

    expect(manifest.entries.map((e) => e.sessionId)).toEqual(['sess-burst']);
    // Outside the window it is never even considered, so it is not a "skip".
    expect(skipReason(manifest, 'sess-outside-window')).toBeUndefined();
    expect(skipReason(manifest, 'sess-recent-activity')).toBe('central-activity-after-burst');
  });

  it('skips sessions with a live container marker or open work, and orphan dirs', () => {
    makeSession('sess-live', { inboundMtimeMs: BURST_CENTER, outboundMtimeMs: JUNE, activeMarker: true });
    makeSession('sess-busy', { inboundMtimeMs: BURST_CENTER, outboundMtimeMs: JUNE, pending: true });
    makeSession('sess-orphan', { inboundMtimeMs: BURST_CENTER, outboundMtimeMs: JUNE, centralRow: false });

    const manifest = plan();

    expect(manifest.entries).toEqual([]);
    expect(skipReason(manifest, 'sess-live')).toBe('container-active');
    expect(skipReason(manifest, 'sess-busy')).toBe('open-work');
    expect(skipReason(manifest, 'sess-orphan')).toBe('central-row-missing');
  });

  it('records the chosen restore target and its provenance', () => {
    makeSession('sess-outbound', { inboundMtimeMs: BURST_CENTER, outboundMtimeMs: JUNE });
    makeSession('sess-heartbeat', { inboundMtimeMs: BURST_CENTER, outboundMtimeMs: APRIL, heartbeatMtimeMs: JUNE });
    // No surviving file signal at all: the central row is the only evidence.
    makeSession('sess-central-only', { inboundMtimeMs: BURST_CENTER });

    const manifest = plan();
    const byId = new Map(manifest.entries.map((e) => [e.sessionId, e]));

    expect(byId.get('sess-outbound')).toMatchObject({ restoreMtimeMs: JUNE, provenance: 'outbound.db' });
    expect(byId.get('sess-heartbeat')).toMatchObject({ restoreMtimeMs: JUNE, provenance: '.heartbeat' });
    expect(byId.get('sess-central-only')).toMatchObject({ restoreMtimeMs: APRIL, provenance: 'central:last_active' });
    for (const entry of manifest.entries) expect(entry.inode).toBeGreaterThan(0);
  });

  it('falls back to created_at when last_active is null', () => {
    makeSession('sess-null-active', {
      inboundMtimeMs: BURST_CENTER,
      lastActive: null,
      createdAt: new Date(APRIL).toISOString(),
    });

    expect(plan().entries[0]).toMatchObject({ restoreMtimeMs: APRIL, provenance: 'central:last_active' });
  });

  it('never chooses a target newer than the bumped mtime', () => {
    // A signal file newer than the burst means the session really did move
    // after it; there is nothing truthful to restore to.
    makeSession('sess-newer-signal', {
      inboundMtimeMs: BURST_CENTER,
      outboundMtimeMs: Date.parse('2026-08-19T00:00:00Z'),
    });

    const manifest = plan();
    expect(manifest.entries).toEqual([]);
    expect(skipReason(manifest, 'sess-newer-signal')).toBe('no-older-signal');
    expect(chooseRestoreTarget(path.join(sessionsRoot, 'ag-1', 'sess-newer-signal'), APRIL)).toMatchObject({
      provenance: 'outbound.db',
    });
  });

  it('executes only pinned entries, writes a preimage first, and reruns as a no-op', () => {
    const dir = makeSession('sess-burst', { inboundMtimeMs: BURST_CENTER, outboundMtimeMs: JUNE });
    const manifestPath = path.join(tmpRoot, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(plan(), null, 2));

    const result = executeRestore(manifestPath);

    expect(result).toMatchObject({ restored: 1, changed: 0, missing: 0, alreadyRestored: 0, claimBusy: 0 });
    expect(result.preimagePath).not.toBe(manifestPath);
    expect(fs.statSync(path.join(dir, 'inbound.db')).mtimeMs).toBe(JUNE);

    const preimage = JSON.parse(fs.readFileSync(result.preimagePath, 'utf-8')) as {
      entries: Array<{ sessionId: string; mtimeMs: number }>;
    };
    expect(preimage.entries).toEqual([expect.objectContaining({ sessionId: 'sess-burst', mtimeMs: BURST_CENTER })]);

    // Rerun: the file already carries the restored clock.
    const rerun = executeRestore(manifestPath);
    expect(rerun).toMatchObject({ restored: 0, alreadyRestored: 1, changed: 0 });
    expect(fs.statSync(path.join(dir, 'inbound.db')).mtimeMs).toBe(JUNE);

    // And the preimage restores the exact prior state.
    const seconds = preimage.entries[0]!.mtimeMs / 1000;
    fs.utimesSync(path.join(dir, 'inbound.db'), seconds, seconds);
    expect(fs.statSync(path.join(dir, 'inbound.db')).mtimeMs).toBe(BURST_CENTER);
  });

  it('writes a fresh immutable preimage per execution and never truncates one', () => {
    const dir = makeSession('sess-burst', { inboundMtimeMs: BURST_CENTER, outboundMtimeMs: JUNE });
    const manifestPath = path.join(tmpRoot, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(plan(), null, 2));

    const first = executeRestore(manifestPath);
    const firstPreimage = fs.readFileSync(first.preimagePath, 'utf-8');
    expect(JSON.parse(firstPreimage).entries).toHaveLength(1);

    // A rerun has nothing to do; the original record must still be intact and
    // must not have been overwritten with an empty one.
    const second = executeRestore(manifestPath);
    expect(second).toMatchObject({ restored: 0, alreadyRestored: 1 });
    expect(second.preimagePath).not.toBe(first.preimagePath);
    expect(fs.readFileSync(first.preimagePath, 'utf-8')).toBe(firstPreimage);
    expect(JSON.parse(fs.readFileSync(first.preimagePath, 'utf-8')).entries[0]).toMatchObject({
      sessionId: 'sess-burst',
      mtimeMs: BURST_CENTER,
    });
    expect(fs.statSync(path.join(dir, 'inbound.db')).mtimeMs).toBe(JUNE);
  });

  it('refuses an explicit preimage path that already exists', () => {
    makeSession('sess-burst', { inboundMtimeMs: BURST_CENTER, outboundMtimeMs: JUNE });
    const manifestPath = path.join(tmpRoot, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(plan(), null, 2));
    const taken = path.join(tmpRoot, 'preimage.json');
    fs.writeFileSync(taken, '{"entries":["precious"]}');

    expect(() => executeRestore(manifestPath, taken)).toThrow(/refusing to overwrite/);
    expect(fs.readFileSync(taken, 'utf-8')).toBe('{"entries":["precious"]}');
  });

  it('acts on the path it derives, not the one the manifest claims', () => {
    const victim = path.join(tmpRoot, 'outside.db');
    fs.writeFileSync(victim, 'not a session file');
    const victimBefore = fs.statSync(victim).mtimeMs;
    const dir = makeSession('sess-burst', { inboundMtimeMs: BURST_CENTER, outboundMtimeMs: JUNE });
    const manifest = plan();
    // A tampered manifest points somewhere else entirely.
    manifest.entries[0]!.inboundPath = victim;
    const manifestPath = path.join(tmpRoot, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const result = executeRestore(manifestPath);

    // The derived path is the real session file, so the entry still applies —
    // and the file the manifest named is untouched.
    expect(result).toMatchObject({ restored: 1 });
    expect(fs.statSync(victim).mtimeMs).toBe(victimBefore);
    expect(fs.statSync(path.join(dir, 'inbound.db')).mtimeMs).toBe(JUNE);
  });

  it('rejects an entry whose identifiers are not plain path segments', () => {
    makeSession('sess-burst', { inboundMtimeMs: BURST_CENTER, outboundMtimeMs: JUNE });
    const manifest = plan();
    manifest.entries[0]!.agentGroupId = '../../etc';
    const manifestPath = path.join(tmpRoot, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    expect(executeRestore(manifestPath)).toMatchObject({ restored: 0, unsafePath: 1 });
  });

  it('binds central activity to the window each mtime falls in', () => {
    const earlier = parseWindow('2026-08-15T16:26:00.000Z±5');
    const twoWindows = [earlier, parseWindow('2026-08-15T20:21:00.000Z±10')];
    // Idle since 17:00 — after the EARLIER window, before the later one. A
    // shared minimum bound would wrongly reject it.
    makeSession('sess-late-burst', {
      inboundMtimeMs: BURST_CENTER,
      outboundMtimeMs: JUNE,
      lastActive: '2026-08-15T17:00:00.000Z',
    });
    // In the earlier window, and its activity postdates that window's start.
    makeSession('sess-early-burst', {
      inboundMtimeMs: Date.parse('2026-08-15T16:26:00.000Z'),
      outboundMtimeMs: JUNE,
      lastActive: '2026-08-15T16:24:00.000Z',
    });

    const manifest = planRestore({ dataDir: tmpRoot, windows: twoWindows, centralDb });

    expect(manifest.entries.map((e) => e.sessionId)).toEqual(['sess-late-burst']);
    expect(skipReason(manifest, 'sess-early-burst')).toBe('central-activity-after-burst');
  });

  it('skips an entry whose mtime or inode moved since the manifest', () => {
    const touched = makeSession('sess-touched', { inboundMtimeMs: BURST_CENTER, outboundMtimeMs: JUNE });
    const replaced = makeSession('sess-replaced', { inboundMtimeMs: BURST_CENTER, outboundMtimeMs: JUNE });
    const removed = makeSession('sess-removed', { inboundMtimeMs: BURST_CENTER, outboundMtimeMs: JUNE });
    const manifestPath = path.join(tmpRoot, 'manifest.json');
    const manifest = plan();
    // The inode pin, exercised directly: the allocator happily reuses a freed
    // inode, so recreating the file is not a reliable way to change it.
    const replacedEntry = manifest.entries.find((e) => e.sessionId === 'sess-replaced')!;
    replacedEntry.inode += 1;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // A real message landed after the dry-run.
    const fresh = Date.parse('2026-08-19T18:00:00Z') / 1000;
    fs.utimesSync(path.join(touched, 'inbound.db'), fresh, fresh);
    // Archived between the dry-run and the execute.
    fs.rmSync(removed, { recursive: true, force: true });

    const result = executeRestore(manifestPath);

    expect(result).toMatchObject({ restored: 0, changed: 2, missing: 1 });
    expect(fs.statSync(path.join(touched, 'inbound.db')).mtimeMs).toBe(fresh * 1000);
    expect(fs.statSync(path.join(replaced, 'inbound.db')).mtimeMs).toBe(BURST_CENTER);
    expect(readManifest(manifestPath).entries).toHaveLength(3);
  });
});
