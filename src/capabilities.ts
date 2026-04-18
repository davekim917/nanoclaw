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
import { getAllAgentGroups } from './db/agent-groups.js';
import { getAllMessagingGroups } from './db/messaging-groups.js';

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
    gws: boolean;            // Google Workspace (Gmail/Calendar/Drive/Docs)
    gmailMcp: boolean;       // legacy Gmail MCP creds
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
    builtin: string[];       // always-on built-in plugins (nanoclaw-hooks)
    installed: string[];     // ~/plugins/* subdirs
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

export function getHostCapabilities(): HostCapabilities {
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
  };
}
