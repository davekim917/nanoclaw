/**
 * Plugin auto-updater (Phase 5.12).
 *
 * Every hour (configurable via PLUGIN_UPDATE_CRON env), runs
 * `git pull --ff-only` in each `~/plugins/<name>` subdir. Logs which
 * plugins updated; optionally notifies a configured JID via the
 * delivery adapter when any plugin advanced.
 *
 * Simplified from v1's src/plugin-updater.ts:
 *   - No DB-backed scheduled_tasks row. v2 has no scheduled_tasks
 *     table on the host side; task scheduling is an agent-level MCP
 *     tool (`schedule_task`). Host cron work uses setInterval, the
 *     same pattern worktree-cleanup (5.0's host-side sibling) uses.
 *   - No cron-parser dep. Hourly is hard-coded; a later refactor can
 *     generalize if we need sub-hour or TZ-aware schedules.
 *
 * The notification is fire-and-forget via a callback injected at
 * startup so this module doesn't pull in delivery.ts directly.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { syncCodexLocalMarketplacePluginCache, syncCodexPluginSkills, syncCodexSubagents } from './codex-sync.js';
import { log } from './log.js';

const execFileAsync = promisify(execFile);

const INTERVAL_MS = 60 * 60 * 1000; // hourly
const STARTUP_DELAY_MS = 5 * 60 * 1000; // wait 5min after startup so host is quiet
const GIT_PULL_TIMEOUT_MS = 30_000;
const CODEX_MARKETPLACE_UPGRADE_TIMEOUT_MS = 60_000;

export interface PluginUpdaterDeps {
  /**
   * Optional: send a notification when plugins updated. First arg is
   * the host's `PLUGIN_UPDATE_NOTIFY_JID` env var (channel-qualified
   * platform id); second is the message text. No-op if the env isn't
   * set. The delivery adapter, not this module, decides routing.
   */
  notify?: (platformId: string, text: string) => Promise<void>;
}

export interface UpdateResult {
  plugin: string;
  changed: boolean;
  error?: string;
}

export interface CodexSurfaceRefreshResult {
  skills?: ReturnType<typeof syncCodexPluginSkills>;
  subagents?: ReturnType<typeof syncCodexSubagents>;
  marketplaceUpgrade?: {
    changed: boolean;
    output?: string;
    error?: string;
  };
  localPluginCache?: ReturnType<typeof syncCodexLocalMarketplacePluginCache>;
}

async function updatePlugin(pluginPath: string, name: string): Promise<UpdateResult> {
  try {
    const { stdout } = await execFileAsync('git', ['pull', '--ff-only'], {
      cwd: pluginPath,
      timeout: GIT_PULL_TIMEOUT_MS,
      encoding: 'utf-8',
    });
    const changed = !stdout.includes('Already up to date.');
    if (changed) {
      log.info('Plugin updated', { plugin: name, output: stdout.trim() });
    }
    return { plugin: name, changed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('Plugin update failed', { plugin: name, err: msg });
    return { plugin: name, changed: false, error: msg };
  }
}

/**
 * Pull every `~/plugins/<name>` and return per-plugin results. No
 * notification side effect — callers (the hourly cron and the
 * /update-plugins slash command) decide what to do with the output.
 */
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
  return results;
}

/**
 * Refresh every Codex surface derived from plugin repos.
 *
 * Codex marketplaces are copied into Codex's installed plugin cache after local
 * `git pull` and after Codex's own Git marketplace checkout is upgraded. The
 * legacy `.agents/skills` and `.codex/agents` mirrors remain for non-native
 * plugin surfaces, but plugin-native workflow skills are excluded by
 * `plugin-skill-discovery`.
 */
export async function refreshCodexPluginSurfaces(): Promise<CodexSurfaceRefreshResult> {
  const result: CodexSurfaceRefreshResult = {};

  try {
    result.skills = syncCodexPluginSkills();
    log.info('Codex plugin skill mirror refreshed', {
      target: result.skills.target,
      discovered: result.skills.discovered,
      created: result.skills.created.length,
      removed: result.skills.removed.length,
      unchanged: result.skills.unchanged.length,
      skipped: result.skills.skipped.length,
    });
  } catch (err) {
    log.warn('Codex plugin skill mirror refresh failed', { err });
  }

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
    log.warn('Codex marketplace upgrade failed', { err: msg });
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
  intervalHandle = setInterval(() => {
    runOnce(deps).catch((err) => log.error('Plugin updater periodic run failed', { err }));
  }, INTERVAL_MS);
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
