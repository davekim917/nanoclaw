import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../test-hermeticity.js';

import type { ResponseFrame } from './frame.js';
import { markCliServerReady, startCliServer, stopCliServer } from './socket-server.js';

allowSubprocess([path.basename(process.execPath), 'flock']);
enforceHermeticity();

// Unix socket paths have a small OS limit — keep them short.
function tmpSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-'));
  return path.join(dir, 's.sock');
}

/**
 * Independent holder for the same directory inode used by startCliServer().
 * `ready` is the barrier: no contender starts until the child has acquired its
 * inherited-FD kernel lock. SIGKILL then models a host crash.
 */
async function holdDirectoryLock(directory: string): Promise<ChildProcess> {
  const holder = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      [
        "import fs from 'node:fs';",
        "import { spawnSync } from 'node:child_process';",
        'const directory = process.argv.at(-1);',
        'const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);',
        "const result = spawnSync('flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd] });",
        'if (result.status !== 0) process.exit(20);',
        "process.stdout.write('ready\\n');",
        'process.stdin.resume();',
        "process.stdin.once('end', () => process.exit(0));",
      ].join(' '),
      directory,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  await new Promise<void>((resolve, reject) => {
    let output = '';
    let stderr = '';
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    holder.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (!settled && output.includes('ready\n')) {
        settled = true;
        resolve();
      }
    });
    holder.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    holder.once('error', fail);
    holder.once('close', (code) =>
      fail(new Error(`independent lock holder exited before ready (${String(code)}): ${stderr.trim()}`)),
    );
  });
  return holder;
}

async function waitForExit(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('close', () => resolve());
  });
}

async function flockExitCode(directory: string): Promise<number | null> {
  const claimant = spawn('flock', ['-n', directory, 'true'], { stdio: 'ignore' });
  return new Promise((resolve, reject) => {
    claimant.once('error', reject);
    claimant.once('close', (code) => resolve(code));
  });
}

function connect(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath);
    conn.once('connect', () => resolve(conn));
    conn.once('error', reject);
  });
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

describe('startCliServer kernel ownership lock', () => {
  it('refuses an independent claimant after its ready barrier, without touching the socket', async () => {
    const socketPath = tmpSocketPath();
    const holder = await holdDirectoryLock(path.dirname(socketPath));
    try {
      await expect(startCliServer(socketPath)).rejects.toThrow(/already holds the kernel lock/);
      expect(fs.existsSync(socketPath)).toBe(false);
    } finally {
      holder.kill('SIGKILL');
      await waitForExit(holder);
    }
  });

  it('reclaims kernel ownership after a crashed independent holder exits', async () => {
    const socketPath = tmpSocketPath();
    const holder = await holdDirectoryLock(path.dirname(socketPath));
    holder.kill('SIGKILL');
    await waitForExit(holder);

    await expect(startCliServer(socketPath)).resolves.toBeUndefined();
  });

  it('rejects a simultaneous same-process start without releasing the winner lock', async () => {
    const socketPath = tmpSocketPath();
    const results = await Promise.allSettled([startCliServer(socketPath), startCliServer(socketPath)]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(fs.existsSync(socketPath)).toBe(true);
  });

  it('releases ownership after a failed bind so a retry can start', async () => {
    const socketPath = tmpSocketPath();
    const other = net.createServer(() => {});
    await new Promise<void>((resolve) => other.listen(socketPath, resolve));
    await expect(startCliServer(socketPath)).rejects.toThrow(/already serving ncl/);
    await new Promise<void>((resolve) => other.close(() => resolve()));

    await expect(startCliServer(socketPath)).resolves.toBeUndefined();
  });

  it('releases ownership only after normal stop closes the listener', async () => {
    const socketPath = tmpSocketPath();
    await startCliServer(socketPath);
    await stopCliServer();

    await expect(startCliServer(socketPath)).resolves.toBeUndefined();
  });

  it('waits for an in-flight start to bind and close before releasing ownership', async () => {
    const socketPath = tmpSocketPath();
    const start = startCliServer(socketPath);
    const stop = stopCliServer();

    await Promise.all([start, stop]);
    expect(await flockExitCode(path.dirname(socketPath))).toBe(0);

    // Mirrors a late main() continuation after SIGTERM: it must not make the
    // next standalone listener ready after the stopped listener is gone.
    markCliServerReady();
    await startCliServer(socketPath);
    const response = await sendFrame(socketPath, 'groups-list');
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('not-ready');
  });

  it('coalesces stops and keeps ownership until an active connection closes', async () => {
    const socketPath = tmpSocketPath();
    await startCliServer(socketPath);
    const conn = await connect(socketPath);

    const firstStop = stopCliServer();
    const secondStop = stopCliServer();
    let stopped = false;
    void firstStop.then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(stopped).toBe(false);
    expect(await flockExitCode(path.dirname(socketPath))).toBe(1);

    conn.destroy();
    await Promise.all([firstStop, secondStop]);
    expect(await flockExitCode(path.dirname(socketPath))).toBe(0);
  });

  it('retains ownership after closing the listener when shutdown requests it', async () => {
    const socketPath = tmpSocketPath();
    await startCliServer(socketPath);
    await stopCliServer({ retainOwnership: true });

    expect(await flockExitCode(path.dirname(socketPath))).toBe(1);

    // The real shutdown exits immediately after teardown; tests release the
    // retained fd explicitly so afterEach does not leak it across cases.
    await stopCliServer();
    expect(await flockExitCode(path.dirname(socketPath))).toBe(0);
  });

  it('fails clearly when util-linux flock is unavailable', async () => {
    const socketPath = tmpSocketPath();
    const previousPath = process.env.PATH;
    process.env.PATH = path.dirname(socketPath);
    try {
      await expect(startCliServer(socketPath)).rejects.toThrow(/requires the util-linux `flock` executable/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it('uses the stable directory inode, with no PID or sidecar bookkeeping', () => {
    const implementation = fs.readFileSync(new URL('./socket-server.ts', import.meta.url), 'utf8');

    expect(implementation).toContain('O_DIRECTORY');
    expect(implementation).toContain("spawn('flock', ['-n', '3']");
    expect(implementation).not.toContain('process.pid');
    expect(implementation).not.toContain('isProcessAlive');
    expect(implementation).not.toContain('readLockPid');
    expect(implementation).not.toContain('socketPath}.lock');
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
