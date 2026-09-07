/**
 * CLAUDE.md composition for agent groups.
 *
 * Replaces the per-group "written once at init, owned by the group" pattern
 * with a host-regenerated entry point that INLINES:
 *   - a shared base (`container/CLAUDE.md`, read directly from its host path)
 *   - built-in module fragments (`<name>.instructions.md` next to each MCP
 *     tool, read directly from their host paths)
 *   - optional per-MCP-server fragments (inline `instructions` field in
 *     `container.json`)
 *   - optional provider-neutral standing instructions
 *
 * Every section is written into the file itself rather than `@`-imported:
 * Claude Code silently DROPS an `@`-import whose resolved realpath falls
 * outside the project directory, and a container-path symlink this function
 * used to write (e.g. `/app/CLAUDE.md`) resolves outside the container's
 * project directory of `/workspace/agent`. Reading the host source directly
 * at compose time — rather than writing a dangling on-host symlink to a
 * container-only path and re-deriving its host equivalent through a
 * container-to-host translation map — sidesteps that entirely: compose
 * always runs host-side, so it never needed the container's view of these
 * paths in the first place. See the comment on the composition block below
 * for the measurement that motivated inlining.
 *
 * Runs on every spawn from `container-runner.buildMounts()`. Deterministic —
 * same inputs produce the same CLAUDE.md. The composition order and fragment
 * sources are documented inline above.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { readContainerConfig, validateMcpServers, type McpServerConfig } from './container-config.js';
import { getContainerConfig } from './db/container-configs.js';
import { flattenClaudeMd } from './agents-md-flatten.js';
import { CODEX_PROJECT_DOC_CONFIGURED_MAX_BYTES, warnIfOversized } from './codex-project-doc-cap.js';
import { readGroupPersona } from './group-persona.js';
import { getDb } from './db/connection.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

// Fragment holding a group's standing instructions. Imported FIRST (before
// the shared base) so it is the top of the composed system prompt.
const STANDING_INSTRUCTIONS_FRAGMENT = 'standing-instructions.md';

// Host-side source paths used to discover fragment sources at compose time.
// Joined against `projectRoot` (derived from GROUPS_DIR) at call time so
// tests, which mock GROUPS_DIR to a scratch dir, resolve these consistently.
const MCP_TOOLS_HOST_SUBPATH = path.join('container', 'agent-runner', 'src', 'mcp-tools');

const COMPOSED_HEADER =
  '<!-- Composed at spawn - do not edit. Standing instructions: standing-instructions.md. Memory: memory/. -->';

export interface ComposeGroupClaudeMdOptions {
  /** Spawn-resolved ID; do not re-derive a workgroup after reconciliation. */
  workgroupId?: string;
  /** Host-generated from the same policy and mounts as this spawn. */
  workgroupReadAccessInstructions?: string | null;
}

/**
 * Regenerate `groups/<folder>/CLAUDE.md` from the shared base, built-in
 * module fragments, and MCP server fragments declared in `container.json`.
 * Creates an empty `CLAUDE.local.md` if missing.
 *
 * `provider` is the spawn-resolved effective provider (session override →
 * container config → 'claude', already lowercased by resolveProviderName).
 * It must come from the spawn path rather than being re-derived here — a
 * session-level provider override would otherwise make this gate disagree
 * with the worker-def sync gate in buildMounts.
 */
/**
 * Directories a group's standing-instructions symlink may resolve into:
 * its own, plus every agent group sharing its workgroup. Siblings that build
 * together share one instruction file, and the workgroup is the data-pool
 * boundary — a group in another workgroup is a different tenant, so a link
 * there would pull that tenant's content into this always-on prompt. A group
 * with no workgroup gets its own directory only.
 */
async function personaSymlinkRoots(group: AgentGroup, groupDir: string): Promise<string[]> {
  if (!group.workgroup_id) return [groupDir];
  try {
    const siblings = await getDb().all<{ folder: string }>(
      `SELECT folder FROM agent_groups WHERE workgroup_id = ?`,
      group.workgroup_id,
    );
    return [groupDir, ...siblings.map((s) => path.resolve(GROUPS_DIR, s.folder))];
  } catch (err) {
    // Fail closed: an unreadable roster must not widen the boundary.
    log.warn('Could not resolve workgroup siblings for persona symlink containment', {
      group: group.folder,
      error: err instanceof Error ? err.message : String(err),
    });
    return [groupDir];
  }
}

export async function composeGroupClaudeMd(
  group: AgentGroup,
  provider: string,
  options: ComposeGroupClaudeMdOptions = {},
): Promise<void> {
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
  }

  removeStaleFragmentArtifacts(group.folder, groupDir);

  // Host-side project root, derived from GROUPS_DIR (not process.cwd()) so
  // every host source this function reads resolves the same way in tests,
  // which mock GROUPS_DIR to a scratch dir without also changing cwd.
  const projectRoot = path.resolve(GROUPS_DIR, '..');

  // Desired fragment set — name -> already-resolved content, ready to be
  // pushed straight into the composed doc. Nothing here is written to disk;
  // it exists only in memory for the duration of this call.
  const configRow = await getContainerConfig(group.id);
  const mcpServers: Record<string, McpServerConfig> = configRow
    ? validateMcpServers(JSON.parse(configRow.mcp_servers) as Record<string, McpServerConfig>)
    : {};
  const desired = new Map<string, string>();

  if (options.workgroupReadAccessInstructions) {
    if (!options.workgroupId)
      throw new Error('workgroup read-access instructions require a spawn-resolved workgroup ID');
    desired.set('host-workgroup-read-access.md', options.workgroupReadAccessInstructions);
  }

  // Built-in module fragments — every MCP/CLI module that ships a
  // sibling `<name>.instructions.md`. These describe how the agent should
  // use that module's tools (install_packages, ncl tasks, etc.). Scheduling
  // guidance lives entirely in cli.instructions.md and is therefore excluded
  // when cli_scope is disabled; there is no separate scheduling MCP fragment.
  // Read (and flattened, in case a module fragment ever grows its own
  // `@`-import) directly from its host path — these are trunk-controlled
  // files, not agent-writable, so flattening is safe.
  const cliDisabled = configRow?.cli_scope === 'disabled';
  const mcpToolsHostDir = path.join(projectRoot, MCP_TOOLS_HOST_SUBPATH);
  if (fs.existsSync(mcpToolsHostDir)) {
    for (const entry of fs.readdirSync(mcpToolsHostDir)) {
      const match = entry.match(/^(.+)\.instructions\.md$/);
      if (!match) continue;
      const moduleName = match[1];
      if (moduleName === 'cli' && cliDisabled) continue;
      desired.set(`module-${moduleName}.md`, flattenClaudeMd(path.join(mcpToolsHostDir, entry)));
    }
  }

  // MCP server fragments — inline instructions from container.json for
  // user-added external MCP servers.
  for (const [name, mcp] of Object.entries(mcpServers)) {
    if (mcp.instructions) {
      desired.set(`mcp-${name}.md`, mcp.instructions);
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
      if (content) desired.set(`plugin-${name}.md`, content);
    }
  }

  // Template persona (if any) — inline; imported first (see the imports
  // assembly) so it prepends the composed system prompt.
  const persona = readGroupPersona(groupDir, await personaSymlinkRoots(group, groupDir));
  if (persona) {
    desired.set(STANDING_INSTRUCTIONS_FRAGMENT, persona);
  }

  // Shared base — read straight from its host path. Flattened in case it
  // ever grows its own `@`-import; host-controlled, not agent-writable, so
  // safe to flatten.
  const sharedBaseHostPath = path.join(projectRoot, 'container', 'CLAUDE.md');

  // Composed entry — every section INLINED, in the same order the imports
  // used to be listed: persona first (top of the system prompt), then the
  // shared base, then the remaining fragments sorted.
  //
  // Inlined rather than `@`-imported because Claude Code silently DROPS an
  // `@`-import whose resolved realpath falls outside the project directory.
  // Inside the container the project directory is `/workspace/agent` (the
  // group folder); this function used to write a `.claude-shared.md` symlink
  // to `/app/CLAUDE.md` and a `.claude-fragments/module-*.md` symlink per
  // module, both of which resolve outside it, so the shared base and every
  // module fragment reached the model as nothing at all. Measured
  // 2026-09-03 in the real agent image (claude-code 2.1.257) by capturing
  // the outgoing Messages API request body: the inline fragment's sentinel
  // was present, both symlinked ones were absent, and `--add-dir` on the
  // target directory does not widen the boundary. Non-Claude providers were
  // unaffected — they read the already flat AGENTS.md below. Now that every
  // section is read from its host path and inlined directly, the symlinks
  // (and the RO mounts that backed them) serve no purpose and are gone —
  // see `removeStaleFragmentArtifacts` above and the mount removal in
  // `container-runner.ts`.
  //
  // SECURITY: an inline fragment's body (mcp/plugin/persona) is emitted
  // VERBATIM — never run through the flattener. Those bodies come from
  // agent-writable sources (the group folder is mounted RW at
  // `/workspace/agent`), and the flattener runs HOST-side with the host
  // user's filesystem access, so expanding them here would let a container
  // author `@~/.env`, have the host inline those bytes, and read them back
  // through its own mount — the same container-to-host exfiltration path the
  // CLAUDE.local.md handling below is careful to avoid. Only the shared base
  // and module fragments, whose sources are host-controlled trunk files, are
  // flattened, and only at the point they're read above.
  const sections: string[] = [COMPOSED_HEADER];
  const pushFragment = (name: string): void => {
    const content = desired.get(name);
    if (content !== undefined) sections.push(content);
  };
  pushFragment(STANDING_INSTRUCTIONS_FRAGMENT);
  sections.push(flattenClaudeMd(sharedBaseHostPath));
  for (const name of [...desired.keys()].filter((n) => n !== STANDING_INSTRUCTIONS_FRAGMENT).sort()) {
    pushFragment(name);
  }
  const body = [...sections, ''].join('\n');
  writeAtomic(path.join(groupDir, 'CLAUDE.md'), body);

  // Codex parity: also emit an AGENTS.md carrying the same flat body plus
  // this group's local standing instructions. Codex doesn't expand
  // @-references in AGENTS.md, so a reference would reach the model as
  // literal text — which is exactly why the body above is already flat.
  //
  // Ensure the local file exists BEFORE reading it — it is part of the
  // AGENTS.md body below, so creating it afterwards would omit it on a
  // group's first spawn.
  const localFile = path.join(groupDir, 'CLAUDE.local.md');
  if (!fs.existsSync(localFile)) {
    fs.writeFileSync(localFile, '');
  }

  // Operator standing instructions must reach EVERY provider, not just Claude.
  // Claude Code auto-discovers `CLAUDE.local.md`; Codex and OpenCode read only
  // the project doc (OpenCode 1.18.9 resolves the first AGENTS.md/CLAUDE.md
  // match and knows nothing of the `.local` convention). Leaving it out silently
  // scoped per-group rules to one sibling of three — including trust-boundary
  // rules like "never permanently delete an email" and a client's "never name
  // AI tooling in these repos", each of which reached 0 of its 2 non-Claude
  // siblings.
  //
  // Read RAW — deliberately NOT through `flattenClaudeMd`. This file lives in
  // the group folder, which is mounted read-write at `/workspace/agent`
  // (`container-runner.ts`), so an agent can write to it. The flattener runs
  // HOST-side with the host user's filesystem access and follows absolute and
  // `~` includes, so expanding it here would let a container author
  // `@~/.env` (or any host path), have the host inline those bytes into
  // `AGENTS.md`, and read them back through its own mount — a container-to-host
  // exfiltration path around the rule that containers never receive raw
  // credentials. An unexpanded `@ref` reaching the model as literal text is the
  // safe failure. No group's local file uses includes today.
  const localBody = fs.readFileSync(localFile, 'utf-8').trim();
  const agentsHeader =
    '<!-- Generated by composeGroupClaudeMd from CLAUDE.md. Do not edit. All instruction sections inlined. -->\n\n';
  // Written UNCAPPED for every provider — content bloat is judged by a human
  // reading the file, not by a byte number. Codex containers raise their own
  // `project_doc_max_bytes` to CODEX_PROJECT_DOC_CONFIGURED_MAX_BYTES
  // (codex-app-server.ts); warn loudly if we ever exceed that, since it means
  // either the doc grew absurdly or the container override stopped applying.
  const fullAgents =
    agentsHeader + body + (localBody ? `\n\n## Standing instructions for this group\n\n${localBody}\n` : '');
  if (provider === 'codex') {
    warnIfOversized(`${group.folder}/AGENTS.md`, fullAgents, CODEX_PROJECT_DOC_CONFIGURED_MAX_BYTES);
  }
  writeAtomic(path.join(groupDir, 'AGENTS.md'), fullAgents);
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

/**
 * ONE-RELEASE CLEANUP — delete after the next deploy has reached every group.
 *
 * Before instruction sections were inlined, `composeGroupClaudeMd` wrote a
 * `.claude-shared.md` symlink (→ `/app/CLAUDE.md`) and a `.claude-fragments/`
 * directory of symlink/inline fragment files so the composed doc could
 * `@`-import them. Both are superseded: every section this function produces
 * is now read from its host path and written into the doc directly, and the
 * mounts that backed those container paths (`/app/CLAUDE.md`,
 * `/workspace/agent/.claude-fragments`) are gone from `container-runner.ts`.
 * Existing group dirs still carry the on-disk artifacts from before this
 * cutover; delete them on next compose so disk state converges without a
 * separate migration pass. Idempotent — a no-op once a group has been
 * cleaned. Logs once per group, only when something was actually removed.
 */
function removeStaleFragmentArtifacts(groupFolder: string, groupDir: string): void {
  let removed = false;

  try {
    fs.unlinkSync(path.join(groupDir, '.claude-shared.md'));
    removed = true;
  } catch {
    /* already gone, or never existed */
  }

  const staleFragmentsDir = path.join(groupDir, '.claude-fragments');
  if (fs.existsSync(staleFragmentsDir)) {
    fs.rmSync(staleFragmentsDir, { recursive: true, force: true });
    removed = true;
  }

  if (removed) {
    log.info('Removed vestigial instruction-fragment artifacts (superseded by full inlining)', {
      group: groupFolder,
    });
  }
}

function writeAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}
