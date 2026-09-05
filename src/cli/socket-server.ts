/**
 * Host-side socket listener. Started from src/index.ts, accepts one frame
 * per connection, calls dispatch() with caller='host', writes the response
 * frame, closes.
 *
 * Lives at data/ncl.sock (separate from data/cli.sock, which the existing
 * chat-style CLI channel adapter owns). Socket file is chmod 0600 — only
 * the user that started the host can connect.
 */
import fs from 'fs';
import net from 'net';

import { log } from '../log.js';
import { dispatch } from './dispatch.js';
import type { CallerContext, RequestFrame, ResponseFrame } from './frame.js';
import { DEFAULT_SOCKET_PATH } from './socket-client.js';

let server: net.Server | null = null;
let heldLockPath: string | null = null;

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

function lockPathFor(socketPath: string): string {
  return `${socketPath}.lock`;
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 sends nothing; it only checks whether the pid exists and is
    // signalable. EPERM means it exists but is owned by another user — still
    // alive, just not ours to check further.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLockPid(lockPath: string): number | null {
  /* eslint-disable no-catch-all/no-catch-all -- a lock file that vanished or is unreadable between our EEXIST and this read is stale by construction */
  try {
    const pid = Number(fs.readFileSync(lockPath, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

/**
 * Claim exclusive ownership of `socketPath` via `O_EXCL` on a sibling lock
 * file — the actual atomic primitive `startCliServer` was missing (PR #453
 * review, round 2): the probe-then-unlink-then-bind sequence below is a
 * check-then-act pattern with no exclusion between the check and the act, so
 * two processes racing it can still both end up with a live listener, one
 * orphaned. `open(..., 'wx')` either creates the file or fails with `EEXIST`
 * atomically at the kernel level — there is no gap for a second caller to
 * land in.
 *
 * A lock file whose pid is dead is stale (the process that held it crashed
 * without a clean shutdown) and is reclaimed; a lock file whose pid is alive
 * means a real peer holds it, and that is reported by name rather than
 * silently retried. The lock is held for the life of the process — released
 * only by `stopCliServer()` — so it doubles as a liveness fact independent
 * of whether the socket file itself survives.
 */
function claimOwnershipLock(socketPath: string): void {
  const lockPath = lockPathFor(socketPath);
  for (;;) {
    let fd: number;
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'EEXIST') throw err;
      const holderPid = readLockPid(lockPath);
      if (holderPid !== null && isProcessAlive(holderPid)) {
        throw new Error(
          `another host instance (pid ${holderPid}) already holds ${lockPath} — ` +
            `refusing to start a second host in this checkout. Stop the other ` +
            `instance and restart.`,
          { cause: err },
        );
      }
      // Stale lock from a process that crashed without releasing it.
      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkErr) {
        const ue = unlinkErr as NodeJS.ErrnoException;
        if (ue.code !== 'ENOENT') throw unlinkErr;
      }
      continue;
    }
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    heldLockPath = lockPath;
    return;
  }
}

function releaseOwnershipLock(): void {
  if (!heldLockPath) return;
  const lockPath = heldLockPath;
  heldLockPath = null;
  /* eslint-disable no-catch-all/no-catch-all -- releasing our own lock is best-effort; a failure here must not block shutdown */
  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    log.warn('Failed to release ncl socket ownership lock', { lockPath, err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
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
  claimOwnershipLock(socketPath);
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
  ready = true;
}

export async function stopCliServer(): Promise<void> {
  ready = false;
  releaseOwnershipLock();
  if (!server) return;
  const s = server;
  server = null;
  await new Promise<void>((resolve) => s.close(() => resolve()));
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
