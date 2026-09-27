#!/usr/bin/env tsx
/**
 * Host daemon: re-runs the Codex sync (AGENTS.md, subagents, local marketplace plugin cache) when its sources
 * change, debounced and under `~/.codex/.sync.lock`. Plugin skills are deliberately not mirrored to host CLI paths:
 * containers build their own skill set from /workspace/plugins at spawn.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import chokidar from 'chokidar';

import { syncCodexAgentsMd, syncCodexLocalMarketplacePluginCache, syncCodexSubagents } from './codex-sync.js';
import { syncOpenCodeSubagents } from './opencode-sync.js';

const HOME = os.homedir();
const CODEX_DIR = path.join(HOME, '.codex');
const CODEX_CONFIG = path.join(CODEX_DIR, 'config.toml');
const LOCK_FILE = path.join(CODEX_DIR, '.sync.lock');
const HEARTBEAT_FILE = path.join(CODEX_DIR, '.sync-heartbeat');

const DEBOUNCE_MS = 5_000;

// chokidar v4+ has no globs: watch directories and filter event paths by name.
const CLAUDE_DIR = path.join(HOME, '.claude');
const PLUGINS_DIR = path.join(HOME, 'plugins');

const WATCH_PATHS = [CLAUDE_DIR, PLUGINS_DIR, CODEX_CONFIG];

function isRelevantPath(eventPath: string): boolean {
  if (eventPath === CODEX_CONFIG) {
    return true;
  }
  // Top-level ~/.claude/*.md only (rules and @-includes).
  if (path.dirname(eventPath) === CLAUDE_DIR && eventPath.endsWith('.md')) {
    return true;
  }
  if (path.dirname(eventPath) === path.join(CLAUDE_DIR, 'agents') && eventPath.endsWith('.md')) {
    return true;
  }
  if (eventPath.startsWith(PLUGINS_DIR + path.sep) && path.basename(eventPath) === 'SKILL.md') {
    return true;
  }
  // Codex-native plugin roots are mirrored into ~/.codex/plugins/cache for active sessions.
  if (eventPath.startsWith(PLUGINS_DIR + path.sep) && isUnderCodexPluginRoot(eventPath)) {
    return true;
  }
  // Plugin-shipped subagents: parent dir named exactly `agents`, at any depth.
  if (
    eventPath.startsWith(PLUGINS_DIR + path.sep) &&
    eventPath.endsWith('.md') &&
    path.basename(path.dirname(eventPath)) === 'agents'
  ) {
    return true;
  }
  return false;
}

function isUnderCodexPluginRoot(eventPath: string): boolean {
  let current = path.dirname(eventPath);
  while (current.startsWith(PLUGINS_DIR + path.sep)) {
    if (fs.existsSync(path.join(current, '.codex-plugin', 'plugin.json'))) {
      return true;
    }
    if (path.dirname(current) === current) break;
    current = path.dirname(current);
  }
  return false;
}

// Without these the recursive watch holds thousands of handles (node_modules, .git per plugin repo).
const IGNORE_PATTERNS: (string | RegExp)[] = [
  /(^|[/\\])\.git([/\\]|$)/,
  /(^|[/\\])node_modules([/\\]|$)/,
  /(^|[/\\])dist([/\\]|$)/,
  /(^|[/\\])build([/\\]|$)/,
  /(^|[/\\])\.cache([/\\]|$)/,
  /(^|[/\\])coverage([/\\]|$)/,
  /(^|[/\\])\.next([/\\]|$)/,
  /(^|[/\\])\.history([/\\]|$)/,
  new RegExp(
    `^${CLAUDE_DIR.replace(/[/\\]/g, '[/\\\\]')}[/\\\\](projects|sessions|plugins|hooks|backups|paste-cache|file-history|shell-snapshots|telemetry|debug|tsc-cache|downloads|uploads|tasks|cache|remote|session-env|teams|plans|skills)([/\\\\]|$)`,
  ),
];

function log(msg: string): void {
  console.log(`[codex-sync-watcher] ${new Date().toISOString()} ${msg}`);
}

function logError(msg: string): void {
  console.error(`[codex-sync-watcher] ${new Date().toISOString()} ERROR ${msg}`);
}

let debounceHandle: NodeJS.Timeout | null = null;
let inFlight = false;
let pendingTrigger: string | null = null;

function scheduleSync(reason: string): void {
  pendingTrigger = reason;
  if (debounceHandle) clearTimeout(debounceHandle);
  debounceHandle = setTimeout(() => {
    debounceHandle = null;
    const trigger = pendingTrigger ?? 'unknown';
    pendingTrigger = null;
    runSync(trigger).catch((err) => {
      logError(`runSync threw: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, DEBOUNCE_MS);
}

/** O_CREAT|O_EXCL lock; a stale lock (dead PID) is removed and retried once. Null when a live process holds it. */
function tryAcquireLock(): number | null {
  fs.mkdirSync(CODEX_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_FILE, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
      return fd;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (attempt === 0 && isStaleLock()) {
        log(`removing stale lock at ${LOCK_FILE}`);
        try {
          fs.unlinkSync(LOCK_FILE);
        } catch {
          /* race: another process won, try the open again anyway */
        }
        continue;
      }
      return null;
    }
  }
  return null;
}

/** Stale when the PID line is unreadable or the PID is dead. */
function isStaleLock(): boolean {
  let contents: string;
  try {
    contents = fs.readFileSync(LOCK_FILE, 'utf-8');
  } catch {
    return false;
  }
  const pidLine = contents.split('\n')[0]?.trim();
  if (!pidLine) return true;
  const pid = Number(pidLine);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false; // process alive — lock is live
  } catch (err) {
    // EPERM: exists but not signalable (other user), so treat as alive.
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true;
    return false;
  }
}

function releaseLock(fd: number | null): void {
  if (fd !== null) {
    try {
      fs.closeSync(fd);
    } catch {
      /* best-effort */
    }
  }
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    /* best-effort */
  }
}

async function runSync(trigger: string): Promise<void> {
  if (inFlight) {
    log(`sync already in flight, dropping fire (trigger=${trigger})`);
    return;
  }
  inFlight = true;
  const fd = tryAcquireLock();
  if (fd === null) {
    log(`another live process holds ${LOCK_FILE}; skipping (trigger=${trigger})`);
    inFlight = false;
    return;
  }

  const t0 = Date.now();
  log(`sync started (trigger=${trigger})`);
  let success = false;
  try {
    const agentsResult = syncCodexAgentsMd();
    log(
      `agents-md: ${agentsResult.changed ? 'wrote' : 'unchanged'} ${agentsResult.target} ` +
        `(${agentsResult.bytes} bytes)`,
    );
    // Plugin skills are not mirrored to host CLI paths (containers build their own from /workspace/plugins).
    const subagentsResult = syncCodexSubagents();
    log(
      `subagents: ${subagentsResult.targets.length} target(s) — discovered=${subagentsResult.discovered} ` +
        `writes=${subagentsResult.writes} unchangedFiles=${subagentsResult.unchangedFiles} ` +
        `removedFiles=${subagentsResult.removedFiles} skipped=${subagentsResult.skipped.length} ` +
        `targets=${subagentsResult.targets.join(',')}`,
    );
    const ocSubagentsResult = syncOpenCodeSubagents();
    log(
      `opencode-subagents: ${ocSubagentsResult.targets.length} target(s) — discovered=${ocSubagentsResult.discovered} ` +
        `writes=${ocSubagentsResult.writes} unchangedFiles=${ocSubagentsResult.unchangedFiles} ` +
        `removedFiles=${ocSubagentsResult.removedFiles} skipped=${ocSubagentsResult.skipped.length} ` +
        `targets=${ocSubagentsResult.targets.join(',')}`,
    );
    const localPluginCacheResult = syncCodexLocalMarketplacePluginCache();
    log(
      `local-plugin-cache: ${localPluginCacheResult.target} — marketplaces=${localPluginCacheResult.marketplaces} ` +
        `installed=${localPluginCacheResult.installed.length} updated=${localPluginCacheResult.updated.length} ` +
        `removed=${localPluginCacheResult.removed.length} skipped=${localPluginCacheResult.skipped.length} ` +
        `errors=${localPluginCacheResult.errors.length}`,
    );
    fs.writeFileSync(HEARTBEAT_FILE, `${new Date().toISOString()} ${trigger}\n`);
    success = true;
  } catch (err) {
    logError(`sync failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    releaseLock(fd);
    inFlight = false;
    const ms = Date.now() - t0;
    log(`sync ${success ? 'completed' : 'FAILED'} in ${ms}ms (trigger=${trigger})`);
  }
}

function main(): void {
  log(`starting (debounce=${DEBOUNCE_MS}ms)`);
  log(`watching: ${WATCH_PATHS.join(', ')}`);

  const watcher = chokidar.watch(WATCH_PATHS, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    ignored: IGNORE_PATTERNS,
    // Our own mirror dirs symlink into ~/plugins/; following them would feed changes back as triggers.
    followSymlinks: false,
  });

  let ready = false;
  // chokidar 5.x can leak `add` events during the initial scan despite `ignoreInitial`.
  const onChange = (kind: string, p: string) => {
    if (!ready) return;
    if (!isRelevantPath(p)) return;
    scheduleSync(`${kind} ${p}`);
  };

  watcher.on('add', (p) => onChange('add', p));
  watcher.on('change', (p) => onChange('change', p));
  watcher.on('unlink', (p) => onChange('unlink', p));
  watcher.on('addDir', (p) => {
    if (!ready) return;
    if (path.dirname(p) === path.join(HOME, 'plugins')) {
      scheduleSync(`new plugin ${path.basename(p)}`);
    }
  });
  watcher.on('unlinkDir', (p) => {
    if (!ready) return;
    if (path.dirname(p) === path.join(HOME, 'plugins')) {
      scheduleSync(`removed plugin ${path.basename(p)}`);
    }
  });
  watcher.on('error', (err) => {
    logError(`watcher error: ${err instanceof Error ? err.message : String(err)}`);
  });
  // `ready` can fire more than once with several watch roots; the flag runs the startup sync once.
  watcher.on('ready', () => {
    if (ready) return;
    ready = true;
    log('watcher ready');
    // After ready, so the startup sync does not race the initial scan; covers edits made while stopped.
    scheduleSync('startup');
  });

  const shutdown = (signal: string) => {
    log(`received ${signal}, shutting down`);
    watcher
      .close()
      .catch((err) => logError(`watcher close error: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
