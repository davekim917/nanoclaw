/**
 * Remote Control (Phase 5.7).
 *
 * Thin wrapper around Claude Code's OOTB `claude remote-control` CLI.
 * NanoClaw doesn't build anything novel here — just spawns the CLI,
 * captures the URL it prints, and tracks the session so we can tell
 * users "already running" on repeat requests and restore state on
 * restart.
 *
 * Ported from v1 with minor v2-idiom adjustments:
 * - logger → log
 * - exported startRemoteControl / stopRemoteControl / getActiveSession
 *   so the host-side system-action handler can drive them
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

interface RemoteControlSession {
  pid: number;
  url: string;
  startedBy: string;
  startedInChat: string;
  startedAt: string;
}

let activeSession: RemoteControlSession | null = null;

const URL_REGEX = /https:\/\/claude\.ai\/code\S+/;
const URL_TIMEOUT_MS = 30_000;
const URL_POLL_MS = 200;
const STATE_FILE = path.join(DATA_DIR, 'remote-control.json');
const STDOUT_FILE = path.join(DATA_DIR, 'remote-control.stdout');
const STDERR_FILE = path.join(DATA_DIR, 'remote-control.stderr');

function saveState(session: RemoteControlSession): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(session));
}

function clearState(): void {
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    // ignore
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Restore session from disk on startup. If the process is still alive, adopt it. Otherwise clean up. */
export function restoreRemoteControl(): void {
  let data: string;
  try {
    data = fs.readFileSync(STATE_FILE, 'utf-8');
  } catch {
    return;
  }
  try {
    const session: RemoteControlSession = JSON.parse(data);
    if (session.pid && isProcessAlive(session.pid)) {
      activeSession = session;
      log.info('Restored Remote Control session', { pid: session.pid, url: session.url });
    } else {
      clearState();
    }
  } catch {
    clearState();
  }
}

export function getActiveSession(): RemoteControlSession | null {
  return activeSession;
}

export async function startRemoteControl(
  sender: string,
  chatJid: string,
  cwd: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (activeSession) {
    if (isProcessAlive(activeSession.pid)) {
      return { ok: true, url: activeSession.url };
    }
    activeSession = null;
    clearState();
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const stdoutFd = fs.openSync(STDOUT_FILE, 'w');
  const stderrFd = fs.openSync(STDERR_FILE, 'w');

  let proc;
  try {
    proc = spawn('claude', ['remote-control', '--name', 'NanoClaw Remote'], {
      cwd,
      stdio: ['pipe', stdoutFd, stderrFd],
      detached: true,
    });
  } catch (err) {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to start: ${msg}` };
  }

  if (proc.stdin) {
    proc.stdin.write('y\n');
    proc.stdin.end();
  }

  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);
  proc.unref();

  const pid = proc.pid;
  if (!pid) return { ok: false, error: 'Failed to get process PID' };

  return new Promise((resolve) => {
    const startTime = Date.now();
    const poll = () => {
      if (!isProcessAlive(pid)) {
        resolve({ ok: false, error: 'Process exited before producing URL' });
        return;
      }

      let content = '';
      try { content = fs.readFileSync(STDOUT_FILE, 'utf-8'); } catch { /* not ready */ }

      const match = content.match(URL_REGEX);
      if (match) {
        const session: RemoteControlSession = {
          pid,
          url: match[0],
          startedBy: sender,
          startedInChat: chatJid,
          startedAt: new Date().toISOString(),
        };
        activeSession = session;
        saveState(session);
        log.info('Remote Control session started', { url: match[0], pid, sender, chatJid });
        resolve({ ok: true, url: match[0] });
        return;
      }

      if (Date.now() - startTime >= URL_TIMEOUT_MS) {
        try { process.kill(-pid, 'SIGTERM'); }
        catch { try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ } }
        resolve({ ok: false, error: 'Timed out waiting for Remote Control URL' });
        return;
      }

      setTimeout(poll, URL_POLL_MS);
    };
    poll();
  });
}

export function stopRemoteControl(): { ok: true } | { ok: false; error: string } {
  if (!activeSession) return { ok: false, error: 'No active Remote Control session' };

  const { pid } = activeSession;
  try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
  activeSession = null;
  clearState();
  log.info('Remote Control session stopped', { pid });
  return { ok: true };
}
