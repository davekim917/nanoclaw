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
 *     table on the host side; task scheduling is agent-level via
 *     `ncl tasks`. Host cron work uses setInterval, the
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

import { syncCodexLocalMarketplacePluginCache, syncCodexSubagents } from './codex-sync.js';
import { refreshMaterializedCodexSkills } from './codex-skill-materialize.js';
import { vendorDesignArtifactLoop } from './design-artifact-loop-vendor.js';
import { log } from './log.js';
import { syncOpenCodeSubagents } from './opencode-sync.js';

const execFileAsync = promisify(execFile);

const INTERVAL_MS = 60 * 60 * 1000; // hourly
const STARTUP_DELAY_MS = 5 * 60 * 1000; // wait 5min after startup so host is quiet
const GIT_PULL_TIMEOUT_MS = 30_000;
const CODEX_MARKETPLACE_UPGRADE_TIMEOUT_MS = 60_000;

// Once-per-process latch for the missing-codex-binary info line — the
// refresh runs hourly and the binary won't appear without operator action,
// so repeating it every cycle is pure log noise (223 warns before this latch).
let codexBinaryMissingLogged = false;

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
  subagents?: ReturnType<typeof syncCodexSubagents>;
  opencodeSubagents?: ReturnType<typeof syncOpenCodeSubagents>;
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
  if (results.some((r) => r.plugin === 'design-artifact-loop' && r.changed)) {
    vendorDesignArtifactLoopIfPresent();
  }
  return results;
}

/**
 * design-artifact-loop's plugin repo is the dev home; the container tree
 * carries vendored copies under container/agent-runner/src/mcp-tools/ and
 * container/skills/, both read-only bind-mounted into containers at spawn
 * (never baked into the image) — so no rebuild is needed for this to take
 * effect. This writes directly into the fork's git-tracked tree, so unlike
 * the codex/opencode mirrors above (untracked runtime caches) it does NOT
 * commit — Operator commits + pushes the result when he next reviews it.
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

/**
 * Refresh every Codex surface derived from plugin repos.
 *
 * Codex marketplaces are copied into Codex's installed plugin cache after local
 * `git pull` and after Codex's own Git marketplace checkout is upgraded. That
 * cache is bind-mounted into containers, so it is a container delivery path,
 * not a host-CLI convenience.
 *
 * Only surfaces that reach containers are refreshed here — see the note in the
 * body for why plugin skills are not mirrored to host CLI paths.
 */
export async function refreshCodexPluginSurfaces(): Promise<CodexSurfaceRefreshResult> {
  const result: CodexSurfaceRefreshResult = {};

  // NOTE: plugin SKILLS are deliberately not mirrored to host CLI paths
  // (`~/.agents/skills`, OpenCode's XDG skill dirs). `~/plugins` is the
  // container agents' plugin source; the operator installs plugins on the host
  // CLIs themselves. Container agents build their own
  // `/home/node/.agents/skills` from `/workspace/plugins` at spawn
  // (container/agent-runner/src/codex-companion-setup.ts), so these host
  // mirrors served nothing but the host's own Codex/OpenCode.
  //
  // Subagent mirrors below DO stay: they target `~/.codex*/agents`, which is
  // bind-mounted into containers, so they are a container delivery path.
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
    // ENOENT = no `codex` binary on the host PATH. This step only upgrades
    // Git-sourced codex marketplaces; the local bootstrap marketplace is
    // synced by syncCodexLocalMarketplacePluginCache below with pure file
    // ops, so a missing host binary loses nothing. Hosts that never
    // installed the codex CLI (containers carry their own) would otherwise
    // log a spurious warn every hourly cycle.
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

  // MUST run before the plugin cache is re-copied. A plugin whose upstream ships a
  // symlinked SKILL.md has a materialized REAL copy under .nanoclaw/codex-skills/;
  // that copy goes stale on `git pull`, and the cache would faithfully copy the stale
  // file. Refreshing here makes a pull propagate all the way to what Codex reads.
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
