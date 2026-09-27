/**
 * Host-regenerated CLAUDE.md/AGENTS.md for agent groups, run on every spawn. Every section is INLINED, never
 * `@`-imported: Claude Code silently drops an `@`-import whose realpath falls outside the project directory.
 */
import fs from 'fs';
import { OUTCOME_REPORTING_INSTRUCTIONS } from './outcome-reporting-instructions.js';
import os from 'os';
import path from 'path';

import { GROUPS_DIR, TASK_LIST_ENABLED } from './config.js';
import {
  effectiveOutcomeReporting,
  readContainerConfig,
  validateMcpServers,
  type McpServerConfig,
} from './container-config.js';
import { getContainerConfig } from './db/container-configs.js';
import { isExcludedPluginPath, splitExcludedPlugins } from './plugin-exclusions.js';
import { flattenClaudeMd } from './agents-md-flatten.js';
import { CODEX_PROJECT_DOC_CONFIGURED_MAX_BYTES, warnIfOversized } from './codex-project-doc-cap.js';
import { readGroupPersona } from './group-persona.js';
import { getDb } from './db/connection.js';
import { log } from './log.js';
import { loadPluginScopes, pluginAllowedForWorkgroup } from './plugin-scopes.js';
import type { AgentGroup } from './types.js';

// Placed first, so it tops the composed system prompt.
const STANDING_INSTRUCTIONS_FRAGMENT = 'standing-instructions.md';

// Joined against projectRoot (derived from GROUPS_DIR) so tests that mock GROUPS_DIR resolve consistently.
const MCP_TOOLS_HOST_SUBPATH = path.join('container', 'agent-runner', 'src', 'mcp-tools');

/** Operator override (via /enable-agent-plugins) for a third-party plugin that ships no clean ruleset. */
const NANOCLAW_ALWAYS_ON_MARKER = '.nanoclaw-always-on.md';

const PLUGIN_ALWAYS_ON_FILE = 'always-on.md';

/** Bounded because one plugin's directive is a fraction of the capped composed doc. */
const MAX_PLUGIN_RULESET_BYTES = 64 * 1024;

/**
 * One ruleset file's trimmed contents, or null when absent, empty, unreadable, or resolving outside `repoRoot`.
 * Security boundary: the host reads plugin-choosable paths and publishes them into the container-visible
 * AGENTS.md, so containment is checked on the realpath (separator-bounded) of the opened descriptor.
 */
function readRulesetFile(dir: string, filename: string, repoRoot: string): string | null {
  const file = path.join(dir, filename);
  // Resolve the root BEFORE the open: a root resolved afterwards can be swapped to contain the opened fd.
  let root: string;
  try {
    root = fs.realpathSync(repoRoot);
  } catch {
    return null;
  }
  let fd: number;
  try {
    // O_NONBLOCK: opening a FIFO for reading would otherwise block the host's event loop.
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    // Containment is judged on the OPEN DESCRIPTOR via /proc/self/fd, which cannot be raced, never on a path.
    // Not O_NOFOLLOW: it misses walked parent symlinks and refuses legitimate in-repo leaf symlinks.
    // Fails closed without /proc (macOS composes no plugin rulesets).
    let opened: string;
    try {
      opened = fs.readlinkSync(`/proc/self/fd/${fd}`);
    } catch {
      log.warn('Cannot identify the open descriptor (no /proc); not composing plugin rulesets on this host', { file });
      return null;
    }
    if (!path.isAbsolute(opened)) return null;
    if (opened !== root && !opened.startsWith(root + path.sep)) {
      log.warn('Plugin ruleset resolves outside its plugin repository; not composing it', { file, repoRoot: root });
      return null;
    }
    // Answer everything from the same descriptor, including size, which a second statSync would let a growing
    // file defeat.
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    // A hard link to a secret passes both realpath and fd-path containment; nlink is what differs.
    if (st.nlink !== 1) {
      log.warn('Plugin ruleset has more than one hard link; not composing it', { file, nlink: st.nlink });
      return null;
    }
    if (st.size > MAX_PLUGIN_RULESET_BYTES) {
      log.warn('Plugin ruleset is too large to compose; skipping it', {
        file,
        bytes: st.size,
        maxBytes: MAX_PLUGIN_RULESET_BYTES,
      });
      return null;
    }
    const buf = Buffer.allocUnsafe(st.size);
    let read = 0;
    while (read < st.size) {
      const n = fs.readSync(fd, buf, read, st.size - read, read);
      if (n === 0) break; // truncated under us — use what the fd actually held
      read += n;
    }
    return buf.subarray(0, read).toString('utf8').trim() || null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Whether either container-side walker treats `dir` as a plugin: Claude needs `.claude-plugin/plugin.json` to
 * exist; Codex needs `.codex-plugin/plugin.json` to parse with a non-empty `name`. Walks `<repo>/<sub>` and
 * `<repo>/plugins/<sub>` unconditionally, unlike Claude's stop-at-a-manifest-root rule (bootstrap ships a root
 * `.claude-plugin/`, so matching it would withhold its sub-plugins' directives from OpenCode).
 */
function hasPluginManifest(dir: string): boolean {
  if (fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))) return true;
  try {
    const raw = fs.readFileSync(path.join(dir, '.codex-plugin', 'plugin.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === 'string' && parsed.name.trim() !== '';
  } catch {
    return false;
  }
}

/** Sub-plugin dirs in both layouts; `subPath` is relative to the plugins root, the spelling `excludePlugins` uses. */
function subPluginDirs(pluginsRoot: string, name: string): Array<{ subPath: string; dir: string }> {
  const out: Array<{ subPath: string; dir: string }> = [];
  const seen = new Set<string>();
  for (const container of [path.join(name, 'plugins'), name]) {
    let subs: string[];
    try {
      subs = fs.readdirSync(path.join(pluginsRoot, container)).sort();
    } catch {
      continue;
    }
    for (const sub of subs) {
      if (sub.startsWith('.')) continue;
      const subPath = path.join(container, sub);
      if (seen.has(subPath)) continue;
      const dir = path.join(pluginsRoot, subPath);
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      if (!hasPluginManifest(dir)) continue;
      seen.add(subPath);
      out.push({ subPath, dir });
    }
  }
  return out;
}

const COMPOSED_HEADER =
  '<!-- Composed at spawn - do not edit. Standing instructions: standing-instructions.md. Memory: memory/. -->';

export interface ComposeGroupClaudeMdOptions {
  /** Spawn-resolved ID; do not re-derive a workgroup after reconciliation. */
  workgroupId?: string;
  /** Host-generated from the same policy and mounts as this spawn. */
  workgroupReadAccessInstructions?: string | null;
  /** Host-generated from the same wiki mount as this spawn (src/workgroup-wiki.ts). */
  workgroupWikiInstructions?: string | null;
}

/**
 * Directories a group's standing-instructions symlink may resolve into: its own plus its workgroup siblings'.
 * Another workgroup is a different tenant.
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

/** `provider` must be the spawn-resolved one (session override included), or this gate disagrees with buildMounts. */
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
  retireLegacyLocalFile(group.folder, groupDir);

  const projectRoot = path.resolve(GROUPS_DIR, '..');

  const configRow = await getContainerConfig(group.id);
  const mcpServers: Record<string, McpServerConfig> = configRow
    ? validateMcpServers(JSON.parse(configRow.mcp_servers) as Record<string, McpServerConfig>)
    : {};
  const desired = new Map<string, string>();
  if (effectiveOutcomeReporting(readContainerConfig(group.folder)))
    desired.set('zz-outcome-reporting.md', OUTCOME_REPORTING_INSTRUCTIONS);

  if (options.workgroupReadAccessInstructions) {
    if (!options.workgroupId)
      throw new Error('workgroup read-access instructions require a spawn-resolved workgroup ID');
    desired.set('host-workgroup-read-access.md', options.workgroupReadAccessInstructions);
  }
  if (options.workgroupWikiInstructions) {
    if (!options.workgroupId) throw new Error('workgroup wiki instructions require a spawn-resolved workgroup ID');
    desired.set('host-workgroup-wiki.md', options.workgroupWikiInstructions);
  }

  // Built-in module fragments (`<name>.instructions.md`). Scheduling guidance lives only in the cli fragment,
  // so it drops out when cli_scope is disabled. Flattening is safe: these are host-controlled trunk files.
  const cliDisabled = configRow?.cli_scope === 'disabled';
  const mcpToolsHostDir = path.join(projectRoot, MCP_TOOLS_HOST_SUBPATH);
  if (fs.existsSync(mcpToolsHostDir)) {
    for (const entry of fs.readdirSync(mcpToolsHostDir)) {
      const match = entry.match(/^(.+)\.instructions\.md$/);
      if (!match) continue;
      const moduleName = match[1];
      if (moduleName === 'cli' && cliDisabled) continue;
      // The task-list tool is registered only while its switch is on.
      if (moduleName === 'task-list' && !TASK_LIST_ENABLED) continue;
      desired.set(`module-${moduleName}.md`, flattenClaudeMd(path.join(mcpToolsHostDir, entry)));
    }
  }

  for (const [name, mcp] of Object.entries(mcpServers)) {
    if (mcp.instructions) {
      desired.set(`mcp-${name}.md`, mcp.instructions);
    }
  }

  // Always-on plugin rulesets. Claude and Codex get a plugin's own directive through its SessionStart hook
  // from the mount; this composes it for OpenCode only. `.nanoclaw-always-on.md` is the operator override,
  // composed for every non-Claude provider. `excludePlugins` and workgroup plugin scopes withhold it here as
  // they do the mount.
  if (provider !== 'claude') {
    // Same predicate as the container walkers (runner plugin-exclusions.ts is a verbatim copy).
    const excluded = splitExcludedPlugins(readContainerConfig(group.folder).excludePlugins);
    const pluginScopes = loadPluginScopes();
    const pluginsRoot = path.join(os.homedir(), 'plugins');
    let pluginDirs: string[] = [];
    try {
      pluginDirs = fs.readdirSync(pluginsRoot).sort();
    } catch {
      /* no ~/plugins — nothing to inject */
    }
    for (const name of pluginDirs) {
      if (isExcludedPluginPath(name, excluded) || !pluginAllowedForWorkgroup(name, options.workgroupId, pluginScopes))
        continue;
      const repoRoot = path.join(pluginsRoot, name);
      const override = readRulesetFile(repoRoot, NANOCLAW_ALWAYS_ON_MARKER, repoRoot);
      if (override) desired.set(`plugin-${name}.md`, override);
      // Codex dispatches plugin hooks only once container-side hook trust is installed; composing for Codex too
      // would deliver the directive twice. Re-check this gate if hook trust is removed.
      if (provider !== 'opencode') continue;
      // An operator override set above wins over the repo root's own ruleset.
      const rootFragment = `plugin-${name}.md`;
      if (!desired.has(rootFragment)) {
        const rootOwn = readRulesetFile(repoRoot, PLUGIN_ALWAYS_ON_FILE, repoRoot);
        if (rootOwn) desired.set(rootFragment, rootOwn);
      }
      for (const { subPath, dir } of subPluginDirs(pluginsRoot, name)) {
        if (isExcludedPluginPath(subPath, excluded)) continue;
        const content = readRulesetFile(dir, PLUGIN_ALWAYS_ON_FILE, repoRoot);
        if (!content) continue;
        // Keyed by the full sub-path: `repo/plugins/foo` and `repo/foo` share a basename. Keys are never used
        // as paths, so the `/` is safe.
        desired.set(`plugin-${subPath}.md`, content);
      }
    }
  }

  const persona = readGroupPersona(groupDir, await personaSymlinkRoots(group, groupDir));
  if (persona) {
    desired.set(STANDING_INSTRUCTIONS_FRAGMENT, persona);
  }

  // Flattening is safe: host-controlled.
  const sharedBaseHostPath = path.join(projectRoot, 'container', 'CLAUDE.md');

  // Persona first, then the shared base, then the remaining fragments sorted.
  //
  // SECURITY: mcp/plugin/persona bodies are emitted VERBATIM, never flattened: their sources are
  // agent-writable, and flattening runs host-side, so an `@~/.env` would exfiltrate host bytes into the mount.
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

  // Same flat body for Codex/OpenCode, which do not expand @-references.
  const fullAgents =
    '<!-- Generated by composeGroupClaudeMd from CLAUDE.md. Do not edit. All instruction sections inlined. -->\n\n' +
    body;
  // Uncapped. Codex containers raise `project_doc_max_bytes` to this value; exceeding it means the doc grew
  // absurdly or the container override stopped applying.
  if (provider === 'codex') {
    warnIfOversized(`${group.folder}/AGENTS.md`, fullAgents, CODEX_PROJECT_DOC_CONFIGURED_MAX_BYTES);
  }
  writeAtomic(path.join(groupDir, 'AGENTS.md'), fullAgents);
}

/**
 * Retire a group's legacy `CLAUDE.local.md`: remove an empty placeholder, warn about anything else (content or
 * a symlink, never followed). Moving content is the operator's call. Accepted race: a container write between
 * the read and the by-name unlink is lost.
 */
const PLACEHOLDER_MAX_BYTES = 4096;

function retireLegacyLocalFile(groupFolder: string, groupDir: string): void {
  const localFile = path.join(groupDir, 'CLAUDE.local.md');
  const warnLegacy = (kind: string): void =>
    log.warn(
      'Legacy CLAUDE.local.md is no longer composed; only Claude loads it. Move its content into standing-instructions.md',
      { group: groupFolder, kind },
    );

  // ONE open, then every judgment on that descriptor: the folder is a live container's RW mount, so a FIFO
  // swapped in would hang the host's main thread. O_NOFOLLOW refuses a symlink; O_NONBLOCK a FIFO wait.
  let fd: number;
  try {
    fd = fs.openSync(
      localFile,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return; // absent — the settled state
    if (code === 'ELOOP') return warnLegacy('symlink'); // never followed, never removed
    log.warn('Could not inspect legacy CLAUDE.local.md; left untouched', {
      group: groupFolder,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  let empty = false;
  let kind = 'other';
  try {
    const st = fs.fstatSync(fd);
    if (st.isFile()) {
      kind = 'file';
      // Bounded read: a container may grow the file after the fstat.
      if (st.size <= PLACEHOLDER_MAX_BYTES) {
        const buf = Buffer.alloc(PLACEHOLDER_MAX_BYTES + 1);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        empty = n <= PLACEHOLDER_MAX_BYTES && buf.toString('utf-8', 0, n).trim() === '';
      }
    }
  } catch {
    /* unreadable: treated as content, never deleted blind */
  } finally {
    fs.closeSync(fd);
  }
  if (!empty) return warnLegacy(kind);

  try {
    fs.unlinkSync(localFile);
  } catch (err) {
    // A container replaced it since the read; the next spawn retries.
    log.warn('Could not remove empty legacy CLAUDE.local.md; left for next spawn', {
      group: groupFolder,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** ONE-RELEASE CLEANUP (delete once every group has respawned): pre-inlining `@`-import symlink artifacts. */
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
