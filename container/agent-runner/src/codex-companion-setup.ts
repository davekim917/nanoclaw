/**
 * Container-local CODEX_HOME setup.
 *
 * When Claude is the agent provider but the agent invokes Codex as a peer
 * (via the `/codex:rescue` subagent or the codex-companion script bundled
 * in the `~/plugins/codex/` plugin), the spawned `codex` reads MCP servers
 * from `~/.codex/config.toml`. Inside the container `~/.codex/` is the
 * host's directory mounted RW — so we cannot inject the container-only
 * `nanoclaw` MCP server entry there without polluting the host's config.
 *
 * The fix: synthesize a container-only Codex config directory at
 * `/home/node/.codex-runtime/`, populated with:
 *   - a symlink to the mounted host `auth.json` (so OAuth refresh still
 *     persists back to the host)
 *   - a symlink to the mounted host `plugins/` cache, so `[plugins.*]`
 *     config blocks resolve the same installed Codex plugins in peer mode
 *   - a config.toml that wraps the host's config with the additional MCP
 *     servers the agent-runner has wired (including `nanoclaw`).
 *
 * The agent-runner sets `process.env.CODEX_HOME` to this directory before
 * constructing the provider — `env: { ...process.env }` is snapshotted into
 * the provider's spawn-env, and inherited by every subsequent `node`,
 * `bun`, or `codex` child process.
 *
 * No-ops when:
 *   - the codex auth mount is absent (operator chose `codexHostAuth: false`)
 *   - we're already inside a Codex-provider session (Codex's own writer
 *     handles `~/.codex/config.toml` directly)
 */
import fs from 'fs';
import path from 'path';

import { tomlBasicString } from './providers/codex-app-server.js';
import {
  type AgentRuntime,
  discoverPortableSkills,
  syncSkillSymlinks as syncDiscoveredSkillSymlinks,
} from './plugin-skill-discovery.js';
import type { McpServerConfig } from './providers/types.js';

const HOST_CODEX_DIR = '/home/node/.codex';
const RUNTIME_CODEX_DIR = '/home/node/.codex-runtime';
const CONTAINER_CLAUDE_SKILLS_DIR = '/home/node/.claude/skills';
const CONTAINER_PLUGINS_DIR = '/workspace/plugins';
// Runtime-agnostic skill discovery path. Codex auto-scans this in addition
// to $CODEX_HOME/skills/ — verified empirically via `codex debug
// prompt-input` (~/.agents/skills/ appears as discovery root `r1`).
// Other compliant agent runtimes (OpenCode, etc.) read here too.
const CONTAINER_AGENTS_SKILLS_DIR = '/home/node/.agents/skills';

function log(msg: string): void {
  console.error(`[codex-companion-setup] ${msg}`);
}

function tomlInlineStringMap(map: Record<string, string>): string {
  return `{ ${Object.entries(map)
    .map(([key, value]) => `${tomlBasicString(key)} = ${tomlBasicString(value)}`)
    .join(', ')} }`;
}

export function renderMcpServerForTest(name: string, config: McpServerConfig): string[] {
  return renderMcpServer(name, config);
}

export function stripExistingMcpServersForTest(toml: string): string {
  return stripExistingMcpServers(toml).stripped;
}

export function parseHostMcpServersForTest(toml: string): Record<string, McpServerConfig> {
  return parseHostMcpServers(toml);
}

export function buildMergedConfigForTest(hostConfig: string, mcpServers: Record<string, McpServerConfig>): string {
  return buildMergedConfig(hostConfig, mcpServers);
}

function renderMcpServer(name: string, config: McpServerConfig): string[] {
  const lines: string[] = [];
  lines.push(`[mcp_servers.${name}]`);

  if (config.type === 'sse') {
    throw new Error(`MCP server "${name}" uses deprecated SSE transport. Use type: "http" instead.`);
  }

  if (config.type === 'http') {
    lines.push(`url = ${tomlBasicString(config.url)}`);
    if (config.headers && Object.keys(config.headers).length > 0) {
      lines.push(`http_headers = ${tomlInlineStringMap(config.headers)}`);
    }
    return lines;
  }

  lines.push('type = "stdio"');
  lines.push(`command = ${tomlBasicString(config.command)}`);
  if (config.args && config.args.length > 0) {
    const argsStr = config.args.map(tomlBasicString).join(', ');
    lines.push(`args = [${argsStr}]`);
  }
  if (config.env && Object.keys(config.env).length > 0) {
    lines.push(`[mcp_servers.${name}.env]`);
    for (const [key, value] of Object.entries(config.env)) {
      lines.push(`${key} = ${tomlBasicString(value)}`);
    }
  }
  return lines;
}

/**
 * Strip MCP server blocks from the host's config.toml so we can re-emit a
 * union of host + container entries (runtime overrides host on collision).
 *
 * Returns `{ stripped, droppedNames }`:
 *   - `stripped` = host config with all `[mcp_servers.*]` tables removed.
 *   - `droppedNames` = set of top-level mcp_servers names that existed in
 *     the host config (so the caller can preserve any that aren't being
 *     overridden by the runtime set).
 *
 * Deliberately simple TOML parser — we only need to recognize top-level
 * `[mcp_servers.*]` table headers. Comments and other tables pass through.
 */
function stripExistingMcpServers(toml: string): { stripped: string; droppedNames: Set<string> } {
  const lines = toml.split('\n');
  const out: string[] = [];
  const droppedNames = new Set<string>();
  let inMcpBlock = false;
  for (const line of lines) {
    const headerMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (headerMatch) {
      const tableName = headerMatch[1].trim();
      inMcpBlock = tableName.startsWith('mcp_servers.');
      if (inMcpBlock) {
        // Capture the top-level server name (strip any sub-table like .env)
        const serverName = tableName.slice('mcp_servers.'.length).split('.')[0];
        if (serverName) droppedNames.add(serverName);
        continue;
      }
    }
    if (inMcpBlock) continue;
    out.push(line);
  }
  return { stripped: out.join('\n'), droppedNames };
}

/**
 * Parse the host's MCP server blocks into a structured map so we can preserve
 * any entries the runtime set doesn't override. Tolerant of comments,
 * blank lines, and `[mcp_servers.<name>.env]` sub-tables.
 *
 * Recognizes:
 *   type = "stdio" | "http" | "sse"
 *   command = "..." / args = [...] / url = "..."
 *   [mcp_servers.<name>.env] KEY = "VALUE"
 */
function parseHostMcpServers(toml: string): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {};
  const lines = toml.split('\n');
  let currentName: string | null = null;
  let isEnvSubTable = false;

  // Working partial config — assembled per server.
  let partial: Record<string, unknown> & { _env?: Record<string, string> } = {};

  const flush = () => {
    if (!currentName) return;
    // Type inference: explicit `type =` wins, else derive from url/command
    // shape. `gitnexus setup` (and other tools) write entries with no
    // `type` field, relying on Codex's auto-detection from url vs command.
    const explicitType = partial.type as string | undefined;
    const url = partial.url as string | undefined;
    const command = partial.command as string | undefined;
    const inferredType = explicitType ?? (url ? 'http' : command ? 'stdio' : undefined);
    if (inferredType === 'sse') {
      throw new Error(`MCP server "${currentName}" uses deprecated SSE transport. Use type: "http" instead.`);
    }
    if (inferredType === 'http') {
      if (url) {
        result[currentName] = {
          type: 'http',
          url,
          ...(partial.headers ? { headers: partial.headers as Record<string, string> } : {}),
        };
      }
    } else if (inferredType === 'stdio') {
      if (command) {
        result[currentName] = {
          type: 'stdio',
          command,
          args: (partial.args as string[] | undefined) ?? [],
          env: partial._env ?? {},
        };
      }
    }
    partial = {};
    currentName = null;
    isEnvSubTable = false;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      const name = header[1].trim();
      if (name.startsWith('mcp_servers.')) {
        const sub = name.slice('mcp_servers.'.length).split('.');
        const top = sub[0];
        if (sub.length === 2 && sub[1] === 'env' && top === currentName) {
          isEnvSubTable = true;
          if (!partial._env) partial._env = {};
        } else {
          flush();
          currentName = top;
          isEnvSubTable = false;
        }
      } else {
        flush();
      }
      continue;
    }

    if (!currentName) continue;

    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1];
    const valueRaw = kv[2].trim();

    if (isEnvSubTable) {
      const env = partial._env as Record<string, string>;
      env[key] = parseTomlString(valueRaw);
      continue;
    }

    if (key === 'type' || key === 'command' || key === 'url') {
      partial[key] = parseTomlString(valueRaw);
    } else if (key === 'http_headers' && valueRaw.startsWith('{')) {
      partial.headers = parseTomlInlineStringMap(valueRaw);
    } else if (key === 'args' && valueRaw.startsWith('[')) {
      const arrayMatch = valueRaw.match(/^\[(.*)\]$/);
      if (arrayMatch) {
        const inside = arrayMatch[1].trim();
        partial.args = inside ? splitTomlArray(inside).map(parseTomlString) : [];
      }
    }
  }
  flush();
  return result;
}

function parseTomlString(raw: string): string {
  const m = raw.match(/^"((?:[^"\\]|\\.)*)"/);
  if (!m) return raw;
  return m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function parseTomlInlineStringMap(raw: string): Record<string, string> {
  const map: Record<string, string> = {};
  const body = raw.trim().replace(/^\{\s*/, '').replace(/\s*\}$/, '');
  for (const part of splitTomlArray(body)) {
    const m = part.match(/^("((?:[^"\\]|\\.)*)"|[A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/);
    if (!m) continue;
    const key = m[2] !== undefined ? parseTomlString(m[1]) : m[1];
    map[key] = parseTomlString(m[3].trim());
  }
  return map;
}

function splitTomlArray(inside: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let buf = '';
  let inString = false;
  let escape = false;
  for (const ch of inside) {
    if (escape) {
      buf += ch;
      escape = false;
      continue;
    }
    if (ch === '\\') {
      buf += ch;
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      buf += ch;
      continue;
    }
    if (!inString) {
      if (ch === '[') depth++;
      if (ch === ']') depth--;
      if (ch === ',' && depth === 0) {
        parts.push(buf.trim());
        buf = '';
        continue;
      }
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

/**
 * Build the merged config.toml. Sourced from:
 *   - the host's config.toml (less its MCP-server blocks — we re-emit them)
 *   - every MCP server in the union of (host MCPs ∪ runtime mcpServers),
 *     with runtime entries overriding host on name collision.
 *
 * Goal: Codex inside the container sees everything host Codex would have
 * seen PLUS the container-only entries (notably `nanoclaw`).
 */
function buildMergedConfig(hostConfig: string, mcpServers: Record<string, McpServerConfig>): string {
  const { stripped } = stripExistingMcpServers(hostConfig);
  const base = rewriteLocalMarketplaceSourcesForContainer(stripped).trimEnd();
  const hostMcps = parseHostMcpServers(hostConfig);

  // Runtime wins on name collision — that's why `mcpServers` is spread second.
  const merged: Record<string, McpServerConfig> = { ...hostMcps, ...mcpServers };

  const mcpLines: string[] = [];
  for (const [name, config] of Object.entries(merged)) {
    mcpLines.push(...renderMcpServer(name, config));
    mcpLines.push('');
  }
  return [base, '', '# --- nanoclaw merged MCP servers (host ∪ container) ---', '', ...mcpLines].join('\n');
}

function rewriteLocalMarketplaceSourcesForContainer(toml: string): string {
  return (
    toml
      .split('\n')
      .map((line) => {
        const match = line.match(/^(\s*source\s*=\s*)"((?:\\.|[^"\\])*)"\s*$/);
        if (!match) return line;
        const source = match[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        const marker = '/plugins/';
        const markerAt = source.indexOf(marker);
        if (markerAt < 0) return line;
        const relative = source.slice(markerAt + marker.length);
        const pluginName = relative.split('/')[0];
        if (!pluginName) return line;
        const containerSource = `/workspace/plugins/${relative}`;
        if (!fs.existsSync(`/workspace/plugins/${pluginName}`)) return line;
        return `${match[1]}${tomlBasicString(containerSource)}`;
      })
      .join('\n')
      .trimEnd() + '\n'
  );
}

/**
 * Set up `/home/node/.codex-runtime/` and return the path so callers can
 * point `CODEX_HOME` at it. Returns `null` when the codex auth mount is
 * absent (no host `~/.codex/auth.json`).
 */
export function setupCodexRuntime(mcpServers: Record<string, McpServerConfig>): string | null {
  const hostAuth = path.join(HOST_CODEX_DIR, 'auth.json');
  if (!fs.existsSync(hostAuth)) {
    log('Host codex auth not mounted — skipping CODEX_HOME runtime setup');
    return null;
  }

  try {
    fs.mkdirSync(RUNTIME_CODEX_DIR, { recursive: true });
  } catch (err) {
    log(`Failed to create runtime dir: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  // Symlink auth.json so OAuth token refresh writes back to the host's
  // mounted file. Replace any stale link from a previous run.
  const runtimeAuth = path.join(RUNTIME_CODEX_DIR, 'auth.json');
  try {
    if (fs.existsSync(runtimeAuth) || fs.lstatSync(runtimeAuth, { throwIfNoEntry: false } as never)) {
      fs.unlinkSync(runtimeAuth);
    }
  } catch {
    /* not present — fine */
  }
  try {
    fs.symlinkSync(hostAuth, runtimeAuth);
  } catch (err) {
    log(`Failed to symlink auth.json: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  // AGENTS.md: symlink the host's behavioral rules so the container-side
  // codex inherits the same global instructions as host codex.
  const hostAgents = path.join(HOST_CODEX_DIR, 'AGENTS.md');
  const runtimeAgents = path.join(RUNTIME_CODEX_DIR, 'AGENTS.md');
  if (fs.existsSync(hostAgents)) {
    try {
      try {
        fs.unlinkSync(runtimeAgents);
      } catch {
        /* fresh */
      }
      fs.symlinkSync(hostAgents, runtimeAgents);
    } catch (err) {
      log(`Failed to symlink AGENTS.md: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // agents/: symlink the host's subagent TOML dir so codex-as-peer sees
  // the same subagent definitions Codex primary sees. The host watcher
  // (src/codex-sync-watcher.ts) populates ~/.codex/agents/ (and per-group
  // ~/.codex-<folder>/agents/) with Claude `.md` → TOML conversions of
  // every plugin-shipped subagent. Without this symlink, codex-as-peer
  // sessions would have CODEX_HOME pointed at .codex-runtime/ with no
  // agents/ subdir, so /agent + spawnAgent would find nothing.
  const hostAgentsDir = path.join(HOST_CODEX_DIR, 'agents');
  const runtimeAgentsDir = path.join(RUNTIME_CODEX_DIR, 'agents');
  if (fs.existsSync(hostAgentsDir)) {
    try {
      try {
        fs.unlinkSync(runtimeAgentsDir);
      } catch {
        /* fresh */
      }
      fs.symlinkSync(hostAgentsDir, runtimeAgentsDir);
    } catch (err) {
      log(`Failed to symlink agents/: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // plugins/: preserve native Codex plugin installs for codex-as-peer mode.
  // The merged config below keeps non-MCP blocks, including `[plugins.*]`;
  // without this symlink those blocks can point at a cache tree that is absent
  // from CODEX_HOME and Codex falls back to whatever legacy skill mirrors exist.
  const hostPluginsDir = path.join(HOST_CODEX_DIR, 'plugins');
  const runtimePluginsDir = path.join(RUNTIME_CODEX_DIR, 'plugins');
  if (fs.existsSync(hostPluginsDir)) {
    try {
      fs.rmSync(runtimePluginsDir, { recursive: true, force: true });
      fs.symlinkSync(hostPluginsDir, runtimePluginsDir);
    } catch (err) {
      log(`Failed to symlink plugins/: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Read host config (tolerate missing — we'll generate a minimal one).
  const hostConfigPath = path.join(HOST_CODEX_DIR, 'config.toml');
  let hostConfig = '';
  try {
    hostConfig = fs.readFileSync(hostConfigPath, 'utf-8');
  } catch {
    hostConfig = '';
  }

  const mergedConfig = buildMergedConfig(hostConfig, mcpServers);
  const runtimeConfigPath = path.join(RUNTIME_CODEX_DIR, 'config.toml');
  try {
    fs.writeFileSync(runtimeConfigPath, mergedConfig);
  } catch (err) {
    log(`Failed to write merged config.toml: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  // Skills mirror is already populated by index.ts at startup with the correct
  // runtime; calling it again here without a runtime arg would default to
  // 'codex' and strip workflow-agents skills for opencode containers that have
  // codex auth mounted (codex-as-peer mode). Idempotency of syncSkillSymlinks
  // makes the call cheap, but the wrong denylist makes it incorrect.

  log(`CODEX_HOME runtime ready at ${RUNTIME_CODEX_DIR} (${Object.keys(mcpServers).length} MCP servers merged)`);
  return RUNTIME_CODEX_DIR;
}

/**
 * Populate `/home/node/.agents/skills/` with symlinks to every discoverable
 * skill — container-bundled NanoClaw skills + host plugin tree. Codex
 * auto-scans this dir (verified via `codex debug prompt-input`; appears as
 * discovery root `r1`), so this is what makes plugin skills like
 * `humanizer`, `gitnexus-*`, `impeccable`, etc. visible to Codex sessions.
 *
 * Called unconditionally from agent-runner startup — needed for BOTH
 * codex-primary (illie-codex) and codex-as-peer (illie running the codex
 * companion script). Idempotent: `syncDiscoveredSkillSymlinks` reconciles
 * existing entries (creates/removes/leaves as appropriate).
 */
export function syncAgentSkillsMirror(runtime?: AgentRuntime): void {
  // Two sources contribute:
  //   1. Container-bundled NanoClaw skills at /home/node/.claude/skills/
  //      (agent-browser, vercel-cli, slack-formatting, etc.)
  //   2. Host plugin tree mounted RO at /workspace/plugins/, discovered via
  //      the same rules the host script applies (`.agents/skills/` preferred,
  //      Claude-only sub-plugins denied).
  // Defers to any pre-existing non-symlink content (host-side mounts, or
  // anything an in-container `gitnexus setup` would later write).
  const containerSkillEntries: Array<{ name: string; skillDir: string; plugin: string }> = [];
  try {
    for (const entry of fs.readdirSync(CONTAINER_CLAUDE_SKILLS_DIR)) {
      const sd = path.join(CONTAINER_CLAUDE_SKILLS_DIR, entry);
      try {
        if (fs.statSync(sd).isDirectory() && fs.existsSync(path.join(sd, 'SKILL.md'))) {
          containerSkillEntries.push({ name: entry, skillDir: sd, plugin: 'container-bundled' });
        }
      } catch {
        continue;
      }
    }
  } catch {
    /* container skills dir missing */
  }

  const pluginSkills = discoverPortableSkills(CONTAINER_PLUGINS_DIR, { runtime });

  // Plugin skills first (preferred source), then container-bundled —
  // first occurrence wins by name.
  const merged = new Map<string, { name: string; skillDir: string; plugin: string }>();
  for (const s of pluginSkills) merged.set(s.name, s);
  for (const s of containerSkillEntries) if (!merged.has(s.name)) merged.set(s.name, s);

  const result = syncDiscoveredSkillSymlinks(CONTAINER_AGENTS_SKILLS_DIR, [...merged.values()]);
  log(
    `~/.agents/skills/: ${merged.size} desired ` +
      `(${containerSkillEntries.length} container + ${pluginSkills.length} plugin) — ` +
      `created=${result.created.length} unchanged=${result.unchanged.length} ` +
      `removed=${result.removed.length} skipped=${result.skipped.length}`,
  );
}
