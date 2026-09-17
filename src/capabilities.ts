/**
 * Capability self-awareness (Phase 5.3).
 *
 * Single source of truth for "what can this NanoClaw install actually
 * do right now?" Reads the current state of channels, mounted
 * credentials, plugins, agent groups, and feature flags, and returns
 * a structured snapshot.
 *
 * Consumers:
 *   - Agent, via the `get_capabilities` MCP tool (so the agent can
 *     answer "can I send email from this install?" without probing).
 *   - External HTTP caller or future UI — any consumer reads the same
 *     shape. v1 built this as a Web UI dependency; v2 inverts that
 *     so Web-UI (or any other consumer) reads core.
 *
 * Nothing here depends on a UI; the UI (if/when one exists) reads
 * this module.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { withCentralSync, withRawDb } from './db/central-lease.js';
import { GROUPS_DIR } from './config.js';
import { getRegisteredChannelNames } from './channels/channel-registry.js';
import { readContainerConfig, type McpServerConfig } from './container-config.js';
import { RETIRED_MCP_SERVER_NAMES, effectiveMcpServers, readFleetMcpServers } from './fleet-mcp-servers.js';
import { getAllAgentGroups, getAgentGroup, getWorkgroupOnecliSecrets } from './db/agent-groups.js';
import type { AgentGroup } from './types.js';
import { mergeWorkgroupAndGroupSecrets, slackUserTokenSecrets } from './onecli-secrets.js';
import { GITHUB_APP_SENTINEL, peekGitHubAppTokenExpiry } from './github-app-token.js';
import { GH_TOKEN_CONTAINER_PATH, githubTokenDeliveredAsEnv } from './github-token-file.js';
import { isOwnerSafeSlackSession } from './modules/permissions/slack-user-token-gate.js';
import { getAllMessagingGroups } from './db/messaging-groups.js';
import { loadPluginScopes, pluginAllowedForWorkgroup } from './plugin-scopes.js';
import { extractToolScopes } from './scoped-env.js';

// Read version once at module load.
let cachedVersion = '0.0.0';
try {
  const pkgPath = path.resolve(GROUPS_DIR, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  cachedVersion = pkg.version || '0.0.0';
} catch {
  // fall back — version is informational only
}

export interface HostCapabilities {
  version: string;

  /** Which channel adapters have self-registered at startup. */
  channels: {
    registered: string[];
    /** Channels with at least one wired messaging_group (i.e., actually in use). */
    active: string[];
  };

  /** Which credential dirs the host has mounted (determines agent tool scope). */
  credentials: {
    gws: boolean; // Google Workspace (Gmail/Calendar/Drive/Docs)
    gmailMcp: boolean; // legacy Gmail MCP creds
    googleCalendarMcp: boolean;
    googleWorkspaceMcp: boolean;
    snowflake: boolean;
    dbt: boolean;
    aws: boolean;
    gcloudKeys: boolean;
    codex: boolean;
  };

  /** Which plugin repos are available to containers. */
  plugins: {
    builtin: string[]; // reserved for future always-on built-ins; currently empty
    installed: string[]; // ~/plugins/* subdirs
  };

  /** Agent groups + their per-group feature flags. */
  agentGroups: Array<{
    id: string;
    name: string;
    folder: string;
    excludePlugins: string[];
    githubTokenEnv: string | null;
  }>;

  /** Messaging group count by channel type (how many places this install is wired into). */
  messagingGroupsByChannel: Record<string, number>;

  /** Which host-side credential env vars are set (for per-tool scoping). Values are never returned — only which names are populated. */
  credentialEnvSet: string[];

  /**
   * Per-service snapshot scoped to the agent_group that owns this session.
   * Lists the accounts/scopes actually wired in for this container and —
   * critically — the exact activation step (e.g. which env var to export)
   * that most CLIs require. Without this, the agent sees `credentials.gws:
   * true` and `gws auth status → auth_method: none` and concludes (wrongly)
   * that it isn't authenticated. Populated only when `forAgentGroupId` is
   * passed to getHostCapabilities.
   */
  session?: SessionServicesSnapshot;
}

export interface SessionServicesSnapshot {
  agentGroupId: string;
  /**
   * The standing instruction that heads the pre-turn roster. Carried on the
   * snapshot (rather than only in host code) so the runner's fresh-context
   * fallback renders the SAME two sentences from the mounted
   * `/workspace/capabilities.json` instead of keeping its own copy to drift
   * (container/agent-runner/src/memory/bootstrap.ts).
   */
  howToUse?: string;
  services: Array<{
    /**
     * Human label, e.g. "Google Workspace". Also the lookup key for
     * `get_capabilities({ service })`, which matches case-insensitively on
     * this, on `cli`, and on `mcpNamespace` — so keep it short and typeable.
     */
    name: string;
    /** CLI binary the agent invokes. Omitted for MCP-only services. */
    cli?: string;
    /** MCP tool namespace (e.g. `mcp__exa__*`). Used for usage-guided entries. */
    mcpNamespace?: string;
    /** Tool names in container.json.tools that imply this service. */
    declaredTools: string[];
    /** Scope names parsed from tool entries (e.g. ['example-labs','support-example-labs']). */
    scopes: string[];
    /** What files / paths the container sees. Container path, not host path. */
    credentialPaths: string[];
    /** Concise activation instruction for the CLI, if any. */
    activation?: string;
    /**
     * The one line this service gets in the ALWAYS-ON pre-turn roster: what it
     * is good for, short enough that every wired service fits the block. Aim
     * at ~80 characters — the roster's whole job is awareness ("you have this,
     * never say you don't"), and the how-to prose below (`useFor` /
     * `activation`) is what the agent fetches on demand with
     * `get_capabilities({ service })` before first use.
     *
     * Hand-written for the hand-written entries; derived from an MCP server's
     * stored `description` for the derived ones (`summarizeCapabilityText`).
     * Absent means the roster derives one from `activation`/`useFor`, which is
     * a fallback, not the intent.
     */
    summary?: string;
    /**
     * When the host's cached copy of this credential expires (ISO-8601), for
     * short-TTL tokens like GitHub App installation tokens. Precision matters:
     * a RUNNING container's own env copy was frozen at its spawn, so if its
     * calls 401 while this shows future expiry, the container holds a stale
     * spawn-time token — restart fixes that. Absent on the first wake after a
     * cold host start (nothing minted yet).
     */
    expiresAt?: string;
    /**
     * When-to-use guidance for services where the gap is "agent doesn't
     * reach for the tool" rather than "agent can't authenticate". Populated
     * for exa, granola, etc. where there's no scope/account choice.
     */
    useFor?: string;
    /**
     * Never evicted by a capability budget while any entry without it can be
     * evicted instead. For an entry whose absence makes the agent deny an
     * ability it has. Honoured through `evictCapability`
     * (src/modules/memory/pre-turn-context.ts:1629) at all three host eviction
     * sites — the service-count limit (:1642), the total budget
     * (:1695) and `enforceFinalBound` (:1741) — and by the runner's
     * fresh-context fallback through its own `evictCapability`
     * (container/agent-runner/src/memory/bootstrap.ts:65, called at :92 and :116).
     */
    retainUnderBudget?: boolean;
  }>;
}

function hostDirExists(...parts: string[]): boolean {
  return fs.existsSync(path.join(os.homedir(), ...parts));
}

/**
 * Render the per-session services snapshot as a CLAUDE.md fragment. Pushed
 * into the composed prompt (see claude-md-compose) so the agent reads its
 * ACTUALLY-WIRED services — Looker, Google Workspace, Snowflake, … — with
 * their activation steps on every turn, instead of guessing it lacks access
 * and rediscovering each session. Returns '' when nothing is wired so the
 * fragment is omitted entirely.
 */
export function renderSessionCapabilities(snapshot: SessionServicesSnapshot): string {
  if (snapshot.services.length === 0) return '';
  const lines: string[] = [
    '# Your wired capabilities (this session)',
    '',
    'The services below are wired into THIS container right now. Do NOT tell the user you lack access to them, and do NOT ask for their credentials — auth is already injected at spawn. Use them directly. For full host-wide detail you can also call `mcp__nanoclaw__get_capabilities`.',
    '',
  ];
  for (const s of snapshot.services) {
    const handle = s.cli ? `CLI \`${s.cli}\`` : s.mcpNamespace ? `MCP \`${s.mcpNamespace}\`` : '';
    const scope = s.scopes.length > 0 ? ` — scopes: ${s.scopes.join(', ')}` : '';
    lines.push(`- **${s.name}**${handle ? ` — ${handle}` : ''}${scope}`);
    const detail = s.activation ?? s.useFor;
    if (detail) lines.push(`  - ${detail}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * The two sentences that head the always-on capability roster.
 *
 * Sentence one is the whole reason the block exists: agents were telling
 * users "I can't do that" about tools sitting wired in their own container.
 * Sentence two is what makes the roster affordable — the mini-manual for any
 * one service is a tool call away, so the block does not have to carry 23 of
 * them (13,247 chars on the widest live group, against a 10,000 budget that
 * silently dropped six services from the end, Hex and Looker among them).
 */
export const CAPABILITY_ROSTER_PREAMBLE =
  'EVERY service listed here is wired into THIS session right now — never tell the user you lack one of them, and never ask for its credentials. ' +
  'These are one-line reminders, not instructions: before you first use a service in a session, call `get_capabilities` with `{"service":"<name>"}` for its full usage notes (auth, exact tool names, known failure shapes).';

/** One roster line: the name, how you reach it, and a short hint. */
export interface CapabilityRosterEntry {
  /** Lookup key for `get_capabilities({ service })`. */
  name: string;
  /** How the agent reaches it — `mcp__looker__*`, `gws`, `curl`, … */
  via: string;
  /** ~80-char hint. Absent only when a service carries no text at all. */
  use?: string;
  /** Short-TTL credential expiry; see SessionServicesSnapshot.services.expiresAt. */
  expiresAt?: string;
  /** See SessionServicesSnapshot.services.retainUnderBudget. */
  retainUnderBudget?: boolean;
}

/** What the pre-turn block carries, in place of the full snapshot. */
export interface CapabilityRoster {
  agentGroupId: string;
  howToUse: string;
  services: CapabilityRosterEntry[];
}

/**
 * Fallback hint for an entry authored without a `summary`: the leading clause
 * of its how-to prose, cut at a word boundary so the line never ends mid-word.
 *
 * Cutting at a sentence end first keeps the common case readable; the
 * character cut is the backstop for a first sentence that runs long.
 */
export function summarizeCapabilityText(text: string, limit = 96): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  const sentence = flat.slice(0, limit + 1).match(/^(.*?[.!?])\s/);
  if (sentence?.[1] && sentence[1].length >= 24) return sentence[1];
  const cut = flat.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 24 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.\s]+$/, '')}…`;
}

/**
 * Reduce a full services snapshot to the always-on roster.
 *
 * This is the shape the pre-turn block carries. It is deliberately lossy: the
 * `useFor` / `activation` prose stays in `/workspace/capabilities.json`, whole
 * and byte-identical, and reaches the agent through
 * `get_capabilities({ service })`. Budget eviction
 * (`src/modules/memory/pre-turn-context.ts`) still runs over the result, but
 * on a roster this size it is a safety net rather than the thing that decides
 * which services an agent is told it has.
 */
export function buildCapabilityRoster(snapshot: SessionServicesSnapshot): CapabilityRoster {
  return {
    agentGroupId: snapshot.agentGroupId,
    howToUse: snapshot.howToUse ?? CAPABILITY_ROSTER_PREAMBLE,
    services: snapshot.services.map((service) => {
      const use = service.summary ?? rosterFallbackUse(service);
      return {
        name: service.name,
        via: service.mcpNamespace ?? service.cli ?? '',
        ...(use === undefined ? {} : { use }),
        ...(service.expiresAt === undefined ? {} : { expiresAt: service.expiresAt }),
        ...(service.retainUnderBudget ? { retainUnderBudget: true as const } : {}),
      };
    }),
  };
}

function rosterFallbackUse(service: SessionServicesSnapshot['services'][number]): string | undefined {
  const text = service.activation ?? service.useFor;
  return text === undefined ? undefined : summarizeCapabilityText(text);
}

/** Env names we scope per-agent-group (must stay in sync with SCOPED_CREDENTIAL_VARS in container-runner). */
const SCOPED_ENV_NAMES = [
  'GITHUB_TOKEN',
  'RENDER_API_KEY',
  'RENDER_WORKSPACE_ID',
  'SNOWFLAKE_ACCOUNT',
  'SNOWFLAKE_USER',
  'SNOWFLAKE_PASSWORD',
  'SNOWFLAKE_WAREHOUSE',
  'SNOWFLAKE_ROLE',
  'SNOWFLAKE_DATABASE',
  'DBT_CLOUD_ACCOUNT_ID',
  'DBT_CLOUD_API_TOKEN',
  // OPENAI_API_KEY and DEEPGRAM_API_KEY removed 2026-07-27: neither is in use.
  // Deepgram is commented out of .env (vault-only since 2026-04-28) and its vault
  // value 401s; OpenAI's only .env value is the `placeholder_for_onecli_proxy`
  // sentinel and there is no key to rotate. Advertising them here told agents the
  // services were wired when every call 401s. The codex provider keeps its own
  // OPENAI_API_KEY fallback (src/providers/codex.ts reads ctx.hostEnv directly),
  // so that path is unaffected and still works the day a real key appears.
  'BRAINTRUST_API_KEY',
  'EXA_API_KEY',
  'ELEVENLABS_API_KEY',
  'RESIDENTIAL_PROXY_URL',
  'SUPABASE_PROJECT_REF',
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_DB_PASSWORD',
  'LOOKER_BASE_URL',
  'LOOKER_CLIENT_ID',
  'LOOKER_CLIENT_SECRET',
  'ATLASSIAN_BASE_URL',
  'SELECT_ORGANIZATION_ID',
];

/**
 * Host plugins as one agent group may see them. Inside a container the
 * snapshot must not name another workgroup's scoped plugin
 * (src/plugin-scopes.ts), so a group snapshot filters by `workgroupId`, the
 * spawn-resolved workgroup the plugin mount also keys on. Without one, every
 * scoped plugin is withheld. The host-wide view (no group) lists everything.
 */
function installedPluginsFor(agentGroupId: string | undefined, workgroupId: string | undefined): string[] {
  const installed = listHostPlugins();
  if (!agentGroupId) return installed;
  const scopes = loadPluginScopes();
  return installed.filter((plugin) => pluginAllowedForWorkgroup(plugin, workgroupId, scopes));
}

function listHostPlugins(): string[] {
  const dir = path.join(os.homedir(), 'plugins');
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir).filter((entry) => {
      if (entry.toLowerCase() === 'gitnexus') return false;
      try {
        return fs.statSync(path.join(dir, entry)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/**
 * Per-service scoped view for a specific agent group. Consumed by the
 * get_capabilities MCP tool (via writeCapabilitiesSnapshot) so the agent can
 * see exactly which accounts / connections / profiles apply to the session
 * it's running in — and how to activate the CLI when the CLI's own
 * auth-status check is blind (gws is the classic case).
 */
/** Mirror of container-runner.ts resolveScopedEnv — duplicated to avoid cross-module coupling. */
function resolveScopedEnvVar(baseName: string, folder: string): { name: string; set: boolean } {
  const conv = `${baseName}_${folder.toUpperCase().replace(/-/g, '_')}`;
  if (process.env[conv]) return { name: conv, set: true };
  if (process.env[baseName]) return { name: baseName, set: true };
  return { name: baseName, set: false };
}

/** Extract section headers from an INI-like file. Used for aws credentials + snowflake connections.toml. */
function iniSections(absPath: string): string[] {
  try {
    const content = fs.readFileSync(absPath, 'utf-8');
    const names: string[] = [];
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*\[([^\]]+)\]/);
      if (m) names.push(m[1].trim());
    }
    return names;
  } catch {
    return [];
  }
}

/** Top-level keys in a dbt profiles.yml (or any simple YAML keyed at col 0). */
function yamlTopLevelKeys(absPath: string): string[] {
  try {
    const content = fs.readFileSync(absPath, 'utf-8');
    const names: string[] = [];
    for (const line of content.split('\n')) {
      const m = line.match(/^([a-zA-Z0-9_-]+):\s*$/);
      if (m) names.push(m[1]);
    }
    return names;
  } catch {
    return [];
  }
}

/**
 * The central-DB facts a services snapshot is built from. Resolved by the
 * caller BEFORE any synchronous block that needs the snapshot: the recall row
 * is built between a write guard and its insert, where nothing may be awaited
 * (seam-3 plan §4.5), so the snapshot's two central reads happen here and the
 * build itself (`buildSessionServicesSnapshotFrom`) touches only the
 * filesystem.
 */
export interface SessionServicesCentral {
  agentGroup: AgentGroup | undefined;
  workgroupSecrets: string[];
}

export async function resolveSessionServicesCentral(agentGroupId: string): Promise<SessionServicesCentral> {
  return {
    agentGroup: await getAgentGroup(agentGroupId),
    workgroupSecrets: await getWorkgroupOnecliSecrets(agentGroupId),
  };
}

export async function buildSessionServicesSnapshot(
  agentGroupId: string,
  sessionMessagingGroupId?: string | null,
): Promise<SessionServicesSnapshot> {
  const central = await resolveSessionServicesCentral(agentGroupId);
  return withCentralSync(
    () => buildSessionServicesSnapshotFrom(agentGroupId, central, sessionMessagingGroupId),
    'session services snapshot',
  );
}

/**
 * Synchronous: filesystem and config, plus ONE lease-only central read (the
 * Slack owner-safety probe below, through `withRawDb`); every other central
 * fact arrives in `central`. Callable only inside a `withCentralSync` block —
 * the recall-row insert holds one, `buildSessionServicesSnapshot` takes one.
 */
export function buildSessionServicesSnapshotFrom(
  agentGroupId: string,
  central: SessionServicesCentral,
  sessionMessagingGroupId?: string | null,
): SessionServicesSnapshot {
  const ag = central.agentGroup;
  const cfg = ag ? readContainerConfig(ag.folder) : undefined;
  // Env-scoped services (Looker, dbt-mcp, dbt Cloud, GitHub, Render) resolve
  // their host creds by FOLDER via resolveScopedEnvVar. Sibling groups (e.g.
  // example-retail-codex) set `credentialFolder` to the seed folder so they
  // share the seed's scoped creds, and the real MCP wiring keys on
  // credentialFolder too (container-runner resolveScopedEnv). The snapshot
  // MUST use the same folder, or it looks for LOOKER_*_EXAMPLE_RETAIL_CODEX
  // (which never exists), falls through to unscoped, and falsely reports
  // "credentials missing — Ask Operator" for every sibling.
  const folder = cfg?.credentialFolder ?? ag?.folder ?? '';
  const tools = cfg?.tools;
  const listAccounts = (absDir: string): string[] => {
    try {
      return fs
        .readdirSync(absDir)
        .filter((e) => e.endsWith('.json'))
        .map((e) => e.replace(/\.json$/, ''))
        .sort();
    } catch {
      return [];
    }
  };

  const declared = (names: string[]): boolean => {
    if (!tools) return false; // unrestricted → don't speculate per-service
    return tools.some((t) => names.includes(t) || names.some((n) => t.startsWith(`${n}:`)));
  };
  const declaredMatchingTools = (names: string[]): string[] => {
    if (!tools) return [];
    return names.filter((n) => tools.some((t) => t === n || t.startsWith(`${n}:`)));
  };
  const scopeIntersect = (toolName: string, available: string[]): string[] => {
    const scopes = extractToolScopes(tools, toolName).scopes;
    return scopes.length === 0 ? available : available.filter((a) => scopes.includes(a));
  };

  const services: SessionServicesSnapshot['services'] = [];

  // Google Workspace — the headline case this exists for.
  const gwsToolNames = ['gmail', 'gmail-readonly', 'calendar', 'google-workspace'];
  const gwsDeclared = gwsToolNames.filter((n) => {
    if (!tools) return true; // undefined tools = unrestricted
    return tools.some((t) => t === n || t.startsWith(`${n}:`));
  });
  if (gwsDeclared.length > 0) {
    const scopes = new Set<string>();
    for (const n of gwsToolNames) {
      for (const s of extractToolScopes(tools, n).scopes) scopes.add(s);
    }
    const hostDir = path.join(os.homedir(), '.config', 'gws', 'accounts');
    const accounts = listAccounts(hostDir);
    const effective = scopes.size > 0 ? accounts.filter((a) => scopes.has(a)) : accounts;
    services.push({
      // Short enough to be a roster line and a typeable `get_capabilities`
      // key; the product list it used to carry moved into `summary`, which is
      // where an ~80-char hint belongs.
      name: 'Google Workspace',
      cli: 'gws',
      declaredTools: gwsDeclared,
      scopes: [...scopes].sort(),
      credentialPaths: effective.map((a) => `/home/node/.config/gws/accounts/${a}.json`),
      summary:
        effective.length > 0
          ? `Gmail, Calendar, Drive, Docs, Sheets, Slides as ${effective.join(', ')} (export the creds file first)`
          : 'Gmail, Calendar, Drive, Docs, Sheets, Slides — no authenticated account file on the host',
      activation:
        effective.length > 0
          ? `export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/<name>.json (valid names: ${effective.join(', ')}). Verify with \`gws auth status\` — WITHOUT this env var gws reports auth_method: none even though creds are mounted.`
          : 'no authenticated account files found in /home/node/.config/gws/accounts/',
    });
  }

  // Snowflake — connection names live in connections.toml; scope suffix is the
  // connection the agent passes to `snow -c <name>`.
  if (declared(['snowflake'])) {
    const connsPath = path.join(os.homedir(), '.snowflake', 'connections.toml');
    const all = iniSections(connsPath);
    const effective = scopeIntersect('snowflake', all);
    services.push({
      name: 'Snowflake',
      cli: 'snow',
      declaredTools: declaredMatchingTools(['snowflake']),
      scopes: effective,
      credentialPaths: ['/home/node/.snowflake/connections.toml'],
      summary:
        effective.length > 0
          ? `Run SQL on the warehouse: \`snow sql -c ${effective[0]}\` (connections: ${effective.join(', ')})`
          : 'SQL on the warehouse — no matching connection in connections.toml',
      activation:
        effective.length > 0
          ? `snow sql -q "SELECT ..." -c <connection>. Valid connections in this session: ${effective.join(', ')}.`
          : 'no matching connections found in connections.toml',
    });
  }

  // AWS — profile names from ~/.aws/credentials; scope suffix is --profile.
  if (declared(['aws'])) {
    const credsPath = path.join(os.homedir(), '.aws', 'credentials');
    const all = iniSections(credsPath).filter((n) => n !== 'default');
    const effective = scopeIntersect('aws', all);
    services.push({
      name: 'AWS',
      cli: 'aws',
      declaredTools: declaredMatchingTools(['aws']),
      scopes: effective,
      credentialPaths: ['/home/node/.aws/credentials'],
      summary:
        effective.length > 0
          ? `AWS CLI against profiles ${effective.join(', ')} (pass --profile)`
          : 'AWS CLI — credentials mounted but no matching scoped profile',
      activation:
        effective.length > 0
          ? `aws --profile <name> <command>. Valid profiles in this session: ${effective.join(', ')}. Verify with \`aws sts get-caller-identity --profile <name>\`.`
          : 'aws credentials mounted but no matching scoped profiles found',
    });
  }

  // dbt — profile names from ~/.dbt/profiles.yml top-level keys; scope suffix
  // is --profile.
  if (declared(['dbt'])) {
    const profilesPath = path.join(os.homedir(), '.dbt', 'profiles.yml');
    const all = yamlTopLevelKeys(profilesPath);
    const effective = scopeIntersect('dbt', all);
    services.push({
      name: 'dbt',
      cli: 'dbt',
      declaredTools: declaredMatchingTools(['dbt']),
      scopes: effective,
      credentialPaths: ['/home/node/.dbt/profiles.yml'],
      summary:
        effective.length > 0
          ? `dbt CLI (run/compile/test/build) on profiles ${effective.join(', ')}`
          : 'dbt CLI — profiles.yml mounted but no matching scoped profile',
      activation:
        effective.length > 0
          ? `dbt run --profile <name> --project-dir <path> (also compile/test/build). Valid profiles in this session: ${effective.join(', ')}.`
          : 'profiles.yml mounted but no matching scoped profiles found',
    });
  }

  // dbt Cloud — env-var-scoped (no `tools` declaration needed; surfaced
  // whenever the host can resolve a token for this folder). DBT_CLOUD_API_TOKEN
  // is the load-bearing var; URL/ACCOUNT_ID are useful context if also set.
  const dbtCloudToken = resolveScopedEnvVar('DBT_CLOUD_API_TOKEN', folder);
  if (dbtCloudToken.set) {
    const dbtCloudUrl = resolveScopedEnvVar('DBT_CLOUD_API_URL', folder);
    const dbtCloudAccount = resolveScopedEnvVar('DBT_CLOUD_ACCOUNT_ID', folder);
    services.push({
      name: 'dbt Cloud',
      cli: 'curl / dbt-cloud-cli',
      declaredTools: [],
      scopes: [],
      credentialPaths: [],
      summary: 'dbt Cloud Admin/Discovery REST — token already in your env, send no auth header of your own',
      activation: `Authenticated via \`DBT_CLOUD_API_TOKEN\` (resolved from host env \`${dbtCloudToken.name}\`)${
        dbtCloudUrl.set
          ? `, base URL via \`${dbtCloudUrl.name}\``
          : ' — no API URL var set, default to https://cloud.getdbt.com'
      }${dbtCloudAccount.set ? `, account id via \`${dbtCloudAccount.name}\`` : ' — no account id var set, required by most endpoints'}. Example: \`curl -H "Authorization: Token $DBT_CLOUD_API_TOKEN" "$DBT_CLOUD_API_URL/api/v2/accounts/$DBT_CLOUD_ACCOUNT_ID/"\`. Do NOT ask the user for the token — it's already in your env.`,
    });
  }

  // GitHub — env-var-scoped. Host resolves GITHUB_TOKEN_<FOLDER> at spawn and
  // forwards as GITHUB_TOKEN; the scoped var may also be visible in-container
  // depending on the forwarding loop. We report which env name the host would
  // have picked.
  // Gated on env-var presence OR explicit tools declaration: the host
  // injects GITHUB_TOKEN unconditionally based on folder-name resolution,
  // so credential availability — not the tools array — is what determines
  // whether the agent actually has GitHub access. The `declared` arm
  // preserves the old "configured but token missing" diagnostic.
  {
    const tokenEnvName = cfg?.githubTokenEnv ?? null;
    const resolved =
      tokenEnvName && process.env[tokenEnvName]
        ? { name: tokenEnvName, set: true }
        : resolveScopedEnvVar('GITHUB_TOKEN', folder);
    if (resolved.set || declared(['github'])) {
      const scopeList = extractToolScopes(tools, 'github').scopes;
      const allowedOrgs = resolveScopedEnvVar('GITHUB_ALLOWED_ORGS', folder);
      // Expiry only means something when THIS group authenticates as the App:
      // peek reads the host-wide App cache, and a PAT group must never be told
      // its static token "expires" on someone else's installation schedule.
      const resolvedTokenValue = resolved.set ? process.env[resolved.name] : undefined;
      const isAppSentinel = resolvedTokenValue === GITHUB_APP_SENTINEL;
      const githubTokenExpiresAt = isAppSentinel ? peekGitHubAppTokenExpiry() : undefined;
      // App-token 403 shapes are App-specific; a PAT group must never have a
      // real authorization failure explained away as "healthy app behavior".
      const tokenShapeNote = isAppSentinel
        ? ` **Known token shape:** \`gh api user\` returns 403 even on a HEALTHY App installation token — apps cannot call \`/user\`; probe liveness with \`gh api repos/{owner}/{repo} --jq .full_name\`. On some app installations \`gh pr checks\` and \`/commits/{sha}/check-runs\` 403 while the Actions runs API still works — if a Checks-path call 403s, read CI via \`gh api repos/{owner}/{repo}/actions/runs?head_sha=<sha>\` (and \`.../actions/runs/{id}/jobs\` for per-job detail) instead.`
        : '';
      services.push({
        name: 'GitHub',
        cli: 'gh',
        declaredTools: declaredMatchingTools(['github']),
        scopes: scopeList,
        credentialPaths: [],
        summary: resolved.set
          ? '`gh` and the VCS CLI are pre-authenticated: repos, PRs, pushes, and CI/Actions status'
          : 'GitHub declared but no token resolved on the host — ask the operator',
        activation: resolved.set
          ? `\`gh\` and \`git\` both pre-authenticated from host env \`${resolved.name}\`${githubTokenDeliveredAsEnv() ? `, forwarded to you as \`GITHUB_TOKEN\`` : ` and delivered as a read-only file at \`${GH_TOKEN_CONTAINER_PATH}\` — the git credential helper and the \`gh\` shim read it per invocation, so the host's hourly re-mint reaches you without a restart, and there is deliberately no \`GITHUB_TOKEN\` in your env`}${
              allowedOrgs.set ? `, restricted to orgs: \`${process.env[allowedOrgs.name]}\`` : ''
            }. \`gh repo view\`, \`gh pr create\`, \`git push\` all work directly. **CI/Actions is included, not a separate integration** — you CAN check build and test status yourself, and must never tell the user you lack access to CI. \`gh pr checks <pr>\` for a PR's check rollup (GraphQL statusCheckRollup under the hood), \`gh run list --branch <branch>\`, \`gh run view <run-id> --log-failed\` for the failing step's output, \`gh run watch <run-id>\` to block until it settles.${tokenShapeNote} A 403 on one endpoint can be a permissions shape rather than a dead credential — before reporting lost access, retry the same read through a different GitHub surface (\`gh api\` covers every endpoint with this same token). To poll a run without burning a turn, use the \`wait\` tool rather than sleeping. DO NOT run \`gh auth login\`. DO NOT ask the user for a token — the credential is already wired up for you.`
          : `GitHub tool declared but no token set at host env ${tokenEnvName ?? 'GITHUB_TOKEN_<folder>'} or fallback GITHUB_TOKEN — ask Operator.`,
        ...(resolved.set && githubTokenExpiresAt ? { expiresAt: githubTokenExpiresAt } : {}),
      });
    }
  }

  // Render — env-var-scoped (RENDER_API_KEY + RENDER_WORKSPACE_ID); also lists
  // the scoped PG/Redis URL env vars the host has forwarded.
  // Gated on env-var presence OR explicit tools declaration (same rationale
  // as GitHub above).
  {
    const apiKey = resolveScopedEnvVar('RENDER_API_KEY', folder);
    if (apiKey.set || declared(['render'])) {
      const workspace = resolveScopedEnvVar('RENDER_WORKSPACE_ID', folder);
      const folderTok = folder.toUpperCase().replace(/-/g, '_');
      const scopedDbEnv = Object.keys(process.env)
        .filter(
          (k) => (k.startsWith('RENDER_PG_') || k.startsWith('RENDER_REDIS_URL_')) && k.includes(`_${folderTok}_`),
        )
        .sort();
      const scopeList = extractToolScopes(tools, 'render').scopes;
      services.push({
        name: 'Render',
        cli: 'render',
        declaredTools: declaredMatchingTools(['render']),
        scopes: scopeList,
        credentialPaths: [],
        summary: apiKey.set
          ? 'Render CLI: list services, tail logs, psql into managed Postgres'
          : 'Render declared but RENDER_API_KEY is unset on the host — ask the operator',
        activation: apiKey.set
          ? `\`render\` CLI authenticated via \`RENDER_API_KEY\` (from host env \`${apiKey.name}\`${workspace.set ? `, workspace via \`${workspace.name}\`` : ''}). Common: \`render services -o json\`, \`render logs --service-id <id>\`, \`render psql --service-id <pg-id>\`.${scopedDbEnv.length > 0 ? ` Scoped DB URLs also injected as env vars: ${scopedDbEnv.join(', ')}.` : ''} DO NOT ask the user for the API key — it's already in your env.`
          : `render tool declared but RENDER_API_KEY not set at host — ask Operator.`,
      });
    }
  }

  // Where the derived MCP entries land. The five universals that moved into
  // the fleet file (exa, deepwiki, context7, pocket, granola) were pushed
  // exactly here, and both capability budgets evict from the END
  // (`evictCapability`, src/modules/memory/pre-turn-context.ts:1629-1634), so
  // appending them instead would have moved every one of them into the
  // eviction zone. The 19 -> 22 services / 8,954 -> 9,773 chars figure quoted
  // in `src/capabilities.test.ts` is that file's own hermetic wide-group
  // fixture, not a production group — the widest LIVE group measured 23
  // services / 13,247 chars of raw snapshot when the roster replaced the
  // full-prose block, i.e. six services past the 10,000-char budget
  // (`PRE_TURN_BOUNDS.capabilityTotalChars`). The entries are built at the end
  // of this function, where every hand-written `mcpNamespace` is known, and
  // spliced in at this index.
  const derivedMcpIndex = services.length;

  // Linear — gated by tool entry. Container-runner injects when 'linear' is in
  // container.json.tools and the OneCLI gateway proxy injects auth at request
  // time (vault entry "Linear" → mcp.linear.app). Only surface in the
  // capabilities snapshot for groups that opted in, so other groups don't
  // claim Linear access they don't actually have.
  if (declared(['linear'])) {
    services.push({
      name: 'Linear',
      mcpNamespace: 'mcp__linear__*',
      declaredTools: declaredMatchingTools(['linear']),
      scopes: [],
      credentialPaths: [],
      summary: 'Linear issue tracker: search/create/update issues, comments, projects, cycles',
      useFor:
        'Linear issue tracker via https://mcp.linear.app/mcp. Auth pre-injected (Authorization: Bearer). Use for: list/search/create/update issues, comments, projects, cycles, teams, users. Tools: `mcp__linear__*`.',
    });
  }

  // Datafold — gated by tool entry. Container-runner injects the official
  // Datafold Streamable HTTP MCP when 'datafold' is in container.json.tools.
  // OneCLI gateway overwrites the placeholder `Authorization: Key ...` header
  // at request time; the raw Datafold API key is never placed in container.json
  // or process env.
  if (declared(['datafold'])) {
    services.push({
      name: 'Datafold',
      mcpNamespace: 'mcp__datafold__*',
      declaredTools: declaredMatchingTools(['datafold']),
      scopes: [],
      credentialPaths: [],
      summary: 'Datafold: list data sources, query them, run Data Diff workflows',
      useFor:
        'Official Datafold Streamable HTTP MCP at https://app.datafold.com/mcp/. Auth pre-injected as `Authorization: Key ...`. Use for listing Datafold data sources, running queries against configured data sources, and managing Data Diff workflows. Tools appear under `mcp__datafold__*` after a fresh container wake.',
    });
  }

  // Atlassian via sooperset/mcp-atlassian (stdio Python MCP, ~72 tools).
  // Gated by tool entry. Hits the tenant's direct Atlassian REST API rather
  // than Rovo MCP. OneCLI injects the Basic credential at request time; the
  // non-secret tenant URL is resolved from scoped host configuration.
  if (declared(['atlassian'])) {
    const baseUrl = resolveScopedEnvVar('ATLASSIAN_BASE_URL', folder);
    services.push({
      // Renamed from "Atlassian (Jira + Confluence)": the product list belongs
      // in the roster hint, and the name doubles as the lookup key for
      // `get_capabilities({ service })`.
      name: 'Atlassian',
      mcpNamespace: 'mcp__atlassian__*',
      declaredTools: declaredMatchingTools(['atlassian']),
      scopes: [],
      credentialPaths: [],
      summary: baseUrl.set
        ? 'Jira + Confluence, ~72 tools: JQL/CQL search, issues, transitions, pages, comments'
        : 'Jira + Confluence declared but ATLASSIAN_BASE_URL is unset — ask the operator',
      useFor: baseUrl.set
        ? `Jira + Confluence via sooperset/mcp-atlassian (direct REST against ${process.env[baseUrl.name]}). Auth pre-injected (Authorization: Basic). ~72 typed tools — Jira: \`mcp__atlassian__jira_search\`, \`jira_get_issue\`, \`jira_create_issue\`, \`jira_update_issue\`, \`jira_add_comment\`, \`jira_get_transitions\`, \`jira_transition_issue\`, project/sprint/board ops, attachments. Confluence: \`mcp__atlassian__confluence_search\`, \`confluence_get_page\`, \`confluence_create_page\`, \`confluence_update_page\`, \`confluence_get_comments\`. Use JQL for Jira search and CQL for Confluence search. NOT available via this surface: Compass and Teamwork Graph.`
        : `Atlassian tool declared but ATLASSIAN_BASE_URL is not configured for this agent group. Ask the operator to set the scoped host value before using Jira or Confluence.`,
    });
  }

  // dbt-mcp — gated by tool entry. dbt-labs/dbt-mcp baked into image via uv
  // (Python 3.12, isolated venv). Container-runner wires the stdio MCP server
  // with credentials resolved per-group: DBT_HOST_<FOLDER>, reuses
  // DBT_CLOUD_API_TOKEN_<FOLDER> as DBT_TOKEN, plus DBT_PROD_ENV_ID/
  // DBT_DEV_ENV_ID/DBT_USER_ID/DBT_MULTICELL_ACCOUNT_PREFIX. Read-only by
  // default: CLI/LSP toolsets disabled, mutating Admin tools (trigger/cancel/
  // retry job_run) blocked via DISABLE_TOOLS.
  if (declared(['dbt-mcp'])) {
    const host = resolveScopedEnvVar('DBT_HOST', folder);
    const token = resolveScopedEnvVar('DBT_CLOUD_API_TOKEN', folder);
    const prodEnvId = resolveScopedEnvVar('DBT_PROD_ENV_ID', folder);
    const credsReady = host.set && token.set && prodEnvId.set;
    services.push({
      name: 'dbt Cloud (dbt-mcp)',
      mcpNamespace: 'mcp__dbt-mcp__*',
      declaredTools: declaredMatchingTools(['dbt-mcp']),
      scopes: [],
      credentialPaths: [],
      summary: credsReady
        ? 'Model lineage/health, Semantic Layer metrics, execute_sql, job-run history (read-only)'
        : 'dbt-mcp declared but its host credentials are incomplete — ask the operator',
      useFor: credsReady
        ? `dbt Cloud via dbt-labs/dbt-mcp on \`${process.env[host.name]}\` (prod env \`${process.env[prodEnvId.name]}\`). Discovery API (project intelligence): \`mcp__dbt-mcp__get_all_models\`, \`get_mart_models\`, \`get_model_details\`, \`get_model_parents\`, \`get_model_children\`, \`get_lineage\`, \`get_model_health\`, \`get_model_performance\`, \`get_related_models\`, \`get_exposures\`, \`get_all_macros\`, \`get_all_sources\`, \`search\`. Semantic Layer: \`list_metrics\`, \`query_metrics\`, \`list_saved_queries\`, \`get_dimensions\`, \`get_entities\`, \`get_metrics_compiled_sql\`. SQL on dbt Platform: \`execute_sql\`, \`text_to_sql\`. Admin API (read-only by default — \`trigger_job_run\`, \`cancel_job_run\`, \`retry_job_run\` are disabled): \`list_projects\`, \`list_jobs\`, \`get_job_details\`, \`list_jobs_runs\`, \`get_job_run_details\`, \`get_job_run_error\`, \`list_job_run_artifacts\`. dbt CLI and LSP toolsets are disabled (no local project mounted). For ad-hoc Cloud REST not exposed here, fall back to \`curl -H "Authorization: Token $DBT_CLOUD_API_TOKEN_${folder.toUpperCase().replace(/-/g, '_')}"\`.`
        : `dbt-mcp tool declared but credentials missing: ${[!host.set && 'DBT_HOST', !token.set && 'DBT_CLOUD_API_TOKEN', !prodEnvId.set && 'DBT_PROD_ENV_ID'].filter(Boolean).join(', ')} not set on host (looked for \`*_${folder.toUpperCase().replace(/-/g, '_')}\` then unscoped fallback). Ask the operator.`,
    });
  }

  // Looker — gated by tool entry. Google's MCP Toolbox (--prebuilt looker) is
  // baked into the image; container-runner wires the stdio MCP server with
  // credentials resolved per-group from LOOKER_*_<FOLDER> env vars. The
  // toolbox exchanges client_id/client_secret for a session token via
  // /api/4.0/login on first call.
  if (declared(['looker'])) {
    const baseUrl = resolveScopedEnvVar('LOOKER_BASE_URL', folder);
    const clientId = resolveScopedEnvVar('LOOKER_CLIENT_ID', folder);
    const clientSecret = resolveScopedEnvVar('LOOKER_CLIENT_SECRET', folder);
    const credsReady = baseUrl.set && clientId.set && clientSecret.set;
    services.push({
      name: 'Looker',
      mcpNamespace: 'mcp__looker__*',
      declaredTools: declaredMatchingTools(['looker']),
      scopes: [],
      credentialPaths: [],
      summary: credsReady
        ? 'Query explores, run raw SQL, inspect LookML, run saved Looks and dashboards'
        : 'Looker declared but its host credentials are incomplete — ask the operator',
      useFor: credsReady
        ? `Looker via Google's MCP Toolbox (--prebuilt looker), instance \`${process.env[baseUrl.name]}\`. Auth via API3 client_id/client_secret (resolved from host env \`${clientId.name}\`). Use for: LookML inspection (\`mcp__looker__get_projects\`, \`get_project_files\`, \`get_project_file\`), inline queries against explores (\`mcp__looker__query\`), raw SQL (\`mcp__looker__query_sql\`), rerunning a UI URL (\`mcp__looker__query_url\`), browsing models/explores/dimensions/measures, listing/running saved Looks and dashboards, warehouse schema introspection (\`get_connection_*\`). Gaps: scheduled plans, alerts, user/role admin, PDT controls — fall back to direct Looker REST API via \`curl\` if needed.`
        : `Looker tool declared but credentials missing: ${[!baseUrl.set && 'LOOKER_BASE_URL', !clientId.set && 'LOOKER_CLIENT_ID', !clientSecret.set && 'LOOKER_CLIENT_SECRET'].filter(Boolean).join(', ')} not set on host (looked for \`*_${folder.toUpperCase().replace(/-/g, '_')}\` then unscoped fallback). Ask the operator.`,
    });
  }

  // Hex — gated by tool entry. The `hex` CLI is baked into the image and
  // wrapped to read XDG_DATA_HOME=/workspace/extra/.local/share so it picks
  // up the mounted host data dir. Auth is OAuth-only (no static-token mode);
  // operator runs `hex auth login` once on host, tokens land in
  // ~/.local/share/hex/default-credentials.json which mounts RW so the CLI's
  // refresh flow can update access tokens. The container-skill at
  // /app/skills/hex/SKILL.md (Hex-authored, regenerated via `hex install
  // agent-skill --claude`) covers the full surface including CLI-only
  // features (cell run, project export/import, suggestion triage, guide
  // preview/publish) that REST does not expose.
  if (declared(['hex'])) {
    const credsExist = hostDirExists('.local', 'share', 'hex');
    services.push({
      name: 'Hex',
      cli: 'hex',
      declaredTools: declaredMatchingTools(['hex']),
      scopes: [],
      credentialPaths: ['/workspace/extra/.local/share/hex/default-credentials.json'],
      summary: credsExist
        ? 'Hex CLI: list/read/run projects and cells, export project YAML, Context Studio, guides'
        : 'Hex declared but the host holds no `hex auth login` credentials — ask the operator',
      activation: credsExist
        ? `\`hex\` CLI ready. Skill at \`/app/skills/hex/SKILL.md\` documents the full command surface. Common verbs: \`hex projects list --json\`, \`hex project get <id> --json\`, \`hex cell list --project-id <id> --json\`, \`hex cell run <cell-id>\`, \`hex project run <id> --watch\`, \`hex suggestion list --json\` (Context Studio), \`hex guide preview\` then \`hex guide publish <preview-id>\`, \`hex project export <id> > project.yaml\`. Always pass \`--json\` when parsing programmatically. If \`hex auth status\` reports not authenticated, the host operator needs to re-run \`hex auth login\` — do NOT attempt OAuth from inside the container.`
        : `Hex tool declared but \`~/.local/share/hex/\` is empty on the host. Ask the operator to run \`hex auth login\` on the host once. Mount allowlist: \`/home/ubuntu\` is already covered (no /manage-mounts call needed).`,
    });
  }

  // Slack — SESSION-AWARE, because the user token (which reads the OWNER's
  // Slack lens) is scoped per session by the owner-safe boundary:
  //
  //   - owner-safe session (owner 1:1 DM, or messaging_group in
  //     slack_user_token.also_allowed_in): the Slack OneCLI secret is injected
  //     → the agent has live Slack read/write access here.
  //   - non-owner-safe session (anything else): the host spawns under the
  //     `-noslack` OneCLI identity with the Slack secret WITHHELD → no Slack
  //     access here, by design, so teammates can't extract the owner's Slack
  //     through the agent. (isOwnerSafeSlackSession, slack-user-token-gate.ts:108;
  //     the two-tier identity, src/container-runner.ts:6941.)
  //
  // The access itself is one surface: the Slack Web API through the OneCLI
  // proxy (`curl https://slack.com/api/<method>`, no auth header). There is no
  // Slack MCP — the korotovsky server that used to sit on top was retired
  // after it failed to connect on every spawn and its failure notice led an
  // agent to conclude Slack was down. `slack_user_token.enabled` no longer
  // gates anything, so the entry keys on the secret alone.
  //
  // `retainUnderBudget`: this entry is what stops the agent telling the owner
  // it can't read a Slack link, and it was the one the pre-turn capability
  // budget dropped (it sits late in this list and budget eviction pops from
  // the end). See evictCapability, src/modules/memory/pre-turn-context.ts:1629.
  const mergedSecrets = mergeWorkgroupAndGroupSecrets(central.workgroupSecrets, cfg?.onecliSecrets);
  const hasSlackSecret = slackUserTokenSecrets(mergedSecrets, cfg?.slack_user_token?.onecli_secret_names).length > 0;
  if (hasSlackSecret) {
    // ownerSafe is only knowable with a session context. When the snapshot is
    // built group-level (no session — e.g. the get_capabilities tool with no
    // messaging group), describe the capability generically rather than
    // fail-closed-withholding, which would under-claim.
    const sessionKnown = sessionMessagingGroupId !== undefined;
    const ownerSafe =
      sessionKnown &&
      withRawDb((db) =>
        isOwnerSafeSlackSession(
          db,
          agentGroupId,
          sessionMessagingGroupId ?? null,
          cfg?.slack_user_token?.also_allowed_in,
        ),
      );

    const archive =
      '`resolve_thread_link` resolves a pasted Slack OR Discord permalink from the workgroup chat archive (`/workspace/archive.db`) in any session. ';
    let useFor: string;
    // The roster line, not a shortened manual. The withheld branch is the one
    // case where the hint changes what the agent may DO, so it says so first
    // and in full — a truncated "WITHHELD…" would read as availability.
    let summary: string;
    if (sessionKnown && !ownerSafe) {
      // Shared session: Slack is genuinely withheld here. Be explicit so the
      // agent does NOT try curl and does NOT promise the owner a read.
      useFor =
        'WITHHELD IN THIS SESSION (by design): this session is not one of the owner’s private/owner-safe Slack contexts (their 1:1 DM, or a messaging group in `slack_user_token.also_allowed_in`), so the Slack user token is NOT injected into your OneCLI agent. You CANNOT read the owner’s Slack DMs/channels/threads here — `curl https://slack.com/api/*` will fail auth. This protects the owner’s Slack from being queried by others through you. (Unrelated to `session_mode` — every channel is still per-thread; this is purely about whose Slack credentials are in scope.) ' +
        archive +
        'If you genuinely need live Slack here, tell the owner to add this messaging group to `slack_user_token.also_allowed_in`.';
      summary =
        'WITHHELD IN THIS SESSION — no live Slack read/write here, by design. Pasted permalinks still resolve from the chat archive.';
    } else if (sessionKnown) {
      useFor =
        'LIVE in THIS session: `curl https://slack.com/api/<method>` with NO auth header — the OneCLI gateway injects the owner’s user token; there is no Slack MCP. PERMALINK `…/archives/C0123/p1789080120758779` → channel `C0123`, ts `1789080120.758779` (dot before the last 6 digits); read it with `conversations.replies?channel=C0123&ts=<the link’s thread_ts if present, else that ts>`. Also `conversations.history`, `search.messages`, `users.info`, `conversations.list`, `auth.test`. ' +
        'Never set your own `Authorization` header or ask for a token (the gateway overwrites it, so a 401 does NOT mean the credential is missing). `chat.postMessage` posts AS THE OWNER: only when they ask, and only if the token carries `chat:write` — `missing_scope` means it does not; say so, do not retry. ' +
        'FILES: `url_private` bytes live on `files.slack.com`, a SEPARATE credential. Try `curl -sSL -o <path> "<url_private>"`, no auth header, then check it: `text/html` or a leading `<!DOCTYPE` is Slack’s login page — that host is not wired here; say so and stop. Operator fix: a second vault entry, same token, host `files.slack.com`, path `*`, withheld like the first (see docs/slack-user-token.md). ' +
        archive +
        'Bottom line: never tell the owner you can’t read a Slack DM/thread/link without first trying `curl https://slack.com/api/auth.test` and the method above.';
      summary = 'LIVE here: slack.com/api by curl with NO auth header — read DMs/channels/threads/permalinks';
    } else {
      useFor =
        'Scoped to owner-safe Slack contexts (NOT `session_mode`): the owner’s 1:1 DM or a messaging group in `slack_user_token.also_allowed_in`; withheld everywhere else. Where present, all Slack read/write is `curl https://slack.com/api/<method>` with NO auth header (the OneCLI gateway injects the user token) — `conversations.history`/`conversations.replies` for a permalink (`p1789080120758779` → ts `1789080120.758779`), `search.messages`, `users.info`, and `chat.postMessage` if the token has `chat:write`. There is no Slack MCP. ' +
        archive +
        'Bottom line: confirm for the current session with `curl https://slack.com/api/auth.test` or `get_capabilities` before telling the owner you can’t read something.';
      summary =
        'slack.com/api by curl with NO auth header — only in the owner’s own Slack contexts; confirm with auth.test';
    }
    services.push({
      name: 'Slack',
      cli: 'curl',
      declaredTools: [],
      scopes: [],
      credentialPaths: [],
      summary,
      useFor,
      retainUnderBudget: true,
    });
  }

  // Cloudflare — official Cloudflare API MCP, gated on BOTH the workgroup's
  // OneCLI secret and the per-group MCP declaration. The secret alone is not
  // a usable agent surface, and the MCP without the secret cannot authenticate;
  // requiring both prevents the capabilities prompt from over-claiming access.
  const hasCloudflareSecret = mergedSecrets.some((s) => /^cloudflare(-|$)/i.test(s));
  const hasCloudflareMcp = !!cfg?.mcpServers?.['cloudflare-api'];
  if (hasCloudflareSecret && hasCloudflareMcp) {
    services.push({
      name: 'Cloudflare',
      mcpNamespace: 'mcp__cloudflare-api__*',
      declaredTools: declaredMatchingTools(['cloudflare']),
      scopes: folder ? [folder] : [],
      credentialPaths: [],
      summary: 'Cloudflare account APIs (DNS, Workers, Pages, R2) via docs → search → execute',
      useFor:
        'Official Cloudflare API MCP at https://mcp.cloudflare.com/mcp — auth pre-injected as `Authorization: Bearer`; do NOT ask for or send the token. Use `mcp__cloudflare-api__docs` for Cloudflare product documentation, `mcp__cloudflare-api__search` to locate the correct OpenAPI endpoint, then `mcp__cloudflare-api__execute` to call it. The server pre-selects the account from the token and exposes its `accountId` to execute code. Covers Cloudflare account APIs such as DNS, Workers, Pages, and R2 API endpoints, subject to the token’s granted permissions. Diagnosing Cloudflare auth failures — `mcp.cloudflare.com` and `api.cloudflare.com` are separately credentialed, so name the one that is actually broken instead of reporting "no Cloudflare access". `1000: Invalid API Token` does NOT by itself mean the token is bad — this install uses an ACCOUNT-scoped API token, and account tokens legitimately return `1000` on USER-scoped endpoints like `/user/tokens/verify`. Probe with an account-scoped call (`GET /accounts`) before concluding anything; a real `1000` there means the stored token is stale or rotated, and retrying cannot fix it. Never verify with `/user/tokens/verify` — it has produced a false "credential is dead" diagnosis twice. `1001 Missing "Authorization" header` from `api.cloudflare.com` means the opposite: nothing was injected on that host, because direct API access is wired separately (its own host-scoped OneCLI secret, or the OneCLI Cloudflare app connection) and may not be set up here. Distinguish them before concluding — `onecli apps get --provider cloudflare` shows whether the app connection exists (`connection: null` = not connected). Never add your own `Authorization` header to test any of this: on a host the gateway does not cover, your header is passed through and Cloudflare rejects its FORMAT (`6003`/`6111`), which reads like a token problem and has already caused a wrong diagnosis once. Send no header and read the error. Note `wrangler` is NOT installed in this container — deploys go through the REST API (Workers script upload, Pages Direct Upload), which is also the route that gets gateway injection. The separate S3-compatible access-key/secret pair is not exposed through this MCP; do not attempt AWS SDK/CLI access or claim direct S3 access unless a signing-capable S3 client is separately wired.',
    });
  }

  // Wix — gated on a Wix OneCLI secret (REST) and/or a mounted ~/.wix (CLI).
  // REST: the gateway injects the API key on www.wixapis.com. CLI: OAuth via the
  // mounted ~/.wix (operator ran `wix login` on the host). The site/account IDs
  // are NOT secret and differ per site, so they're supplied per task, never baked in.
  const hasWixSecret = mergedSecrets.some((s) => /wix/i.test(s));
  const hasWixCli = cfg?.wixHostAuth === true;
  if (hasWixSecret || hasWixCli) {
    const parts: string[] = [];
    if (hasWixSecret) {
      parts.push(
        'REST API at https://www.wixapis.com — auth pre-injected (do NOT set an Authorization header yourself). You MUST add exactly one target header: `wix-site-id: <SITE_ID>` for site-level APIs (Stores, Bookings, CMS/`wix-data`, Contacts) or `wix-account-id: <ACCOUNT_ID>` for account-level. These IDs are NOT secret and differ per site — the user gives you the one for the site you are working on; never hardcode or guess them. A 400 "missing site/account context" means the header is missing (or you sent both).',
      );
    }
    if (hasWixCli) {
      parts.push(
        '`wix` CLI for Velo local-dev + publish on git-integrated Wix sites — pre-authenticated via the mounted ~/.wix (run `wix whoami` to confirm; DO NOT run `wix login`). Use it to edit Velo page code and `wix publish`. It CANNOT create pages or place/position elements — that is a Wix-editor (human) action; once a page and its named elements exist, you wire them in code.',
      );
    }
    services.push({
      name: 'Wix',
      // `curl` when only the REST secret is wired, not `undefined`: the roster
      // renders `via` from `mcpNamespace ?? cli`, and this was the one entry
      // that could produce a line with no "how you reach it" at all. `curl` is
      // what every other gateway-injected REST entry here uses (Slack, SELECT,
      // Profound, Fivetran), and it is a lookup handle for `get_capabilities`.
      cli: hasWixCli ? 'wix' : 'curl',
      declaredTools: [],
      scopes: [],
      credentialPaths: hasWixCli ? ['/home/node/.wix/auth/account.json'] : [],
      summary: [
        hasWixSecret ? 'www.wixapis.com REST (you supply the wix-site-id / wix-account-id header)' : '',
        hasWixCli ? '`wix` CLI for Velo page code and publish' : '',
      ]
        .filter(Boolean)
        .join('; '),
      useFor: parts.join(' '),
    });
  }

  // SELECT (select.dev) — REST-only via the OneCLI gateway, gated on a
  // `Select-*` OneCLI secret. The organization id is non-secret, but still
  // tenant-specific, so it is resolved from scoped host configuration.
  if (mergedSecrets.some((s) => /^select(-|$)/i.test(s))) {
    const selectOrg = resolveScopedEnvVar('SELECT_ORGANIZATION_ID', folder);
    const organizationPath = selectOrg.set ? process.env[selectOrg.name] : '<organization_id>';
    services.push({
      // Renamed from "SELECT (select.dev)" — the domain belongs in the hint,
      // and the name doubles as the `get_capabilities` lookup key.
      name: 'SELECT',
      cli: 'curl',
      declaredTools: [],
      scopes: folder ? [folder] : [],
      credentialPaths: [],
      summary: selectOrg.set
        ? 'api.select.dev — Snowflake cost & usage analytics; routes are organization-scoped'
        : 'api.select.dev — Snowflake cost & usage; SELECT_ORGANIZATION_ID unset, ask the operator',
      useFor: `Snowflake cost & usage analytics REST API at https://api.select.dev — auth pre-injected as \`Authorization: Bearer\` (send NO auth header; the OneCLI gateway adds it at the boundary). Routes are organization-scoped: \`GET /api/${organizationPath}/...\` (for example \`/users\` and \`/usage-group-sets\`). ${selectOrg.set ? 'The organization id is configured for this agent group.' : 'SELECT_ORGANIZATION_ID is not configured for this agent group; ask the operator to set the scoped host value before calling the API.'} SELECT validates the key against the organization in the path, so a wrong or missing organization can return 401 even when the key is valid. Docs: https://api-docs.select.dev/ (route index at /llms.txt).`,
    });
  }

  // Profound — REST/reporting API via OneCLI. Gated on the workgroup OneCLI
  // secret name "Profound". No MCP/CLI surface is wired: agents call
  // api.tryprofound.com directly and the gateway injects X-API-Key.
  if (mergedSecrets.some((s) => /^profound$/i.test(s))) {
    services.push({
      name: 'Profound',
      cli: 'curl',
      declaredTools: [],
      scopes: folder ? [folder] : [],
      credentialPaths: [],
      summary: 'api.tryprofound.com — AI-search visibility, citations, sentiment, referral reports',
      useFor:
        'Profound REST/reporting API at https://api.tryprofound.com — auth pre-injected as `X-API-Key` (send NO auth header; the OneCLI gateway adds it at the boundary). Use for Profound organization discovery and reports: `GET /v1/org/categories`, `/v1/org/domains`, `/v1/org/models`, `/v1/org/regions`; report pulls such as `POST /v1/reports/visibility`, `/citations`, `/sentiment`, `/query-fanouts`, `/v1/prompts/answers`, `/v2/reports/referrals`, and `/v2/reports/bots`.',
    });
  }

  // Fivetran — REST-only via the OneCLI gateway, gated on a `Fivetran-*` OneCLI
  // secret. The gateway injects `Authorization: Basic <base64(apiKey:apiSecret)>`
  // at the boundary (e.g. vault entry "Fivetran-ExampleRetail" → api.fivetran.com).
  if (mergedSecrets.some((s) => /^fivetran(-|$)/i.test(s))) {
    services.push({
      name: 'Fivetran',
      cli: 'curl',
      declaredTools: [],
      scopes: [],
      credentialPaths: [],
      summary: 'api.fivetran.com — inspect and manage ingestion groups, connectors, users',
      useFor:
        'Data-ingestion / connector management REST API at https://api.fivetran.com (e.g. `GET /v1/groups`, `/v1/connectors`, `/v1/users`). Auth pre-injected as `Authorization: Basic` (send NO auth header; the OneCLI gateway adds it at the boundary). Docs: https://fivetran.com/docs/rest-api.',
    });
  }

  // Every MCP server this container actually gets that no entry above already
  // describes. `effectiveMcpServers` is the SAME merge the spawn path runs
  // (src/container-runner.ts, buildContainerArgs) — fleet defaults from
  // data/fleet-mcp-servers.json plus this group's own container.json entries,
  // minus `excludeMcpServers` — so a server the agent has is a server the
  // agent is told about, with no second list to keep in sync. Adding a tool is
  // one `ncl groups config add-mcp-server` away, with or without `--fleet`.
  //
  // "Already described" is matched on the namespace, not the label: an entry
  // whose `mcpNamespace` is `mcp__<name>__*` owns that server's text (Linear,
  // Datafold, Atlassian, dbt-mcp and Looker still write their own, because
  // each says something the stored entry cannot).
  const describedMcpServers = new Set(
    services
      .map((service) => service.mcpNamespace)
      .filter((namespace): namespace is string => typeof namespace === 'string')
      .map((namespace) => namespace.replace(/^mcp__/, '').replace(/__\*$/, '')),
  );
  // Fleet entries are the fleet-wide baseline every group inherits; a
  // group-specific server is the one a budget should give up first. Marking
  // the baseline `retainUnderBudget` is the same mechanism #862 used for
  // Slack, and for the same reason: an agent that loses the line stops
  // believing it has the tool. Keyed on the fleet REGISTRY, not on which copy
  // won the merge — a group that declares `littlebird` itself (all 24 do
  // today) holds the same capability. If every entry is retained the budget
  // still terminates: `evictCapability` pops the last one outright
  // (src/modules/memory/pre-turn-context.ts:1633).
  const fleetProvided = new Set(Object.keys(readFleetMcpServers()));
  const derived: SessionServicesSnapshot['services'] = [];
  for (const [name, server] of Object.entries(effectiveMcpServers(cfg))) {
    if (describedMcpServers.has(name)) continue;
    // A retired name still sitting in some group's container.json is deleted
    // from the merged map by the runner on every spawn
    // (container/agent-runner/src/retired-mcp-servers.ts:13, applied at
    // container/agent-runner/src/index.ts:256), so advertising it would
    // promise a tool that cannot exist — the exact failure docs/slack-user-token.md
    // documents. The entry stays in the spawn payload, where the runner logs
    // the drop for the operator; it just never reaches the agent's capability
    // list.
    if (RETIRED_MCP_SERVER_NAMES.has(name)) continue;
    // A hand-edited container.json can hold a malformed entry: the group file's
    // `validateMcpServers` refuses only SSE (src/container-config.ts:573-590),
    // so `null` reaches here. One bad entry must not cost the whole snapshot —
    // an agent with no capability list is the worse failure by far.
    if (server === null || typeof server !== 'object') continue;
    // Every string this block reads off a stored server goes through
    // `storedString`. The type says these are strings, but a hand-edited
    // container.json is not type-checked on the way in: `validateMcpServers`
    // refuses only SSE (src/container-config.ts:575), and
    // `parseMcpServerConfig`, which DOES type-check `displayName` and
    // `description` (src/container-config.ts:445-452), only runs on CLI
    // intake. Untyped values reaching the string helpers here throw, and this
    // function's caller catches — so `buildPreTurnContext` degrades to an
    // empty roster and `writeCapabilitiesSnapshot` logs and writes nothing.
    // One malformed entry would hide every valid service, which is the same
    // failure the `server === null` skip above exists to prevent.
    const displayName = storedString(server.displayName);
    const description = storedString(server.description);
    derived.push({
      name: displayName ?? name.charAt(0).toUpperCase() + name.slice(1),
      mcpNamespace: `mcp__${name}__*`,
      declaredTools: declaredMatchingTools([name]),
      scopes: [],
      credentialPaths: [],
      // A stored server has no hand-written roster line, so derive one from
      // the same `description` the full entry carries — its leading clause is
      // written to say what the server is for, which is what the roster needs.
      // With no description there is nothing to say but where it dials:
      // `genericMcpUseFor`'s full sentence would spend ~60 roster characters
      // restating the namespace that the entry's `via` already carries.
      summary: description === undefined ? mcpEndpoint(server) : summarizeCapabilityText(description, 80),
      useFor: description ?? genericMcpUseFor(name, server),
      ...(fleetProvided.has(name) ? { retainUnderBudget: true } : {}),
    });
  }
  // Fleet entries first inside the derived block, group-specific after, so the
  // block reads in the order the hardcoded universals used to (exa, deepwiki,
  // …) and a group's own servers sit later — nearer the end the budgets eat
  // from. `Object.entries` would otherwise lead with the group's own map.
  derived.sort((a, b) => Number(Boolean(b.retainUnderBudget)) - Number(Boolean(a.retainUnderBudget)));
  services.splice(derivedMcpIndex, 0, ...derived);

  return { agentGroupId, howToUse: CAPABILITY_ROSTER_PREAMBLE, services };
}

/**
 * Capability text for a stored MCP server that carries no `description`.
 *
 * Deliberately says nothing about what the server does — that is the
 * `description` field's job — and names only the endpoint the agent needs to
 * reason about, in one short line: every derived entry costs the capability
 * budget (`PRE_TURN_BOUNDS.capabilityTotalChars`), and a described server
 * spends those characters saying something useful instead.
 *
 * A URL is safe to print: `parseMcpServerConfig` refuses one carrying
 * credentials at intake (src/container-config.ts:477-501), and the agent reads
 * the same value in its own read-only container.json mount
 * (src/container-runner.ts:4877). `env` and `headers` are never rendered —
 * those DO carry placeholder credentials.
 */
function genericMcpUseFor(name: string, server: McpServerConfig): string {
  return `MCP server \`${name}\` (${mcpEndpoint(server)}); tools self-describe under \`mcp__${name}__*\`.`;
}

/**
 * What to print as a server's endpoint.
 *
 * Every remote MCP this fork wires as stdio is the bridge pattern — `command:
 * "bun"`, `args: ["/app/src/remote-mcp-bridge.ts", "<endpoint>"]` (see
 * `container/agent-runner/src/remote-mcp-bridge.ts`, and the `dropbox` /
 * `amplitude` entries on this install) — so printing `command` alone says "bun" for
 * all of them and identifies nothing. Print what the bridge dials instead; a
 * genuine local subprocess still prints its command.
 *
 * Keyed on the PRESENCE of `url`, not on `type`. `HttpMcpServerConfig.type` is
 * required in the type (src/container-config.ts:109), but a hand-edited
 * container.json reaches here unvalidated for this field — `validateMcpServers`
 * refuses only SSE (src/container-config.ts:575) — and a `{ url }` entry with
 * no `type` then narrowed to the stdio arm and printed `undefined`, because
 * stdio's `command` is absent on it. Same defensive reasoning as the
 * `server === null` skip above.
 */
function mcpEndpoint(server: McpServerConfig): string {
  // Read as `unknown` rather than through the union's arms: the value came
  // off disk, so its runtime shape may not match either arm (see `storedString`).
  const stored = server as { url?: unknown; args?: unknown; command?: unknown };
  const url = storedString(stored.url);
  if (url !== undefined) return url;
  const args = Array.isArray(stored.args) ? (stored.args as unknown[]) : [];
  const [script, endpoint] = args;
  if (typeof script === 'string' && script.endsWith('remote-mcp-bridge.ts') && typeof endpoint === 'string') {
    return endpoint;
  }
  return storedString(stored.command) ?? 'endpoint unknown';
}

/**
 * A string field read off a stored MCP server, or `undefined` when the stored
 * value is not a usable string.
 *
 * `McpServerConfig` types these as strings, but nothing type-checks a
 * hand-edited `container.json` on the way in — see the block in
 * `buildSessionServicesSnapshotFrom` where the derived entries are built.
 * Every read of `displayName`, `description`, `url` and `command` in this file
 * goes through here, so one bad value degrades that one field instead of
 * throwing out of the whole snapshot.
 */
function storedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export async function getHostCapabilities(
  forAgentGroupId?: string,
  sessionMessagingGroupId?: string | null,
  /** The spawn-resolved workgroup; filters `plugins.installed` for a group snapshot. */
  workgroupId?: string,
): Promise<HostCapabilities> {
  const registered = getRegisteredChannelNames();

  const messagingGroups = await getAllMessagingGroups();
  const byChannel: Record<string, number> = {};
  for (const mg of messagingGroups) {
    byChannel[mg.channel_type] = (byChannel[mg.channel_type] ?? 0) + 1;
  }
  const active = Object.keys(byChannel).sort();

  const agentGroups = (await getAllAgentGroups()).map((ag) => {
    const cfg = readContainerConfig(ag.folder);
    return {
      id: ag.id,
      name: ag.name,
      folder: ag.folder,
      excludePlugins: cfg.excludePlugins ?? [],
      githubTokenEnv: cfg.githubTokenEnv ?? null,
    };
  });

  const credentialEnvSet = SCOPED_ENV_NAMES.filter((name) => {
    // "Set" means the base name OR any per-group scoped variant is set.
    if (process.env[name]) return true;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith(`${name}_`)) return true;
    }
    return false;
  });

  return {
    version: cachedVersion,
    channels: { registered, active },
    credentials: {
      gws: hostDirExists('.config', 'gws', 'accounts'),
      gmailMcp: hostDirExists('.gmail-mcp'),
      googleCalendarMcp: hostDirExists('.config', 'google-calendar-mcp'),
      googleWorkspaceMcp: hostDirExists('.google_workspace_mcp', 'credentials'),
      snowflake: hostDirExists('.snowflake'),
      dbt: hostDirExists('.dbt'),
      aws: hostDirExists('.aws'),
      gcloudKeys: hostDirExists('.gcloud-keys'),
      codex: hostDirExists('.codex'),
    },
    plugins: {
      builtin: [],
      installed: installedPluginsFor(forAgentGroupId, workgroupId),
    },
    agentGroups,
    messagingGroupsByChannel: byChannel,
    credentialEnvSet,
    session: forAgentGroupId ? await buildSessionServicesSnapshot(forAgentGroupId, sessionMessagingGroupId) : undefined,
  };
}
