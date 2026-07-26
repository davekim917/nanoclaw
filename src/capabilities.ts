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

import { GROUPS_DIR } from './config.js';
import { getRegisteredChannelNames } from './channels/channel-registry.js';
import { readContainerConfig } from './container-config.js';
import { getDb } from './db/connection.js';
import { getAllAgentGroups, getAgentGroup, getWorkgroupOnecliSecrets } from './db/agent-groups.js';
import { mergeWorkgroupAndGroupSecrets, slackUserTokenSecrets } from './onecli-secrets.js';
import { isOwnerSafeSlackSession } from './modules/permissions/slack-user-token-gate.js';
import { getAllMessagingGroups } from './db/messaging-groups.js';
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
  services: Array<{
    /** Human label, e.g. "Google Workspace". */
    name: string;
    /** CLI binary the agent invokes. Omitted for MCP-only services. */
    cli?: string;
    /** MCP tool namespace (e.g. `mcp__exa__*`). Used for usage-guided entries. */
    mcpNamespace?: string;
    /** Tool names in container.json.tools that imply this service. */
    declaredTools: string[];
    /** Scope names parsed from tool entries (e.g. ['illysium','support-illysium']). */
    scopes: string[];
    /** What files / paths the container sees. Container path, not host path. */
    credentialPaths: string[];
    /** Concise activation instruction for the CLI, if any. */
    activation?: string;
    /**
     * When-to-use guidance for services where the gap is "agent doesn't
     * reach for the tool" rather than "agent can't authenticate". Populated
     * for exa, granola, etc. where there's no scope/account choice.
     */
    useFor?: string;
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
  'OPENAI_API_KEY',
  'BRAINTRUST_API_KEY',
  'EXA_API_KEY',
  'DEEPGRAM_API_KEY',
  'ELEVENLABS_API_KEY',
  'RESIDENTIAL_PROXY_URL',
  'SUPABASE_PROJECT_REF',
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_DB_PASSWORD',
  'LOOKER_BASE_URL',
  'LOOKER_CLIENT_ID',
  'LOOKER_CLIENT_SECRET',
];

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

export function buildSessionServicesSnapshot(
  agentGroupId: string,
  sessionMessagingGroupId?: string | null,
): SessionServicesSnapshot {
  const ag = getAgentGroup(agentGroupId);
  const cfg = ag ? readContainerConfig(ag.folder) : undefined;
  // Env-scoped services (Looker, dbt-mcp, dbt Cloud, GitHub, Render) resolve
  // their host creds by FOLDER via resolveScopedEnvVar. Sibling groups (e.g.
  // madison-reed-codex) set `credentialFolder` to the seed folder so they
  // share the seed's scoped creds, and the real MCP wiring keys on
  // credentialFolder too (container-runner resolveScopedEnv). The snapshot
  // MUST use the same folder, or it looks for LOOKER_*_MADISON_REED_CODEX
  // (which never exists), falls through to unscoped, and falsely reports
  // "credentials missing — Ask Dave" for every sibling.
  const folder = cfg?.credentialFolder ?? ag?.folder ?? '';
  const tools = cfg?.tools;
  const excludedMcpServers = new Set(cfg?.excludeMcpServers ?? []);
  const universalMcpAvailable = (name: string): boolean =>
    !excludedMcpServers.has(name) || cfg?.mcpServers?.[name] !== undefined;

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
      name: 'Google Workspace (Gmail / Calendar / Drive / Docs / Sheets / Slides)',
      cli: 'gws',
      declaredTools: gwsDeclared,
      scopes: [...scopes].sort(),
      credentialPaths: effective.map((a) => `/home/node/.config/gws/accounts/${a}.json`),
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
      services.push({
        name: 'GitHub',
        cli: 'gh',
        declaredTools: declaredMatchingTools(['github']),
        scopes: scopeList,
        credentialPaths: [],
        activation: resolved.set
          ? `\`gh\` and \`git\` both pre-authenticated via \`GITHUB_TOKEN\` (resolved from host env \`${resolved.name}\`)${
              allowedOrgs.set ? `, restricted to orgs: \`${process.env[allowedOrgs.name]}\`` : ''
            }. \`gh repo view\`, \`gh pr create\`, \`git push\` all work directly. DO NOT run \`gh auth login\`. DO NOT ask the user for a token — it's already in your env.`
          : `GitHub tool declared but no token set at host env ${tokenEnvName ?? 'GITHUB_TOKEN_<folder>'} or fallback GITHUB_TOKEN — ask Dave.`,
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
        activation: apiKey.set
          ? `\`render\` CLI authenticated via \`RENDER_API_KEY\` (from host env \`${apiKey.name}\`${workspace.set ? `, workspace via \`${workspace.name}\`` : ''}). Common: \`render services -o json\`, \`render logs --service-id <id>\`, \`render psql --service-id <pg-id>\`.${scopedDbEnv.length > 0 ? ` Scoped DB URLs also injected as env vars: ${scopedDbEnv.join(', ')}.` : ''} DO NOT ask the user for the API key — it's already in your env.`
          : `render tool declared but RENDER_API_KEY not set at host — ask Dave.`,
      });
    }
  }

  // Exa — universal. Always shown; container-runner injects the MCP
  // unconditionally and the OneCLI gateway proxy injects auth at request
  // time (vault entry "Exa-MCP" → mcp.exa.ai).
  if (universalMcpAvailable('exa')) {
    services.push({
      name: 'Exa',
      mcpNamespace: 'mcp__exa__*',
      declaredTools: declaredMatchingTools(['exa']),
      scopes: [],
      credentialPaths: [],
      useFor:
        'Web search, research, and code context. Prefer exa over ad-hoc WebSearch/WebFetch for: web search (`mcp__exa__web_search_exa`), company research (`mcp__exa__company_research_exa`), people search (`mcp__exa__people_search_exa`), deep research (`mcp__exa__deep_researcher_start` then `_check`), code context from public repos (`mcp__exa__get_code_context_exa`), crawling specific URLs (`mcp__exa__crawling_exa`).',
    });
  }

  // DeepWiki — always-on. No tool gate; host injects the MCP server unconditionally.
  if (universalMcpAvailable('deepwiki'))
    services.push({
      name: 'DeepWiki',
      mcpNamespace: 'mcp__deepwiki__*',
      declaredTools: [],
      scopes: [],
      credentialPaths: [],
      useFor:
        'AI-powered documentation for any public GitHub repo. Use when the user asks "how does repo X work", for reading wiki structure, fetching wiki contents, or asking free-form questions about a repo. Tools: `mcp__deepwiki__read_wiki_structure`, `mcp__deepwiki__read_wiki_contents`, `mcp__deepwiki__ask_question`.',
    });

  // Context7 — always-on. Fetches up-to-date library docs; useful when the
  // agent would otherwise rely on stale training knowledge.
  if (universalMcpAvailable('context7'))
    services.push({
      name: 'Context7',
      mcpNamespace: 'mcp__context7__*',
      declaredTools: [],
      scopes: [],
      credentialPaths: [],
      useFor:
        'Live library / framework / SDK / API docs — React, Next.js, Prisma, Tailwind, Claude SDKs, Stripe, etc. Prefer Context7 over training-memory for: library-specific debugging, API syntax, config options, version migrations, CLI usage. Do NOT use for refactoring, business logic, or general concepts.',
    });

  // Pocket — universal. Always shown; container-runner injects the MCP
  // unconditionally and the OneCLI gateway proxy injects auth at request
  // time (vault entry "Pocket" → public.heypocketai.com).
  if (universalMcpAvailable('pocket'))
    services.push({
      name: 'Pocket',
      mcpNamespace: 'mcp__pocket__*',
      declaredTools: declaredMatchingTools(['pocket']),
      scopes: [],
      credentialPaths: [],
      useFor:
        'Personal knowledge / memory via https://public.heypocketai.com/mcp. Auth pre-injected (Authorization: Bearer). Use Pocket tools to save references, recall prior context, search personal knowledge.',
    });

  // Granola — universal. Always shown; container-runner injects unconditionally.
  if (universalMcpAvailable('granola'))
    services.push({
      name: 'Granola',
      mcpNamespace: 'mcp__granola__*',
      declaredTools: declaredMatchingTools(['granola']),
      scopes: [],
      credentialPaths: [],
      useFor:
        'Meeting transcripts + notes via Granola REST API. Auth injected by OneCLI on public-api.granola.ai; no token visible in-container. Tools: `mcp__granola__list_meetings`, `mcp__granola__get_meeting` (set include_transcript=true for raw transcript).',
    });

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
      useFor:
        'Official Datafold Streamable HTTP MCP at https://app.datafold.com/mcp/. Auth pre-injected as `Authorization: Key ...`. Use for listing Datafold data sources, running queries against configured data sources, and managing Data Diff workflows. Tools appear under `mcp__datafold__*` after a fresh container wake.',
    });
  }

  // Atlassian via sooperset/mcp-atlassian (stdio Python MCP, ~72 tools).
  // Gated by tool entry. Hits the direct Atlassian REST API at
  // <site>.atlassian.net — NOT Rovo MCP, which requires an org admin to
  // grant per-user API token access. OneCLI gateway injects
  // `Authorization: Basic base64(email:api-token)` at request time (vault
  // entry "Atlassian" → madison-reed.atlassian.net). Covers Jira (issues,
  // projects, sprints, JQL search, transitions, comments, attachments,
  // bulk ops) and Confluence (pages, spaces, search, comments, content
  // creation/editing). Compass and Teamwork Graph are NOT available via
  // this surface — they're Rovo-only.
  if (declared(['atlassian'])) {
    services.push({
      name: 'Atlassian (Jira + Confluence)',
      mcpNamespace: 'mcp__atlassian__*',
      declaredTools: declaredMatchingTools(['atlassian']),
      scopes: [],
      credentialPaths: [],
      useFor:
        'Jira + Confluence via sooperset/mcp-atlassian (direct REST against madison-reed.atlassian.net). Auth pre-injected (Authorization: Basic). ~72 typed tools — Jira: `mcp__atlassian__jira_search`, `jira_get_issue`, `jira_create_issue`, `jira_update_issue`, `jira_add_comment`, `jira_get_transitions`, `jira_transition_issue`, project/sprint/board ops, attachments. Confluence: `mcp__atlassian__confluence_search`, `confluence_get_page`, `confluence_create_page`, `confluence_update_page`, `confluence_get_comments`. Use JQL for Jira search (`assignee = currentUser() AND status != Done` etc.) and CQL for Confluence search. NOT available via this surface: Compass, Teamwork Graph (those are Rovo MCP only).',
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
      useFor: credsReady
        ? `dbt Cloud via dbt-labs/dbt-mcp on \`${process.env[host.name]}\` (prod env \`${process.env[prodEnvId.name]}\`). Discovery API (project intelligence): \`mcp__dbt-mcp__get_all_models\`, \`get_mart_models\`, \`get_model_details\`, \`get_model_parents\`, \`get_model_children\`, \`get_lineage\`, \`get_model_health\`, \`get_model_performance\`, \`get_related_models\`, \`get_exposures\`, \`get_all_macros\`, \`get_all_sources\`, \`search\`. Semantic Layer: \`list_metrics\`, \`query_metrics\`, \`list_saved_queries\`, \`get_dimensions\`, \`get_entities\`, \`get_metrics_compiled_sql\`. SQL on dbt Platform: \`execute_sql\`, \`text_to_sql\`. Admin API (read-only by default — \`trigger_job_run\`, \`cancel_job_run\`, \`retry_job_run\` are disabled): \`list_projects\`, \`list_jobs\`, \`get_job_details\`, \`list_jobs_runs\`, \`get_job_run_details\`, \`get_job_run_error\`, \`list_job_run_artifacts\`. dbt CLI and LSP toolsets are disabled (no local project mounted). For ad-hoc Cloud REST not exposed here, fall back to \`curl -H "Authorization: Token $DBT_CLOUD_API_TOKEN_${folder.toUpperCase().replace(/-/g, '_')}"\`.`
        : `dbt-mcp tool declared but credentials missing: ${[!host.set && 'DBT_HOST', !token.set && 'DBT_CLOUD_API_TOKEN', !prodEnvId.set && 'DBT_PROD_ENV_ID'].filter(Boolean).join(', ')} not set on host (looked for \`*_${folder.toUpperCase().replace(/-/g, '_')}\` then unscoped fallback). Ask Dave.`,
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
      useFor: credsReady
        ? `Looker via Google's MCP Toolbox (--prebuilt looker), instance \`${process.env[baseUrl.name]}\`. Auth via API3 client_id/client_secret (resolved from host env \`${clientId.name}\`). Use for: LookML inspection (\`mcp__looker__get_projects\`, \`get_project_files\`, \`get_project_file\`), inline queries against explores (\`mcp__looker__query\`), raw SQL (\`mcp__looker__query_sql\`), rerunning a UI URL (\`mcp__looker__query_url\`), browsing models/explores/dimensions/measures, listing/running saved Looks and dashboards, warehouse schema introspection (\`get_connection_*\`). Gaps: scheduled plans, alerts, user/role admin, PDT controls — fall back to direct Looker REST API via \`curl\` if needed.`
        : `Looker tool declared but credentials missing: ${[!baseUrl.set && 'LOOKER_BASE_URL', !clientId.set && 'LOOKER_CLIENT_ID', !clientSecret.set && 'LOOKER_CLIENT_SECRET'].filter(Boolean).join(', ')} not set on host (looked for \`*_${folder.toUpperCase().replace(/-/g, '_')}\` then unscoped fallback). Ask Dave.`,
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
      activation: credsExist
        ? `\`hex\` CLI ready. Skill at \`/app/skills/hex/SKILL.md\` documents the full command surface. Common verbs: \`hex projects list --json\`, \`hex project get <id> --json\`, \`hex cell list --project-id <id> --json\`, \`hex cell run <cell-id>\`, \`hex project run <id> --watch\`, \`hex suggestion list --json\` (Context Studio), \`hex guide preview\` then \`hex guide publish <preview-id>\`, \`hex project export <id> > project.yaml\`. Always pass \`--json\` when parsing programmatically. If \`hex auth status\` reports not authenticated, the host operator needs to re-run \`hex auth login\` — do NOT attempt OAuth from inside the container.`
        : `Hex tool declared but \`~/.local/share/hex/\` is empty on the host. Ask Dave to run \`hex auth login\` on the host once. Mount allowlist: \`/home/ubuntu\` is already covered (no /manage-mounts call needed).`,
    });
  }

  // Slack read access — SESSION-AWARE, because the user-token (which reads the
  // OWNER's Slack lens) is scoped per session by the owner-safe boundary:
  //
  //   - owner-safe session (owner 1:1 DM, or messaging_group in
  //     slack_user_token.also_allowed_in): the Slack OneCLI secret is injected
  //     → the agent has live Slack read access here.
  //   - non-owner-safe session (anything else): the host spawns under the `-noslack`
  //     OneCLI identity with the Slack secret WITHHELD → no Slack access here,
  //     by design, so teammates can't extract the owner's Slack through the
  //     agent. (See isOwnerSafeSlackSession + the two-tier identity in
  //     container-runner.)
  //
  // Layering of the access (when present), correct shape — MCP first, proxy
  // floor underneath:
  //   - Convenience layer: the user-token MCP (`mcp__slack-user-token__*`),
  //     registered per-spawn in owner-safe sessions when slack_user_token is
  //     enabled. Structured — prefer it when loaded.
  //   - Floor: direct Slack Web API via the OneCLI proxy (`curl
  //     https://slack.com/api/*`, no auth header — the proxy injects the
  //     token). ALWAYS available when the secret is in-session, so the agent
  //     must never conclude "no Slack access" just because the MCP isn't
  //     loaded.
  // `resolve_thread_link` (archive) works in any session regardless.
  const mergedSecrets = mergeWorkgroupAndGroupSecrets(getWorkgroupOnecliSecrets(agentGroupId), cfg?.onecliSecrets);
  const hasSlackSecret = slackUserTokenSecrets(mergedSecrets, cfg?.slack_user_token?.onecli_secret_names).length > 0;
  const slackMcpEnabled = !!cfg?.slack_user_token?.enabled;
  if (hasSlackSecret || slackMcpEnabled) {
    // ownerSafe is only knowable with a session context. When the snapshot is
    // built group-level (no session — e.g. the get_capabilities tool with no
    // messaging group), describe the capability generically rather than
    // fail-closed-withholding, which would under-claim.
    const sessionKnown = sessionMessagingGroupId !== undefined;
    const ownerSafe =
      sessionKnown &&
      isOwnerSafeSlackSession(
        getDb(),
        agentGroupId,
        sessionMessagingGroupId ?? null,
        cfg?.slack_user_token?.also_allowed_in,
      );

    let useFor: string;
    if (hasSlackSecret && sessionKnown && !ownerSafe) {
      // Shared session: Slack is genuinely withheld here. Be explicit so the
      // agent does NOT try curl/MCP and does NOT promise the owner a read.
      useFor =
        'WITHHELD IN THIS SESSION (by design): this session is not one of the owner’s private/owner-safe Slack contexts (their 1:1 DM, or a messaging group in `slack_user_token.also_allowed_in`), so the Slack user token is NOT injected into your OneCLI agent. You CANNOT read the owner’s Slack DMs/channels/threads here — `curl https://slack.com/api/*` will fail auth and the user-token MCP is not loaded. This protects the owner’s Slack from being queried by others through you. (Unrelated to `session_mode` — every channel is still per-thread; this is purely about whose Slack credentials are in scope.) `resolve_thread_link` still resolves a pasted Slack/Discord permalink from the workgroup archive (`/workspace/archive.db`). If you genuinely need live Slack here, tell the owner to add this messaging group to `slack_user_token.also_allowed_in`.';
    } else {
      // Owner-safe session, or group-level/no-session snapshot. Describe the
      // layered access: MCP first (when present), proxy floor underneath.
      const floor =
        hasSlackSecret && sessionKnown && ownerSafe
          ? 'Floor (always available when you have Slack access — reach for this whenever the MCP isn’t loaded): direct Slack Web API through the OneCLI proxy. `curl https://slack.com/api/<method>` with NO auth header; the proxy injects the user token at the boundary. `auth.test` to confirm identity, then `conversations.history`, `conversations.replies`, `search.messages`, `conversations.list`, `users.info`, etc. Reads everything the owner can see. '
          : hasSlackSecret
            ? 'Floor (withheld in this snapshot because we don’t yet know whether the session is owner-safe): direct Slack Web API may be available in an owner-safe session — call `get_capabilities` with a session context to confirm. '
            : '';
      const mcp = slackMcpEnabled
        ? 'Convenience layer (prefer when loaded): the user-token MCP `mcp__slack-user-token__*` (`conversations_history`, `conversations_replies`, `conversations_search_messages`) — structured Slack reads. Registered in owner-safe sessions (owner DM, or an allow-listed context). If it isn’t in your tool list, that does NOT mean you lack Slack — use the proxy floor. '
        : '';
      const availability = !sessionKnown
        ? 'Availability is scoped to owner-safe Slack contexts (NOT the same thing as `session_mode` — every channel stays per-thread): present in the owner’s 1:1 DM or a messaging group in `slack_user_token.also_allowed_in`; withheld everywhere else. '
        : '';
      // Bottom line must match what we actually know:
      //   - no Slack secret at all → weak generic nudge.
      //   - session known + owner-safe → assert access in THIS session.
      //   - session unknown (group-level fragment) → state the session-scoped
      //     rule WITHOUT claiming access here, since non-owner-safe sessions withhold.
      const bottomLine = !hasSlackSecret
        ? 'Bottom line: before telling the owner you can’t read a DM/thread/quoted message, check your tools and try `resolve_thread_link`.'
        : sessionKnown
          ? 'Bottom line: you have live Slack read access in THIS session — never tell the owner you can’t read a DM/thread/quoted message without first trying the MCP (if loaded) or `curl https://slack.com/api/auth.test`, plus `resolve_thread_link`.'
          : 'Bottom line: in owner-safe Slack contexts you have live Slack read access (use the MCP if loaded, else the curl floor); everywhere else it is withheld. Confirm for the current session via your tool list or `get_capabilities` before telling the owner you can’t read something.';
      useFor =
        availability +
        mcp +
        floor +
        '`resolve_thread_link` resolves a pasted Slack OR Discord permalink from the workgroup chat archive (`/workspace/archive.db`) in any session. The BOT token can post + read channels the bot is in but cannot read arbitrary DMs. ' +
        bottomLine;
    }
    services.push({ name: 'Slack (read)', declaredTools: [], scopes: [], credentialPaths: [], useFor });
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
      useFor:
        'Official Cloudflare API MCP at https://mcp.cloudflare.com/mcp — auth pre-injected as `Authorization: Bearer`; do NOT ask for or send the token. Use `mcp__cloudflare-api__docs` for Cloudflare product documentation, `mcp__cloudflare-api__search` to locate the correct OpenAPI endpoint, then `mcp__cloudflare-api__execute` to call it. The server pre-selects the account from the token and exposes its `accountId` to execute code. Covers Cloudflare account APIs such as DNS, Workers, Pages, and R2 API endpoints, subject to the token’s granted permissions. The separate S3-compatible access-key/secret pair is not exposed through this MCP; do not attempt AWS SDK/CLI access or claim direct S3 access unless a signing-capable S3 client is separately wired.',
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
      cli: hasWixCli ? 'wix' : undefined,
      declaredTools: [],
      scopes: [],
      credentialPaths: hasWixCli ? ['/home/node/.wix/auth/account.json'] : [],
      useFor: parts.join(' '),
    });
  }

  // SELECT (select.dev) — REST-only via the OneCLI gateway, gated on a
  // `Select-*` OneCLI secret. No MCP/CLI surface: the agent `curl`s the host
  // directly and the gateway injects `Authorization: Bearer <key>` at the
  // boundary (e.g. vault entry "Select-MadisonReed" → api.select.dev). The
  // organization_id rides in the URL path and is NOT a secret; it's embedded
  // only for the MadisonReed tenant (the install's only SELECT org), mirroring
  // how the Atlassian entry above embeds the madison-reed site.
  if (mergedSecrets.some((s) => /^select(-|$)/i.test(s))) {
    const selectOrg = mergedSecrets.some((s) => /madison.?reed/i.test(s))
      ? 'org_DceCh2f5ybKfzIlh'
      : '<organization_id — ask the owner>';
    services.push({
      name: 'SELECT (select.dev)',
      cli: 'curl',
      declaredTools: [],
      scopes: [],
      credentialPaths: [],
      useFor: `Snowflake cost & usage analytics REST API at https://api.select.dev — auth pre-injected as \`Authorization: Bearer\` (send NO auth header; the OneCLI gateway adds it at the boundary). Routes are ORG-SCOPED: \`GET /api/${selectOrg}/...\` (e.g. \`/users\`, \`/usage-group-sets\`); the org id goes in the path and is not secret. GOTCHA: SELECT validates the key against the org in the path, so a wrong or missing org returns \`401 {"detail":"Invalid API key"}\` even when the key is valid — do NOT read that as a bad key. Docs: https://api-docs.select.dev/ (route index at /llms.txt).`,
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
      scopes: ['madison-reed'],
      credentialPaths: [],
      useFor:
        'Madison Reed Profound REST/reporting API at https://api.tryprofound.com — auth pre-injected as `X-API-Key` (send NO auth header; the OneCLI gateway adds it at the boundary). Use for Profound organization discovery and reports: `GET /v1/org/categories`, `/v1/org/domains`, `/v1/org/models`, `/v1/org/regions`; report pulls such as `POST /v1/reports/visibility`, `/citations`, `/sentiment`, `/query-fanouts`, `/v1/prompts/answers`, `/v2/reports/referrals`, and `/v2/reports/bots`.',
    });
  }

  // Fivetran — REST-only via the OneCLI gateway, gated on a `Fivetran-*` OneCLI
  // secret. The gateway injects `Authorization: Basic <base64(apiKey:apiSecret)>`
  // at the boundary (e.g. vault entry "Fivetran-MadisonReed" → api.fivetran.com).
  if (mergedSecrets.some((s) => /^fivetran(-|$)/i.test(s))) {
    services.push({
      name: 'Fivetran',
      cli: 'curl',
      declaredTools: [],
      scopes: [],
      credentialPaths: [],
      useFor:
        'Data-ingestion / connector management REST API at https://api.fivetran.com (e.g. `GET /v1/groups`, `/v1/connectors`, `/v1/users`). Auth pre-injected as `Authorization: Basic` (send NO auth header; the OneCLI gateway adds it at the boundary). Docs: https://fivetran.com/docs/rest-api.',
    });
  }

  return { agentGroupId, services };
}

export function getHostCapabilities(
  forAgentGroupId?: string,
  sessionMessagingGroupId?: string | null,
): HostCapabilities {
  const registered = getRegisteredChannelNames();

  const messagingGroups = getAllMessagingGroups();
  const byChannel: Record<string, number> = {};
  for (const mg of messagingGroups) {
    byChannel[mg.channel_type] = (byChannel[mg.channel_type] ?? 0) + 1;
  }
  const active = Object.keys(byChannel).sort();

  const agentGroups = getAllAgentGroups().map((ag) => {
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
      installed: listHostPlugins(),
    },
    agentGroups,
    messagingGroupsByChannel: byChannel,
    credentialEnvSet,
    session: forAgentGroupId ? buildSessionServicesSnapshot(forAgentGroupId, sessionMessagingGroupId) : undefined,
  };
}
