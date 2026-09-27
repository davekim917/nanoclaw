import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { getContainerImageBase, getDefaultContainerImage, getInstallSlug } from './install-slug.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'ONECLI_API_KEY',
  'TZ',
  'NANOCLAW_WORKGROUP_SHARED_FS',
  'NANOCLAW_SELF_HEAL',
  'NANOCLAW_SELF_HEAL_TAKEOVER',
  'NANOCLAW_TASK_LIST',
  'CONTAINER_CPU_LIMIT',
  'CONTAINER_CPU_SHARES',
  'CONTAINER_MEMORY_LIMIT',
  'CONTAINER_MEMORY_RESERVATION',
  'CONTAINER_MEMORY_SWAP_LIMIT',
  'CONTAINER_MEMORY_BUDGET',
  'CONTAINER_PIDS_LIMIT',
  'MAX_CONCURRENT_CONTAINERS',
  'NANOCLAW_EGRESS_LOCKDOWN',
  'NANOCLAW_EGRESS_NETWORK',
  'NANOCLAW_TASK_SCRIPT_TIMEOUT_MS',
  'NANOCLAW_REPOSITORY_QUIESCE_TIMEOUT_MS',
  'ONECLI_GATEWAY_CONTAINER',
]);

/**
 * @deprecated WhatsApp adapter copies now read the ASSISTANT_NAME .env key
 * directly. Re-export retained one release for stale adapter copies
 * (the `channels` branch's whatsapp.ts imports it); scheduled for deletion.
 */
export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';

// Instance-wide default agent provider for newly created groups. `claude` (the
// built-in provider) when unset, so existing installs are unaffected on upgrade.
// Applied only at group-creation time (stamped onto the config row) — never in
// provider resolution — so existing groups are never retroactively flipped.
// Per-group `ncl groups config update --provider` still overrides it.
export const DEFAULT_AGENT_PROVIDER = (
  process.env.DEFAULT_AGENT_PROVIDER ||
  envConfig.DEFAULT_AGENT_PROVIDER ||
  'claude'
).toLowerCase();

/**
 * @deprecated WhatsApp adapter copies now read the ASSISTANT_HAS_OWN_NUMBER
 * .env key directly. Re-export retained one release for stale adapter copies
 * (the `channels` branch's whatsapp.ts imports it); scheduled for deletion.
 */
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'mount-allowlist.json');
export const SENDER_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'sender-allowlist.json');
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const CENTRAL_DB_PATH = path.join(DATA_DIR, 'v2.db');
export const REPO_ROOT = PROJECT_ROOT;

// These consts are captured at import time, before index.ts's loadEnvIntoProcess() runs, so a value present
// only in .env must come through envConfig, not process.env, or the flag silently reads false.
export const WORKGROUP_SHARED_FS =
  (process.env.NANOCLAW_WORKGROUP_SHARED_FS ?? envConfig.NANOCLAW_WORKGROUP_SHARED_FS) === '1';
// Detection and the `self-heal: would …` log always run; kills, respawns and chat notices need the flag.
export const SELF_HEAL_ENABLED = (process.env.NANOCLAW_SELF_HEAL ?? envConfig.NANOCLAW_SELF_HEAL) === '1';
// Arms only the stale-claim takeover rung; both this and SELF_HEAL_ENABLED must be '1'. Separate because a
// misfire hands one agent's claim to another with no human in the loop.
export const SELF_HEAL_TAKEOVER_ENABLED =
  (process.env.NANOCLAW_SELF_HEAL_TAKEOVER ?? envConfig.NANOCLAW_SELF_HEAL_TAKEOVER) === '1';
// Default on; `0` is the fleet-wide off switch. Read at host start to gate delivery (reaches adopted
// containers too) and at spawn to decide whether the container gets update_task_list.
export const TASK_LIST_ENABLED = (process.env.NANOCLAW_TASK_LIST ?? envConfig.NANOCLAW_TASK_LIST) !== '0';
export const TASK_SCRIPT_TIMEOUT_MS = parseTimeoutMs(
  process.env.NANOCLAW_TASK_SCRIPT_TIMEOUT_MS ?? envConfig.NANOCLAW_TASK_SCRIPT_TIMEOUT_MS,
);
// How long a repository publish/transfer waits for sibling containers to reach the mount barrier before
// killing them. Longer than the 120s default because these jobs run detached from the delivery drain.
export const REPOSITORY_MOUNT_QUIESCENCE_TIMEOUT_MS = parseTimeoutMs(
  process.env.NANOCLAW_REPOSITORY_QUIESCE_TIMEOUT_MS ?? envConfig.NANOCLAW_REPOSITORY_QUIESCE_TIMEOUT_MS,
  600_000,
  30 * 60_000,
);
function parseTimeoutMs(raw: string | undefined, fallbackMs = 120_000, maxMs = 600_000): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  // Clamp: an operator typo would stall the sequential sweep loop for hours per due script.
  return Math.min(parsed, maxMs);
}
// Local agent-template library. Committed but ships empty (+ README). Resolved
// once at load. Override to another LOCAL path via NANOCLAW_TEMPLATES_DIR; never
// a remote URL, never an ncl flag, never runtime-mutable.
export const TEMPLATES_DIR = process.env.NANOCLAW_TEMPLATES_DIR
  ? path.resolve(process.env.NANOCLAW_TEMPLATES_DIR)
  : path.resolve(PROJECT_ROOT, 'templates');

// Per-checkout image tag so two installs on the same host don't share
// `nanoclaw-agent:latest` and clobber each other on rebuild.
export const CONTAINER_IMAGE_BASE = process.env.CONTAINER_IMAGE_BASE || getContainerImageBase(PROJECT_ROOT);
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || getDefaultContainerImage(PROJECT_ROOT);
// Install slug — stamped onto every spawned container via --label so
// cleanupOrphans only reaps containers from this install, not peers.
export const INSTALL_SLUG = getInstallSlug(PROJECT_ROOT);
/** 3x the 30 s renewal interval. Lives here because container-runner.ts needs it and must not import main.ts. */
export const HOST_LEASE_TTL_MS = 90_000;
export const CONTAINER_INSTALL_LABEL = `nanoclaw-install=${INSTALL_SLUG}`;
// Deliberately not upstream's `ncl-…`: the snapshot pruner selects live containers by this name prefix, so a
// rename would make it delete snapshots a running container still has bind-mounted. Keep until it selects by label.
export const CONTAINER_NAME_PREFIX = 'nanoclaw-v2-';
export const CONTAINER_GROUP_LABEL_KEY = 'nanoclaw-group';
export const CONTAINER_SESSION_LABEL_KEY = 'nanoclaw-session';
export const CONTAINER_WORKGROUP_LABEL_KEY = 'nanoclaw-workgroup';
export const CONTAINER_ROLE_LABEL_KEY = 'nanoclaw-role';
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760', 10);
export const CONTAINER_MEMORY_LIMIT = process.env.CONTAINER_MEMORY_LIMIT || envConfig.CONTAINER_MEMORY_LIMIT || '3g';
export const CONTAINER_MEMORY_RESERVATION =
  process.env.CONTAINER_MEMORY_RESERVATION || envConfig.CONTAINER_MEMORY_RESERVATION || CONTAINER_MEMORY_LIMIT;
export const CONTAINER_MEMORY_SWAP_LIMIT =
  process.env.CONTAINER_MEMORY_SWAP_LIMIT || envConfig.CONTAINER_MEMORY_SWAP_LIMIT || CONTAINER_MEMORY_LIMIT;
export const CONTAINER_MEMORY_BUDGET = process.env.CONTAINER_MEMORY_BUDGET || envConfig.CONTAINER_MEMORY_BUDGET || '';
// Codex gives every native subagent its own MCP process tree, so a coordinator with five workers needs over 512.
export const DEFAULT_CONTAINER_PIDS_LIMIT = 1024;
export const CONTAINER_PIDS_LIMIT = Math.max(
  1,
  parseInt(
    process.env.CONTAINER_PIDS_LIMIT || envConfig.CONTAINER_PIDS_LIMIT || String(DEFAULT_CONTAINER_PIDS_LIMIT),
    10,
  ) || DEFAULT_CONTAINER_PIDS_LIMIT,
);
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const ONECLI_API_KEY = process.env.ONECLI_API_KEY || envConfig.ONECLI_API_KEY;
export const MAX_MESSAGES_PER_PROMPT = Math.max(1, parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10);
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
// 0 disables the host-level admission cap.
const parsedMaxConcurrentContainers = parseInt(
  process.env.MAX_CONCURRENT_CONTAINERS || envConfig.MAX_CONCURRENT_CONTAINERS || '24',
  10,
);
export const MAX_CONCURRENT_CONTAINERS =
  Number.isFinite(parsedMaxConcurrentContainers) && parsedMaxConcurrentContainers >= 0
    ? parsedMaxConcurrentContainers
    : 24;
// Empty = no `--cpus` flag.
export const CONTAINER_CPU_LIMIT = process.env.CONTAINER_CPU_LIMIT || envConfig.CONTAINER_CPU_LIMIT || '';
// `--cpu-shares` weight: a relative share of contended CPU, not a ceiling. Empty = no flag.
export const CONTAINER_CPU_SHARES = process.env.CONTAINER_CPU_SHARES || envConfig.CONTAINER_CPU_SHARES || '';

// Egress lockdown — force all agent traffic through the OneCLI gateway on a
// no-internet Docker network. Off by default; consumed by src/egress-lockdown.ts.
export const EGRESS_LOCKDOWN = (process.env.NANOCLAW_EGRESS_LOCKDOWN || envConfig.NANOCLAW_EGRESS_LOCKDOWN) === 'true';
export const EGRESS_NETWORK =
  process.env.NANOCLAW_EGRESS_NETWORK || envConfig.NANOCLAW_EGRESS_NETWORK || 'nanoclaw-egress';
export const ONECLI_GATEWAY_CONTAINER =
  process.env.ONECLI_GATEWAY_CONTAINER || envConfig.ONECLI_GATEWAY_CONTAINER || 'onecli';

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [process.env.TZ, envConfig.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
