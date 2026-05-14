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
  discoverPortableSkills,
  syncSkillSymlinks as syncDiscoveredSkillSymlinks,
} from './plugin-skill-discovery.js';
import type { McpServerConfig } from './providers/types.js';

const HOST_CODEX_DIR = '/home/node/.codex';
const RUNTIME_CODEX_DIR = '/home/node/.codex-runtime';
const CONTAINER_CLAUDE_SKILLS_DIR = '/home/node/.claude/skills';
const CONTAINER_PLUGINS_DIR = '/workspace/plugins';

function log(msg: string): void {
  console.error(`[codex-companion-setup] ${msg}`);
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

export function buildMergedConfigForTest(
  hostConfig: string,
  mcpServers: Record<string, McpServerConfig>,
): string {
  return buildMergedConfig(hostConfig, mcpServers);
}

function renderMcpServer(name: string, config: McpServerConfig): string[] {
  const lines: string[] = [];
  lines.push(`[mcp_servers.${name}]`);

  if (config.type === 'http' || config.type === 'sse') {
    lines.push(`type = ${tomlBasicString(config.type)}`);
    lines.push(`url = ${tomlBasicString(config.url)}`);
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
    const type = (partial.type as string | undefined) ?? 'stdio';
    if (type === 'http' || type === 'sse') {
      const url = partial.url as string | undefined;
      if (url) result[currentName] = { type, url };
    } else {
      const command = partial.command as string | undefined;
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
  const base = stripped.trimEnd();
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
      try { fs.unlinkSync(runtimeAgents); } catch { /* fresh */ }
      fs.symlinkSync(hostAgents, runtimeAgents);
    } catch (err) {
      log(`Failed to symlink AGENTS.md: ${err instanceof Error ? err.message : String(err)}`);
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

  const merged = buildMergedConfig(hostConfig, mcpServers);
  const runtimeConfigPath = path.join(RUNTIME_CODEX_DIR, 'config.toml');
  try {
    fs.writeFileSync(runtimeConfigPath, merged);
  } catch (err) {
    log(`Failed to write merged config.toml: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  // Skills parity: symlink every skill Claude has into CODEX_HOME/skills/
  // so Codex auto-discovers them. Two sources:
  //   1. Container-bundled NanoClaw skills at /home/node/.claude/skills/
  //      (agent-browser, vercel-cli, slack-formatting, etc.) — these are
  //      operationally tied to the container; runtime-agnostic enough.
  //   2. Host plugin tree mounted RO at /workspace/plugins/ — discovers
  //      every plugin-bundled portable skill using the same rules the
  //      host script applies (`.agents/skills/` canonical preferred,
  //      Claude-only sub-plugins denied).
  // Codex's user skills (.system/) live under HOST_CODEX_DIR mounted at
  // /home/node/.codex/skills/.system — those don't conflict because
  // /home/node/.codex-runtime/skills/ is a fresh dir.
  const runtimeSkillsDir = path.join(RUNTIME_CODEX_DIR, 'skills');
  syncSkillSymlinks(runtimeSkillsDir, CONTAINER_CLAUDE_SKILLS_DIR);

  // Layer plugin-discovered skills on top. Reconcile inside this dir so
  // both sources coexist; container-bundled skills get added first, then
  // plugin skills are layered (plugin-source wins on name collision —
  // matches what Codex would see on the host).
  const pluginSkills = discoverPortableSkills(CONTAINER_PLUGINS_DIR);
  if (pluginSkills.length > 0) {
    // syncDiscoveredSkillSymlinks reconciles against the whole dir, so
    // call it with the UNION of plugin skills + already-linked container
    // skills to avoid wiping the container-bundled set.
    const containerSkillEntries: Array<{ name: string; skillDir: string; plugin: string }> = [];
    try {
      for (const entry of fs.readdirSync(CONTAINER_CLAUDE_SKILLS_DIR)) {
        const sd = path.join(CONTAINER_CLAUDE_SKILLS_DIR, entry);
        if (fs.statSync(sd).isDirectory() && fs.existsSync(path.join(sd, 'SKILL.md'))) {
          containerSkillEntries.push({ name: entry, skillDir: sd, plugin: 'container-bundled' });
        }
      }
    } catch {
      /* container skills dir missing */
    }
    // Plugin skills first, then container-bundled — first occurrence wins,
    // so plugin sources override on collision.
    const merged = new Map<string, { name: string; skillDir: string; plugin: string }>();
    for (const s of pluginSkills) merged.set(s.name, s);
    for (const s of containerSkillEntries) if (!merged.has(s.name)) merged.set(s.name, s);

    const result = syncDiscoveredSkillSymlinks(runtimeSkillsDir, [...merged.values()]);
    log(
      `Plugin skills: ${pluginSkills.length} discovered under ${CONTAINER_PLUGINS_DIR}; ` +
        `synced ${result.created.length}+${result.unchanged.length} (+${result.removed.length} removed)`,
    );
  }

  log(`CODEX_HOME runtime ready at ${RUNTIME_CODEX_DIR} (${Object.keys(mcpServers).length} MCP servers merged)`);
  return RUNTIME_CODEX_DIR;
}

/**
 * Populate `dst` with a symlink for each subdirectory of `src` that
 * contains a SKILL.md. Reconciles on each spawn: links to skills no
 * longer present in `src` are removed; new skills get fresh links.
 *
 * Idempotent — re-running produces the same end state.
 */
function syncSkillSymlinks(dst: string, src: string): void {
  fs.mkdirSync(dst, { recursive: true });

  // Discover desired skills: each subdir of src with a SKILL.md.
  const desired = new Set<string>();
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(src);
  } catch {
    return; // src doesn't exist (e.g. before container skills mount)
  }
  for (const entry of entries) {
    const skillPath = path.join(src, entry);
    try {
      if (!fs.statSync(skillPath).isDirectory()) continue;
      const skillMd = path.join(skillPath, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      desired.add(entry);
    } catch {
      continue;
    }
  }

  // Reconcile against existing entries in dst.
  let existing: string[] = [];
  try {
    existing = fs.readdirSync(dst);
  } catch {
    /* fresh dir */
  }
  for (const entry of existing) {
    if (desired.has(entry)) continue;
    const linkPath = path.join(dst, entry);
    try {
      const stat = fs.lstatSync(linkPath);
      // Only remove our own symlinks — preserve any directories the
      // operator placed here manually.
      if (stat.isSymbolicLink()) fs.unlinkSync(linkPath);
    } catch {
      /* missing — fine */
    }
  }
  for (const entry of desired) {
    const linkPath = path.join(dst, entry);
    const target = path.join(src, entry);
    let currentTarget: string | null = null;
    try {
      currentTarget = fs.readlinkSync(linkPath);
    } catch {
      /* missing */
    }
    if (currentTarget === target) continue;
    try {
      fs.unlinkSync(linkPath);
    } catch {
      /* missing */
    }
    try {
      fs.symlinkSync(target, linkPath);
    } catch (err) {
      log(`Failed to symlink skill ${entry}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
