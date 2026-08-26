/**
 * Container config types and access layer.
 *
 * `groups/<folder>/container.json` is the canonical source of truth for every
 * non-DB field (onecliSecrets, tools, credentialFolder, codexHostAuth,
 * dailySummary, etc.) — read by `readContainerConfig`, written by
 * `writeContainerConfig`, modified directly on disk by skills and operators.
 *
 * The `container_configs` table mirrors a subset of operationally-mutated
 * scalars (provider, model, effort, image_tag, assistant_name, skills,
 * mcp_servers, packages_apt, packages_npm, additional_mounts, cli_scope) so
 * those fields are addressable via `ncl groups config get/update` and survive
 * across container respawns. `configFromDb` reconstructs ONLY those scalars;
 * it does NOT carry the file-only fields. Any code path that writes the file
 * from DB state alone would silently drop those fields — which is why no such
 * path exists. The DB row is a read-side projection, not an authoritative
 * source for the full config.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { validateContainerResources, type ContainerResources } from './container-resources.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

/**
 * Per-MCP-server config. Stdio (default) runs a subprocess inside the
 * container; http hits a remote Streamable HTTP URL with credentials injected
 * at the HTTPS_PROXY layer by OneCLI — the container never sees the token.
 * SSE is deprecated and rejected by config validation.
 */
export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig | SseMcpServerConfig;

export interface StdioMcpServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  instructions?: string;
}

export interface HttpMcpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  // Optional always-in-context guidance; host imports into composed CLAUDE.md.
  instructions?: string;
}

export interface SseMcpServerConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
  // Optional always-in-context guidance; host imports into composed CLAUDE.md.
  instructions?: string;
}

export function validateMcpServers(servers: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  for (const [name, server] of Object.entries(servers)) {
    if (server?.type === 'sse') {
      throw new Error(
        `MCP server "${name}" uses deprecated SSE transport. Use Streamable HTTP (type: "http") instead.`,
      );
    }
  }
  return servers;
}

export interface AdditionalMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

/** Shape of the materialized `container.json` file read by the container runner. */
export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  skills: string[] | 'all';
  provider?: string;
  groupName?: string;
  assistantName?: string;
  agentGroupId?: string;
  maxMessagesPerPrompt?: number;
  /** Per-session container resource request and hard ceilings. */
  resources?: ContainerResources;

  /**
   * Provider-level model / reasoning effort tracked in the container_configs
   * DB row (upstream's 014 schema). Distinct from the per-group default*
   * fields below — those are intent ("opus" alias resolution); these are
   * what the DB row materializes for ops tooling that scopes via `ncl`.
   */
  model?: string;
  effort?: string;

  /**
   * Where to route spawns while `provider` is recorded unavailable (an
   * exhausted account, a suspended key). Opt-in per group: with no
   * declaration a provider outage still fails loudly rather than silently
   * changing which model answers a user.
   *
   * A fallback is a deliberate degradation — a different vendor means
   * different failure modes and, for adversarial roles, a loss of the
   * independence the pairing was built for. Groups that care must say so in
   * their own output; this field only keeps them running.
   */
  providerFallback?: {
    provider: string;
    model?: string;
    effort?: string;
  };

  /**
   * Per-group OneCLI secret declaration. Each entry is either a secret
   * NAME (e.g. "Datafold-ExampleRetail") or a UUID. Names resolve via
   * `onecli secrets list` at apply time. When non-empty, the host
   * forces the agent's secret mode to `selective` and assigns exactly
   * these secrets (declarative — replaces any prior assignment).
   *
   * Missing/empty/absent = no-op: agent keeps whatever assignment and
   * mode the operator set via the UI or CLI. Use this when you want a
   * group to have access to only a specific subset of vault secrets
   * (e.g. `example-retail` should not see `Example Labs-*` keys).
   *
   * Hard-fails the container spawn if any declared name doesn't resolve
   * to a vault secret — matches the codebase's fail-closed posture so
   * misconfigurations are loud rather than silently broken.
   */
  onecliSecrets?: string[];

  /**
   * Name of the env var on the host that holds this group's GitHub token.
   * If unset, container-runner derives a name from the folder
   * (`GITHUB_TOKEN_<FOLDER_UPPER>` with dashes as underscores) and falls
   * back to `GITHUB_TOKEN`.
   */
  githubTokenEnv?: string;

  /**
   * Plugin subdir names under `~/plugins/` to NOT mount for this group.
   * Plugins under `~/plugins/` are mounted into every container by default
   * (RO at `/workspace/plugins/<name>`). Use this when a group shouldn't
   * have access to a specific plugin — e.g., security-sensitive agents
   * excluding the `codex` plugin to avoid handing them a CLI with the
   * host's Codex OAuth session.
   */
  excludePlugins?: string[];

  /**
   * Named MCP servers to suppress for this group. Universal MCPs
   * (granola, deepwiki, context7, exa, pocket) are injected by default
   * in every container; add entries here to opt OUT per group.
   */
  excludeMcpServers?: string[];

  /**
   * When true, expose host Codex auth to the container. For provider=codex,
   * the active `~/.codex` remains a session-local private copy, and the host
   * Codex home is mounted separately as a read-only refresh source so long
   * running containers can heal a stale copied auth.json. For codex-as-peer
   * groups, the host Codex home is mounted directly. SECURITY: read access
   * to auth.json is enough to exfiltrate the OAuth token. Default OFF — opt
   * in only for groups that specifically need Codex host auth (e.g., the Codex
   * agent provider, /codex:rescue use cases). Pre-2026-05-03 the mount was
   * unconditional and RW; the cross-tenant audit forced it opt-in.
   */
  codexHostAuth?: boolean;

  /**
   * When true, mount the host `~/.wix` directory into the container RW so the
   * Wix CLI uses the host's OAuth session (operator ran `wix login` once on the
   * host). RW because the CLI rewrites `~/.wix/auth/account.json` on token
   * refresh. Mounted straight to `/home/node/.wix` via a dedicated path in
   * container-runner — NOT `additionalMounts`, which `validateAdditionalMounts`
   * sandboxes under `/workspace/extra` (where the CLI's `os.homedir()`-based
   * `~/.wix` lookup would never find it). Mirrors `codexHostAuth`. Default OFF.
   */
  wixHostAuth?: boolean;

  /**
   * Ordered list of additional host `~/.codex*` directories to mount as
   * fallback OAuth identities. Each entry is a host path (e.g.
   * `~/.codex`, `~/.codex-other`). At spawn, container-runner resolves
   * `~`, drops entries that lack an `auth.json`, mounts each survivor RW
   * at `/home/node/.codex-fallback-N/`, and forwards
   * `CODEX_FALLBACK_HOMES=/home/node/.codex-fallback-1:/home/node/.codex-fallback-2`.
   *
   * The container's codex provider rotates through these on
   * UsageLimitExceeded / ServerOverloaded / coarse-systemError by
   * copying the active thread's rollout `.jsonl` into the next CODEX_HOME's
   * sessions tree, killing the codex app-server, and respawning under the
   * new CODEX_HOME. Conversation history is preserved (the rollout file
   * is self-contained — codex reconstructs history inline).
   *
   * Inherits the existing `codexHostAuth: true` gate; entries are ignored
   * when host-auth mounting is opt-out.
   */
  codexAuthFallbacks?: string[];

  /**
   * Optional override for the folder used as the lookup key when resolving
   * per-group credentials (LOOKER_*, DBT_*, GITHUB_TOKEN, RENDER_PG_*,
   * GIT_AUTHOR_*, Claude OAuth, Codex auth dir, etc.) via the
   * `<BASE>_<FOLDER_UPPER>` scoped-env convention.
   *
   * Default (when undefined): `agent_groups.folder` is the lookup key, so
   * each group needs its own scoped env vars.
   *
   * Set when a sibling agent group should inherit another group's credentials
   * — most commonly a Codex sibling cloned from a Claude source. Example:
   * `groups/example-retail-codex/container.json` sets
   * `"credentialFolder": "example-retail"` so example-assistant-codex picks up
   * `LOOKER_BASE_URL_EXAMPLE_RETAIL` instead of looking for the non-existent
   * `LOOKER_BASE_URL_EXAMPLE_RETAIL_CODEX`.
   *
   * Does NOT affect identity-bound paths such as container name, group dir
   * mount, and log fields; those stay on `agent_groups.folder`.
   */
  credentialFolder?: string;

  /**
   * Parse-only legacy compatibility data. Retained so old container.json files
   * still deserialize without loss; true and false are behaviorally inert.
   */
  gitnexusInjectAgentsMd?: boolean;

  /**
   * Per-group default model when the agent uses the bare `opus` alias.
   * Resolves the SDK's opus-alias short-circuit ANTHROPIC_DEFAULT_OPUS_MODEL.
   * Overrides the install-wide DEFAULT_OPUS_MODEL constant in
   * container-runner.ts. Per-channel wiring overrides this; per-session
   * `-m <model>` flags override on top of that.
   */
  defaultModel?: string;

  /**
   * Per-group default reasoning effort when the agent doesn't pass
   * `-e <level>`. One of 'low' | 'medium' | 'high' | 'xhigh' | 'max'.
   * Overrides the install-wide DEFAULT_EFFORT constant in
   * container-runner.ts. Per-channel wiring overrides this; per-session
   * `-e <level>` flags override on top of that.
   */
  defaultEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  /**
   * Per-agent-group default tone profile name (matches a file under
   * `tone-profiles/<name>.md`). Acts as the fallback when a per-channel
   * wiring doesn't set `default_tone` on `messaging_group_agents`.
   */
  tone?: string;

  /**
   * Per-agent credential/tool allowlist. Each entry is either a bare tool
   * name (`snowflake`) or scoped (`snowflake:archive-one`, `aws:example-data`).
   * Omit to grant every credential surface; include to filter per-tool
   * before mount. Supported tool names: gmail, gmail-readonly, calendar,
   * google-workspace, snowflake, aws, gcloud, dbt, github, render, datafold,
   * linear, atlassian, looker, dbt-mcp.
   *
   * This is a FILTER, not a grant — an entry here only permits a surface some
   * other code path mounts or injects. A name that nothing honors is silently
   * inert, so do not read a `tools` entry as evidence that a credential is
   * wired. `browser-auth` was listed here for a long time and never had an
   * implementation: no `isToolEnabled('browser-auth')` call, no `.env` section,
   * no staged `creds/` dir. Groups declaring `browser-auth:<account>` read as
   * though browser credentials were scoped per agent when nothing was
   * delivered; browser logins are supplied by an explicit `additionalMounts`
   * entry or a shared workgroup file instead. Removed 2026-08-07 after it cost
   * a live debugging session.
   */
  tools?: string[];

  /**
   * Per-provider sticky config for the agent that runs in this group.
   * Populated by `create_agent`'s host handler after container-side Zod
   * validation (decision D4 — container is the validation authority).
   * Each provider reads only its own slice.
   *
   * Source of truth for valid keys per provider:
   *   container/agent-runner/src/providers/<name>.ts — see the exported
   *   `<name>ConfigSchema`. Currently:
   *     - 'claude': { model?: string, effort?: 'low'|'medium'|'high'|'xhigh'|'max' }
   *     - 'codex':  { model?: string,
   *                   reasoning_effort?: 'low'|'medium'|'high'|'xhigh'|'max'|'ultra',
   *                   max_concurrent_threads_per_session?: positive integer }
   *     - Others (e.g. opencode, mock): no configSchema — must be empty {}.
   *
   * Provider schemas are the durable source of truth; historical planning
   * artifacts are intentionally not tracked in the public repository.
   */
  providerConfig?: Record<string, unknown>;

  /**
   * Per-group daily summary digest config. The host-side daily-summary timer
   * (src/daily-summary.ts) posts a per-group activity digest once a day; by
   * default it targets the primary wired channel (highest mga.priority,
   * oldest-wired tiebreak). Set `messagingGroupId` to override the selected
   * destination for a particular installation.
   */
  dailySummary?: {
    messagingGroupId?: string;
    /**
     * Include the shipped-work sections (🤖 Agent Shipped / 🛠 Other commits)
     * in the digest. Defaults to true. Workgroups whose ship state already
     * lives in a dedicated release channel (a release scrum-master agent)
     * set false so the digest carries only backlog activity.
     */
    shipLog?: boolean;
    /**
     * Include backlog items resolved during the digest window. Defaults to
     * true. Set false when another workflow already reports completed work
     * and this digest should be an open-backlog-only reminder.
     */
    resolved?: boolean;
    /**
     * Include the ranked open-backlog list (parent headline + threaded list).
     * Defaults to true. Set false once the workgroup's backlog lives in a real
     * tracker and is rendered by `backlogCanvas` — the daily repost of a list
     * that barely changes day to day is noise, and the canvas is always current.
     */
    backlog?: boolean;
  };

  /**
   * Per-workgroup live backlog board, rendered into a Slack channel canvas by
   * `src/backlog-canvas.ts`. Presence of `messagingGroupId` is the opt-in — no
   * declaration means no canvas, so other workgroups are unaffected.
   *
   * Declare this on the group whose Slack bot holds the `canvases:write` scope;
   * the canvas is a property of the channel, not of the posting bot, so the
   * choice of writer is invisible to readers.
   */
  backlogCanvas?: {
    /** Destination channel. Its channel_type also selects the bot token. */
    messagingGroupId?: string;
    /** Linear team whose issues the board renders (e.g. "XZO"). */
    linearTeam?: string;
  };

  /**
   * Observatory presentation for this agent's WORKGROUP. Declared on any one
   * member group (same convention as backlogCanvas); the first declaration
   * found wins.
   *
   * `platforms` is an allow-list of channel-type prefixes the office floor
   * shows — `["slack"]` hides a workgroup's dormant Discord wiring without
   * un-wiring it. Absent = show every platform.
   */
  observatory?: {
    platforms?: string[];
    /** Platform ids to keep off the office floor (a canvas the API reports as a channel, a bot-only room). */
    hideRooms?: string[];
  };

  /**
   * The workgroup this agent belongs to. Set by migration 036 and written
   * into container.json for workgroup-scoped retrieval.
   *
   * Value matches workgroups.id (e.g. "example-retail" for both example-retail
   * and example-retail-codex agents).
   */
  workgroup_id?: string;

  /**
   * Slack user-token (xoxp-) MCP capability. When enabled, the agent gets
   * the korotovsky/slack-mcp-server MCP — letting it search/read DMs,
   * channels, threads, and files from the OWNER'S Slack lens.
   *
   * Fail-closed defaults: the capability is auto-scoped to the owner's
   * 1:1 DM with this agent at runtime. Adding the agent to a shared
   * channel does NOT grant teammates the ability to query through it
   * unless the operator explicitly extends `also_allowed_in` with the
   * channel's messaging_group_id.
   *
   * The OneCLI vault must have a token entry for the agent's workspace
   * (e.g., `Slack-User-Token-Example Labs`) assigned via the workgroup's
   * `onecli_secrets`. Without the token, the MCP refuses to register
   * even when `enabled: true` and the gate would allow.
   */
  slack_user_token?: SlackUserTokenConfig;
}

/**
 * Per-agent Slack user-token MCP capability. Wired into containers via the
 * korotovsky/slack-mcp-server binary. The actual token lives in OneCLI vault
 * and is injected at request time — never appears in this config.
 */
export interface SlackUserTokenConfig {
  /**
   * Whether this agent has the Slack user-token MCP at all. When false or
   * unset, the MCP is never registered for this agent. Default false.
   */
  enabled: boolean;

  /**
   * Override allow-list. By default the MCP is only registered when the
   * spawning session is the owner's 1:1 DM with this agent. Add specific
   * `messaging_group_id` values here to allow the capability in additional
   * contexts (e.g., a private channel that's just the owner + trusted
   * collaborators where it's OK to query the owner's lens).
   *
   * Format: messaging_groups.id strings. Use `pnpm exec tsx scripts/q.ts
   * data/v2.db "SELECT id, name FROM messaging_groups"` to find ids.
   */
  also_allowed_in?: string[];

  /**
   * Names (or UUIDs) of the OneCLI secrets that back Slack user-token access
   * for this agent — the credentials that let it read the OWNER's Slack via
   * the proxy (`curl https://slack.com/api/*`) or the MCP. In SHARED sessions
   * (not owner-safe per `also_allowed_in` / owner-DM) these secrets are
   * WITHHELD from the session's OneCLI agent, so neither curl nor the MCP can
   * reach Slack — the boundary is enforced at the credential layer, not just
   * the MCP registration.
   *
   * When unset, the host falls back to a naming convention: any merged
   * OneCLI secret whose name contains both "slack" and "user" (case-
   * insensitive — matches `Slack-User-Token-*`). Set this explicitly when
   * your secret doesn't follow that convention, so the security control
   * doesn't rely on a regex guess. See `slackUserTokenSecrets`.
   */
  onecli_secret_names?: string[];
}

function emptyConfig(): ContainerConfig {
  // tools defaults to `[]` (default-deny) for new groups so a child
  // spawned via create_agent doesn't inherit every credential surface
  // (snowflake, gws, aws, dbt, etc.). Operators add tool entries to
  // explicitly grant credential access. Pre-2026-05-03 this field was
  // omitted, which made `isToolEnabled()` allow every tool — pairing
  // dangerously with create_agent. See cross-tenant audit.
  return {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all',
    tools: [],
  };
}

function configPath(folder: string): string {
  return path.join(GROUPS_DIR, folder, 'container.json');
}

/** Build a `ContainerConfig` from a DB row + agent group identity. */
export function configFromDb(row: ContainerConfigRow, group: AgentGroup): ContainerConfig {
  return {
    mcpServers: validateMcpServers(JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>),
    packages: {
      apt: JSON.parse(row.packages_apt) as string[],
      npm: JSON.parse(row.packages_npm) as string[],
    },
    imageTag: row.image_tag ?? undefined,
    additionalMounts: JSON.parse(row.additional_mounts) as AdditionalMountConfig[],
    skills: JSON.parse(row.skills) as string[] | 'all',
    provider: row.provider ?? undefined,
    groupName: group.name,
    assistantName: row.assistant_name ?? group.name,
    agentGroupId: group.id,
    maxMessagesPerPrompt: row.max_messages_per_prompt ?? undefined,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
  };
}

/**
 * Read the container config for a group, returning sensible defaults for
 * any missing fields (or an entirely empty config if the file is absent).
 * Never throws for missing / malformed JSON — corruption logs a warning
 * via console.error and falls back to empty. Unsupported MCP transports fail
 * closed after the file is parsed.
 */
export function readContainerConfig(folder: string): ContainerConfig {
  const p = configPath(folder);
  if (!fs.existsSync(p)) return emptyConfig();

  let raw: Partial<ContainerConfig>;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<ContainerConfig>;
  } catch (err) {
    console.error(`[container-config] failed to parse ${p}: ${String(err)}`);
    return emptyConfig();
  }

  return materializeContainerConfig(raw);
}

/**
 * Read one trustworthy config snapshot for an operator-gated spawn. Unlike the
 * legacy reader, absence, malformed JSON, and symlinks are fatal so a canary
 * fence cannot silently fall back to stale DB identity.
 */
export function readContainerConfigStrict(folder: string): ContainerConfig {
  const p = configPath(folder);
  const stat = fs.lstatSync(p);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe container config: ${p}`);
  const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<ContainerConfig>;
  return materializeContainerConfig(raw);
}

/** Select strict admission reads only while an operator spawn fence is active. */
export function readContainerConfigForSpawn(folder: string, requireAuthoritativeFile: boolean): ContainerConfig {
  return requireAuthoritativeFile ? readContainerConfigStrict(folder) : readContainerConfig(folder);
}

function materializeContainerConfig(raw: Partial<ContainerConfig>): ContainerConfig {
  validateContainerResources(raw.resources);

  return {
    mcpServers: validateMcpServers(raw.mcpServers ?? {}),
    packages: {
      apt: raw.packages?.apt ?? [],
      npm: raw.packages?.npm ?? [],
    },
    imageTag: raw.imageTag,
    additionalMounts: raw.additionalMounts ?? [],
    skills: raw.skills ?? 'all',
    provider: raw.provider,
    groupName: raw.groupName,
    assistantName: raw.assistantName,
    agentGroupId: raw.agentGroupId,
    maxMessagesPerPrompt: raw.maxMessagesPerPrompt,
    resources: raw.resources,
    model: raw.model,
    effort: raw.effort,
    providerFallback: raw.providerFallback,
    githubTokenEnv: raw.githubTokenEnv,
    excludePlugins: raw.excludePlugins,
    codexHostAuth: raw.codexHostAuth,
    wixHostAuth: raw.wixHostAuth,
    codexAuthFallbacks: raw.codexAuthFallbacks,
    credentialFolder: raw.credentialFolder,
    excludeMcpServers: raw.excludeMcpServers,
    gitnexusInjectAgentsMd: raw.gitnexusInjectAgentsMd,
    defaultModel: raw.defaultModel,
    defaultEffort: raw.defaultEffort,
    tone: raw.tone,
    tools: raw.tools,
    providerConfig: raw.providerConfig,
    dailySummary: raw.dailySummary,
    backlogCanvas: raw.backlogCanvas,
    observatory: raw.observatory,
    onecliSecrets: raw.onecliSecrets,
    workgroup_id: raw.workgroup_id,
    slack_user_token: raw.slack_user_token,
  };
}

/**
 * Write the container config for a group, creating the groups/<folder>/
 * directory if necessary. Pretty-printed JSON so diffs in the activation
 * flow are reviewable.
 */
export function writeContainerConfig(folder: string, config: ContainerConfig): void {
  validateMcpServers(config.mcpServers ?? {});
  validateContainerResources(config.resources);
  const p = configPath(folder);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Apply a mutator function to a group's container config and persist the
 * result. Convenient for append-style changes like `install_packages` and
 * `add_mcp_server` handlers.
 */
export function updateContainerConfig(folder: string, mutate: (config: ContainerConfig) => void): ContainerConfig {
  const config = readContainerConfig(folder);
  mutate(config);
  writeContainerConfig(folder, config);
  return config;
}

/**
 * Initialize an empty container.json for a group if one doesn't already
 * exist. Idempotent — used from `group-init.ts`.
 */
export function initContainerConfig(folder: string): boolean {
  const p = configPath(folder);
  if (fs.existsSync(p)) return false;
  writeContainerConfig(folder, emptyConfig());
  return true;
}
