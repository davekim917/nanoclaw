/**
 * What a shadow host (`NANOCLAW_SHADOW=1`, see shadow-host.ts) may run and
 * read. Every list is an ALLOWLIST: a name missing from it, including one
 * added to the codebase later, is off on a shadow. Each registry that starts
 * work, and each reader of configuration, consults exactly one list at the
 * point where it dispatches:
 *
 *   environment        index.ts (process env, before the app loads), env-file.ts, env.ts, main.ts loadEnvIntoProcess
 *   host-module starts shadow-host.ts startShadowHostModules (by start callback name)
 *   adapter-ready      delivery.ts onDeliveryAdapterReady (by callback name)
 *   sweep duties       host-sweep.ts (duties, SLA hooks and kill follow-ups, by name)
 *   channel adapters   channels/channel-registry.ts startRegisteredChannelAdapter
 *   agent providers    shadow-host.ts shadowProviderViolation, at spawn
 *   ncl commands       cli/dispatch.ts
 *   delivery actions   delivery.ts, the action a container asks the host to run
 *   approval handlers  modules/approvals/primitive.ts getApprovalHandler
 *
 * Adding a name is a claim that it acts only on this checkout's own data,
 * sessions and containers. Anything reaching state the two hosts share — the
 * OneCLI approval queue and secrets, the image store, `~/plugins`, host files
 * outside the checkout, a chat platform, GitHub, a model API — stays off.
 *
 * Node builtins only (through shadow-flag.ts): index.ts and env-file.ts
 * import this before the application module graph loads.
 */
import { isShadowProcess } from './shadow-flag.js';

/**
 * Environment keys a shadow can see, from the process environment or `.env`:
 * what the OS, node and docker need, plus the non-credential configuration a
 * shadow needs to boot and run a CLI turn. `ONECLI_API_KEY` is the one
 * credential: spawning needs the gateway, and the OneCLI seams themselves are
 * guarded in shadow-host.ts. The proxy keys are left out on purpose: they are
 * how host-side code reaches the OneCLI proxy that injects credentials, so
 * without them every host-side credentialed call fails closed. Containers get
 * their proxy from OneCLI at spawn, not from the host environment.
 */
const SHADOW_ENV_KEYS: ReadonlySet<string> = new Set([
  // OS, node, docker, systemd
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'PWD',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'TZ',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'NODE_ENV',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'INVOCATION_ID',
  'JOURNAL_STREAM',
  // NanoClaw
  'NANOCLAW_SHADOW',
  'WEBHOOK_PORT',
  'LOG_LEVEL',
  'ASSISTANT_NAME',
  'DEFAULT_AGENT_PROVIDER',
  'ONECLI_URL',
  'ONECLI_API_KEY',
  'ONECLI_GATEWAY_CONTAINER',
  'CONTAINER_IMAGE',
  'CONTAINER_IMAGE_BASE',
  'CONTAINER_TIMEOUT',
  'CONTAINER_MAX_OUTPUT_SIZE',
  'CONTAINER_MEMORY_BUDGET',
  'CONTAINER_MEMORY_LIMIT',
  'CONTAINER_MEMORY_RESERVATION',
  'CONTAINER_MEMORY_SWAP_LIMIT',
  'CONTAINER_CPU_LIMIT',
  'CONTAINER_CPU_SHARES',
  'CONTAINER_PIDS_LIMIT',
  'MAX_CONCURRENT_CONTAINERS',
  'MAX_MESSAGES_PER_PROMPT',
  'IDLE_TIMEOUT',
  'PENDING_MESSAGE_MAX_AGE_HOURS',
  'SESSION_ARTIFACT_IDLE_HOURS',
  'NANOCLAW_TASK_SCRIPT_TIMEOUT_MS',
  'NANOCLAW_WORKGROUP_SHARED_FS',
  'NANOCLAW_EGRESS_NETWORK',
  'NANOCLAW_EGRESS_LOCKDOWN',
  'NANOCLAW_DEPENDENCY_CACHE',
  'NANOCLAW_DASHBOARD_SESSION_TTL_HOURS',
]);

/**
 * Host-module start callbacks (`onHostStart(function <name>() …)`) a shadow
 * runs. None: every one registered today reaches shared state (plugin
 * sources, a chat platform, GitHub) or is housekeeping a short-lived shadow
 * does not need.
 */
export const SHADOW_HOST_MODULES: ReadonlySet<string> = new Set<string>();

/**
 * Delivery-adapter-ready callbacks a shadow runs. None: the only one today
 * starts the OneCLI approval handler, which polls a queue production shares.
 */
const SHADOW_ADAPTER_READY: ReadonlySet<string> = new Set<string>();

/**
 * Host-sweep duties, SLA observation hooks and kill follow-ups a shadow runs:
 * the per-session work (claims, wakes, container health and its notices,
 * recurrence, GC) and the housekeeping that prunes or reconciles this
 * checkout's own databases. Off: token refresh (GitHub, MCP OAuth), image and
 * disk cleanup, egress-network repair, wiki recovery, the orchestrator
 * reconciler, claims reconciliation against GitHub, approval sweeps, task
 * auto-archive, promise watch, and the title duties that call a model or a
 * chat platform.
 */
export const SHADOW_SWEEP_DUTIES: ReadonlySet<string> = new Set([
  'processing-ack-sync',
  'stale-pending-expiry',
  'pre-wake-orphan-claim-reset',
  'due-wake-admission',
  'done-proposal-mirror',
  'continuation-read',
  'continuation-recovery-parking',
  'continuation-wake-eligibility',
  'container-wake',
  'ceiling-kill-accountability',
  'provider-self-heal',
  'idle-task-reap',
  'idle-chat-reap',
  'running-container-sla',
  'kill-ceiling-notice',
  'container-oom-notice',
  'orphan-claim-reset',
  'recurrence-fanout',
  'spent-task-session-gc',
  'thread-close-advance',
  'steer-idempotency-prune',
  'channel-ingress-receipt-prune',
  'scheduled-move-recovery',
  'audit-body-prune',
  'dashboard-token-prune',
  'usage-rollup',
  'orphaned-repo-fence-release',
  'cli-request-execution-prune',
  'task-failure-escalation',
  'coordination-orphans',
]);

/** Channel adapters a shadow starts: the CLI channel is its only transport. */
export const SHADOW_CHANNELS: ReadonlySet<string> = new Set(['cli']);

/**
 * Agent providers a shadow spawns. Codex and OpenCode sessions mount host
 * credential homes read-write.
 */
const SHADOW_PROVIDERS: ReadonlySet<string> = new Set(['claude']);

/**
 * `ncl` commands a shadow serves, to the operator and to its own agents. Off:
 * `integrations-*` (OneCLI secret writes, OAuth token rotation),
 * `repositories-*` (repository publication), `slack-workspaces-*` (platform
 * tokens), `storage-*` (the shared image store), package changes (image
 * builds), and the host mounts, owner notifications, parity checks and task
 * moves a verification run does not need.
 */
export const SHADOW_CLI_COMMANDS: ReadonlySet<string> = new Set([
  'help',
  'approvals-approve',
  'approvals-get',
  'approvals-help',
  'approvals-list',
  'approvals-reject',
  'denied-models-add',
  'denied-models-get',
  'denied-models-help',
  'denied-models-list',
  'denied-models-list-by-provider',
  'denied-models-remove',
  'destinations-add',
  'destinations-help',
  'destinations-list',
  'destinations-remove',
  'dropped-messages-help',
  'dropped-messages-list',
  'groups-config-add-mcp-server',
  'groups-config-get',
  'groups-config-remove-mcp-server',
  'groups-config-update',
  'groups-create',
  'groups-delete',
  'groups-get',
  'groups-help',
  'groups-list',
  'groups-restart',
  'groups-update',
  'members-add',
  'members-help',
  'members-list',
  'members-remove',
  'messaging-groups-create',
  'messaging-groups-delete',
  'messaging-groups-get',
  'messaging-groups-help',
  'messaging-groups-list',
  'messaging-groups-send',
  'messaging-groups-update',
  'policies-help',
  'policies-list',
  'policies-remove',
  'policies-set',
  'roles-grant',
  'roles-help',
  'roles-list',
  'roles-revoke',
  'sessions-get',
  'sessions-help',
  'sessions-list',
  'tasks-append-log',
  'tasks-cancel',
  'tasks-create',
  'tasks-delete',
  'tasks-dispatch',
  'tasks-get',
  'tasks-help',
  'tasks-list',
  'tasks-pause',
  'tasks-resume',
  'tasks-run',
  'tasks-update',
  'usage-help',
  'usage-list',
  'usage-summary',
  'user-dms-help',
  'user-dms-list',
  'users-create',
  'users-get',
  'users-help',
  'users-list',
  'users-update',
  'wirings-create',
  'wirings-delete',
  'wirings-get',
  'wirings-help',
  'wirings-list',
  'wirings-update',
]);

/**
 * System actions a shadow's containers may ask the host to run. Off: remote
 * control (a host `claude` process under the operator's login), support
 * tickets, repository publication, wiki admission, the backlog, and
 * `install_packages` (an image build).
 */
export const SHADOW_DELIVERY_ACTIONS: ReadonlySet<string> = new Set([
  'turn_end',
  'cli_request',
  'grant_access',
  'revoke_access',
  'list_access',
  'spawn_task',
  'spawn_complete',
  'spawn_failed',
  'spawn_cancel',
  'spawn_progress',
  'spawn_request_steer',
  'set_channel_model',
  'set_channel_effort',
  'schedule_wake',
  'create_agent',
  'provider_unavailable',
  'provider_retry_primary',
  'request_choice',
  'request_bash_gate',
  'request_destructive_gate',
  'escalate_to_owner',
  'add_mcp_server',
  'change_model',
]);

/**
 * Approved actions a shadow replays. A shadow's database can start as a copy
 * of production's, pending approval rows included, so the replay registry is
 * gated as well as the requests that create rows.
 */
export const SHADOW_APPROVAL_ACTIONS: ReadonlySet<string> = new Set([
  'cli_command',
  'create_agent',
  'a2a_message_gate',
  'bash-gate',
  'destructive-gate',
  'owner_escalation',
  'add_mcp_server',
  'change_model',
]);

function allows(list: ReadonlySet<string>, name: string): boolean {
  return !isShadowProcess() || list.has(name);
}

export const shadowMayReadEnvKey = (key: string): boolean => allows(SHADOW_ENV_KEYS, key);
export const shadowMayStartHostModule = (name: string): boolean => allows(SHADOW_HOST_MODULES, name);
export const shadowMayRunAdapterReady = (name: string): boolean => allows(SHADOW_ADAPTER_READY, name);
export const shadowMayRunSweepDuty = (name: string): boolean => allows(SHADOW_SWEEP_DUTIES, name);
export const shadowMayStartChannel = (name: string): boolean => allows(SHADOW_CHANNELS, name);
export const shadowMayRunProvider = (name: string): boolean => allows(SHADOW_PROVIDERS, name);
export const shadowMayRunCliCommand = (name: string): boolean => allows(SHADOW_CLI_COMMANDS, name);
export const shadowMayRunDeliveryAction = (name: string): boolean => allows(SHADOW_DELIVERY_ACTIONS, name);
export const shadowMayReplayApproval = (name: string): boolean => allows(SHADOW_APPROVAL_ACTIONS, name);

let scrubbedEnvKeys: string[] = [];
let processEnvScrubbed = false;

/**
 * On a shadow, delete every process-environment key outside the allowlist, so
 * code that reads `process.env` directly, and every child process, sees only
 * allowlisted keys. Runs from the entry shim before the application loads:
 * modules capture environment values at import.
 */
export function scrubShadowProcessEnv(): void {
  if (!isShadowProcess()) return;
  const removed = Object.keys(process.env).filter((key) => !SHADOW_ENV_KEYS.has(key));
  for (const key of removed) delete process.env[key];
  scrubbedEnvKeys = removed.sort();
  processEnvScrubbed = true;
}

/**
 * Whether the entry shim scrubbed this process's environment. A shadow started
 * straight from src/main.ts skips the shim, and modules have already captured
 * whatever the environment held, so boot refuses it.
 */
export function shadowProcessEnvScrubbed(): boolean {
  return processEnvScrubbed;
}

/** The names `scrubShadowProcessEnv` removed, for the boot log (never values). */
export function scrubbedShadowEnvKeys(): readonly string[] {
  return scrubbedEnvKeys;
}
