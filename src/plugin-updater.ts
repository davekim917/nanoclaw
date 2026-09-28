/**
 * Hourly `git pull --ff-only` of each `~/plugins/<name>`, `npm ci --ignore-scripts` for each existing install whose
 * lockfile it changed, a refresh of the derived Codex surfaces, and a `PLUGIN_UPDATE_NOTIFY_JID` note if any advanced.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { syncCodexLocalMarketplacePluginCache, syncCodexSubagents } from './codex-sync.js';
import { refreshMaterializedCodexSkills } from './codex-skill-materialize.js';
import { getDeliveryAdapter } from './delivery.js';
import { vendorDesignArtifactLoop } from './design-artifact-loop-vendor.js';
import { onHostShutdown, onHostStart } from './host-lifecycle.js';
import { log } from './log.js';
import { syncOpenCodeSubagents } from './opencode-sync.js';

const execFileAsync = promisify(execFile);

const INTERVAL_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 5 * 60 * 1000; // let the host settle after boot
const GIT_PULL_TIMEOUT_MS = 30_000;
const CODEX_MARKETPLACE_UPGRADE_TIMEOUT_MS = 60_000;
const NPM_CI_TIMEOUT_MS = 5 * 60_000;
const NPM_LOCKFILE = 'package-lock.json';
const NPM_SHRINKWRAP = 'npm-shrinkwrap.json';
const NPM_REGISTRY_HOST = 'registry.npmjs.org';
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

interface LockEntry {
  resolved?: unknown;
  version?: unknown;
  link?: unknown;
}

// The hourly refresh would repeat the missing-codex-binary line forever; log it once per process.
let codexBinaryMissingLogged = false;

export interface PluginUpdaterDeps {
  /** Called with `PLUGIN_UPDATE_NOTIFY_JID` (channel-qualified platform id) and the text when plugins updated. */
  notify?: (platformId: string, text: string) => Promise<void>;
}

export interface UpdateResult {
  plugin: string;
  changed: boolean;
  error?: string;
}

export interface CodexSurfaceRefreshResult {
  subagents?: ReturnType<typeof syncCodexSubagents>;
  opencodeSubagents?: ReturnType<typeof syncOpenCodeSubagents>;
  marketplaceUpgrade?: {
    changed: boolean;
    output?: string;
    error?: string;
  };
  localPluginCache?: ReturnType<typeof syncCodexLocalMarketplacePluginCache>;
}

async function gitHead(pluginPath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: pluginPath,
    timeout: GIT_PULL_TIMEOUT_MS,
    encoding: 'utf-8',
  });
  return stdout.trim();
}

async function updatePlugin(pluginPath: string, name: string): Promise<UpdateResult> {
  try {
    const before = await gitHead(pluginPath);
    const { stdout } = await execFileAsync('git', ['pull', '--ff-only'], {
      cwd: pluginPath,
      timeout: GIT_PULL_TIMEOUT_MS,
      encoding: 'utf-8',
    });
    const after = await gitHead(pluginPath);
    const changed = before !== after;
    if (changed) {
      log.info('Plugin updated', { plugin: name, output: stdout.trim() });
      await installChangedLockfiles(pluginPath, name, before, after);
    }
    return { plugin: name, changed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('Plugin update failed', { plugin: name, err: msg });
    return { plugin: name, changed: false, error: msg };
  }
}

async function installChangedLockfiles(pluginPath: string, name: string, from: string, to: string): Promise<void> {
  let lockfiles: string[];
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--name-only', '-z', '--diff-filter=d', `${from}..${to}`, '--', `:(glob)**/${NPM_LOCKFILE}`],
      { cwd: pluginPath, timeout: GIT_PULL_TIMEOUT_MS, encoding: 'utf-8' },
    );
    lockfiles = stdout.split('\0').filter(Boolean);
  } catch (err) {
    log.warn('Plugin lockfile diff failed; skipping dependency install', {
      plugin: name,
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  for (const lockfile of lockfiles) {
    const dir = path.dirname(lockfile);
    const cwd = path.join(pluginPath, dir);
    const args = ['ci', '--ignore-scripts', '--prefix', cwd];
    const command = ['npm', ...args].join(' ');
    if (!fs.existsSync(path.join(cwd, 'node_modules'))) {
      log.info('Plugin lockfile changed; no existing install to refresh', { plugin: name, dir });
      continue;
    }
    const refusal = lockfileRefusal(cwd);
    if (refusal) {
      log.warn('Plugin dependency install refused', { plugin: name, dir, command, reason: refusal });
      continue;
    }
    try {
      await execFileAsync('npm', args, { cwd, timeout: NPM_CI_TIMEOUT_MS, encoding: 'utf-8' });
      log.info('Plugin dependencies installed', { plugin: name, dir, command });
    } catch (err) {
      log.warn('Plugin dependency install failed', {
        plugin: name,
        dir,
        command,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function lockfileRefusal(dir: string): string | null {
  if (fs.existsSync(path.join(dir, NPM_SHRINKWRAP)))
    return `${NPM_SHRINKWRAP} present; npm would install from it instead`;
  let lock: { lockfileVersion?: unknown; packages?: Record<string, LockEntry> };
  try {
    lock = JSON.parse(fs.readFileSync(path.join(dir, NPM_LOCKFILE), 'utf-8'));
  } catch (err) {
    return `unreadable lockfile: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (typeof lock.lockfileVersion !== 'number' || lock.lockfileVersion < 2 || !lock.packages) {
    return 'lockfile predates lockfileVersion 2';
  }
  const nonRegistry = Object.entries(lock.packages)
    .filter(([key, entry]) => key.includes('node_modules/') && entry.link !== true && !fromRegistry(entry))
    .map(([key]) => key);
  return nonRegistry.length > 0
    ? `non-registry dependencies, whose prepare scripts npm runs despite --ignore-scripts: ${nonRegistry.join(', ')}`
    : null;
}

function fromRegistry(entry: LockEntry): boolean {
  if (entry.resolved === undefined) return typeof entry.version === 'string' && SEMVER.test(entry.version);
  if (typeof entry.resolved !== 'string' || !URL.canParse(entry.resolved)) return false;
  const url = new URL(entry.resolved);
  return url.protocol === 'https:' && url.host === NPM_REGISTRY_HOST;
}

/** Pull every `~/plugins/<name>`; no notification side effect. */
export async function runPluginUpdates(): Promise<UpdateResult[]> {
  const pluginsRoot = path.join(os.homedir(), 'plugins');
  if (!fs.existsSync(pluginsRoot)) {
    log.debug('Plugin updater: ~/plugins missing, skipping');
    return [];
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(pluginsRoot);
  } catch (err) {
    log.warn('Plugin updater: failed to read ~/plugins', { err });
    return [];
  }

  const repos = entries.filter((name) => {
    const p = path.join(pluginsRoot, name);
    try {
      return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, '.git'));
    } catch {
      return false;
    }
  });

  if (repos.length === 0) return [];

  log.info('Plugin updater: scanning', { count: repos.length });
  const results = await Promise.all(repos.map((name) => updatePlugin(path.join(pluginsRoot, name), name)));
  if (results.some((r) => r.changed)) {
    await refreshCodexPluginSurfaces();
  }
  if (results.some((r) => r.plugin === 'design-artifact-loop' && r.changed)) {
    vendorDesignArtifactLoopIfPresent();
  }
  return results;
}

/**
 * The vendored design-artifact-loop copies are bind-mounted at spawn, so no rebuild is needed. Writes into the
 * git-tracked tree and does NOT commit: the operator reviews and commits the result.
 */
function vendorDesignArtifactLoopIfPresent(): void {
  try {
    const changed = vendorDesignArtifactLoop();
    if (changed.length > 0) {
      log.info('design-artifact-loop auto-vendored from updated plugin repo', { files: changed });
    } else {
      log.debug('design-artifact-loop plugin repo updated but nothing to vendor (e.g. docs/assets only)');
    }
  } catch (err) {
    log.warn('design-artifact-loop auto-vendor failed', { err });
  }
}

/** Refresh every Codex surface derived from plugin repos that reaches containers (the plugin cache is bind-mounted). */
export async function refreshCodexPluginSurfaces(): Promise<CodexSurfaceRefreshResult> {
  const result: CodexSurfaceRefreshResult = {};

  // Plugin skills are deliberately not mirrored to host CLI paths: containers build their own skill set from
  // /workspace/plugins at spawn. Subagent mirrors stay: `~/.codex*/agents` is bind-mounted into containers.
  try {
    result.subagents = syncCodexSubagents();
    log.info('Codex subagent mirror refreshed', {
      targets: result.subagents.targets.length,
      discovered: result.subagents.discovered,
      writes: result.subagents.writes,
      removed: result.subagents.removedFiles,
      skipped: result.subagents.skipped.length,
    });
  } catch (err) {
    log.warn('Codex subagent mirror refresh failed', { err });
  }

  try {
    result.opencodeSubagents = syncOpenCodeSubagents();
    log.info('OpenCode subagent mirror refreshed', {
      targets: result.opencodeSubagents.targets.length,
      discovered: result.opencodeSubagents.discovered,
      writes: result.opencodeSubagents.writes,
      removed: result.opencodeSubagents.removedFiles,
      skipped: result.opencodeSubagents.skipped.length,
    });
  } catch (err) {
    log.warn('OpenCode subagent mirror refresh failed', { err });
  }

  try {
    const { stdout, stderr } = await execFileAsync('codex', ['plugin', 'marketplace', 'upgrade'], {
      timeout: CODEX_MARKETPLACE_UPGRADE_TIMEOUT_MS,
      encoding: 'utf-8',
    });
    const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
    const changed =
      !/(No configured Git marketplaces to upgrade\.|All configured Git marketplaces are already up to date\.)/.test(
        output,
      );
    result.marketplaceUpgrade = { changed, output };
    log.info('Codex marketplace upgrade completed', { changed, output });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.marketplaceUpgrade = { changed: false, error: msg };
    // ENOENT: no host `codex` binary. Only Git-sourced marketplaces need it; the local one syncs by file ops below.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      if (!codexBinaryMissingLogged) {
        codexBinaryMissingLogged = true;
        log.info(
          'Codex CLI not installed on host — skipping Git-marketplace upgrade (local marketplaces sync via file ops)',
        );
      }
    } else {
      log.warn('Codex marketplace upgrade failed', { err: msg });
    }
  }

  // MUST run before the plugin cache is re-copied: materialized copies of symlinked SKILL.md files go stale on
  // `git pull`, and the cache would copy the stale file.
  try {
    const materialized = refreshMaterializedCodexSkills();
    if (materialized.refreshed.length > 0) {
      log.info('Re-materialized codex skills for symlink-shipping plugins', {
        plugins: materialized.refreshed,
      });
    }
  } catch (err) {
    log.warn('Codex skill re-materialization failed', { err });
  }

  try {
    result.localPluginCache = syncCodexLocalMarketplacePluginCache();
    log.info('Codex marketplace plugin cache refreshed', {
      target: result.localPluginCache.target,
      marketplaces: result.localPluginCache.marketplaces,
      installed: result.localPluginCache.installed.length,
      updated: result.localPluginCache.updated.length,
      removed: result.localPluginCache.removed.length,
      skipped: result.localPluginCache.skipped.length,
      errors: result.localPluginCache.errors.length,
    });
  } catch (err) {
    log.warn('Codex marketplace plugin cache refresh failed', { err });
  }

  return result;
}

async function runOnce(deps: PluginUpdaterDeps): Promise<void> {
  const results = await runPluginUpdates();
  const changed = results.filter((r) => r.changed);
  if (changed.length === 0) return;

  const notifyJid = process.env.PLUGIN_UPDATE_NOTIFY_JID;
  if (notifyJid && deps.notify) {
    const msg = `Updated ${changed.length} plugin(s): ${changed.map((r) => r.plugin).join(', ')}`;
    deps.notify(notifyJid, msg).catch((err) => {
      log.warn('Plugin update notify failed', { err });
    });
  }
}

let intervalHandle: NodeJS.Timeout | null = null;
let startupHandle: NodeJS.Timeout | null = null;

export function startPluginUpdater(deps: PluginUpdaterDeps = {}): void {
  if (intervalHandle || startupHandle) return;
  startupHandle = setTimeout(() => {
    startupHandle = null;
    runOnce(deps).catch((err) => log.error('Plugin updater startup run failed', { err }));
  }, STARTUP_DELAY_MS);
  startupHandle.unref?.();
  intervalHandle = setInterval(() => {
    runOnce(deps).catch((err) => log.error('Plugin updater periodic run failed', { err }));
  }, INTERVAL_MS);
  intervalHandle.unref?.();
}

export function stopPluginUpdater(): void {
  if (startupHandle) {
    clearTimeout(startupHandle);
    startupHandle = null;
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

onHostStart(function pluginUpdaterHostStart() {
  // UNGUARDED — a synchronous startup failure must abort boot (§4.2).
  startPluginUpdater({
    notify: async (platformId, text) => {
      const parts = platformId.split(':');
      if (parts.length < 2) {
        log.warn('Plugin updater notify: malformed jid', { platformId });
        return;
      }
      const channelType = parts[0];
      const realPlatformId = parts.slice(1).join(':');
      const adapter = getDeliveryAdapter();
      if (!adapter) {
        log.warn('Plugin updater notify: no delivery adapter yet', { platformId });
        return;
      }
      await adapter.deliver(channelType, realPlatformId, null, 'chat', JSON.stringify({ text }));
    },
  });
  log.info('Plugin updater started');
});

onHostShutdown(function pluginUpdaterHostShutdown() {
  try {
    stopPluginUpdater();
  } catch (err) {
    log.error('Plugin updater failed to stop', { err });
  }
});
