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
});
