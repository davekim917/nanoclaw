import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { CronExpressionParser } from 'cron-parser';

import { PLUGINS_DIR } from './config.js';
import { createTask, getTaskById, updateTask } from './db.js';
import { logger } from './logger.js';
import { registerSystemTaskHandler } from './task-scheduler.js';

const execFileAsync = promisify(execFile);

const PLUGIN_UPDATE_CRON = process.env.PLUGIN_UPDATE_CRON || '0 * * * *';
const PLUGIN_UPDATE_TZ = process.env.PLUGIN_UPDATE_TZ || 'UTC';

export const PLUGIN_UPDATER_TASK_ID = '__plugin_updater';

export interface PluginUpdaterDeps {
  notifyJid: string | null;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

function computeNextRun(): string {
  const interval = CronExpressionParser.parse(PLUGIN_UPDATE_CRON, {
    tz: PLUGIN_UPDATE_TZ,
  });
  return interval.next().toDate().toISOString();
}

/**
 * Idempotent: ensures the plugin updater task row exists in scheduled_tasks.
 * If the row already exists, leaves it untouched (preserving next_run for catch-up).
 * If the cron expression has changed (env var updated), updates schedule_value and recomputes next_run.
 */
export function ensurePluginUpdaterTask(): void {
  const existing = getTaskById(PLUGIN_UPDATER_TASK_ID);
  if (existing) {
    const updates: Parameters<typeof updateTask>[1] = {};
    let nextRun = existing.next_run;

    if (existing.schedule_value !== PLUGIN_UPDATE_CRON) {
      updates.schedule_value = PLUGIN_UPDATE_CRON;
    }
    if (existing.schedule_tz !== PLUGIN_UPDATE_TZ) {
      updates.schedule_tz = PLUGIN_UPDATE_TZ;
    }
    if (updates.schedule_value || updates.schedule_tz) {
      nextRun = computeNextRun();
      updates.next_run = nextRun;
    }
    if (existing.status !== 'active') {
      updates.status = 'active';
    }
    if (Object.keys(updates).length > 0) {
      updateTask(PLUGIN_UPDATER_TASK_ID, updates);
      logger.info({ updates, nextRun }, 'Plugin updater task updated');
    } else {
      logger.info(
        { nextRun, cron: PLUGIN_UPDATE_CRON },
        'Plugin updater task exists',
      );
    }
    return;
  }

  const nextRun = computeNextRun();
  createTask({
    id: PLUGIN_UPDATER_TASK_ID,
    group_folder: '__system',
    chat_jid: '__system',
    prompt: 'Plugin updater (system task)',
    schedule_type: 'cron',
    schedule_value: PLUGIN_UPDATE_CRON,
    context_mode: 'isolated',
    task_type: 'system',
    schedule_tz: PLUGIN_UPDATE_TZ,
    next_run: nextRun,
    status: 'active',
    created_at: new Date().toISOString(),
  });
  logger.info(
    { nextRun, cron: PLUGIN_UPDATE_CRON },
    'Plugin updater task created',
  );
}

/**
 * Register the plugin updater handler with the task scheduler.
 * Must be called before startSchedulerLoop().
 *
 * Runs git pull --ff-only on every git repo in PLUGINS_DIR.
 * If any repos were updated and notifyJid is set, posts a summary to that channel.
 * No-ops (already up to date) are silently skipped.
 */
export function registerPluginUpdaterHandler(deps: PluginUpdaterDeps): void {
  registerSystemTaskHandler(PLUGIN_UPDATER_TASK_ID, async () => {
    if (!fs.existsSync(PLUGINS_DIR)) {
      logger.warn({ dir: PLUGINS_DIR }, 'Plugins directory not found, skipping update');
      return;
    }

    const entries = fs.readdirSync(PLUGINS_DIR).filter((e) => {
      try {
        return fs.statSync(path.join(PLUGINS_DIR, e)).isDirectory();
      } catch {
        return false;
      }
    });

    const updated: string[] = [];
    const failed: string[] = [];

    for (const entry of entries) {
      const pluginPath = path.join(PLUGINS_DIR, entry);
      if (!fs.existsSync(path.join(pluginPath, '.git'))) continue;

      try {
        const { stdout } = await execFileAsync('git', ['pull', '--ff-only'], {
          cwd: pluginPath,
          timeout: 30_000,
          encoding: 'utf-8',
        });
        if (!stdout.includes('Already up to date.')) {
          updated.push(entry);
          logger.info({ plugin: entry, output: stdout.trim() }, 'Plugin updated');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push(entry);
        logger.error({ plugin: entry, error: message }, 'Plugin update failed');
      }
    }

    if ((updated.length === 0 && failed.length === 0) || !deps.notifyJid) return;

    const parts: string[] = [];
    if (updated.length > 0) parts.push(`Updated: ${updated.join(', ')}`);
    if (failed.length > 0) parts.push(`Failed: ${failed.join(', ')}`);
    await deps.sendMessage(deps.notifyJid, `Plugin update: ${parts.join(' | ')}`);
  });
}
