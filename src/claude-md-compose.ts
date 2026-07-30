/**
 * CLAUDE.md composition for agent groups.
 *
 * Replaces the per-group "written once at init, owned by the group" pattern
 * with a host-regenerated entry point that imports:
 *   - a shared base (`container/CLAUDE.md` mounted RO at `/app/CLAUDE.md`)
 *   - optional per-skill fragments (skills that ship `instructions.md`)
 *   - optional per-MCP-server fragments (inline `instructions` field in
 *     `container.json`)
 *   - optional provider-neutral standing instructions
 *
 * Runs on every spawn from `container-runner.buildMounts()`. Deterministic —
 * same inputs produce the same CLAUDE.md, and stale fragments are pruned.
 * The composition order and fragment sources are documented inline above.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { readContainerConfig, validateMcpServers, type McpServerConfig } from './container-config.js';
import { getContainerConfig } from './db/container-configs.js';
import { flattenClaudeMd } from './agents-md-flatten.js';
import { CODEX_PROJECT_DOC_MAX_BYTES, capCodexProjectDoc } from './codex-project-doc-cap.js';
import { readGroupPersona } from './group-persona.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

// Fragment holding a template's persona prepend. Imported FIRST (before the
// shared base) so the persona is the top of the composed system prompt.
const PERSONA_FRAGMENT = 'persona.md';

// Symlink targets are container paths — dangling on host (hence the readlink
// dance instead of existsSync), valid inside the container via RO mounts.
const SHARED_CLAUDE_MD_CONTAINER_PATH = '/app/CLAUDE.md';
const SHARED_SKILLS_CONTAINER_BASE = '/app/skills';
const SHARED_MCP_TOOLS_CONTAINER_BASE = '/app/src/mcp-tools';

// Host-side source paths used to discover fragment sources at compose time.
// Resolved at call time (process.cwd() = project root) so tests can swap cwd.
const MCP_TOOLS_HOST_SUBPATH = path.join('container', 'agent-runner', 'src', 'mcp-tools');

const COMPOSED_HEADER =
  '<!-- Composed at spawn - do not edit. Standing instructions: instructions.prepend.md. Memory: memory/. -->';

/**
 * Regenerate `groups/<folder>/CLAUDE.md` from the shared base, enabled skill
 * fragments, and MCP server fragments declared in `container.json`. Creates
 * an empty `CLAUDE.local.md` if missing.
 *
 * `provider` is the spawn-resolved effective provider (session override →
 * container config → 'claude', already lowercased by resolveProviderName).
 * It must come from the spawn path rather than being re-derived here — a
 * session-level provider override would otherwise make this gate disagree
 * with the worker-def sync gate in buildMounts.
 */
export function composeGroupClaudeMd(group: AgentGroup, provider: string): void {
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

  // Built-in module fragments — every MCP/CLI module that ships a
  // sibling `<name>.instructions.md`. These describe how the agent should
  // use that module's tools (install_packages, ncl tasks, etc.). Scheduling
  // guidance lives entirely in cli.instructions.md and is therefore excluded
  // when cli_scope is disabled; there is no separate scheduling MCP fragment.
  const cliDisabled = configRow?.cli_scope === 'disabled';
  const mcpToolsHostDir = path.join(process.cwd(), MCP_TOOLS_HOST_SUBPATH);
  if (fs.existsSync(mcpToolsHostDir)) {
    for (const entry of fs.readdirSync(mcpToolsHostDir)) {
      const match = entry.match(/^(.+)\.instructions\.md$/);
      if (!match) continue;
      const moduleName = match[1];
      if (moduleName === 'cli' && cliDisabled) continue;
      // Worker-def orchestration is Claude-only (Task-tool subagents from
      // ~/.claude/agents); codex/opencode groups must not get these instructions.
      if (moduleName === 'orchestrator-workers' && provider !== 'claude') continue;
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

  // Always-on agent-plugin rulesets — NON-Claude groups only. A Claude group
  // gets a plugin's always-on behavior from its mounted SessionStart hook
  // (CLAUDE_PLUGINS_ROOT auto-loads it); Codex/OpenCode containers fire NO
  // plugin hooks, so we inject the plugin's captured ruleset here instead. A
  // plugin opts in by writing its ruleset to `~/plugins/<name>/.nanoclaw-always-on.md`
  // (the /enable-agent-plugins skill authors this). Per-group opt-out reuses
  // `excludePlugins` — the same field that drops the Claude mount — so excluding
  // a plugin from a group removes it on every provider. See docs/skills-model.md.
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
      let content: string;
      try {
        if (!fs.statSync(rulesetFile).isFile()) continue;
        content = fs.readFileSync(rulesetFile, 'utf-8').trim();
      } catch {
        continue;
      }
      if (content) desired.set(`plugin-${name}.md`, { type: 'inline', content });
    }
  }

  // Template persona (if any) — inline so it survives the prune below; imported
  // first (see the imports assembly) so it prepends the composed system prompt.
  const persona = readGroupPersona(groupDir);
  if (persona) {
    desired.set(PERSONA_FRAGMENT, { type: 'inline', content: persona });
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

  // Composed entry — imports only. Persona first (top of the system prompt),
  // then the shared base, then the remaining fragments sorted.
  const imports: string[] = [];
  if (desired.has(PERSONA_FRAGMENT)) {
    imports.push(`@./.claude-fragments/${PERSONA_FRAGMENT}`);
  }
  imports.push('@./.claude-shared.md');
  for (const name of [...desired.keys()].filter((n) => n !== PERSONA_FRAGMENT).sort()) {
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
  const agentsBody = flattenClaudeMd(path.join(groupDir, 'CLAUDE.md'), { containerToHost });
  const agentsHeader =
    '<!-- Generated by composeGroupClaudeMd from CLAUDE.md. Do not edit. @-includes resolved inline for Codex. -->\n\n';
  // The 32KB cap is Codex's `project_doc_max_bytes` — it is NOT a universal
  // AGENTS.md limit. Applying it to every provider made OpenCode groups shed
  // whole behavioral sections to satisfy a constraint their runtime does not
  // have (`project_doc` appears nowhere in the OpenCode 1.18.9 binary), and
  // Claude groups pay it for a file they never read (Claude Code discovers
  // CLAUDE.md and ignores a sibling AGENTS.md). Cap only the provider that
  // actually truncates; others get the full doc, with a size log so a future
  // provider-side limit still leaves a breadcrumb.
  const fullAgents = agentsHeader + agentsBody;
  const agentsOut = provider === 'codex' ? capCodexProjectDoc(fullAgents, `${group.folder}/AGENTS.md`) : fullAgents;
  if (provider !== 'codex' && Buffer.byteLength(fullAgents, 'utf-8') > CODEX_PROJECT_DOC_MAX_BYTES) {
    log.info('AGENTS.md exceeds Codex cap but provider is not Codex — written uncapped', {
      label: `${group.folder}/AGENTS.md`,
      provider,
      bytes: Buffer.byteLength(fullAgents, 'utf-8'),
    });
  }
  writeAtomic(path.join(groupDir, 'AGENTS.md'), agentsOut);

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
 *     doesn't already exist — byte-preserves pre-cutover content as per-group
 *     standing instructions for explicit instruction reconciliation; after the
 *     first spawn regenerates `CLAUDE.md`, this branch is skipped because
 *     `CLAUDE.local.md` now exists)
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
