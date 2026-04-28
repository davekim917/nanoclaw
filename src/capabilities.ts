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
import { getAllAgentGroups, getAgentGroup } from './db/agent-groups.js';
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

  /** Which plugin repos are mounted into containers from ~/plugins/ + the built-in nanoclaw-hooks. */
  plugins: {
    builtin: string[]; // always-on built-in plugins (nanoclaw-hooks)
    installed: string[]; // ~/plugins/* subdirs
  };

  /** Agent groups + their per-group feature flags. */
  agentGroups: Array<{
    id: string;
    name: string;
    folder: string;
    gitnexusInjectAgentsMd: boolean;
    ollamaAdminTools: boolean;
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
];

function listHostPlugins(): string[] {
  const dir = path.join(os.homedir(), 'plugins');
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir).filter((entry) => {
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

function builtinPlugins(): string[] {
  const builtinPluginDir = path.resolve(GROUPS_DIR, '..', 'container', 'nanoclaw-plugin');
  return fs.existsSync(builtinPluginDir) ? ['nanoclaw-hooks'] : [];
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

function buildSessionServicesSnapshot(agentGroupId: string): SessionServicesSnapshot {
  const ag = getAgentGroup(agentGroupId);
  const folder = ag?.folder ?? '';
  const cfg = ag ? readContainerConfig(ag.folder) : undefined;
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
  services.push({
    name: 'Exa',
    mcpNamespace: 'mcp__exa__*',
    declaredTools: declaredMatchingTools(['exa']),
    scopes: [],
    credentialPaths: [],
    useFor:
      'Web search, research, and code context. Prefer exa over ad-hoc WebSearch/WebFetch for: web search (`mcp__exa__web_search_exa`), company research (`mcp__exa__company_research_exa`), people search (`mcp__exa__people_search_exa`), deep research (`mcp__exa__deep_researcher_start` then `_check`), code context from public repos (`mcp__exa__get_code_context_exa`), crawling specific URLs (`mcp__exa__crawling_exa`).',
  });

  // DeepWiki — always-on. No tool gate; host injects the MCP server unconditionally.
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
  services.push({
    name: 'Granola',
    mcpNamespace: 'mcp__granola__*',
    declaredTools: declaredMatchingTools(['granola']),
    scopes: [],
    credentialPaths: [],
    useFor:
      'Meeting transcripts + notes via Granola REST API. Auth injected by OneCLI on public-api.granola.ai; no token visible in-container. Tools: `mcp__granola__list_meetings`, `mcp__granola__get_meeting` (set include_transcript=true for raw transcript).',
  });

  return { agentGroupId, services };
}

export function getHostCapabilities(forAgentGroupId?: string): HostCapabilities {
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
      gitnexusInjectAgentsMd: !!cfg.gitnexusInjectAgentsMd,
      ollamaAdminTools: !!cfg.ollamaAdminTools,
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
      builtin: builtinPlugins(),
      installed: listHostPlugins(),
    },
    agentGroups,
    messagingGroupsByChannel: byChannel,
    credentialEnvSet,
    session: forAgentGroupId ? buildSessionServicesSnapshot(forAgentGroupId) : undefined,
  };
}
