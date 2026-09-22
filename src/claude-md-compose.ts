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
import { OUTCOME_REPORTING_INSTRUCTIONS } from './outcome-reporting-instructions.js';
import os from 'os';
import path from 'path';

import { GROUPS_DIR } from './config.js';
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

// Fragment holding a group's standing instructions. Imported FIRST (before
// the shared base) so it is the top of the composed system prompt.
const STANDING_INSTRUCTIONS_FRAGMENT = 'standing-instructions.md';

// Host-side source paths used to discover fragment sources at compose time.
// Joined against `projectRoot` (derived from GROUPS_DIR) at call time so
// tests, which mock GROUPS_DIR to a scratch dir, resolve these consistently.
const MCP_TOOLS_HOST_SUBPATH = path.join('container', 'agent-runner', 'src', 'mcp-tools');

/**
 * NanoClaw-side override marker, written by the operator (via
 * /enable-agent-plugins) into a `~/plugins` entry that ships no clean standing
 * ruleset of its own. A NanoClaw-specific filename, so it belongs only on
 * third-party plugins we do not control.
 */
const NANOCLAW_ALWAYS_ON_MARKER = '.nanoclaw-always-on.md';

/**
 * A plugin's OWN standing-directive file, in the plugin's own vocabulary — no
 * NanoClaw-specific name, nothing a plugin repo carries for our benefit.
 */
const PLUGIN_ALWAYS_ON_FILE = 'always-on.md';

/**
 * Largest plugin ruleset this composer will read, in bytes.
 *
 * Sized against the surface it feeds rather than picked round: the composed
 * doc as a whole is already capped at `CODEX_PROJECT_DOC_CONFIGURED_MAX_BYTES`
 * (`src/codex-project-doc-cap.ts`), and one plugin's standing directive is a
 * fraction of a document that also carries the persona, the shared base and
 * every other fragment. 64 KiB is far above every ruleset in the tree and far
 * below anything that costs a spawn measurable time or memory.
 */
const MAX_PLUGIN_RULESET_BYTES = 64 * 1024;

/**
 * One ruleset file's trimmed contents, or null when absent, empty, unreadable,
 * or resolving outside `repoRoot`.
 *
 * The containment check is this reader's security boundary, and it lives here
 * because this is the one place the bytes are actually read. What this composes
 * lands in the group's `AGENTS.md`, which is mounted into the container — so the
 * HOST reads a path and publishes it somewhere the container can see. Every
 * component of that path is plugin-choosable: `statSync` and `readFileSync`
 * follow symlinks, and `subPluginDirs` walks through directory symlinks too, so
 * an `always-on.md` symlinked at `~/.codex/auth.json`, or a sub-plugin directory
 * symlinked at `/etc`, would otherwise read host-only state and paste it into
 * the prompt.
 *
 * That a plugin's code is already trusted to RUN in the container is not the
 * same permission — this crosses host-only state into container-visible state.
 * So the rule is resolved-path containment rather than a check on the final
 * component: `realpathSync` both sides, compared with a separator boundary so a
 * sibling named `<root>-evil` cannot prefix-match. Resolving the root as well
 * keeps an ordinarily-symlinked `~/plugins/<name>` (a dev checkout living
 * elsewhere) working, and an in-repo symlink still composes — only leaving the
 * repository is refused.
 */
function readRulesetFile(dir: string, filename: string, repoRoot: string): string | null {
  const file = path.join(dir, filename);
  // The root is resolved BEFORE the open, and that ordering is the point. A
  // root resolved afterwards is a second pathname lookup the first one cannot
  // constrain: swap `~/plugins/<repo>` for a symlink to `/home/ubuntu` between
  // the two, and a descriptor holding `~/.codex/auth.json` measures as
  // contained by the freshly-resolved root. Resolving first means the fd is
  // always judged against the root we INTENDED, and a root swapped before the
  // open sends the open somewhere that no longer measures as inside it.
  let root: string;
  try {
    root = fs.realpathSync(repoRoot);
  } catch {
    return null;
  }
  let fd: number;
  try {
    // O_NONBLOCK, always: opening a FIFO for reading blocks until a writer
    // appears, and that open happens before any check below can reject it — so
    // a plugin repo carrying a `mkfifo` would hang the host's single event loop
    // rather than return an error. On a regular file Linux ignores the flag.
    // Same flag, same reason, as `readContainedFile` in
    // `src/dashboard/api/attention-fs.ts`, which is where this pattern comes
    // from.
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    // Containment is decided about the OPEN DESCRIPTOR, never about a path.
    // `realpathSync(file)` answers a question about a string at one instant;
    // between that answer and the read, any component — the leaf or a directory
    // `subPluginDirs` walked through — can become a symlink, and the read then
    // follows somewhere the check never saw. `/proc/self/fd/<fd>` is a
    // kernel-maintained link to the inode this descriptor already holds, so it
    // cannot be raced: the open happened first, and nothing about a path can
    // change what an open descriptor refers to.
    //
    // This matters because what the host reads here is written into the group's
    // `AGENTS.md`, which is mounted into the container — so a win moves
    // host-only state (`~/.codex/auth.json`, `.env`) into container-visible
    // state. That a plugin's code already runs in the container is a different
    // permission.
    //
    // NOT `O_NOFOLLOW`: it refuses only the final component, so it would not
    // close the walked-parent case this check does close, and it WOULD refuse a
    // leaf that is legitimately a symlink to another file inside the same repo.
    //
    // FAILS CLOSED where the descriptor cannot be identified. `/proc` is absent
    // on macOS, and falling back to `realpathSync(file)` there would reinstate
    // exactly the pathname lookup this check exists to avoid. `attention-fs.ts`
    // does take that fallback, because it serves a live dashboard where
    // emitting nothing is a visible outage; here the cost is that a macOS
    // developer checkout composes no plugin rulesets, which is a degraded
    // convenience rather than a broken product. This host is Linux (CLAUDE.md).
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
    // Every remaining question is answered from this same descriptor, so a swap
    // has nothing left to win — including the size bound, which a second
    // `statSync` would let a growing file defeat.
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    // A HARD LINK defeats containment in either form, and measuring it is the
    // only way to see that: `ln ~/.codex/auth.json <repo>/plugins/x/always-on.md`
    // makes both `realpath` and the fd path answer with the in-repo name
    // (verified on this host), because a hard link is not an indirection — the
    // directory entry IS the file. So containment alone would compose the
    // secret. `nlink` is the property that actually differs, and this repo
    // already uses it for the same reason on the canonical-git sentinel
    // (`docs/review-notes.md`, #739). A plugin's standing ruleset having a
    // second name is not a legitimate shape.
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
 * A directory is a sub-plugin when it declares itself one, which is the signal
 * both container-side walkers use: Claude asks only that
 * `.claude-plugin/plugin.json` EXIST (`hasManifest`,
 * `container/agent-runner/src/providers/claude.ts:1760`, applied to `<repo>/<sub>`
 * and `<repo>/plugins/<sub>` alike), while Codex additionally requires the
 * manifest to PARSE and carry a non-empty `name`, since that name is what it
 * registers (`readCodexPluginEntryName`,
 * `container/agent-runner/src/codex-companion-setup.ts:804`, reached from
 * `findCodexSubPlugins` at `:853` for the same two layouts).
 *
 * Each manifest is held to its OWN walker's rule rather than to one rule for
 * both: a broken `.codex-plugin/plugin.json` is not a plugin to Codex, so it
 * must not be one here either.
 *
 * EITHER manifest, because this composer serves OpenCode — the provider with no
 * native plugin loader at all — and a directory either walker would load as a
 * plugin is one this must be able to speak for. A directory declaring neither is
 * not a plugin to anything in this system: a ruleset file under
 * `~/plugins/<repo>/docs/` would otherwise be injected into every OpenCode
 * group's standing prompt while no walker mounts, registers or excludes it, and
 * `excludePlugins` names plugins.
 *
 * NOT a claim that this walks the same DIRECTORIES the walkers do, only that it
 * asks the same question of one. Claude stops descending at a repo root that
 * carries a manifest and descends a level deeper than this does elsewhere; this
 * composer walks `<repo>/<sub>` and `<repo>/plugins/<sub>` unconditionally, and
 * that is load-bearing — `bootstrap` ships a root `.claude-plugin/`, so matching
 * Claude's stop-at-the-root rule would withhold `plugins/wwbd`'s directive from
 * every OpenCode group.
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

/**
 * Every sub-plugin directory of one `~/plugins` entry, in both layouts the
 * container-side walkers descend: `<repo>/plugins/<sub>` and `<repo>/<sub>`.
 * Returned paths are relative to the plugins root, which is the spelling
 * `excludePlugins` uses.
 */
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
 * Regenerate `groups/<folder>/CLAUDE.md` from the shared base, built-in
 * module fragments, and MCP server fragments declared in `container.json`.
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
  retireLegacyLocalFile(group.folder, groupDir);

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

  // Always-on agent-plugin rulesets. A plugin's standing directive reaches a
  // container by ONE of two paths, never both:
  //
  //   1. The plugin's own SessionStart hook, from the mounted plugin. Claude
  //      auto-loads it via CLAUDE_PLUGINS_ROOT; Codex fires plugin hooks too,
  //      and a hook that injects context is how a Codex container gets the
  //      directive natively. Neither provider is composed for below.
  //   2. This composer, for OpenCode only — the one provider with no plugin
  //      hook path at all. It reads the plugin's own generic
  //      `always-on.md` (no NanoClaw-specific filename in the plugin repo).
  //
  // Separately, `~/plugins/<name>/.nanoclaw-always-on.md` is the operator's
  // OVERRIDE for a third-party plugin that ships no clean ruleset — a
  // NanoClaw-side convention authored by /enable-agent-plugins, read for every
  // non-Claude provider as it always has been.
  //
  // Per-group opt-out reuses `excludePlugins` — the same field that drops the
  // mount — so excluding a plugin, or one sub-plugin path of a monorepo,
  // withholds its directive here too. A workgroup-scoped plugin's ruleset
  // reaches only its workgroups, matching the mount (src/plugin-scopes.ts);
  // with no spawn-resolved workgroup it reaches none. See docs/skills-model.md.
  if (provider !== 'claude') {
    // The same split, and below the same predicate, the three container
    // walkers ask (`container/agent-runner/src/plugin-exclusions.ts` is a
    // verbatim copy of the module this imports), so a directive and a
    // registration can never disagree about one entry.
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
      // A plugin's own always-on.md reaches OpenCode and nothing else. Claude
      // auto-loads the plugin's SessionStart hook through CLAUDE_PLUGINS_ROOT,
      // and Codex fires plugin hooks too — but ONLY for a plugin whose
      // `.codex-plugin/plugin.json` declares them AND whose hook identity is
      // TRUSTED. That trust is not automatic: codex reports an unenrolled plugin
      // hook as `trustStatus: "untrusted"` and never dispatches it, which made
      // this gate's premise FALSE until #827 installed container-side hook
      // trust. #827 is merged and is in this branch, so the premise holds. The
      // ordering was the fix rather than the code — composing for Codex in the
      // meantime would have delivered the text twice the day #827 landed.
      // Re-check this gate if hook trust is removed, or if a plugin's manifest
      // stops declaring the hooks file it ships.
      if (provider !== 'opencode') continue;
      // The repo ROOT's own generic ruleset, for a single-plugin repo whose
      // directive is not under a sub-plugin. Without this, such a repo would
      // still need a NanoClaw-specific `.nanoclaw-always-on.md` to reach
      // OpenCode — the exact property a plugin repo we maintain is supposed to
      // avoid. Same containment read and same key as the override, so an
      // operator override present alongside it wins: `desired.set` above ran
      // first, and this does not overwrite.
      const rootFragment = `plugin-${name}.md`;
      if (!desired.has(rootFragment)) {
        const rootOwn = readRulesetFile(repoRoot, PLUGIN_ALWAYS_ON_FILE, repoRoot);
        if (rootOwn) desired.set(rootFragment, rootOwn);
      }
      for (const { subPath, dir } of subPluginDirs(pluginsRoot, name)) {
        if (isExcludedPluginPath(subPath, excluded)) continue;
        const content = readRulesetFile(dir, PLUGIN_ALWAYS_ON_FILE, repoRoot);
        if (!content) continue;
        // Keyed by the FULL sub-path, not its basename. A repo carrying the
        // same name in both walked layouts (`repo/plugins/foo` and `repo/foo`
        // — `subPluginDirs` returns both) shares a basename, so a
        // basename-keyed fragment collided and one sub-plugin's ruleset was
        // silently dropped. `subPath` is unique per sub-plugin by construction
        // (`subPluginDirs` dedupes on it — the `seen` set at :93, added at
        // :111), and it always carries a `/`, which a top-level
        // `plugin-<name>.md` key never can: `name` is an entry of
        // `fs.readdirSync(pluginsRoot)` (:273), i.e. one path component. The
        // two key spaces are therefore disjoint and no collision is reachable.
        //
        // A `/` here is safe ONLY because these keys never become paths, so
        // that is asserted against every consumer rather than assumed — a key
        // that reached a path join would make this traversal, not a collision.
        // `desired` is a function-local const (:204), never returned and never
        // passed to a callee. Written at :209, :213, :232, :240, :280, this
        // line, and :323; read at exactly two places — `pushFragment`'s
        // `desired.get` (:364) and the `[...desired.keys()].sort()` that orders
        // sections (:369). Both feed `sections`, joined into `body` (:372) and
        // written to two FIXED paths, `<groupDir>/CLAUDE.md` (:373) and
        // `<groupDir>/AGENTS.md` (:420). No key is ever a filename: the
        // `.claude-fragments/` directory that once made them one is gone along
        // with the mount that backed it (`src/container-runner.ts:4845-4846`),
        // and `removeStaleFragmentArtifacts` only deletes that legacy
        // directory — it never reads `desired`.
        desired.set(`plugin-${subPath}.md`, content);
      }
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
  // through its own mount — a container-to-host exfiltration path around the
  // rule that containers never receive raw credentials. Only the shared base
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

  // Codex parity: also emit an AGENTS.md carrying the same flat body. Codex
  // doesn't expand @-references in AGENTS.md, so a reference would reach the
  // model as literal text — which is exactly why the body above is already
  // flat. The two files are the same document: every per-group instruction
  // reaches every provider through `standing-instructions.md`, composed above.
  const fullAgents =
    '<!-- Generated by composeGroupClaudeMd from CLAUDE.md. Do not edit. All instruction sections inlined. -->\n\n' +
    body;
  // Written UNCAPPED for every provider — content bloat is judged by a human
  // reading the file, not by a byte number. Codex containers raise their own
  // `project_doc_max_bytes` to CODEX_PROJECT_DOC_CONFIGURED_MAX_BYTES
  // (codex-app-server.ts); warn loudly if we ever exceed that, since it means
  // either the doc grew absurdly or the container override stopped applying.
  if (provider === 'codex') {
    warnIfOversized(`${group.folder}/AGENTS.md`, fullAgents, CODEX_PROJECT_DOC_CONFIGURED_MAX_BYTES);
  }
  writeAtomic(path.join(groupDir, 'AGENTS.md'), fullAgents);
}

/**
 * Retire a group's legacy `CLAUDE.local.md`.
 *
 * It is a leftover of the v2 cutover, which renamed each group's hand-written
 * `CLAUDE.md` so the host could generate that name. It then held the same
 * thing as `standing-instructions.md` — a group's identity and standing rules
 * — in a second place that reached providers unevenly: Claude Code
 * auto-discovers it, Codex and OpenCode never did, so this composer used to
 * append it to `AGENTS.md` by hand. One persona file per group,
 * `standing-instructions.md`, now carries all of it.
 *
 * Earlier builds created the file empty on every init and every spawn, so an
 * empty or whitespace-only regular file is that placeholder and is removed.
 * Anything else — real content, or a symlink — is left exactly as it is and
 * warned about on every spawn. It is no longer composed, so for Codex and
 * OpenCode it is invisible, while Claude Code still loads it natively: the
 * one-provider-only reach this retirement exists to end. Moving its content
 * is an edit to an agent's identity, which is the operator's call, not this
 * function's. A symlink is never followed or read here.
 *
 * One window is accepted, not closed: the unlink is by name, so a write the
 * container lands between the read and the unlink is lost. Only the container
 * can race it, into a file it has no reason to write, for microseconds.
 */
const PLACEHOLDER_MAX_BYTES = 4096;

function retireLegacyLocalFile(groupFolder: string, groupDir: string): void {
  const localFile = path.join(groupDir, 'CLAUDE.local.md');
  const warnLegacy = (kind: string): void =>
    log.warn(
      'Legacy CLAUDE.local.md is no longer composed; only Claude loads it. Move its content into standing-instructions.md',
      { group: groupFolder, kind },
    );

  // ONE open, then every judgment on that descriptor. The folder is a live
  // container's read-write /workspace/agent, so a lstat-then-read-then-rm by
  // name can be raced: swap in a FIFO after the lstat and a blocking read hangs
  // the host's main thread — every group, not one. O_NOFOLLOW refuses a symlink
  // (ELOOP), O_NONBLOCK makes a FIFO open return instead of waiting for a
  // writer, and fstat on the fd judges the object actually opened.
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
      // A placeholder is 0 bytes (a trimmed one a few more); anything larger is
      // content by definition. The read is BOUNDED as well as gated: the size
      // is from fstat, and a container growing the file after it must not turn
      // this into an unbounded read on the host's main thread.
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
    // A container replaced it since the read (a directory, say). Nothing was
    // lost and the spawn must not fail over a retired file; next spawn retries.
    log.warn('Could not remove empty legacy CLAUDE.local.md; left for next spawn', {
      group: groupFolder,
      error: err instanceof Error ? err.message : String(err),
    });
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
