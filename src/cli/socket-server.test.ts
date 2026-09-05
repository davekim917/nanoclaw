import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { startCliServer, stopCliServer } from './socket-server.js';

// Unix socket paths have a small OS limit — keep them short.
function tmpSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-'));
  return path.join(dir, 's.sock');
}

afterEach(async () => {
  await stopCliServer();
});

describe('startCliServer single-bind', () => {
  it('refuses to take over a socket a live server is accepting on', async () => {
    const socketPath = tmpSocketPath();
    // Another host instance, simulated by a raw listener on the same path.
    const other = net.createServer(() => {});
    await new Promise<void>((resolve) => other.listen(socketPath, resolve));
    try {
      await expect(startCliServer(socketPath)).rejects.toThrow(/already serving ncl/);
      // The live socket file must still be there — nothing was unlinked.
      expect(fs.existsSync(socketPath)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  it('cleans up a stale socket file nobody answers and binds', async () => {
    const socketPath = tmpSocketPath();
    // A crashed run's leftover: the file exists but no listener answers.
    fs.writeFileSync(socketPath, '');
    await startCliServer(socketPath);
    // Bound and accepting: a client connect succeeds.
    await new Promise<void>((resolve, reject) => {
      const probe = net.createConnection(socketPath);
      probe.once('connect', () => {
        probe.destroy();
        resolve();
      });
      probe.once('error', reject);
    });
  });

  it('binds normally when no socket file exists', async () => {
    const socketPath = tmpSocketPath();
    await startCliServer(socketPath);
    expect(fs.existsSync(socketPath)).toBe(true);
  });

  // PR #453 review, P2: a concurrent second host process can win the gap
  // between our stale-verdict probe and our own unlink+bind, leaving both
  // servers running while only the winner is reachable. Simulated here by
  // making our own unlinkSync call spawn a competing live listener on the
  // same path before our retry's bind runs — exactly the interleaving a
  // second real host process racing this same sequence would produce.
  it('re-probes on retry instead of trusting a stale verdict, and catches a competitor that won the race', async () => {
    const socketPath = tmpSocketPath();
    fs.writeFileSync(socketPath, ''); // stale leftover
    const competitor = net.createServer(() => {});
    const realUnlinkSync = fs.unlinkSync;
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((p) => {
      realUnlinkSync(p as fs.PathLike);
      if (p === socketPath) {
        // A competing process wins the now-empty path before our own retry
        // gets to it.
        competitor.listen(socketPath);
      }
    });
    try {
      await expect(startCliServer(socketPath)).rejects.toThrow(/already serving ncl/);
      expect(unlinkSpy).toHaveBeenCalled();
      // The competitor's socket must survive — we must not have unlinked it
      // a second time trying to steal it back.
      expect(fs.existsSync(socketPath)).toBe(true);
    } finally {
      unlinkSpy.mockRestore();
      await new Promise<void>((resolve) => competitor.close(() => resolve()));
    }
  });

  it('gives up after the bind-attempt ceiling when the path keeps coming back stale', async () => {
    const socketPath = tmpSocketPath();
    fs.writeFileSync(socketPath, '');
    const realUnlinkSync = fs.unlinkSync;
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((p) => {
      realUnlinkSync(p as fs.PathLike);
      if (p === socketPath) {
        // Something keeps recreating a dead file at this path — never a
        // live listener, so every probe says "stale", but every bind still
        // fails because the file is back by the time we retry.
        fs.writeFileSync(socketPath, '');
      }
    });
    try {
      await expect(startCliServer(socketPath)).rejects.toThrow(/could not bind/);
    } finally {
      unlinkSpy.mockRestore();
    }
  });
});
