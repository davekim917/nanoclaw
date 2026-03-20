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
import { COMMIT_DIGEST_TASK_ID } from '../commit-digest.js';
import { DAILY_TASK_ID } from '../daily-notifications.js';
import {
  countAllBacklog,
  countAllMemories,
  countAllShipLog,
  countPendingGates,
  countThreadMetadata,
  taskExistsById,
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

// --- Capabilities cache (30s TTL) ---

let cachedCapabilities: { data: Capabilities; timestamp: number } | null = null;
const CAPABILITIES_TTL_MS = 30_000;

export function getCapabilities(deps: CapabilityDeps): Capabilities {
  const now = Date.now();
  if (cachedCapabilities && now - cachedCapabilities.timestamp < CAPABILITIES_TTL_MS) {
    return cachedCapabilities.data;
  }
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

  // Activity summary / Commit digest: targeted existence check by task ID
  let activitySummaryAvailable = false;
  let commitDigestAvailable = false;
  try {
    activitySummaryAvailable = taskExistsById(DAILY_TASK_ID);
    commitDigestAvailable = taskExistsById(COMMIT_DIGEST_TASK_ID);
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

  const result: Capabilities = {
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

  cachedCapabilities = { data: result, timestamp: Date.now() };
  return result;
}
