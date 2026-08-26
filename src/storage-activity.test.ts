import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acquireStorageActivityLease,
  clearStorageCleanupClaims,
  resetStorageActivityState,
  tryRunWithStorageCleanupClaim,
} from './storage-activity.js';

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
