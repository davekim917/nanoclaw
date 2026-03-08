import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'RESIDENTIAL_PROXY_URL',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Default model for the agent container. Per-group overrides live in
// ContainerConfig.model; per-message overrides via "use opus/sonnet/haiku".
export const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'claude-sonnet-4-6';

// Map short aliases to full model IDs
export const MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

// Pattern to detect "use <model>" in a message (e.g., "use opus to research X")
export const MODEL_OVERRIDE_PATTERN = /\buse\s+(opus|sonnet|haiku)\b/i;

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

/** Build a trigger pattern for a specific assistant name. */
export function buildTriggerPattern(name: string): RegExp {
  return new RegExp(`^@${escapeRegex(name)}\\b`, 'i');
}

/** Resolve per-group assistant name, falling back to global default. */
export function resolveAssistantName(containerConfig?: {
  assistantName?: string;
}): string {
  return containerConfig?.assistantName || ASSISTANT_NAME;
}

// External Claude Code plugin directory (e.g. davekim917/bootstrap)
// Skills and agents are synced into each group's .claude/ before container runs
export const PLUGIN_DIR =
  process.env.PLUGIN_DIR || path.join(HOME_DIR, 'bootstrap');

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Residential proxy for browser automation (bypasses datacenter IP geo-fencing)
export const RESIDENTIAL_PROXY_URL =
  process.env.RESIDENTIAL_PROXY_URL || envConfig.RESIDENTIAL_PROXY_URL;
