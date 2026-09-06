/**
 * Host-side socket listener. Started from src/index.ts, accepts one frame
 * per connection, calls dispatch() with caller='host', writes the response
 * frame, closes.
 *
 * Lives at data/ncl.sock (separate from data/cli.sock, which the existing
 * chat-style CLI channel adapter owns). Socket file is chmod 0600 — only
 * the user that started the host can connect.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { log } from '../log.js';
import { dispatch } from './dispatch.js';
import type { CallerContext, RequestFrame, ResponseFrame } from './frame.js';
import { DEFAULT_SOCKET_PATH } from './socket-client.js';

let server: net.Server | null = null;
let heldOwnershipFd: number | null = null;
let startPromise: Promise<void> | null = null;
let stopPromise: Promise<void> | null = null;

// Requests are refused with `not-ready` until markCliServerReady() is called.
// The socket binds (and claims ownership) well before archive init, FS
// reconciliation, the OneCLI preflight, container-config backfill, and
// channel-adapter setup finish (PR #453 review) — early ownership and early
// request-handling are different guarantees, and only the first is safe this
// soon.
let ready = false;

const PROBE_TIMEOUT_MS = 1000;

// Bounded retries for the bind race below (PR #453 review round 1): a
// concurrent second host process can win the gap between our probe and our
// bind, so we must be able to re-probe and retry a few times rather than
// assume our own stale verdict is still true by the time we act on it. This
// is defense in depth for a peer that binds the path WITHOUT going through
// claimOwnershipLock below (e.g. anything else listening on the path) — the
// lock is what actually closes the race between two callers of
// startCliServer() itself; five is generous for a race that, if it recurs
// every attempt, means something is persistently recreating the path — not
// worth retrying forever.
const MAX_BIND_ATTEMPTS = 5;

/**
 * Claim the data-directory inode with a kernel-held flock before the central
 * database is opened. The transient flock process locks its inherited fd 3;
 * the parent keeps the same open-file description for the host lifetime.
 * Closing that final parent fd releases the lock on graceful or crashed exit.
 */
async function claimOwnershipLock(socketPath: string): Promise<number> {
  const directory = path.dirname(socketPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  let fd: number | null = null;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(fd).isDirectory()) {
      throw new Error(`ncl ownership path is not a directory: ${directory}`);
    }
    await lockInheritedFd(fd, directory);
    return fd;
  } catch (err) {
    if (fd !== null) fs.closeSync(fd);
    throw err;
  }
}

/** Acquire the kernel flock without keeping a helper process alive. */
function lockInheritedFd(fd: number, directory: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd] });
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    child.once('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        fail(
          new Error('ncl single-host ownership requires the util-linux `flock` executable; install it and restart.', {
            cause: err,
          }),
        );
        return;
      }
      fail(new Error(`failed to start ncl ownership lock for ${directory}`, { cause: err }));
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve();
        return;
      }
      if (code === 1) {
        reject(
          new Error(
            `another host instance already holds the kernel lock for ${directory} — ` +
              'refusing to start a second host in this checkout. Stop the other instance and restart.',
          ),
        );
        return;
      }
      reject(new Error(`ncl ownership lock failed for ${directory} (flock exited ${String(code)})`));
    });
  });
}

function releaseOwnershipLock(): void {
  const fd = heldOwnershipFd;
  heldOwnershipFd = null;
  if (fd === null) return;
  try {
    fs.closeSync(fd);
  } catch (err) {
    log.warn('Failed to release ncl kernel ownership lock', { err });
  }
}

/**
 * Is a live server accepting on this socket path? Used before stale-socket
 * cleanup so a second host started in the same checkout refuses to take over
 * a running host's socket instead of silently unlinking it (after which every
 * `ncl` call would route to the newcomer while the original keeps running).
 * No verdict within the timeout counts as live — when unsure, never steal.
 */
function probeLiveServer(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection(socketPath);
    const done = (live: boolean): void => {
      probe.destroy();
      resolve(live);
    };
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
    probe.setTimeout(PROBE_TIMEOUT_MS, () => done(true));
  });
}

/**
 * Bind and listen, once. Rejects with the raw `EADDRINUSE` error when the
 * path is occupied — by a live listener or a stale leftover file, either
 * way `bind(2)` cannot tell the difference and neither can we without a
 * separate probe.
 */
function bindOnce(s: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    s.once('error', reject);
    s.listen(socketPath, () => {
      try {
        fs.chmodSync(socketPath, 0o600);
      } catch (err) {
        log.warn('Failed to chmod ncl socket (continuing)', { socketPath, err });
      }
      log.info('ncl CLI server listening', { socketPath });
      resolve();
    });
  });
}

export async function startCliServer(socketPath: string = DEFAULT_SOCKET_PATH): Promise<void> {
  if (startPromise || stopPromise || server || heldOwnershipFd !== null) {
    throw new Error('ncl CLI server is already starting or running');
  }
  startPromise = startCliServerInner(socketPath);
  try {
    await startPromise;
  } finally {
    startPromise = null;
  }
}

async function startCliServerInner(socketPath: string): Promise<void> {
  heldOwnershipFd = await claimOwnershipLock(socketPath);
  try {
    await bindWithRetry(socketPath);
  } catch (err) {
    releaseOwnershipLock();
    throw err;
  }
}

async function bindWithRetry(socketPath: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const s = net.createServer((conn) => handleConnection(conn));
    try {
      await bindOnce(s, socketPath);
      server = s;
      return;
    } catch (err) {
      s.close();
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'EADDRINUSE') throw err;

      // The path is occupied. Re-probe fresh on THIS attempt rather than
      // trusting an earlier verdict — the check-then-act gap between a
      // probe and an unlink is exactly where a concurrent second host
      // process can win the race (PR #453 review, reproduced with two
      // Node processes racing this same sequence): treating the bind's own
      // EADDRINUSE as the trigger to re-probe, instead of unlinking once
      // up front and never looking again, is what closes that window. A
      // live listener still means refuse, unconditionally.
      if (await probeLiveServer(socketPath)) {
        throw new Error(
          `another host instance is already serving ncl at ${socketPath} — ` +
            `refusing to take over its socket. Stop the other instance ` +
            `(or remove the file if you are certain none is running) and restart.`,
          { cause: err },
        );
      }
      if (attempt >= MAX_BIND_ATTEMPTS) {
        throw new Error(
          `could not bind ${socketPath} after ${MAX_BIND_ATTEMPTS} attempts — ` +
            `the path keeps coming back stale-but-occupied, which points at ` +
            `something other than an ordinary crash leftover.`,
          { cause: err },
        );
      }
      try {
        fs.unlinkSync(socketPath);
      } catch (unlinkErr) {
        const ue = unlinkErr as NodeJS.ErrnoException;
        if (ue.code !== 'ENOENT') {
          log.warn('Failed to unlink stale ncl socket (will try to bind anyway)', { socketPath, err: unlinkErr });
        }
      }
      // Loop and retry the bind — the next iteration re-probes before
      // acting again, so a competitor that won this round is caught then.
    }
  }
}

/**
 * Flip once startup has cleared every boot gate the socket does not wait
 * for: archive init, FS reconciliation, the OneCLI preflight, container-
 * config backfill, and channel-adapter setup (PR #453 review, round 2).
 * Before this, `startCliServer` has already bound the socket and claimed
 * ownership — that part is intentionally early, see `claimOwnershipLock` —
 * but `handleFrame` refuses to call `dispatch()` until this is set, because
 * `ncl` can mutate central-DB state those gates are still establishing.
 */
export function markCliServerReady(): void {
  // Shutdown can race an async startup after it has claimed ownership. Once
  // the listener has been closed, a late startup continuation must not leave
  // readiness set for a later standalone restart in this process.
  if (server) ready = true;
}

export async function stopCliServer({ retainOwnership = false }: { retainOwnership?: boolean } = {}): Promise<void> {
  ready = false;
  if (stopPromise) return stopPromise;

  stopPromise = stopCliServerInner(retainOwnership);
  try {
    await stopPromise;
  } finally {
    stopPromise = null;
  }
}

async function stopCliServerInner(retainOwnership: boolean): Promise<void> {
  // A signal can arrive while the transient flock subprocess is still
  // acquiring the claim. Wait for that start to bind, then close it, so this
  // stop can never release a claim belonging to an in-flight start.
  const pendingStart = startPromise;
  if (pendingStart) await pendingStart.catch(() => undefined);

  const s = server;
  server = null;
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  if (!retainOwnership) {
    // Keep ownership until the listener has closed, so a new host cannot
    // acquire the directory lock while this server still owns the socket.
    releaseOwnershipLock();
  }
}

function handleConnection(conn: net.Socket): void {
  let buffer = '';
  conn.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      void handleFrame(conn, line);
    }
  });
  conn.on('error', (err) => {
    log.warn('ncl CLI server connection error', { err });
  });
}

async function handleFrame(conn: net.Socket, line: string): Promise<void> {
  let req: RequestFrame;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isRequestFrame(parsed)) throw new Error('bad request shape');
    req = parsed;
  } catch (e) {
    write(conn, {
      id: 'unknown',
      ok: false,
      error: {
        code: 'transport-error',
        message: `bad frame: ${e instanceof Error ? e.message : String(e)}`,
      },
    });
    return;
  }

  if (!ready) {
    write(conn, {
      id: req.id,
      ok: false,
      error: { code: 'not-ready', message: 'host starting — try again once startup completes' },
    });
    return;
  }

  // Host caller — connecting to data/ncl.sock requires file-system access
  // to a 0600 socket owned by the host user, so we treat the socket path
  // itself as the auth boundary.
  const ctx: CallerContext = { caller: 'host' };
  const res = await dispatch(req, ctx);
  write(conn, res);
}

function write(conn: net.Socket, frame: ResponseFrame): void {
  try {
    conn.write(JSON.stringify(frame) + '\n');
    conn.end();
  } catch (err) {
    log.warn('Failed to write ncl CLI response', { err });
  }
}

function isRequestFrame(x: unknown): x is RequestFrame {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.command === 'string' && typeof o.args === 'object' && o.args !== null;
}
