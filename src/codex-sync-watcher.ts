#!/usr/bin/env tsx
/**
 * Codex sync watcher daemon.
 *
 * Watches the source-of-truth files Codex parity depends on and re-runs the
 * sync scripts whenever they change. Closes the host-side drift gap that
 * the per-container-spawn sync already handles inside containers.
 *
 * What changes the daemon catches:
 *   - `~/.claude/CLAUDE.md`                        — top-level behavioral rules
 *   - `~/.claude/` glob `*.md`                     — any `@`-included file (RTK.md today,
 *                                                    anything else Operator adds tomorrow)
 *   - `~/.claude/agents/*.md`                      — Claude personal-scope subagents
 *   - `~/.codex/config.toml`                       — local marketplace installs/enabled state
 *   - `~/plugins/` recursive `SKILL.md` files      — every plugin-bundled skill
 *   - `~/plugins/` recursive `.codex-plugin` trees — Codex-native plugin installs
 *   - `~/plugins/**` recursive `agents/*.md`       — plugin-shipped subagents
 *   - `~/plugins/<plugin>` add/remove              — marketplace install/uninstall
 *
 * What it does on change:
 *   - debounce 5s (collapse rapid edits into one run)
 *   - acquire file lock at `~/.codex/.sync.lock` (concurrent fires no-op)
 *   - refresh Codex AGENTS.md, subagents, and the local marketplace plugin
 *     cache in-process. Plugin SKILLS are deliberately not mirrored to host
 *     CLI paths — `~/plugins` is the container agents' plugin source, and
 *     containers build their own skill set from /workspace/plugins at spawn.
 *   - touch `~/.codex/.sync-heartbeat` on success for future healthcheck timer
 *
 * On startup:
 *   - log version + watch list
 *   - run sync once immediately (covers edits made while daemon was stopped)
 *
 * Crash behavior: systemd restarts on any non-zero exit; sync failures
 * surface as ERROR-prefixed stderr lines (visible in `journalctl -u
 * nanoclaw-codex-sync`).
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

// chokidar v4+ removed glob support — paths are interpreted literally.
// We watch directories instead and filter event paths by name.
const CLAUDE_DIR = path.join(HOME, '.claude');
const PLUGINS_DIR = path.join(HOME, 'plugins');

const WATCH_PATHS = [CLAUDE_DIR, PLUGINS_DIR, CODEX_CONFIG];

/** Returns true if `eventPath` is a change we care about. */
function isRelevantPath(eventPath: string): boolean {
  if (eventPath === CODEX_CONFIG) {
    return true;
  }
  // ~/.claude — only top-level *.md files (behavioral rules + @-includes).
  // Ignore everything else under .claude/ (projects, sessions, plugins cache,
  // hooks, statusline, etc.). path.dirname() catches the "direct child" case.
  if (path.dirname(eventPath) === CLAUDE_DIR && eventPath.endsWith('.md')) {
    return true;
  }
  // ~/.claude/agents/<name>.md — personal-scope subagents (currently empty
  // for Operator but supported for completeness so future overrides trigger sync).
  if (path.dirname(eventPath) === path.join(CLAUDE_DIR, 'agents') && eventPath.endsWith('.md')) {
    return true;
  }
  // ~/plugins/<plugin>/.../SKILL.md — any SKILL.md anywhere under a plugin.
  if (eventPath.startsWith(PLUGINS_DIR + path.sep) && path.basename(eventPath) === 'SKILL.md') {
    return true;
  }
  // ~/plugins/<plugin>/.../.codex-plugin/plugin.json or any file under a
  // Codex-native plugin root. These are installed through Codex marketplace
  // metadata and mirrored into ~/.codex/plugins/cache for active sessions.
  if (eventPath.startsWith(PLUGINS_DIR + path.sep) && isUnderCodexPluginRoot(eventPath)) {
    return true;
  }
  // ~/plugins/<plugin>/<...>/agents/<name>.md — plugin-shipped subagents.
  // The immediate parent dir must be named exactly `agents` (catches both
  // top-level and nested-sub-plugin layouts) and the file must be `.md`.
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

// Paths chokidar should skip while recursing. Without these the daemon
// would hold thousands of file watches (node_modules in each plugin =
// each git repo brings thousands of files we don't care about). Keeps
// the resident watch set tiny.
const IGNORE_PATTERNS: (string | RegExp)[] = [
  /(^|[/\\])\.git([/\\]|$)/,
  /(^|[/\\])node_modules([/\\]|$)/,
  /(^|[/\\])dist([/\\]|$)/,
  /(^|[/\\])build([/\\]|$)/,
  /(^|[/\\])\.cache([/\\]|$)/,
  /(^|[/\\])coverage([/\\]|$)/,
  /(^|[/\\])\.next([/\\]|$)/,
  /(^|[/\\])\.history([/\\]|$)/,
  // ~/.claude subtrees we don't care about — keep the watch set tiny.
  new RegExp(
    `^${CLAUDE_DIR.replace(/[/\\]/g, '[/\\\\]')}[/\\\\](projects|sessions|plugins|hooks|backups|paste-cache|file-history|shell-snapshots|telemetry|debug|tsc-cache|downloads|uploads|tasks|cache|remote|session-env|teams|plans|skills)([/\\\\]|$)`,
  ),
];

function log(msg: string): void {
  // systemd journal captures stderr alongside stdout, but keeping the
  // distinction makes `journalctl --priority` filters useful.
  console.log(`[codex-sync-watcher] ${new Date().toISOString()} ${msg}`);
}

function logError(msg: string): void {
  console.error(`[codex-sync-watcher] ${new Date().toISOString()} ERROR ${msg}`);
}

let debounceHandle: NodeJS.Timeout | null = null;
let inFlight = false;
let pendingTrigger: string | null = null;

function scheduleSync(reason: string): void {
  // Carry the most recent trigger into the log line so flapping events
  // surface their source.
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

/**
 * Acquire `LOCK_FILE` with O_CREAT | O_EXCL semantics. If a stale lock
 * from a crashed prior run exists (PID no longer alive), remove it and
 * retry once. Returns the fd on success, null when another live process
 * holds the lock.
 */
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

/**
 * A lock file is stale when:
 *   - its PID line is empty/unreadable (older format / partial write), OR
 *   - the recorded PID is no longer alive on the system (process.kill 0)
 */
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
    // ESRCH = no such process. EPERM = exists but we can't signal it
    // (different user) — treat as alive to be safe.
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
    // In-process — no spawned tsx. Each call is a few hundred ms of fs work.
    const agentsResult = syncCodexAgentsMd();
    log(
      `agents-md: ${agentsResult.changed ? 'wrote' : 'unchanged'} ${agentsResult.target} ` +
        `(${agentsResult.bytes} bytes)`,
    );
    // Plugin skills are NOT mirrored to host CLI paths — `~/plugins` feeds
    // container agents, which build their own skill set from
    // /workspace/plugins at spawn. The operator owns host CLI plugins.
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
    // Don't follow symlinks — our own mirror dirs symlink into ~/plugins/,
    // and we don't want changes there to feed back as triggers.
    followSymlinks: false,
  });

  let ready = false;
  // Suppress events during the initial scan even though `ignoreInitial: true`
  // is set — chokidar 5.x sometimes leaks `add` events for matched files
  // during the scan window before `ready` fires. Belt-and-suspenders.
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
    // Only react to plugin-root direct children (new plugin installed).
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
  // Per chokidar docs, `ready` fires once after the initial scan completes.
  // In practice with multiple glob patterns it can fire multiple times; we
  // gate on a local flag so the post-ready startup sync only runs once.
  watcher.on('ready', () => {
    if (ready) return;
    ready = true;
    log('watcher ready');
    // Initial sync on startup — covers edits made while daemon was stopped.
    // Fire AFTER the watcher is ready so we don't race with the initial
    // scan or fire on every file the scan emits.
    scheduleSync('startup');
  });

  // Graceful shutdown on SIGTERM (systemctl stop).
  const shutdown = (signal: string) => {
    log(`received ${signal}, shutting down`);
    watcher.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
