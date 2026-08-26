import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { log } from './log.js';
import { ensureSchema, openInboundDb } from './db/session-db.js';

import {
  acquireStorageActivityLease,
  clearStorageCleanupClaims,
  plantStorageActivityMarker,
  resetStorageActivityState,
  tryRunWithStorageCleanupClaim,
} from './storage-activity.js';

beforeEach(() => {
  vi.clearAllMocks();
});

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-storage-activity-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sessionDirShape(dataDir: string, ag: string, sess: string): string {
  return path.join(dataDir, 'v2-sessions', ag, sess);
}

describe('storage activity leases', () => {
  it('prevents a planned cleanup from applying after a session becomes active', async () => {
    const root = tempRoot();
    const target = path.join(root, 'node_modules');
    fs.mkdirSync(target);
    const lease = await acquireStorageActivityLease(root, 'sess-live');

    const applied = tryRunWithStorageCleanupClaim(root, () => fs.rmSync(target, { recursive: true }));

    expect(applied).toBe(false);
    expect(fs.existsSync(target)).toBe(true);
    await lease.release();
  });

  it('allows cleanup after the final activity lease is released', async () => {
    const root = tempRoot();
    const target = path.join(root, '.cache');
    fs.mkdirSync(target);
    const first = await acquireStorageActivityLease(root, 'sess-a');
    const second = await acquireStorageActivityLease(root, 'sess-b');

    await first.release();
    expect(tryRunWithStorageCleanupClaim(root, () => fs.rmSync(target, { recursive: true }))).toBe(false);

    await second.release();
    expect(tryRunWithStorageCleanupClaim(root, () => fs.rmSync(target, { recursive: true }))).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('keeps overlapping leases from the same holder independent', async () => {
    const root = tempRoot();
    const target = path.join(root, 'node_modules');
    fs.mkdirSync(target);
    const first = await acquireStorageActivityLease(root, 'sess-same');
    const second = await acquireStorageActivityLease(root, 'sess-same');

    await first.release();
    expect(tryRunWithStorageCleanupClaim(root, () => fs.rmSync(target, { recursive: true }))).toBe(false);

    await second.release();
    expect(tryRunWithStorageCleanupClaim(root, () => fs.rmSync(target, { recursive: true }))).toBe(true);
  });

  it('removes an exclusive claim when writing its diagnostic payload fails', () => {
    const root = tempRoot();
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    expect(() => tryRunWithStorageCleanupClaim(root, () => {})).toThrow('disk full');
    expect(fs.existsSync(path.join(root, '.nanoclaw-storage-cleanup'))).toBe(false);
  });

  it('resets stale activity markers and claims in both flat and nested thread layouts', () => {
    const dataDir = tempRoot();
    const flat = path.join(dataDir, 'v2-threads', 'thread-flat', 'worktrees');
    const nested = path.join(dataDir, 'v2-threads', 'wg-example', 'thread-nested', 'worktrees');
    const session = path.join(dataDir, 'v2-sessions', 'ag-example', 'sess-example');
    const rootsToReset = [flat, nested, session];

    for (const root of rootsToReset) {
      fs.mkdirSync(path.join(root, '.nanoclaw-storage-active'), { recursive: true });
      fs.writeFileSync(path.join(root, '.nanoclaw-storage-active', 'stale-holder'), '1234\n');
      fs.writeFileSync(path.join(root, '.nanoclaw-storage-cleanup'), '{"pid":1234}');
    }

    clearStorageCleanupClaims(dataDir);
    for (const root of rootsToReset) {
      expect(fs.existsSync(path.join(root, '.nanoclaw-storage-cleanup'))).toBe(false);
      expect(fs.existsSync(path.join(root, '.nanoclaw-storage-active'))).toBe(true);
    }

    resetStorageActivityState(dataDir);
    for (const root of rootsToReset) {
      expect(fs.existsSync(path.join(root, '.nanoclaw-storage-active'))).toBe(false);
      expect(fs.existsSync(path.join(root, '.nanoclaw-storage-cleanup'))).toBe(false);
    }
  });

  // Inbound message writes now take a lease on sessionDir() and wait for any
  // claim there with no timeout, so a session root this sweep misses is a
  // session whose stale claim is never cleared and whose messages never land.
  // One unreadable group used to abandon every group after it.
  it('clears later session roots when an earlier group directory is unreadable', () => {
    const dataDir = tempRoot();
    const sessions = path.join(dataDir, 'v2-sessions');
    // Sorted order matters: `ag-a` is walked first and must not abort the rest.
    const blocked = path.join(sessions, 'ag-a');
    const reachable = path.join(sessions, 'ag-b', 'sess-live');
    fs.mkdirSync(blocked, { recursive: true });
    fs.mkdirSync(reachable, { recursive: true });
    fs.writeFileSync(path.join(reachable, '.nanoclaw-storage-cleanup'), '{"pid":1234}');
    fs.chmodSync(blocked, 0o000);

    try {
      resetStorageActivityState(dataDir);
      expect(fs.existsSync(path.join(reachable, '.nanoclaw-storage-cleanup'))).toBe(false);
    } finally {
      fs.chmodSync(blocked, 0o755);
    }
  });

  it('clears thread roots when the sessions root is unreadable entirely', () => {
    const dataDir = tempRoot();
    const sessions = path.join(dataDir, 'v2-sessions');
    const thread = path.join(dataDir, 'v2-threads', 'thread-flat', 'worktrees');
    fs.mkdirSync(sessions, { recursive: true });
    fs.mkdirSync(thread, { recursive: true });
    fs.writeFileSync(path.join(thread, '.nanoclaw-storage-cleanup'), '{"pid":1234}');
    fs.chmodSync(sessions, 0o000);

    try {
      resetStorageActivityState(dataDir);
      expect(fs.existsSync(path.join(thread, '.nanoclaw-storage-cleanup'))).toBe(false);
    } finally {
      fs.chmodSync(sessions, 0o755);
    }
  });

  // The lease path and the cleanup path must agree on the shape of a session
  // root, or the two sets silently diverge.
  it('enumerates exactly the two-level shape sessionDir produces', () => {
    const dataDir = tempRoot();
    const sessPath = sessionDirShape(dataDir, 'ag-1', 'sess-1');
    fs.mkdirSync(sessPath, { recursive: true });
    fs.writeFileSync(path.join(sessPath, '.nanoclaw-storage-cleanup'), '{"pid":1}');
    // One level too shallow and one too deep must both be left alone.
    const shallow = path.join(dataDir, 'v2-sessions', 'ag-1');
    const deep = path.join(sessPath, 'worktrees');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(shallow, '.nanoclaw-storage-cleanup'), '{"pid":2}');
    fs.writeFileSync(path.join(deep, '.nanoclaw-storage-cleanup'), '{"pid":3}');

    resetStorageActivityState(dataDir);

    expect(fs.existsSync(path.join(sessPath, '.nanoclaw-storage-cleanup'))).toBe(false);
    expect(fs.existsSync(path.join(shallow, '.nanoclaw-storage-cleanup'))).toBe(true);
    expect(fs.existsSync(path.join(deep, '.nanoclaw-storage-cleanup'))).toBe(true);
  });
});

describe('synchronous storage activity marker', () => {
  it('blocks a concurrent cleanup for as long as the marker is held', () => {
    const root = tempRoot();
    const release = plantStorageActivityMarker(root, 'writer');
    let acted = false;
    expect(tryRunWithStorageCleanupClaim(root, () => (acted = true))).toBe(false);
    expect(acted).toBe(false);
    release();
    expect(tryRunWithStorageCleanupClaim(root, () => (acted = true))).toBe(true);
    expect(acted).toBe(true);
  });

  it('refuses to plant while a cleanup owns the claim, and leaves no marker', () => {
    const root = tempRoot();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, '.nanoclaw-storage-cleanup'), '{"pid":1}');

    expect(() => plantStorageActivityMarker(root, 'writer')).toThrow(/being reclaimed/);
    // A marker left behind here would block cleanup for this root forever.
    expect(fs.existsSync(path.join(root, '.nanoclaw-storage-active'))).toBe(false);
  });

  it('is idempotent on release', () => {
    const root = tempRoot();
    const release = plantStorageActivityMarker(root, 'writer');
    release();
    const other = plantStorageActivityMarker(root, 'other');
    release(); // second call must not remove someone else's protection
    expect(tryRunWithStorageCleanupClaim(root, () => undefined)).toBe(false);
    other();
  });

  // The re-entrancy case: writeSessionMessage holds the async lease and then
  // opens the inbound DB. Under an owned lease the inner planter must do
  // NOTHING — planting is unnecessary, and re-checking the claim would throw
  // inside the reclaim's create-claim-then-read-markers window and discard an
  // accepted message.
  it('is a no-op under a lease this process already holds', async () => {
    const root = tempRoot();
    const outer = await acquireStorageActivityLease(root, 'ingestion');

    const inner = plantStorageActivityMarker(root, 'inbound-open');
    inner();
    expect(
      tryRunWithStorageCleanupClaim(root, () => undefined),
      'outer lease still holds',
    ).toBe(false);

    await outer.release();
    expect(tryRunWithStorageCleanupClaim(root, () => undefined)).toBe(true);
  });

  it('does not throw under an owned lease even while a claim is present', async () => {
    const root = tempRoot();
    const outer = await acquireStorageActivityLease(root, 'ingestion');
    // The reclaim has created its claim and has not yet read the markers that
    // will make it abandon. Pre-fix the inner planter threw here, losing the
    // message to a reclaim that never runs.
    fs.writeFileSync(path.join(root, '.nanoclaw-storage-cleanup'), '{"pid":1}');

    expect(() => plantStorageActivityMarker(root, 'inbound-open')()).not.toThrow();

    fs.rmSync(path.join(root, '.nanoclaw-storage-cleanup'), { force: true });
    await outer.release();
  });

  it('still refcounts overlapping leases so the first release does not free the second', async () => {
    const root = tempRoot();
    const a = await acquireStorageActivityLease(root, 'one');
    const b = await acquireStorageActivityLease(root, 'two');

    await a.release();
    expect(plantStorageActivityMarker(root, 'inner'), 'b still holds, so still a no-op').toBeTypeOf('function');
    expect(tryRunWithStorageCleanupClaim(root, () => undefined)).toBe(false);

    await b.release();
    expect(tryRunWithStorageCleanupClaim(root, () => undefined)).toBe(true);
  });

  // Two independent SYNC holders, no lease involved: the original independence
  // property still has to hold for them.
  it('keeps two independent sync markers independent', () => {
    const root = tempRoot();
    const first = plantStorageActivityMarker(root, 'first');
    const second = plantStorageActivityMarker(root, 'second');

    first();
    expect(
      tryRunWithStorageCleanupClaim(root, () => undefined),
      'second still holds',
    ).toBe(false);
    second();
    expect(tryRunWithStorageCleanupClaim(root, () => undefined)).toBe(true);
  });
});

describe('openInboundDb guards the whole handle lifetime', () => {
  function inboundIn(root: string): string {
    fs.mkdirSync(root, { recursive: true });
    const p = path.join(root, 'inbound.db');
    ensureSchema(p, 'inbound');
    return p;
  }

  it('blocks a reclaim from the open until the close', () => {
    const root = tempRoot();
    const dbPath = inboundIn(root);

    const db = openInboundDb(dbPath);
    // This is the C5 window: open, not yet written. Pre-fix the writer was
    // invisible here and the reclaim would tar-and-unlink underneath it.
    expect(tryRunWithStorageCleanupClaim(root, () => undefined)).toBe(false);
    db.close();
    expect(tryRunWithStorageCleanupClaim(root, () => undefined)).toBe(true);
  });

  it('refuses to open while a reclaim owns the claim', () => {
    const root = tempRoot();
    const dbPath = inboundIn(root);
    fs.writeFileSync(path.join(root, '.nanoclaw-storage-cleanup'), '{"pid":1}');

    expect(() => openInboundDb(dbPath)).toThrow(/being reclaimed/);
  });

  it('releases the marker when the open itself fails', () => {
    const root = tempRoot();
    fs.mkdirSync(root, { recursive: true });
    // A directory where the DB file should be: better-sqlite3 throws.
    fs.mkdirSync(path.join(root, 'inbound.db'), { recursive: true });

    expect(() => openInboundDb(path.join(root, 'inbound.db'))).toThrow();
    // The marker must not outlive the failed open, or this root is never
    // reclaimable again.
    expect(tryRunWithStorageCleanupClaim(root, () => undefined)).toBe(true);
  });

  it('reports a leaked handle instead of skipping the reclaim silently', () => {
    const root = tempRoot();
    const dbPath = inboundIn(root);
    openInboundDb(dbPath); // deliberately never closed

    expect(tryRunWithStorageCleanupClaim(root, () => undefined)).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      'storage-activity: cleanup skipped, resource is in use',
      expect.objectContaining({ resourceRoot: root, holders: 1 }),
    );
  });
});

describe('acquireStorageActivityLease is observable and bounded', () => {
  // Real timers, faked clock. The loop awaits fs.promises.access, which
  // resolves on the threadpool and so is not driven by fake timers at all —
  // but the warn/cap thresholds are pure Date.now() arithmetic, so moving the
  // clock is enough and the loop still turns at its real 25ms.
  // Returns the jumper and its own restore; the suite-level restoreAllMocks
  // would also catch it, but a Date.now spy outliving its test poisons every
  // timing assertion after it and that is not worth leaving to a hook.
  let restoreClock: (() => void) | null = null;
  function clockJumper(): (ms: number) => void {
    const base = Date.now();
    let offset = 0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => base + offset);
    restoreClock = () => spy.mockRestore();
    return (ms: number) => {
      offset += ms;
    };
  }
  afterEach(() => {
    restoreClock?.();
    restoreClock = null;
  });

  const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

  function waitWarnCount(): number {
    return (log.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      (c) => c[0] === 'storage-activity: still waiting on a cleanup claim',
    ).length;
  }

  it('warns once after waiting, then still acquires when the claim clears', async () => {
    const root = tempRoot();
    fs.mkdirSync(root, { recursive: true });
    const claim = path.join(root, '.nanoclaw-storage-cleanup');
    fs.writeFileSync(claim, '{"pid":1}');
    const jump = clockJumper();

    const pending = acquireStorageActivityLease(root, 'ingestion');
    // `startedAt` is captured after the function's first await, so the clock
    // must not move until the loop is actually running.
    await settle(50);
    jump(12_000);
    await settle();
    expect(waitWarnCount(), 'should have warned once past the threshold').toBe(1);

    jump(5_000);
    await settle();
    expect(waitWarnCount(), 'warns once, not every 25ms').toBe(1);

    fs.rmSync(claim, { force: true });
    const lease = await pending;
    expect(lease.release).toBeTypeOf('function');
    await lease.release();
  });

  it('keeps waiting and keeps escalating rather than discarding the write', async () => {
    const root = tempRoot();
    fs.mkdirSync(root, { recursive: true });
    const claim = path.join(root, '.nanoclaw-storage-cleanup');
    fs.writeFileSync(claim, '{"pid":1}');
    const jump = clockJumper();

    let settled: string | null = null;
    const pending = acquireStorageActivityLease(root, 'ingestion').then(
      () => (settled = 'resolved'),
      (err: Error) => (settled = err.message),
    );
    await settle(50);

    // Two hours: past any plausible cap, including both of archival's
    // independently bounded 60-minute phases back to back.
    jump(10_000);
    await settle();
    jump(2 * 60 * 60 * 1000);
    await settle();

    expect(settled, 'an accepted message must never be discarded on a timer').toBeNull();
    expect(waitWarnCount(), 'silence is what is bounded, so it keeps reporting').toBeGreaterThan(1);

    fs.rmSync(claim, { force: true });
    await pending;
    expect(settled).toBe('resolved');
  });
});
