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
  'CONTAINER_CPU_LIMIT',
  'CONTAINER_MEMORY_LIMIT',
  'CONTAINER_MEMORY_RESERVATION',
  'CONTAINER_MEMORY_SWAP_LIMIT',
  'CONTAINER_MEMORY_BUDGET',
  'CONTAINER_PIDS_LIMIT',
  'MAX_CONCURRENT_CONTAINERS',
  'NANOCLAW_EGRESS_LOCKDOWN',
  'NANOCLAW_EGRESS_NETWORK',
  'ONECLI_GATEWAY_CONTAINER',
]);

/**
 * @deprecated WhatsApp adapter copies now read the ASSISTANT_NAME .env key
 * directly. Re-export retained one release for stale adapter copies
 * (origin/channels whatsapp.ts:42 imports it); scheduled for deletion.
 */
export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
/**
 * @deprecated WhatsApp adapter copies now read the ASSISTANT_HAS_OWN_NUMBER
 * .env key directly. Re-export retained one release for stale adapter copies
 * (origin/channels whatsapp.ts:42 imports it); scheduled for deletion.
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
export const REPO_ROOT = PROJECT_ROOT;

// Feature flag: when '1', workgroup members share a dedicated
// `data/workgroups/<workgroup_id>/` directory bind-mounted at
// `/workspace/workgroup`, and a startup migration consolidates the seed
// sibling's shared dirs there. Default OFF — the live-data migration only
// runs, and the container mount only changes, when explicitly enabled.
// See docs/specs/workgroup-shared-fs.md.
// Honor the real environment (takes precedence) AND .env. These config consts
// are captured at import time — BEFORE index.ts's loadEnvIntoProcess() runs — so
// a value present only in .env must come through envConfig (readEnvFile), not
// process.env, or the flag silently reads false. See docs/specs/workgroup-shared-fs.md.
export const WORKGROUP_SHARED_FS =
  (process.env.NANOCLAW_WORKGROUP_SHARED_FS ?? envConfig.NANOCLAW_WORKGROUP_SHARED_FS) === '1';
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
export const CONTAINER_INSTALL_LABEL = `nanoclaw-install=${INSTALL_SLUG}`;
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760', 10); // 10MB default
export const CONTAINER_MEMORY_LIMIT = process.env.CONTAINER_MEMORY_LIMIT || envConfig.CONTAINER_MEMORY_LIMIT || '3g';
export const CONTAINER_MEMORY_RESERVATION =
  process.env.CONTAINER_MEMORY_RESERVATION || envConfig.CONTAINER_MEMORY_RESERVATION || CONTAINER_MEMORY_LIMIT;
export const CONTAINER_MEMORY_SWAP_LIMIT =
  process.env.CONTAINER_MEMORY_SWAP_LIMIT || envConfig.CONTAINER_MEMORY_SWAP_LIMIT || CONTAINER_MEMORY_LIMIT;
export const CONTAINER_MEMORY_BUDGET = process.env.CONTAINER_MEMORY_BUDGET || envConfig.CONTAINER_MEMORY_BUDGET || '';
export const CONTAINER_PIDS_LIMIT = Math.max(
  1,
  parseInt(process.env.CONTAINER_PIDS_LIMIT || envConfig.CONTAINER_PIDS_LIMIT || '512', 10) || 512,
);
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const ONECLI_API_KEY = process.env.ONECLI_API_KEY || envConfig.ONECLI_API_KEY;
export const MAX_MESSAGES_PER_PROMPT = Math.max(1, parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10);
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
// Host-level admission cap. 0 disables the cap entirely; Docker memory/PID
// limits still bound each individual agent container.
const parsedMaxConcurrentContainers = parseInt(
  process.env.MAX_CONCURRENT_CONTAINERS || envConfig.MAX_CONCURRENT_CONTAINERS || '24',
  10,
);
export const MAX_CONCURRENT_CONTAINERS =
  Number.isFinite(parsedMaxConcurrentContainers) && parsedMaxConcurrentContainers >= 0
    ? parsedMaxConcurrentContainers
    : 24;
// Per-container CPU cap, passed through to `docker run`. Default empty =
// no flag added (memory/pids limits above already bound each container).
// Operators opt in: CONTAINER_CPU_LIMIT=2.
export const CONTAINER_CPU_LIMIT = process.env.CONTAINER_CPU_LIMIT || envConfig.CONTAINER_CPU_LIMIT || '';

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
