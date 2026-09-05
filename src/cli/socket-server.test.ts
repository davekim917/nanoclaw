import { spawnSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResponseFrame } from './frame.js';
import { markCliServerReady, startCliServer, stopCliServer } from './socket-server.js';

// Unix socket paths have a small OS limit — keep them short.
function tmpSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-'));
  return path.join(dir, 's.sock');
}

function sendFrame(socketPath: string, command: string): Promise<ResponseFrame> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath);
    let buffer = '';
    conn.once('connect', () => {
      conn.write(JSON.stringify({ id: 'test', command, args: {} }) + '\n');
    });
    conn.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
    });
    conn.once('close', () => {
      try {
        resolve(JSON.parse(buffer.trim()) as ResponseFrame);
      } catch (err) {
        reject(err);
      }
    });
    conn.once('error', reject);
  });
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

// PR #453 review, round 2: the probe-then-unlink-then-bind sequence above is
// still a check-then-act pattern between separate startCliServer() callers —
// closing that requires a real atomic primitive, not more retries.
describe('startCliServer ownership lock', () => {
  it('claims exclusive ownership atomically: a concurrent second call for the same path is refused, naming the live pid', async () => {
    const socketPath = tmpSocketPath();
    const results = await Promise.allSettled([startCliServer(socketPath), startCliServer(socketPath)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(
      new RegExp(`already holds ${socketPath}\\.lock`),
    );
    // Naming its own pid: both calls are this test process.
    expect((rejected[0] as PromiseRejectedResult).reason.message).toContain(`pid ${process.pid}`);
    expect(fs.existsSync(socketPath)).toBe(true);
  });

  it('reclaims a lock file left behind by a process that no longer exists', async () => {
    const socketPath = tmpSocketPath();
    // A process that ran and exited — guaranteed dead by the time spawnSync
    // returns, unlike an arbitrary made-up pid that might collide with
    // something real.
    const dead = spawnSync(process.execPath, ['-e', '']);
    fs.writeFileSync(`${socketPath}.lock`, String(dead.pid));
    await startCliServer(socketPath);
    expect(fs.existsSync(socketPath)).toBe(true);
    // The lock now names us, not the dead process.
    expect(fs.readFileSync(`${socketPath}.lock`, 'utf8')).toBe(String(process.pid));
  });

  it('releases the lock on a failed start so a subsequent start can claim it', async () => {
    const socketPath = tmpSocketPath();
    const other = net.createServer(() => {});
    await new Promise<void>((resolve) => other.listen(socketPath, resolve));
    try {
      await expect(startCliServer(socketPath)).rejects.toThrow(/already serving ncl/);
      // Our own ownership lock must not linger after a failed bind — nothing
      // else claimed the socket, so the lock and the socket-conflict error
      // are orthogonal, and a retry (e.g. after the operator stops the
      // other instance) must not be blocked by our own leftover lock.
      expect(fs.existsSync(`${socketPath}.lock`)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  it('releases the lock on stopCliServer so a fresh start can reclaim it', async () => {
    const socketPath = tmpSocketPath();
    await startCliServer(socketPath);
    expect(fs.existsSync(`${socketPath}.lock`)).toBe(true);
    await stopCliServer();
    expect(fs.existsSync(`${socketPath}.lock`)).toBe(false);
  });
});

describe('startCliServer readiness gate', () => {
  it('refuses to dispatch before markCliServerReady(), with a structured not-ready error', async () => {
    const socketPath = tmpSocketPath();
    await startCliServer(socketPath);
    const res = await sendFrame(socketPath, 'groups-list');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('not-ready');
  });

  it('dispatches once markCliServerReady() has run', async () => {
    const socketPath = tmpSocketPath();
    await startCliServer(socketPath);
    markCliServerReady();
    // An unrecognized command still reaches dispatch() (unknown-command, not
    // not-ready) — proof the gate lifted, without needing the DB/guard stack
    // this test file does not set up.
    const res = await sendFrame(socketPath, 'definitely-not-a-real-command');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('unknown-command');
  });
});
