/**
 * CLAUDE.md composition for agent groups.
 *
 * Replaces the per-group "written once at init, owned by the group" pattern
 * with a host-regenerated entry point that imports:
 *   - a shared base (`container/CLAUDE.md` mounted RO at `/app/CLAUDE.md`)
 *   - optional per-skill fragments (skills that ship `instructions.md`)
 *   - optional per-MCP-server fragments (inline `instructions` field in
 *     `container.json`)
 *   - per-group agent memory (`CLAUDE.local.md`, auto-loaded by Claude Code)
 *
 * Runs on every spawn from `container-runner.buildMounts()`. Deterministic —
 * same inputs produce the same CLAUDE.md, and stale fragments are pruned.
 *
 * See `docs/claude-md-composition.md` for the full design.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { readContainerConfig, validateMcpServers, type McpServerConfig } from './container-config.js';
import { getContainerConfig } from './db/container-configs.js';
import { buildSessionServicesSnapshot, renderSessionCapabilities } from './capabilities.js';
import { flattenClaudeMd } from './agents-md-flatten.js';
import { capCodexProjectDoc } from './codex-project-doc-cap.js';
import { rewriteCodexRtkGuidance } from './codex-rtk-guidance.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

// Symlink targets are container paths — dangling on host (hence the readlink
// dance instead of existsSync), valid inside the container via RO mounts.
const SHARED_CLAUDE_MD_CONTAINER_PATH = '/app/CLAUDE.md';
const SHARED_SKILLS_CONTAINER_BASE = '/app/skills';
const SHARED_MCP_TOOLS_CONTAINER_BASE = '/app/src/mcp-tools';

// Host-side source paths used to discover fragment sources at compose time.
// Resolved at call time (process.cwd() = project root) so tests can swap cwd.
const MCP_TOOLS_HOST_SUBPATH = path.join('container', 'agent-runner', 'src', 'mcp-tools');

const COMPOSED_HEADER = '<!-- Composed at spawn — do not edit. Edit CLAUDE.local.md for per-group content. -->';

/**
 * Regenerate `groups/<folder>/CLAUDE.md` from the shared base, enabled skill
 * fragments, and MCP server fragments declared in `container.json`. Creates
 * an empty `CLAUDE.local.md` if missing.
 */
export function composeGroupClaudeMd(group: AgentGroup): void {
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
  }

  const sharedLink = path.join(groupDir, '.claude-shared.md');
  syncSymlink(sharedLink, SHARED_CLAUDE_MD_CONTAINER_PATH);

  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (!fs.existsSync(fragmentsDir)) {
    fs.mkdirSync(fragmentsDir, { recursive: true });
  }

  // Desired fragment set.
  const configRow = getContainerConfig(group.id);
  const mcpServers: Record<string, McpServerConfig> = configRow
    ? validateMcpServers(JSON.parse(configRow.mcp_servers) as Record<string, McpServerConfig>)
    : {};
  const desired = new Map<string, { type: 'symlink' | 'inline'; content: string }>();

  // Skill fragments — every skill that ships an `instructions.md`.
  // TODO (shared-source refactor): respect `container.json` skill selection.
  const skillsHostDir = path.join(process.cwd(), 'container', 'skills');
  if (fs.existsSync(skillsHostDir)) {
    for (const skillName of fs.readdirSync(skillsHostDir)) {
      const hostFragment = path.join(skillsHostDir, skillName, 'instructions.md');
      if (fs.existsSync(hostFragment)) {
        desired.set(`skill-${skillName}.md`, {
          type: 'symlink',
          content: `${SHARED_SKILLS_CONTAINER_BASE}/${skillName}/instructions.md`,
        });
      }
    }
  }

  // Built-in module fragments — every MCP tool source file that ships a
  // sibling `<name>.instructions.md`. These describe how the agent should
  // use that module's MCP tools (schedule_task, install_packages, etc.).
  // Skip cli.instructions.md when cli_scope is disabled.
  const cliDisabled = configRow?.cli_scope === 'disabled';
  const mcpToolsHostDir = path.join(process.cwd(), MCP_TOOLS_HOST_SUBPATH);
  if (fs.existsSync(mcpToolsHostDir)) {
    for (const entry of fs.readdirSync(mcpToolsHostDir)) {
      const match = entry.match(/^(.+)\.instructions\.md$/);
      if (!match) continue;
      const moduleName = match[1];
      if (moduleName === 'cli' && cliDisabled) continue;
      desired.set(`module-${moduleName}.md`, {
        type: 'symlink',
        content: `${SHARED_MCP_TOOLS_CONTAINER_BASE}/${entry}`,
      });
    }
  }

  // MCP server fragments — inline instructions from container.json for
  // user-added external MCP servers.
  for (const [name, mcp] of Object.entries(mcpServers)) {
    if (mcp.instructions) {
      desired.set(`mcp-${name}.md`, {
        type: 'inline',
        content: mcp.instructions,
      });
    }
  }

  // Session capabilities fragment — the services actually wired into this
  // container (Looker, Google Workspace, Snowflake, …) with their activation
  // steps, so the agent reads them every turn instead of (wrongly) concluding
  // it lacks access and rediscovering each session. Push, not pull: the same
  // snapshot the `get_capabilities` MCP tool returns, baked into the prompt.
  // Best-effort — a failure here must never block CLAUDE.md regeneration.
  try {
    const capsFragment = renderSessionCapabilities(buildSessionServicesSnapshot(group.id));
    if (capsFragment) {
      desired.set('session-capabilities.md', { type: 'inline', content: capsFragment });
    }
  } catch (err) {
    log.warn('Session capabilities fragment skipped', { group: group.id, err: String(err) });
  }

  // Always-on agent-plugin rulesets — NON-Claude groups only. A Claude group
  // gets a plugin's always-on behavior from its mounted SessionStart hook
  // (CLAUDE_PLUGINS_ROOT auto-loads it); Codex/OpenCode containers fire NO
  // plugin hooks, so we inject the plugin's captured ruleset here instead. A
  // plugin opts in by writing its ruleset to `~/plugins/<name>/.nanoclaw-always-on.md`
  // (the /enable-agent-plugins skill authors this). Per-group opt-out reuses
  // `excludePlugins` — the same field that drops the Claude mount — so excluding
  // a plugin from a group removes it on every provider. See docs/skills-model.md.
  const provider = (configRow?.provider ?? 'claude').toLowerCase();
  if (provider !== 'claude') {
    const excluded = new Set(readContainerConfig(group.folder).excludePlugins ?? []);
    const pluginsRoot = path.join(os.homedir(), 'plugins');
    let pluginDirs: string[] = [];
    try {
      pluginDirs = fs.readdirSync(pluginsRoot).sort();
    } catch {
      /* no ~/plugins — nothing to inject */
    }
    for (const name of pluginDirs) {
      if (excluded.has(name)) continue;
      const rulesetFile = path.join(pluginsRoot, name, '.nanoclaw-always-on.md');
      let content = '';
      try {
        if (!fs.statSync(rulesetFile).isFile()) continue;
        content = fs.readFileSync(rulesetFile, 'utf-8').trim();
      } catch {
        continue;
      }
      if (content) desired.set(`plugin-${name}.md`, { type: 'inline', content });
    }
  }

  // Reconcile: drop stale, write desired.
  for (const existing of fs.readdirSync(fragmentsDir)) {
    if (!desired.has(existing)) {
      fs.unlinkSync(path.join(fragmentsDir, existing));
    }
  }
  for (const [name, frag] of desired) {
    const fragPath = path.join(fragmentsDir, name);
    if (frag.type === 'symlink') {
      syncSymlink(fragPath, frag.content);
    } else {
      writeAtomic(fragPath, frag.content);
    }
  }

  // Composed entry — imports only.
  const imports = ['@./.claude-shared.md'];
  for (const name of [...desired.keys()].sort()) {
    imports.push(`@./.claude-fragments/${name}`);
  }
  const body = [COMPOSED_HEADER, ...imports, ''].join('\n');
  writeAtomic(path.join(groupDir, 'CLAUDE.md'), body);

  // Codex parity: also emit an AGENTS.md with the same content but with
  // @-includes resolved inline. Codex doesn't expand @-references in
  // AGENTS.md, so the references would otherwise reach the model as
  // literal text. The composer's symlinks point at container paths
  // (`/app/CLAUDE.md`, `/app/skills/<n>/instructions.md`,
  // `/app/src/mcp-tools/<n>.instructions.md`) — pass a translation map
  // to the flattener so it can read those targets from their host paths.
  const projectRoot = path.resolve(GROUPS_DIR, '..');
  const containerToHost: Record<string, string> = {
    [SHARED_CLAUDE_MD_CONTAINER_PATH]: path.join(projectRoot, 'container', 'CLAUDE.md'),
    [SHARED_SKILLS_CONTAINER_BASE]: path.join(projectRoot, 'container', 'skills'),
    [SHARED_MCP_TOOLS_CONTAINER_BASE]: path.join(projectRoot, MCP_TOOLS_HOST_SUBPATH),
  };
  const agentsBody = rewriteCodexRtkGuidance(flattenClaudeMd(path.join(groupDir, 'CLAUDE.md'), { containerToHost }));
  const agentsHeader =
    '<!-- Generated by composeGroupClaudeMd from CLAUDE.md. Do not edit. @-includes resolved inline for Codex. -->\n\n';
  writeAtomic(
    path.join(groupDir, 'AGENTS.md'),
    capCodexProjectDoc(agentsHeader + agentsBody, `${group.folder}/AGENTS.md`),
  );

  const localFile = path.join(groupDir, 'CLAUDE.local.md');
  if (!fs.existsSync(localFile)) {
    fs.writeFileSync(localFile, '');
  }
}

/**
 * One-time cutover from the `groups/global/CLAUDE.md` + `.claude-global.md`
 * pattern. Idempotent — safe to run on every host startup.
 *
 * For each group dir:
 *   - remove `.claude-global.md` symlink if present
 *   - rename `CLAUDE.md` → `CLAUDE.local.md` (only if `CLAUDE.local.md`
 *     doesn't already exist — preserves pre-cutover content as per-group
 *     memory; after the first spawn regenerates `CLAUDE.md`, this branch
 *     is skipped because `CLAUDE.local.md` now exists)
 *
 * Globally:
 *   - delete `groups/global/` (content already in `container/CLAUDE.md`)
 */
export function migrateGroupsToClaudeLocal(): void {
  if (!fs.existsSync(GROUPS_DIR)) return;

  const actions: string[] = [];

  for (const entry of fs.readdirSync(GROUPS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'global') continue;

    const groupDir = path.join(GROUPS_DIR, entry.name);

    const oldGlobalLink = path.join(groupDir, '.claude-global.md');
    try {
      fs.lstatSync(oldGlobalLink);
      fs.unlinkSync(oldGlobalLink);
      actions.push(`${entry.name}/.claude-global.md removed`);
    } catch {
      /* already gone */
    }

    const claudeMd = path.join(groupDir, 'CLAUDE.md');
    const claudeLocal = path.join(groupDir, 'CLAUDE.local.md');
    if (fs.existsSync(claudeMd) && !fs.existsSync(claudeLocal)) {
      fs.renameSync(claudeMd, claudeLocal);
      actions.push(`${entry.name}/CLAUDE.md → CLAUDE.local.md`);
    }
  }

  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    fs.rmSync(globalDir, { recursive: true, force: true });
    actions.push('groups/global/ removed');
  }

  if (actions.length > 0) {
    log.info('Migrated groups to CLAUDE.local.md model', { actions });
  }
}

function syncSymlink(linkPath: string, target: string): void {
  let currentTarget: string | null = null;
  try {
    currentTarget = fs.readlinkSync(linkPath);
  } catch {
    /* missing */
  }
  if (currentTarget === target) return;
  try {
    fs.unlinkSync(linkPath);
  } catch {
    /* missing */
  }
  fs.symlinkSync(target, linkPath);
}

function writeAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}
