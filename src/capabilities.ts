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
    /** CLI binary the agent invokes. */
    cli?: string;
    /** Tool names in container.json.tools that imply this service. */
    declaredTools: string[];
    /** Scope names parsed from tool entries (e.g. ['illysium','support-illysium']). */
    scopes: string[];
    /** What files / paths the container sees. Container path, not host path. */
    credentialPaths: string[];
    /** Concise activation instruction for the CLI, if any. */
    activation?: string;
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
function buildSessionServicesSnapshot(agentGroupId: string): SessionServicesSnapshot {
  const ag = getAgentGroup(agentGroupId);
  const tools = ag ? readContainerConfig(ag.folder).tools : undefined;

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
