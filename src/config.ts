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
// Feature flag: when '1', the host sweep ACTS on its self-heal detections
// (wedged-tool accountability wakes, failed-provider respawns). Default OFF —
// detection and the `self-heal: would …` log line always run; kills, respawns,
// and chat notices need the flag. Same env-then-.env read as
// WORKGROUP_SHARED_FS above, and for the same reason: these consts are captured
// at import time, before index.ts calls loadEnvIntoProcess().
export const SELF_HEAL_ENABLED = (process.env.NANOCLAW_SELF_HEAL ?? envConfig.NANOCLAW_SELF_HEAL) === '1';
// Feature flag: arms ONLY the stale-claim ladder's last rung — a sibling agent
// group being handed another agent's abandoned claim. Deliberately independent
// of SELF_HEAL_ENABLED (both must be '1' for a takeover to fire): it is the one
// self-heal action where an agent takes work from another agent with no human
// in the loop, and a misfire recreates the duplicate work claims exist to
// prevent. Nudges prove themselves first. See modules/claims/self-heal.ts.
export const SELF_HEAL_TAKEOVER_ENABLED =
  (process.env.NANOCLAW_SELF_HEAL_TAKEOVER ?? envConfig.NANOCLAW_SELF_HEAL_TAKEOVER) === '1';
// Live task list (docs/specs/slack-task-list/plan.md). Default ON; `0` is the
// fleet-wide off switch. The host reads it twice: here, at host start, to gate
// delivery (task_list rows dropped, 💭 status posts back) — which reaches even
// adopted containers — and at spawn, where it decides whether the container gets
// the update_task_list tool (`NANOCLAW_TASK_LIST=1`). Same env-then-.env read as
// SELF_HEAL_ENABLED, for the same import-time reason.
export const TASK_LIST_ENABLED = (process.env.NANOCLAW_TASK_LIST ?? envConfig.NANOCLAW_TASK_LIST) !== '0';
// Pre-task script timeout in ms, shared by the host path (host-script.ts) and
// forwarded into containers for the container path (task-script.ts). Read via
// env-then-.env for the same import-order reason as the flags above.
export const TASK_SCRIPT_TIMEOUT_MS = parseTimeoutMs(
  process.env.NANOCLAW_TASK_SCRIPT_TIMEOUT_MS ?? envConfig.NANOCLAW_TASK_SCRIPT_TIMEOUT_MS,
);
// How long a repository publish/transfer waits for every sibling container in
// the workgroup to reach the mount barrier before it kills them
// (`quiesceSessionsForRepositoryMounts`). Ten minutes, not the 120s default
// that still applies to every other caller: the repository actions run detached
// from the serial delivery drain (modules/repository-workspaces/job-runner.ts),
// so a long wait costs the publishing workgroup patience instead of freezing
// outbound delivery for the whole fleet. Same env-then-.env read as the flags
// above, for the same import-order reason.
export const REPOSITORY_MOUNT_QUIESCENCE_TIMEOUT_MS = parseTimeoutMs(
  process.env.NANOCLAW_REPOSITORY_QUIESCE_TIMEOUT_MS ?? envConfig.NANOCLAW_REPOSITORY_QUIESCE_TIMEOUT_MS,
  600_000,
  30 * 60_000,
);
function parseTimeoutMs(raw: string | undefined, fallbackMs = 120_000, maxMs = 600_000): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  // Clamp: an operator typo of 120000000 ms would stall the sequential sweep
  // loop for a day per due script. Ten minutes is already generous headroom
  // over the ~56s watcher that motivated this knob; callers that wait on a
  // whole workgroup rather than one script raise the ceiling explicitly.
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
/**
 * Lease TTL handed to `startHostInstanceLease`, logged with the §6 evidence
 * line, and used by the spawn path's late lease start, so the value operators
 * read is the one in force everywhere. 3x the 30 s renewal interval, matching
 * upstream's default (src/host-instance.ts). It lives here rather than in
 * main.ts because `src/container-runner.ts` needs the same number and must not
 * import the entrypoint.
 */
export const HOST_LEASE_TTL_MS = 90_000;
export const CONTAINER_INSTALL_LABEL = `nanoclaw-install=${INSTALL_SLUG}`;
// Container name prefix. Load-bearing, and deliberately NOT upstream's `ncl-…`
// grammar: the snapshot pruner selects live containers by
// `name=nanoclaw-v2-` (src/agent-runner-source.ts) and a successful listing
// that matches nothing returns an empty set, so renaming would make the
// pruner delete snapshots a running container still has bind-mounted. Every
// container already running on an install carries this prefix too. A later
// upstream port will propose the rename again; the answer stays no until the
// pruner selects by label instead. One constant, two importers
// (src/container-runner.ts, src/agent-runner-source.ts) so the two cannot
// drift — pinned by src/container-labels.test.ts.
export const CONTAINER_NAME_PREFIX = 'nanoclaw-v2-';
// Scope labels stamped onto every spawned container beside the install label.
// Metadata only until the boot-quiescence door reads them to compute its
// scoped stop set from the container runtime rather than from the in-process
// registry, which is empty at boot.
export const CONTAINER_GROUP_LABEL_KEY = 'nanoclaw-group';
export const CONTAINER_SESSION_LABEL_KEY = 'nanoclaw-session';
export const CONTAINER_WORKGROUP_LABEL_KEY = 'nanoclaw-workgroup';
export const CONTAINER_ROLE_LABEL_KEY = 'nanoclaw-role';
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760', 10); // 10MB default
export const CONTAINER_MEMORY_LIMIT = process.env.CONTAINER_MEMORY_LIMIT || envConfig.CONTAINER_MEMORY_LIMIT || '3g';
export const CONTAINER_MEMORY_RESERVATION =
  process.env.CONTAINER_MEMORY_RESERVATION || envConfig.CONTAINER_MEMORY_RESERVATION || CONTAINER_MEMORY_LIMIT;
export const CONTAINER_MEMORY_SWAP_LIMIT =
  process.env.CONTAINER_MEMORY_SWAP_LIMIT || envConfig.CONTAINER_MEMORY_SWAP_LIMIT || CONTAINER_MEMORY_LIMIT;
export const CONTAINER_MEMORY_BUDGET = process.env.CONTAINER_MEMORY_BUDGET || envConfig.CONTAINER_MEMORY_BUDGET || '';
// Codex app-server gives every native subagent its own MCP process tree. The
// previous 512 default was exhausted by one coordinator plus five workers in
// MCP-heavy groups before memory pressure was material. Keep a finite Docker
// safety boundary, but leave enough room for the provider's bounded worker
// pool and transient tool subprocesses.
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
// Per-container CPU *weight*, passed through to `docker run --cpu-shares`.
// Relative share of contended CPU, not a ceiling: an idle host still lets a
// single container burst up to CONTAINER_CPU_LIMIT, while a busy host slices
// proportionally instead of thrashing. Default empty = no flag added; Docker's
// own default is 1024, which maps to the cgroup v2 default `cpu.weight` 100,
// so leaving this unset is a true no-op. Operators opt in:
// CONTAINER_CPU_SHARES=512.
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
