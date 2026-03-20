/**
 * Capability discovery for the NanoClaw Web UI.
 *
 * Feature detection uses meaningful availability checks — not just table
 * existence (since createSchema() creates all tables unconditionally).
 * Checks handler registration + row counts, directory existence, and env vars.
 */
import fs from 'fs';
import path from 'path';

import { getRegisteredChannelNames } from '../channels/registry.js';
import {
  countAllBacklog,
  countAllMemories,
  countAllShipLog,
  countPendingGates,
  countThreadMetadata,
  getAllTasks,
} from '../db.js';
import type { Capabilities } from './types.js';

// Read version from package.json once at module load
let cachedVersion = '0.0.0';
try {
  const pkgPath = path.resolve(process.cwd(), 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  cachedVersion = pkg.version || '0.0.0';
} catch {
  // package.json not found — use fallback
}

export interface CapabilityDeps {
  getRegisteredGroups: () => Array<{
    jid: string;
    name: string;
    folder: string;
  }>;
}

export function getCapabilities(deps: CapabilityDeps): Capabilities {
  const groups = deps.getRegisteredGroups();

  // --- Feature detection ---

  // Memory: check if any memories exist (keyword search works even without vec)
  const memoryAvailable = countAllMemories() > 0;

  // Backlog: check if any backlog items exist
  const backlogAvailable = countAllBacklog() > 0;

  // Ship log: check if any ship log entries exist
  const shipLogAvailable = countAllShipLog() > 0;

  // Thread search: check if any thread metadata is indexed
  const threadSearchAvailable = countThreadMetadata() > 0;

  // Gate protocol: check if pending gates have ever been created
  const gateProtocolAvailable = countPendingGates() > 0;

  // Activity summary / Commit digest: look for system tasks with known identifiers
  let activitySummaryAvailable = false;
  let commitDigestAvailable = false;
  try {
    const allTasks = getAllTasks();
    for (const task of allTasks) {
      if (task.task_type === 'system') {
        if (
          task.prompt.includes('daily-notifications') ||
          task.prompt.includes('activity-summary')
        ) {
          activitySummaryAvailable = true;
        }
        if (task.prompt.includes('commit-digest')) {
          commitDigestAvailable = true;
        }
      }
    }
  } catch {
    // DB not initialized
  }

  // Tone profiles: check directory existence + .md files
  let toneProfilesAvailable = false;
  try {
    const toneDir = path.resolve(process.cwd(), 'tone-profiles');
    if (fs.existsSync(toneDir)) {
      const files = fs.readdirSync(toneDir);
      toneProfilesAvailable = files.some((f) => f.endsWith('.md'));
    }
  } catch {
    // Directory doesn't exist
  }

  // Ollama: env var check
  const ollamaAvailable = !!(
    process.env.OLLAMA_HOST && process.env.OLLAMA_HOST.trim()
  );

  return {
    version: cachedVersion,
    features: {
      memory: memoryAvailable,
      backlog: backlogAvailable,
      ship_log: shipLogAvailable,
      thread_search: threadSearchAvailable,
      tone_profiles: toneProfilesAvailable,
      gate_protocol: gateProtocolAvailable,
      activity_summary: activitySummaryAvailable,
      commit_digest: commitDigestAvailable,
      ollama: ollamaAvailable,
    },
    channels: getRegisteredChannelNames(),
    groups,
  };
}
