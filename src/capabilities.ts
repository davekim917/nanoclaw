/**
 * Capability self-awareness: what this install can do right now (channels, credentials, plugins, agent groups,
 * flags), read by the agent's `get_capabilities` tool and any other consumer.
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
import { gatewayRestHosts, mergeWorkgroupAndGroupSecrets, slackUserTokenSecrets } from './onecli-secrets.js';
import { GITHUB_APP_SENTINEL, peekGitHubAppTokenExpiry } from './github-app-token.js';
import { GH_TOKEN_CONTAINER_PATH, githubTokenDeliveredAsEnv } from './github-token-file.js';
import { isOwnerSafeSlackSession } from './modules/permissions/slack-user-token-gate.js';
import { getAllMessagingGroups } from './db/messaging-groups.js';
import { loadPluginScopes, pluginAllowedForWorkgroup } from './plugin-scopes.js';
import { extractToolScopes } from './scoped-env.js';

let cachedVersion = '0.0.0';
try {
  const pkgPath = path.resolve(GROUPS_DIR, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  cachedVersion = pkg.version || '0.0.0';
} catch {
  // Version is informational only.
}

export interface HostCapabilities {
  version: string;

  channels: {
    registered: string[];
    /** Channels with at least one wired messaging_group. */
    active: string[];
  };

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

  plugins: {
    builtin: string[]; // reserved for future always-on built-ins; currently empty
    installed: string[]; // ~/plugins/* subdirs
  };

  agentGroups: Array<{
    id: string;
    name: string;
    folder: string;
    excludePlugins: string[];
    githubTokenEnv: string | null;
  }>;

  messagingGroupsByChannel: Record<string, number>;

  /** Which scoped credential env names are set. Values are never returned. */
  credentialEnvSet: string[];

  /**
   * Per-service view for the owning agent group, including the exact CLI activation step: without it the agent
   * sees `credentials.gws: true` plus `auth_method: none` and wrongly concludes it is unauthenticated. Present
   * only when `forAgentGroupId` is passed.
   */
  session?: SessionServicesSnapshot;
}

export interface SessionServicesSnapshot {
  agentGroupId: string;
  /**
   * The roster's standing instruction, carried on the snapshot so the runner's fresh-context fallback renders
   * the same text from `/workspace/capabilities.json` instead of a drifting copy.
   */
  howToUse?: string;
  services: Array<{
    /** Also the case-insensitive lookup key for `get_capabilities({ service })`, so keep it short and typeable. */
    name: string;
    /** Omitted for MCP-only services. */
    cli?: string;
    mcpNamespace?: string;
    declaredTools: string[];
    scopes: string[];
    /** Container paths, not host paths. */
    credentialPaths: string[];
    activation?: string;
    /**
     * The ~80-char line this service gets in the always-on roster; the how-to prose (`useFor`/`activation`) is
     * fetched on demand. Absent means the roster derives one from that prose, as a fallback.
     */
    summary?: string;
    /**
     * Host-cached credential expiry (ISO-8601) for short-TTL tokens. A running container's env copy was frozen
     * at spawn, so 401s while this shows a future expiry mean a stale spawn-time token: restart fixes it.
     */
    expiresAt?: string;
    /** When-to-use guidance, for services where the gap is reaching for the tool rather than authenticating. */
    useFor?: string;
    /**
     * Never evicted by a capability budget while an entry without it can be, for entries whose absence makes
     * the agent deny an ability it has. Honoured by `evictCapability` at every host eviction site and in the
     * runner's fresh-context fallback.
     */
    retainUnderBudget?: boolean;
  }>;
}

function hostDirExists(...parts: string[]): boolean {
  return fs.existsSync(path.join(os.homedir(), ...parts));
}

/**
 * Heads the always-on roster. Sentence one exists because agents denied tools wired in their own container;
 * sentence two keeps the roster affordable by putting each manual one call away. Sentence three must stay
 * always-on: prohibitions only work if read before the agent decides to look anything up.
 */
export const CAPABILITY_ROSTER_PREAMBLE =
  'EVERY service listed here is wired into THIS session right now — never tell the user you lack one of them, and never ask for its credentials. ' +
  'These are one-line reminders, not instructions: before you first use a service in a session, call `get_capabilities` with `{"service":"<name>"}` for its full usage notes (auth, exact tool names, known failure shapes). ' +
  'Credentials are injected for you at spawn, so NEVER run an interactive login or auth command in this container (`gh auth login`, `wix login`, `hex auth login`, `aws configure`, `aws sso login`, `snow login`, …) and NEVER set your own `Authorization` header on a gateway-injected service — the gateway overwrites it, so a 401 there is not evidence the credential is missing. If a credential genuinely fails, report it to the operator instead of re-authenticating.';

export interface CapabilityRosterEntry {
  name: string;
  /** `mcp__looker__*`, `gws`, `curl`, … */
  via: string;
  /** ~80-char hint. Absent only when a service carries no text at all. */
  use?: string;
  /** See SessionServicesSnapshot.services.expiresAt. */
  expiresAt?: string;
  retainUnderBudget?: boolean;
}

export interface CapabilityRoster {
  agentGroupId: string;
  howToUse: string;
  services: CapabilityRosterEntry[];
}

/** Fallback hint: the leading clause of the how-to prose, cut at a sentence end, else at a word boundary. */
function summarizeCapabilityText(text: string, limit = 96): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  const sentence = flat.slice(0, limit + 1).match(/^(.*?[.!?])\s/);
  if (sentence?.[1] && sentence[1].length >= 24) return sentence[1];
  const cut = flat.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 24 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.\s]+$/, '')}…`;
}

/**
 * Reduce a services snapshot to the always-on roster. Deliberately lossy: the full prose stays in
 * `/workspace/capabilities.json` and reaches the agent through `get_capabilities({ service })`.
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

/**
 * A name list bounded to fit the roster hint; over budget it collapses to a count. Load-bearing: these lists are
 * the only unbounded part of a hint, and `boundedText` clips from the end, where the safety imperative is.
 */
export function boundedNameList(names: string[], budget = ROSTER_NAME_LIST_CHARS): string {
  const joined = names.join(', ');
  if (joined.length <= budget) return joined;
  return `${names.length} available — get_capabilities for names`;
}

/** Derived from the longest fixed hint part (152 of a 200-char cap); `capabilities.test.ts` checks the worst case. */
const ROSTER_NAME_LIST_CHARS = 48;

function rosterFallbackUse(service: SessionServicesSnapshot['services'][number]): string | undefined {
  const text = service.activation ?? service.useFor;
  return text === undefined ? undefined : summarizeCapabilityText(text);
}

/** Must stay in sync with SCOPED_CREDENTIAL_VARS in container-runner. */
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
  // OPENAI_API_KEY and DEEPGRAM_API_KEY are deliberately absent: neither has a working key, so advertising them
  // made every call 401. The codex provider reads its own OPENAI_API_KEY fallback.
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
 * Host plugins as one agent group may see them: a group snapshot must not name another workgroup's scoped
 * plugin, so it filters by the spawn-resolved `workgroupId`; with none, every scoped plugin is withheld.
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

/** Mirror of container-runner.ts resolveScopedEnv, duplicated to avoid cross-module coupling. */
function resolveScopedEnvVar(baseName: string, folder: string): { name: string; set: boolean } {
  const conv = `${baseName}_${folder.toUpperCase().replace(/-/g, '_')}`;
  if (process.env[conv]) return { name: conv, set: true };
  if (process.env[baseName]) return { name: baseName, set: true };
  return { name: baseName, set: false };
}

/** Section headers of an INI-like file (aws credentials, snowflake connections.toml). */
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

/** Top-level keys of a dbt profiles.yml (any simple YAML keyed at column 0). */
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
 * The central-DB facts a services snapshot needs, resolved by the caller beforehand: the recall row is built
 * between a write guard and its insert, where nothing may be awaited.
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
 * Synchronous: filesystem and config plus one lease-only central read (the Slack owner-safety probe); callable
 * only inside a `withCentralSync` block.
 */
export function buildSessionServicesSnapshotFrom(
  agentGroupId: string,
  central: SessionServicesCentral,
  sessionMessagingGroupId?: string | null,
): SessionServicesSnapshot {
  const ag = central.agentGroup;
  const cfg = ag ? readContainerConfig(ag.folder) : undefined;
  // Must resolve by the same credential folder the MCP wiring uses: a sibling group sets `credentialFolder` to
  // the seed's, and its own folder's scoped vars never exist, which would falsely report credentials missing.
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
      name: 'Google Workspace',
      cli: 'gws',
      declaredTools: gwsDeclared,
      scopes: [...scopes].sort(),
      credentialPaths: effective.map((a) => `/home/node/.config/gws/accounts/${a}.json`),
      // Names the env var and the `auth_method: none` symptom on both branches: that report is the misreading
      // this entry exists to prevent.
      summary:
        effective.length > 0
          ? `Gmail/Calendar/Drive/Docs/Sheets/Slides (${boundedNameList(effective)}); export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE — \`auth_method: none\` means that var is unset, not missing creds`
          : 'No gws account file on the host yet; once there is one, export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE — `auth_method: none` means that var is unset, not missing creds',
      activation:
        effective.length > 0
          ? `export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/<name>.json (valid names: ${effective.join(', ')}). Verify with \`gws auth status\` — WITHOUT this env var gws reports auth_method: none even though creds are mounted.`
          : 'no authenticated account files found in /home/node/.config/gws/accounts/',
    });
  }

  // Scope suffix is the connection passed to `snow -c <name>`.
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
          ? `Run SQL on the warehouse: \`snow sql -c ${effective[0]}\` (connections: ${boundedNameList(effective)})`
          : 'SQL on the warehouse — no matching connection in connections.toml',
      activation:
        effective.length > 0
          ? `snow sql -q "SELECT ..." -c <connection>. Valid connections in this session: ${effective.join(', ')}.`
          : 'no matching connections found in connections.toml',
    });
  }

  // Scope suffix is --profile.
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
          ? `AWS CLI against profiles ${boundedNameList(effective)} (pass --profile)`
          : 'AWS CLI — credentials mounted but no matching scoped profile',
      activation:
        effective.length > 0
          ? `aws --profile <name> <command>. Valid profiles in this session: ${effective.join(', ')}. Verify with \`aws sts get-caller-identity --profile <name>\`.`
          : 'aws credentials mounted but no matching scoped profiles found',
    });
  }

  // Profiles are ~/.dbt/profiles.yml top-level keys; scope suffix is --profile.
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
          ? `dbt CLI (run/compile/test/build) on profiles ${boundedNameList(effective)}`
          : 'dbt CLI — profiles.yml mounted but no matching scoped profile',
      activation:
        effective.length > 0
          ? `dbt run --profile <name> --project-dir <path> (also compile/test/build). Valid profiles in this session: ${effective.join(', ')}.`
          : 'profiles.yml mounted but no matching scoped profiles found',
    });
  }

  // Env-var-scoped, surfaced whenever a token resolves for this folder; no `tools` declaration needed.
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

  // Gated on the token OR a tools declaration: the host injects GITHUB_TOKEN by folder regardless of `tools`, so
  // credential availability decides access; the `declared` arm keeps the "configured but token missing" case.
  {
    const tokenEnvName = cfg?.githubTokenEnv ?? null;
    const resolved =
      tokenEnvName && process.env[tokenEnvName]
        ? { name: tokenEnvName, set: true }
        : resolveScopedEnvVar('GITHUB_TOKEN', folder);
    if (resolved.set || declared(['github'])) {
      const scopeList = extractToolScopes(tools, 'github').scopes;
      const allowedOrgs = resolveScopedEnvVar('GITHUB_ALLOWED_ORGS', folder);
      // Expiry applies only when this group authenticates as the App: a PAT group must never be told its token
      // expires on another installation's schedule.
      const resolvedTokenValue = resolved.set ? process.env[resolved.name] : undefined;
      const isAppSentinel = resolvedTokenValue === GITHUB_APP_SENTINEL;
      const githubTokenExpiresAt = isAppSentinel ? peekGitHubAppTokenExpiry() : undefined;
      // A PAT group must never have a real authorization failure explained away as App behavior.
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
          ? '`gh` and the VCS CLI are pre-authenticated: repos, PRs, pushes, and CI/Actions status. Never run `gh auth login`'
          : 'GitHub declared but no token resolved on the host — ask the operator, do not run `gh auth login`',
        activation: resolved.set
          ? `\`gh\` and \`git\` both pre-authenticated from host env \`${resolved.name}\`${githubTokenDeliveredAsEnv() ? `, forwarded to you as \`GITHUB_TOKEN\`` : ` and delivered as a read-only file at \`${GH_TOKEN_CONTAINER_PATH}\` — the git credential helper and the \`gh\` shim read it per invocation, so the host's hourly re-mint reaches you without a restart, and there is deliberately no \`GITHUB_TOKEN\` in your env`}${
              allowedOrgs.set ? `, restricted to orgs: \`${process.env[allowedOrgs.name]}\`` : ''
            }. \`gh repo view\`, \`gh pr create\`, \`git push\` all work directly. **CI/Actions is included, not a separate integration** — you CAN check build and test status yourself, and must never tell the user you lack access to CI. \`gh pr checks <pr>\` for a PR's check rollup (GraphQL statusCheckRollup under the hood), \`gh run list --branch <branch>\`, \`gh run view <run-id> --log-failed\` for the failing step's output, \`gh run watch <run-id>\` to block until it settles.${tokenShapeNote} A 403 on one endpoint can be a permissions shape rather than a dead credential — before reporting lost access, retry the same read through a different GitHub surface (\`gh api\` covers every endpoint with this same token). To poll a run without burning a turn, use the \`wait\` tool rather than sleeping. DO NOT run \`gh auth login\`. DO NOT ask the user for a token — the credential is already wired up for you.`
          : `GitHub tool declared but no token set at host env ${tokenEnvName ?? 'GITHUB_TOKEN_<folder>'} or fallback GITHUB_TOKEN — ask Operator.`,
        ...(resolved.set && githubTokenExpiresAt ? { expiresAt: githubTokenExpiresAt } : {}),
      });
    }
  }

  // Gated on env-var presence OR a tools declaration, as for GitHub.
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

  // Derived MCP entries are spliced in here, not appended: both capability budgets evict from the end, and the
  // fleet universals must not land in the eviction zone.
  const derivedMcpIndex = services.length;

  // Only for groups that opted in, so others do not claim Linear access they lack.
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

  // The OneCLI gateway overwrites the placeholder header; the raw key is never in container.json or env.
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

  // OneCLI injects the credential; the tenant URL comes from scoped host configuration.
  if (declared(['atlassian'])) {
    const baseUrl = resolveScopedEnvVar('ATLASSIAN_BASE_URL', folder);
    services.push({
      // Also the `get_capabilities` lookup key; the product list belongs in the hint.
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

  // Read-only by default: CLI/LSP toolsets disabled and mutating Admin tools blocked via DISABLE_TOOLS.
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

  // OAuth-only; the mounted credentials file is RW so the CLI's refresh flow can update tokens.
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

  // Session-aware: the user token reads the owner's Slack, so it is injected only in owner-safe sessions (owner
  // DM or `also_allowed_in`); elsewhere the spawn withholds it so teammates cannot extract the owner's Slack.
  // `retainUnderBudget`: this is the entry that stops the agent claiming it cannot read a Slack link.
  const mergedSecrets = mergeWorkgroupAndGroupSecrets(central.workgroupSecrets, cfg?.onecliSecrets);
  const hasSlackSecret = slackUserTokenSecrets(mergedSecrets, cfg?.slack_user_token?.onecli_secret_names).length > 0;
  if (hasSlackSecret) {
    // Without a session context, describe generically rather than withhold, which would under-claim.
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
    // The withheld branch changes what the agent may do, so it says so first and in full.
    let summary: string;
    if (sessionKnown && !ownerSafe) {
      // Explicit so the agent neither tries curl nor promises the owner a read.
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

  // Requires both the secret and the MCP declaration: either alone is not a usable surface.
  const hasCloudflareSecret = mergedSecrets.some((s) => /^cloudflare(-|$)/i.test(s));
  const hasCloudflareMcp = !!cfg?.mcpServers?.['cloudflare-api'];
  if (hasCloudflareSecret && hasCloudflareMcp) {
    services.push({
      name: 'Cloudflare',
      mcpNamespace: 'mcp__cloudflare-api__*',
      declaredTools: declaredMatchingTools(['cloudflare']),
      scopes: folder ? [folder] : [],
      credentialPaths: [],
      // Both imperatives are always-on: each forbids a misdiagnosis already made and believed.
      summary:
        'Cloudflare account APIs (DNS, Workers, Pages, R2) via docs → search → execute. Never verify with /user/tokens/verify, and send no Authorization header of your own',
      useFor:
        'Official Cloudflare API MCP at https://mcp.cloudflare.com/mcp — auth pre-injected as `Authorization: Bearer`; do NOT ask for or send the token. Use `mcp__cloudflare-api__docs` for Cloudflare product documentation, `mcp__cloudflare-api__search` to locate the correct OpenAPI endpoint, then `mcp__cloudflare-api__execute` to call it. The server pre-selects the account from the token and exposes its `accountId` to execute code. Covers Cloudflare account APIs such as DNS, Workers, Pages, and R2 API endpoints, subject to the token’s granted permissions. Diagnosing Cloudflare auth failures — `mcp.cloudflare.com` and `api.cloudflare.com` are separately credentialed, so name the one that is actually broken instead of reporting "no Cloudflare access". `1000: Invalid API Token` does NOT by itself mean the token is bad — this install uses an ACCOUNT-scoped API token, and account tokens legitimately return `1000` on USER-scoped endpoints like `/user/tokens/verify`. Probe with an account-scoped call (`GET /accounts`) before concluding anything; a real `1000` there means the stored token is stale or rotated, and retrying cannot fix it. Never verify with `/user/tokens/verify` — it has produced a false "credential is dead" diagnosis twice. `1001 Missing "Authorization" header` from `api.cloudflare.com` means the opposite: nothing was injected on that host, because direct API access is wired separately (its own host-scoped OneCLI secret, or the OneCLI Cloudflare app connection) and may not be set up here. Distinguish them before concluding — `onecli apps get --provider cloudflare` shows whether the app connection exists (`connection: null` = not connected). Never add your own `Authorization` header to test any of this: on a host the gateway does not cover, your header is passed through and Cloudflare rejects its FORMAT (`6003`/`6111`), which reads like a token problem and has already caused a wrong diagnosis once. Send no header and read the error. Note `wrangler` is NOT installed in this container — deploys go through the REST API (Workers script upload, Pages Direct Upload), which is also the route that gets gateway injection. The separate S3-compatible access-key/secret pair is not exposed through this MCP; do not attempt AWS SDK/CLI access or claim direct S3 access unless a signing-capable S3 client is separately wired.',
    });
  }

  // Site/account IDs differ per site and are supplied per task, never baked in.
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
      // Never `undefined`: the roster renders `via` from `mcpNamespace ?? cli`, and it is a lookup handle.
      cli: hasWixCli ? 'wix' : 'curl',
      declaredTools: [],
      scopes: [],
      credentialPaths: hasWixCli ? ['/home/node/.wix/auth/account.json'] : [],
      // Always-on: a guessed site id writes to the wrong site, and neither mistake prompts a lookup first.
      summary: [
        hasWixSecret
          ? 'www.wixapis.com REST — add exactly one wix-site-id/wix-account-id header, taken from the user, never hardcoded or guessed'
          : '',
        hasWixCli ? '`wix` CLI for Velo code and publish; never run `wix login`' : '',
      ]
        .filter(Boolean)
        .join('; '),
      useFor: parts.join(' '),
    });
  }

  // The organization id is tenant-specific, so it comes from scoped host configuration.
  if (mergedSecrets.some((s) => /^select(-|$)/i.test(s))) {
    const selectOrg = resolveScopedEnvVar('SELECT_ORGANIZATION_ID', folder);
    const organizationPath = selectOrg.set ? process.env[selectOrg.name] : '<organization_id>';
    services.push({
      // Also the `get_capabilities` lookup key; the domain belongs in the hint.
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

  // Every MCP server this container gets that no entry above describes. `effectiveMcpServers` is the same merge
  // the spawn runs, so there is no second list. "Already described" matches on namespace, not label.
  const describedMcpServers = new Set(
    services
      .map((service) => service.mcpNamespace)
      .filter((namespace): namespace is string => typeof namespace === 'string')
      .map((namespace) => namespace.replace(/^mcp__/, '').replace(/__\*$/, '')),
  );
  // The fleet baseline is retained under budget (an agent that loses the line stops believing in the tool);
  // keyed on the fleet registry, not on which copy won the merge. `evictCapability` still terminates.
  const fleetProvided = new Set(Object.keys(readFleetMcpServers()));
  const derived: SessionServicesSnapshot['services'] = [];
  for (const [name, server] of Object.entries(effectiveMcpServers(cfg))) {
    if (describedMcpServers.has(name)) continue;
    // The runner deletes retired names on every spawn (retired-mcp-servers.ts), so advertising one would promise
    // a tool that cannot exist.
    if (RETIRED_MCP_SERVER_NAMES.has(name)) continue;
    // A hand-edited container.json can hold a malformed entry; one bad entry must not cost the whole snapshot.
    if (server === null || typeof server !== 'object') continue;
    // Stored strings go through `storedString`: container.json is not type-checked on the way in, and a throw
    // here would empty the whole roster.
    const displayName = storedString(server.displayName);
    const description = storedString(server.description);
    derived.push({
      name: displayName ?? name.charAt(0).toUpperCase() + name.slice(1),
      mcpNamespace: `mcp__${name}__*`,
      declaredTools: declaredMatchingTools([name]),
      scopes: [],
      credentialPaths: [],
      // No hand-written line: derive from `description`; without one, just the endpoint.
      summary: description === undefined ? mcpEndpoint(server) : summarizeCapabilityText(description, 80),
      useFor: description ?? genericMcpUseFor(name, server),
      ...(fleetProvided.has(name) ? { retainUnderBudget: true } : {}),
    });
  }
  // Fleet entries first, group-specific after, so a group's own servers sit nearer the end the budgets eat from.
  derived.sort((a, b) => Number(Boolean(b.retainUnderBudget)) - Number(Boolean(a.retainUnderBudget)));
  services.splice(derivedMcpIndex, 0, ...derived);

  // Secrets the gateway injects into direct REST calls, keyed by host from OneCLI metadata (a name does not prove
  // REST injection). Without it, an agent finding no `<SERVICE>_API_KEY` in env concludes the service is unwired.
  const slackSecrets = new Set(slackUserTokenSecrets(mergedSecrets, cfg?.slack_user_token?.onecli_secret_names));
  const restHosts = [
    ...new Set(
      gatewayRestHosts(mergedSecrets.filter((secret) => !slackSecrets.has(secret)))
        // Slack's own entry carries the owner-safe withholding rule.
        .filter((entry) => !PROVIDER_SECRET.test(entry.name) && !/^slack(-|$)/i.test(entry.name))
        .map((entry) => entry.host),
    ),
  ];
  if (restHosts.length > 0) {
    services.push({
      name: 'OneCLI gateway',
      cli: 'curl',
      declaredTools: [],
      scopes: restHosts,
      credentialPaths: [],
      summary: `${boundedNameList(restHosts)}: call directly; auth is injected, no key in env`,
      useFor: `The gateway injects a credential into requests to: ${restHosts.join(', ')}. Call those hosts directly (curl, fetch, or the vendor SDK with any placeholder key). A missing \`<SERVICE>_API_KEY\` env var is expected there and is NOT evidence the service is unavailable; do not substitute a stub. A 401/403 from the host is the real signal; report it to the operator.`,
    });
  }

  return { agentGroupId, howToUse: CAPABILITY_ROSTER_PREAMBLE, services };
}

/** Model-provider keys: the runtime's own credential, not a service to call. */
const PROVIDER_SECRET = /^(anthropic|openai|opencode)(-|$)/i;

/**
 * Capability text for a stored MCP server with no `description`: the endpoint only, in one short line. A URL is
 * safe to print (intake refuses credentialed URLs); `env` and `headers` are never rendered.
 */
function genericMcpUseFor(name: string, server: McpServerConfig): string {
  return `MCP server \`${name}\` (${mcpEndpoint(server)}); tools self-describe under \`mcp__${name}__*\`.`;
}

/**
 * The endpoint the server dials: for the stdio bridge pattern (`bun remote-mcp-bridge.ts <endpoint>`) that is
 * the bridge argument, not "bun". Keyed on the presence of `url`, not `type`, because a hand-edited
 * container.json can omit `type`.
 */
function mcpEndpoint(server: McpServerConfig): string {
  // Read as `unknown`: the value came off disk and may match neither arm.
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
 * A stored MCP server string field, or `undefined` when unusable. Nothing type-checks a hand-edited
 * container.json, so one bad value degrades one field instead of throwing out of the snapshot.
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
