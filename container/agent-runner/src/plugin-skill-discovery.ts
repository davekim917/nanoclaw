/**
 * Plugin-skill discovery for Codex parity.
 *
 * Walks a `~/plugins/`-style root and finds every portable skill (SKILL.md)
 * that should be exposed to Codex. The host script and the container-side
 * setup both consume this — same rules apply to `~/plugins/*` on host and
 * `/workspace/plugins/*` inside the container.
 *
 * Discovery preference order per plugin (highest-priority match wins, one
 * skill-name → one path):
 *
 *   1. `<plugin>/.agents/skills/<name>/SKILL.md`        ← runtime-agnostic canonical
 *   2. `<plugin>/skills/<name>/SKILL.md`                ← top-level skills dir
 *   3. `<plugin>/SKILL.md`                              ← single-skill (name = plugin)
 *   4. `<plugin>/plugin/skills/<name>/SKILL.md`         ← impeccable-style
 *   5. `<plugin>/<plugin>-cursor-integration/skills/<name>/SKILL.md`
 *   6. `<plugin>/<plugin>-claude-plugin/skills/<name>/SKILL.md`
 *
 * Skipped:
 *   - Plugins on `denyPlugins` (Claude-runtime-only by design — bootstrap-workflow,
 *     codex plugin, etc.)
 *   - Skill dirs under runtime-specific path segments: `.claude/`, `.cursor/`,
 *     `.opencode/`, `.gemini/`, `.kiro/`, `.trae/`, `.trae-cn/`, `.qoder/`,
 *     `.rovodev/`, `.github/`, `.pi/` (these are runtime-specific duplicates;
 *     prefer `.agents/skills/` which is the canonical multi-runtime version)
 *   - SKILL.md files with `user-invocable: false` in frontmatter
 *   - Deprecated dirs under `<plugin>/deprecated/`
 *   - Plugins under `<plugin>/plugins/<sub>/skills/` when `<sub>` matches a
 *     plugin-specific denylist (e.g. bootstrap-workflow within davekim917/bootstrap)
 *   - Codex-native plugin skill roots that are loaded through Codex plugin
 *     metadata. Mirroring those into `~/.agents/skills` would create a second
 *     same-named install path and make source precedence ambiguous.
 */
import fs from 'fs';
import path from 'path';

import { isExcludedPluginPath, splitExcludedPlugins, type ExcludedPlugins } from './plugin-exclusions.js';

export interface DiscoveredSkill {
  /** Skill name (used as `~/.codex/skills/<name>/` link basename) */
  name: string;
  /** Absolute path to the skill directory containing SKILL.md */
  skillDir: string;
  /** Plugin folder it came from */
  plugin: string;
  /**
   * Absolute path to the repository root that must CONTAIN every byte this
   * skill contributes to a mirror. `syncSkillSymlinks` refuses anything
   * resolving outside it; the host twin carries the full reasoning.
   */
  pluginRoot: string;
}

/** `fs.realpathSync`, or null when the path does not resolve. Null means refuse. */
export function resolveRealPath(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/**
 * Is an already-resolved path inside an already-resolved root? Separator
 * boundary, so a sibling named `<root>-evil` cannot prefix-match.
 */
export function isWithinResolvedRoot(resolved: string, resolvedRoot: string): boolean {
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

/**
 * The resolved repository roots a mirror built from `pluginsRoot` may point
 * into — one per plugin directory, each resolved so a symlinked plugin checkout
 * keeps working.
 */
export function resolvePluginRoots(pluginsRoot: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(pluginsRoot);
  } catch {
    return [];
  }
  const roots: string[] = [];
  for (const entry of entries) {
    // `.git`, `.codex`, `.agents` under the plugins root are not plugins and
    // must not widen the boundary.
    if (entry.startsWith('.')) continue;
    const resolved = resolveRealPath(path.join(pluginsRoot, entry));
    if (resolved === null) continue;
    if (!isDirectory(resolved)) continue;
    roots.push(resolved);
  }
  return roots;
}

/**
 * Plugins to skip entirely. These wrap Claude-only runtime functionality
 * (Skill tool, Agent tool, slash-command machinery).
 */
export const DEFAULT_DENY_PLUGINS = new Set<string>([
  // bootstrap: many sub-plugins inside; we walk it with a finer-grained denylist
  //            via DENY_SUB_PLUGIN_SKILL_DIRS, not at the top level.
  // codex: skills here are Codex-plugin internal, already loaded via the codex
  //        Claude plugin and either non-user-invocable or specific to Claude.
  'codex',
  // design-artifact-loop: ships in-tree (container/skills skill + the
  //   agent-runner design_review MCP tool rooted at /workspace/agent). The
  //   standalone plugin's portable skill uses cwd-based paths the in-container
  //   tool rejects — mirroring it would duplicate the in-tree skill with
  //   conflicting instructions. Host codex loads it natively via `codex plugin add`.
  'design-artifact-loop',
]);

/**
 * Within a multi-plugin repo (like davekim917/bootstrap, which contains
 * workflow/domain/tools sub-plugins), these maps mark the *sub-plugin* skill
 * roots to ignore — runtime-conditional. Different agent runtimes have
 * different native plugin loaders, so a skill that's "denied" for one runtime
 * (because the runtime loads it via a native path) may need to be surfaced
 * for another runtime that lacks that loader.
 *
 * Format: `<plugin>/<sub-plugin-skills-segment>`
 *
 * Sibling-parity invariant: when adding a new runtime, the denylist for that
 * runtime should ONLY exclude skill roots that this runtime loads through
 * another path. Skills that can't be invoked but CAN be read as instruction
 * text should still be surfaced.
 */
const DENY_SUB_PLUGIN_SKILL_DIRS_BY_RUNTIME: Record<AgentRuntime, Set<string>> = {
  claude: new Set<string>([
    'bootstrap/plugins/workflow-agents/skills',
    'bootstrap/plugins/orchestrate-agents/skills',
  ]),
  codex: new Set<string>([
    'bootstrap/plugins/workflow/skills',
    'bootstrap/plugins/workflow-agents/skills',
    // orchestrate-agents needs no entry: it ships `.codex-plugin`, so the
    // manifest rule already keeps it out of the codex mirror.
    'bootstrap/plugins/orchestrate/skills',
  ]),
  opencode: new Set<string>([
    'bootstrap/plugins/workflow/skills',
    // Claude orchestrate dispatches through Claude's Agent tool; the
    // orchestrate-agents twin stays surfaced, matching team-*.
    'bootstrap/plugins/orchestrate/skills',
    // workflow-agents is NOT denied — opencode has no native codex-plugin
    // loader, and surfacing the skill TEXT gives the agent awareness of
    // /team-* patterns even without the spawn_task harness.
  ]),
};

export type AgentRuntime = 'claude' | 'codex' | 'opencode';

// 'claude' is intentionally the most-conservative fallback (every runtime is
// allowed to see Claude's workflow skill set). Callers should pass `runtime`
// explicitly; this default exists only for back-compat.
const DEFAULT_RUNTIME: AgentRuntime = 'claude';

/**
 * Path segments that mean "runtime-specific copy of a skill" — we prefer the
 * `.agents/skills/` canonical version (or the plugin-author's chosen top-level)
 * over these.
 */
const RUNTIME_SPECIFIC_DIRS = new Set<string>([
  '.claude',
  '.cursor',
  '.opencode',
  '.gemini',
  '.kiro',
  '.trae',
  '.trae-cn',
  '.qoder',
  '.rovodev',
  '.github',
  '.pi',
]);

/**
 * A (sub)plugin dir that ships `.codex-plugin/plugin.json` is loaded natively by
 * Codex through its plugin marketplace/cache — skills namespaced `<plugin>:`,
 * plus any MCP server the plugin declares. Mirroring such a plugin into the
 * portable-skill set would DUPLICATE every skill (unprefixed, and — worse —
 * stripped of its MCP server). So the Codex mirror skips a plugin Codex already
 * loads natively. This is orthogonal to the .nanoclaw-plugin.json marker: the
 * marker says "don't deliver to this sibling AT ALL" (any mechanism); this rule
 * says "don't DOUBLE-deliver to Codex via the mirror what it already gets
 * natively." A Codex-native plugin therefore stays OUT of `denySiblings` for
 * codex (Codex should have it) yet is still skipped from the Codex mirror here.
 */
function loadedNativelyByCodex(pluginRootDir: string): boolean {
  return fs.existsSync(path.join(pluginRootDir, '.codex-plugin', 'plugin.json'));
}

/**
 * Per-plugin sibling routing marker: `~/plugins/<plugin>/.nanoclaw-plugin.json`.
 * The single source of truth for which of the three container agent providers
 * (claude | codex | opencode) a plugin is delivered to. Default is all three;
 * `denySiblings` is the exception list. Written/updated by enable-agent-plugin
 * (`--deny`/`--allow`) or edited by hand, and re-read on every reconcile and
 * every container spawn — so a change after initial enabling just takes effect,
 * no drift. See docs and enable-agent-plugin.ts.
 */
export function readPluginDenySiblings(pluginDir: string): Set<AgentRuntime> {
  try {
    const raw = fs.readFileSync(path.join(pluginDir, '.nanoclaw-plugin.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { denySiblings?: unknown };
    const list = Array.isArray(parsed.denySiblings) ? parsed.denySiblings : [];
    return new Set(list.filter((x): x is AgentRuntime => x === 'claude' || x === 'codex' || x === 'opencode'));
  } catch {
    // No marker / unreadable / malformed → deliver to all siblings (the default).
    return new Set();
  }
}

function hasSkillMd(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, 'SKILL.md')).isFile();
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readFrontmatter(skillMd: string): Record<string, string> {
  try {
    const content = fs.readFileSync(skillMd, 'utf-8');
    if (!content.startsWith('---')) return {};
    const end = content.indexOf('\n---', 3);
    if (end < 0) return {};
    const block = content.slice(4, end);
    const result: Record<string, string> = {};
    for (const line of block.split('\n')) {
      const m = line.match(/^([a-z][a-z0-9_-]*)\s*:\s*(.*)$/i);
      if (m) result[m[1]] = m[2].trim();
    }
    return result;
  } catch {
    return {};
  }
}

function isUserInvocable(skillDir: string): boolean {
  const fm = readFrontmatter(path.join(skillDir, 'SKILL.md'));
  return fm['user-invocable'] !== 'false';
}

function readPluginName(skillDir: string): string | null {
  const fm = readFrontmatter(path.join(skillDir, 'SKILL.md'));
  return fm.name || null;
}

/**
 * For a single plugin folder, enumerate every portable skill following the
 * preference order. Returns each skill exactly once (by name) — later
 * matches with the same name are dropped.
 */
function discoverInPlugin(
  pluginDir: string,
  pluginName: string,
  denySubPluginSkillDirs: Set<string>,
  allowNonInvocable: boolean,
  runtime: AgentRuntime,
  excluded: ExcludedPlugins,
): DiscoveredSkill[] {
  const skills = new Map<string, DiscoveredSkill>();

  // Manifest-derived mirror routing: the Codex mirror skips any plugin root
  // Codex loads natively (see loadedNativelyByCodex). Applied per plugin root
  // — the top-level plugin (rules 1–6) and each sub-plugin (rules 7–8).
  const skipCodexNative = (root: string) => runtime === 'codex' && loadedNativelyByCodex(root);
  const doTopLevel = !skipCodexNative(pluginDir);

  // The group's exclusions, asked ONCE here rather than at each layout rule.
  // Every rule below ends at `recordCandidate`, and it is the only place that
  // holds the candidate's full path, so this is the seam they share. Rules 7
  // and 8 used to carry the check themselves, and rules 4-6 — `plugin/`,
  // `<repo>-cursor-integration/`, `<repo>-claude-plugin/`, all of them
  // root-level sub-plugin layouts an entry can legitimately name — did not, so
  // an excluded sub-plugin in one of those shapes was recorded before the
  // later check could refuse it (first match wins), and only this walker
  // disagreed: Claude's and Codex's honour the same entry. A predicate applied
  // per layout rule is a predicate one new layout rule forgets.
  //
  // `relPath` is assembled from this walk's own names — `pluginName`, then the
  // path the rule built under `pluginDir` — never a `realpath`, which is what
  // `isExcludedPluginPath` requires. Ancestor coverage does the rest: a
  // candidate at `<repo>/plugin/skills/<name>` is covered by an entry naming
  // `<repo>/plugin`.
  const excludedCandidate = (skillDir: string): boolean => {
    const rel = path.relative(pluginDir, skillDir);
    return isExcludedPluginPath(rel ? `${pluginName}/${rel.split(path.sep).join('/')}` : pluginName, excluded);
  };

  const recordCandidate = (skillDir: string) => {
    if (!hasSkillMd(skillDir)) return;
    if (excludedCandidate(skillDir)) return;
    // `user-invocable: false` skills are referenceable helpers (e.g.
    // team-verification-before-completion), not user-facing commands. Claude & Codex load
    // them via native plugin loaders — available to reference, hidden from the command list.
    // OpenCode has NO plugin loader; this discovery mirror is its ONLY skill delivery, so
    // filtering these out makes them UNavailable and breaks the visible skills that reference
    // them. For opencode we therefore provision them too (they also surface as commands —
    // opencode can't load-without-surfacing — an accepted cosmetic cost for availability parity).
    if (!isUserInvocable(skillDir) && !allowNonInvocable) return;
    const fmName = readPluginName(skillDir);
    const name = fmName ?? path.basename(skillDir);
    if (skills.has(name)) return; // first match wins (preference order)
    skills.set(name, { name, skillDir, plugin: pluginName, pluginRoot: pluginDir });
  };

  // 1. .agents/skills/<name>/
  const agentsSkillsDir = path.join(pluginDir, '.agents', 'skills');
  if (doTopLevel && isDirectory(agentsSkillsDir)) {
    for (const sub of fs.readdirSync(agentsSkillsDir)) {
      recordCandidate(path.join(agentsSkillsDir, sub));
    }
  }

  // 2. skills/<name>/
  const topSkillsDir = path.join(pluginDir, 'skills');
  if (doTopLevel && isDirectory(topSkillsDir)) {
    for (const sub of fs.readdirSync(topSkillsDir)) {
      recordCandidate(path.join(topSkillsDir, sub));
    }
  }

  // 3. <plugin>/SKILL.md (single-skill plugin)
  if (doTopLevel) recordCandidate(pluginDir);

  // 4. plugin/skills/<name>/ (impeccable's `plugin/` subdir)
  const pluginSubDir = path.join(pluginDir, 'plugin', 'skills');
  if (doTopLevel && isDirectory(pluginSubDir)) {
    for (const sub of fs.readdirSync(pluginSubDir)) {
      recordCandidate(path.join(pluginSubDir, sub));
    }
  }

  // 5. <plugin>-cursor-integration/skills/<name>/
  const cursorDir = path.join(pluginDir, `${pluginName}-cursor-integration`, 'skills');
  if (doTopLevel && isDirectory(cursorDir)) {
    for (const sub of fs.readdirSync(cursorDir)) {
      recordCandidate(path.join(cursorDir, sub));
    }
  }

  // 6. <plugin>-claude-plugin/skills/<name>/ (last resort)
  const claudePluginDir = path.join(pluginDir, `${pluginName}-claude-plugin`, 'skills');
  if (doTopLevel && isDirectory(claudePluginDir)) {
    for (const sub of fs.readdirSync(claudePluginDir)) {
      recordCandidate(path.join(claudePluginDir, sub));
    }
  }

  // 7. multi-plugin repos: <plugin>/plugins/<sub>/skills/<name>/
  //    Common in davekim917/bootstrap. Respect manifest routing + curated denylist.
  const multiPluginDir = path.join(pluginDir, 'plugins');
  if (isDirectory(multiPluginDir)) {
    for (const sub of fs.readdirSync(multiPluginDir)) {
      const subDir = path.join(multiPluginDir, sub);
      if (skipCodexNative(subDir)) continue;
      const subKey = `${pluginName}/plugins/${sub}/skills`;
      if (denySubPluginSkillDirs.has(subKey)) continue;
      const subSkillsDir = path.join(subDir, 'skills');
      if (!isDirectory(subSkillsDir)) continue;
      for (const skillName of fs.readdirSync(subSkillsDir)) {
        recordCandidate(path.join(subSkillsDir, skillName));
      }
    }
  }

  // 8. marketplace monorepos: <plugin>/<sub>/skills/<name>/ — sub-plugins at the
  //    REPO ROOT rather than under `plugins/` (rule 7). anthropics/knowledge-work-plugins
  //    is shaped this way. Gated on `<sub>/.claude-plugin/plugin.json` so we only walk
  //    dirs that declare themselves a plugin — the same signal Claude's own
  //    discoverPlugins uses — instead of every subdirectory in the repo.
  for (const sub of fs.readdirSync(pluginDir)) {
    if (RUNTIME_SPECIFIC_DIRS.has(sub)) continue;
    const subDir = path.join(pluginDir, sub);
    if (!isDirectory(subDir)) continue;
    if (!fs.existsSync(path.join(subDir, '.claude-plugin', 'plugin.json'))) continue;
    if (skipCodexNative(subDir)) continue;
    if (denySubPluginSkillDirs.has(`${pluginName}/${sub}/skills`)) continue;
    const subSkillsDir = path.join(subDir, 'skills');
    if (!isDirectory(subSkillsDir)) continue;
    for (const skillName of fs.readdirSync(subSkillsDir)) {
      recordCandidate(path.join(subSkillsDir, skillName));
    }
  }

  return [...skills.values()];
}

export interface DiscoverOptions {
  /** Plugins to skip entirely (matched against folder name) */
  denyPlugins?: Set<string>;
  /** Skills to skip by name (regardless of source plugin) */
  denySkills?: Set<string>;
  /** Paths or path components that should never be traversed (runtime-specific dirs) */
  denyDirSegments?: Set<string>;
  /**
   * Target agent runtime. Selects the appropriate sub-plugin denylist.
   * Defaults to 'codex' for back-compat with the original caller.
   */
  runtime?: AgentRuntime;
  /**
   * A group's `excludePlugins`, already split (`./plugin-exclusions.js`).
   * Honoured for BOTH shapes: a top-level entry drops the repo, a sub-plugin
   * path drops that sub-plugin's skills while the rest of the repo still
   * mirrors. Defaults to "nothing excluded" — the host copy's callers
   * (`src/opencode-sync.ts`, `scripts/enable-agent-plugin.ts`) build mirrors
   * that are not scoped to one agent group and so have no list to apply.
   */
  excludePlugins?: ExcludedPlugins;
}

/**
 * Walk a plugins root and return every portable skill we'd want to expose to
 * the target runtime. Pure function — no filesystem writes.
 */
export function discoverPortableSkills(pluginsRoot: string, options: DiscoverOptions = {}): DiscoveredSkill[] {
  if (!isDirectory(pluginsRoot)) return [];

  const denyPlugins = options.denyPlugins ?? DEFAULT_DENY_PLUGINS;
  const denySkills = options.denySkills ?? new Set<string>();
  const runtime = options.runtime ?? DEFAULT_RUNTIME;
  const denySubPluginSkillDirs = DENY_SUB_PLUGIN_SKILL_DIRS_BY_RUNTIME[runtime];
  // OpenCode has no native plugin loader (the discovery mirror is its sole skill delivery),
  // so it must also receive `user-invocable:false` helper skills that the visible skills
  // reference. Claude/Codex load those via their plugin loaders, so their mirrors stay lean.
  const allowNonInvocable = runtime === 'opencode';

  const excluded = options.excludePlugins ?? splitExcludedPlugins(undefined);

  const allSkills = new Map<string, DiscoveredSkill>();
  for (const pluginName of fs.readdirSync(pluginsRoot)) {
    if (denyPlugins.has(pluginName)) continue;
    if (isExcludedPluginPath(pluginName, excluded)) continue;
    if (RUNTIME_SPECIFIC_DIRS.has(pluginName)) continue;
    const pluginDir = path.join(pluginsRoot, pluginName);
    if (!isDirectory(pluginDir)) continue;
    // Per-plugin sibling routing: skip this plugin for the current runtime if
    // its .nanoclaw-plugin.json marker denies this sibling (default: all three).
    if (readPluginDenySiblings(pluginDir).has(runtime)) continue;
    // Skip deprecated subtree contents — they live at <plugin>/deprecated/ and
    // shouldn't appear as portable skills.
    for (const skill of discoverInPlugin(
      pluginDir,
      pluginName,
      denySubPluginSkillDirs,
      allowNonInvocable,
      runtime,
      excluded,
    )) {
      if (denySkills.has(skill.name)) continue;
      if (skill.skillDir.includes('/deprecated/')) continue;
      // First-plugin-wins by name (alphabetical iteration); a later plugin
      // with the same skill name won't override.
      if (!allSkills.has(skill.name)) allSkills.set(skill.name, skill);
    }
  }
  return [...allSkills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Reconcile a target skills dir against a discovered skill set.
 *
 * Critical constraint: Codex's skill auto-discovery only follows REAL
 * directories — symlinked dirs at `<dst>/<name>` are silently skipped
 * (verified empirically 2026-05-14: `humanizer` as a symlink → not found
 * at `r1`; same content as a real dir → found at `r1`).
 *
 * Therefore we mirror as: real dir at `<dst>/<name>/` containing
 * **per-child symlinks** to every entry in the source skill dir
 * (`SKILL.md` + any `scripts/`, `agents/`, `reference/` subdirs).
 * Codex sees a real dir → discovers it. Reads of SKILL.md / scripts
 * follow the symlinks → auto-update inherits from plugin marketplace
 * updates with zero re-sync.
 *
 * Behavior:
 * - Creates real-dir `<dst>/<name>/` + child symlinks for each source entry.
 * - If `<dst>/<name>/` already exists as a real dir, reconciles its child
 *   symlinks (adds missing, removes stale, leaves non-symlinks alone) —
 *   so on every re-run it converges. A native install that wrote real files
 *   there is preserved verbatim.
 * - Skips a name entirely when `<dst>/<name>/` contains real (non-symlink)
 *   files — that's the "operator-placed or natively-installed" signal.
 * - Removes our previously-managed mirror dirs for names no longer in the
 *   desired set. Detection: a dir whose child entries are entirely symlinks
 *   to paths under any known plugin source root we control.
 *
 * Returns four buckets:
 *   - `created`:   new mirror dir created
 *   - `unchanged`: existing mirror dir matches desired child set
 *   - `updated`:   existing mirror dir needed child resync
 *   - `removed`:   stale managed mirror dir deleted
 *   - `skipped`:   would have written but a real non-managed entry already
 *                  exists (deferring to it)
 *   - `refused`:   a skill (or one child of one) resolving outside its own
 *                  `pluginRoot`
 *
 * CONTAINMENT: every path mirrored here is one a plugin chose, and the mirror
 * is read into agent-visible state, so a link out of the repository would make
 * the reader fetch state the plugin was never given. `SKILL.md` is COPIED here,
 * so no downstream filter can see that read. Refusals are returned rather than
 * logged so this file stays logic-identical to its host twin; callers log.
 * A refused name is treated as NOT desired, so a dir a previous run wrote for
 * it is pruned by the cleanup pass.
 *
 * Idempotent.
 */
export function syncSkillSymlinks(
  dst: string,
  skills: DiscoveredSkill[],
): {
  created: string[];
  removed: string[];
  unchanged: string[];
  skipped: string[];
  refused: string[];
} {
  fs.mkdirSync(dst, { recursive: true });

  const created: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];
  const skipped: string[] = [];
  const refused: string[] = [];

  // Decided before anything is written, so a refused name is absent from
  // `desired` and the cleanup pass prunes a dir a previous run made for it.
  const desired = new Map<string, { skillDir: string; resolvedRoot: string }>();
  for (const skill of skills) {
    const resolvedRoot = resolveRealPath(skill.pluginRoot);
    const resolvedSkillDir = resolveRealPath(skill.skillDir);
    if (resolvedRoot === null || resolvedSkillDir === null || !isWithinResolvedRoot(resolvedSkillDir, resolvedRoot)) {
      refused.push(skill.name);
      continue;
    }
    desired.set(skill.name, { skillDir: skill.skillDir, resolvedRoot });
  }

  // ── Cleanup pass: drop managed mirror dirs whose name is no longer
  // desired. A managed mirror dir is a real dir whose entries are all
  // symlinks (no real files of its own). Anything else is preserved.
  let existing: string[] = [];
  try {
    existing = fs.readdirSync(dst);
  } catch {
    /* fresh dir */
  }
  for (const entry of existing) {
    if (desired.has(entry)) continue;
    const entryPath = path.join(dst, entry);
    try {
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) {
        // Legacy top-level symlink (from earlier implementation).
        fs.unlinkSync(entryPath);
        removed.push(entry);
        continue;
      }
      if (stat.isDirectory() && isManagedMirror(entryPath)) {
        fs.rmSync(entryPath, { recursive: true, force: true });
        removed.push(entry);
      }
    } catch {
      /* missing — fine */
    }
  }

  // ── Sync pass: ensure each desired skill is a real dir whose children
  // are symlinks to the corresponding source entries.
  for (const [name, { skillDir: srcDir, resolvedRoot }] of desired) {
    const skillDirAtDst = path.join(dst, name);

    let dstStat: fs.Stats | null = null;
    try {
      dstStat = fs.lstatSync(skillDirAtDst);
    } catch {
      /* missing */
    }

    if (dstStat?.isSymbolicLink()) {
      // Legacy: top-level was a symlink from an earlier implementation.
      // Replace with managed mirror.
      try {
        fs.unlinkSync(skillDirAtDst);
      } catch {
        /* race */
      }
      dstStat = null;
    }

    if (dstStat?.isDirectory() && !isManagedMirror(skillDirAtDst)) {
      // Native install present (real files rather than our managed links).
      // Don't touch it.
      skipped.push(name);
      continue;
    }

    const mirrored = mirrorSkillDir(skillDirAtDst, srcDir, resolvedRoot);
    for (const child of mirrored.refusedChildren) refused.push(`${name}/${child}`);
    const changed = mirrored.changed;
    if (dstStat?.isDirectory()) {
      if (changed) {
        // Re-sync touched some links; classify as updated (we report
        // as `created` in returned buckets for simplicity — caller
        // mostly cares about "new vs unchanged" distinction).
        created.push(name);
      } else {
        unchanged.push(name);
      }
    } else {
      created.push(name);
    }
  }

  return { created, removed, unchanged, skipped, refused };
}

/**
 * Marker file we drop inside every mirror dir we create. Lets us
 * distinguish our writes from native installs (e.g. `gitnexus setup`)
 * without ambiguity — a native install never has this file. Managed-ness is
 * ALL it means: the source a dir was published from lives in
 * `MIRROR_SOURCE_ROOT_FILE`, which the support-dir mirror writes too and which
 * `isManagedMirror` must not key on.
 */
export const MIRROR_MARKER = '.nanoclaw-managed';

/**
 * Provenance file: the plugin repository a mirror dir was published from.
 *
 * The dir's own name is a skill name and carries no provenance, and the reader
 * that needs it is the session copy (`copyOpenCodeSkills`,
 * `src/providers/opencode.ts`): containment there has to be against this ONE
 * repository, not against the union of every repository under `~/plugins`. A
 * union lets a link NESTED below a mirror dir's top level — never seen by these
 * writers, which resolve only each direct child — reach a DIFFERENT plugin,
 * including a workgroup-scoped one the mirror deliberately never published
 * (`scopedPluginNames`, `src/plugin-scopes.ts`).
 *
 * Separate from `MIRROR_MARKER` because the support-dir mirror
 * (`mirrorSupportDir`, `src/opencode-sync.ts`) needs provenance too and must NOT
 * read as a managed skill mirror — `isManagedMirror` keys on `MIRROR_MARKER`,
 * and the cleanup pass deletes a managed dir whose name is not a desired skill,
 * which every support dir's is not.
 */
export const MIRROR_SOURCE_ROOT_FILE = '.nanoclaw-source-root';

/** Names this mirror owns in its own dirs. A plugin child using one is never mirrored. */
export const MIRROR_OWNED_CHILDREN: ReadonlySet<string> = new Set([MIRROR_MARKER, MIRROR_SOURCE_ROOT_FILE]);

/**
 * The provenance file's contents for a mirror dir published from `resolvedRoot`.
 *
 * JSON-encoded, so a directory name containing a newline can neither forge nor
 * truncate the record — a real Linux basename may contain one
 * (`docs/review-notes/826.md`, the segment-rule rounds).
 */
export function formatMirrorSourceRoot(resolvedRoot: string): string {
  return `${JSON.stringify(resolvedRoot)}\n`;
}

/**
 * Write the provenance file, replacing anything that is not already exactly it.
 *
 * `lstat` first and unlink a non-regular entry: if an earlier write failed, the
 * child loop could have symlinked a plugin's own same-named file into this dir,
 * and writing through that link would both trust a plugin-authored record and
 * write into the plugin's repository. Returns whether anything changed.
 */
export function writeMirrorSourceRoot(mirrorDir: string, resolvedRoot: string): boolean {
  const file = path.join(mirrorDir, MIRROR_SOURCE_ROOT_FILE);
  const content = formatMirrorSourceRoot(resolvedRoot);
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(file, { throwIfNoEntry: false });
  } catch {
    return false;
  }
  if (stat !== undefined && stat.isFile()) {
    try {
      if (fs.readFileSync(file, 'utf8') === content) return false;
    } catch {
      /* unreadable — rewrite below */
    }
  } else if (stat !== undefined) {
    try {
      fs.rmSync(file, { recursive: true, force: true });
    } catch {
      return false;
    }
  }
  try {
    fs.writeFileSync(file, content);
    return true;
  } catch {
    return false;
  }
}

/**
 * The plugin repository a mirror dir was published from, or null when it holds
 * no provenance file — a dir published before this record existed, or one an
 * operator or native installer placed. Null means "no provenance recorded",
 * never "any root": the caller decides what an unattributed dir may do.
 *
 * `lstat`-gated to a regular file, so a symlink standing where the record
 * belongs is not followed and read as a record.
 */
export function readMirrorSourceRoot(mirrorDir: string): string | null {
  const file = path.join(mirrorDir, MIRROR_SOURCE_ROOT_FILE);
  let stat: fs.Stats | undefined;
  try {
    // `throwIfNoEntry` suppresses ENOENT and nothing else: this path has a
    // caller-supplied DIRECTORY component, so a file (or a symlink to one)
    // standing where that directory should be throws ENOTDIR, and an unreadable
    // parent throws EACCES. Unhandled, either would escape a `cpSync` filter and
    // fail the whole spawn over one bad entry in a shared mirror.
    stat = fs.lstatSync(file, { throwIfNoEntry: false });
  } catch {
    return null;
  }
  if (stat === undefined || !stat.isFile()) return null;
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const value: unknown = JSON.parse(content.trim());
    return typeof value === 'string' && value !== '' ? value : null;
  } catch {
    return null;
  }
}

/**
 * A "managed mirror" dir is one we created: it contains our marker file.
 * Anything without the marker is treated as operator-placed or native
 * install (preserved verbatim).
 *
 * Empty dirs count as managed (treated as "ours, just emptied" — safe to
 * write into).
 */
function isManagedMirror(dir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  if (entries.length === 0) return true;
  return entries.includes(MIRROR_MARKER);
}

/**
 * Materialize `<dstDir>` as a real directory containing:
 *   - `SKILL.md`: a REAL FILE (copied from source). Codex's auto-discovery
 *     skips symlinked SKILL.md files (verified empirically 2026-05-14),
 *     so we copy. Re-copies only when source mtime > dst mtime.
 *   - Every other top-level child: a symlink to the corresponding source
 *     entry. Subdir reads at agent runtime follow symlinks normally, so
 *     `scripts/`, `reference/`, `agents/`, etc. inherit auto-update.
 *
 * Every child is resolved against `resolvedRoot` first; one that leaves the
 * plugin's own repository is refused and named in `refusedChildren` instead of
 * being mirrored — the `SKILL.md` copy and the per-child symlink alike. A
 * dangling child resolves to null and is refused too.
 *
 * Returns whether anything changed, plus the refused child names.
 */
function mirrorSkillDir(
  dstDir: string,
  srcDir: string,
  resolvedRoot: string,
): { changed: boolean; refusedChildren: string[] } {
  let changed = false;
  const refusedChildren: string[] = [];
  let dstExists: fs.Stats | null = null;
  try {
    dstExists = fs.lstatSync(dstDir);
  } catch {
    /* missing */
  }
  if (!dstExists) {
    fs.mkdirSync(dstDir, { recursive: true });
    changed = true;
  } else if (!dstExists.isDirectory()) {
    return { changed: false, refusedChildren }; // caller should have filtered this case
  }

  // Drop our marker so future runs recognize this as a managed mirror.
  const markerPath = path.join(dstDir, MIRROR_MARKER);
  if (!fs.existsSync(markerPath)) {
    try {
      fs.writeFileSync(markerPath, 'managed by nanoclaw plugin-skill-discovery\n');
      changed = true;
    } catch {
      /* swallow — non-critical */
    }
  }
  // Record the ONE repository this dir was published from, so the session copy
  // can contain every link under it to that root. Rewritten when it differs, so
  // a dir published before this record existed — or from a plugin that has since
  // moved — self-heals on the next sync.
  if (writeMirrorSourceRoot(dstDir, resolvedRoot)) changed = true;

  let srcEntries: string[];
  try {
    srcEntries = fs.readdirSync(srcDir);
  } catch {
    return { changed, refusedChildren };
  }

  // Containment, decided before the removal pass below so a child refused now
  // is ALSO pruned from a dst a previous run wrote it into.
  const allowedChildren: string[] = [];
  for (const child of srcEntries) {
    // Names this mirror writes itself are never taken from the source. A plugin
    // shipping one would otherwise be mirrored into the slot our own record
    // occupies the moment a write of ours fails, and the copy would then read a
    // plugin-authored provenance record.
    if (MIRROR_OWNED_CHILDREN.has(child)) continue;
    const resolvedChild = resolveRealPath(path.join(srcDir, child));
    if (resolvedChild === null || !isWithinResolvedRoot(resolvedChild, resolvedRoot)) {
      refusedChildren.push(child);
      continue;
    }
    allowedChildren.push(child);
  }
  const desiredChildren = new Set(allowedChildren);

  // Remove stale children whose name no longer exists in src.
  // Only remove our own writes — symlinks and copies of SKILL.md.
  let dstChildren: string[] = [];
  try {
    dstChildren = fs.readdirSync(dstDir);
  } catch {
    /* fresh */
  }
  for (const child of dstChildren) {
    if (desiredChildren.has(child)) continue;
    if (MIRROR_OWNED_CHILDREN.has(child)) continue; // preserve the files we own
    const childPath = path.join(dstDir, child);
    try {
      const stat = fs.lstatSync(childPath);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(childPath);
        changed = true;
      } else if (child === 'SKILL.md') {
        // Stale copy — source no longer has SKILL.md (shouldn't happen for
        // valid skills, but clean up just in case).
        fs.unlinkSync(childPath);
        changed = true;
      }
    } catch {
      /* missing */
    }
  }

  // Sync each contained source child into dst.
  for (const child of allowedChildren) {
    const childPath = path.join(dstDir, child);
    const srcPath = path.join(srcDir, child);

    if (child === 'SKILL.md') {
      if (syncSkillMdCopy(childPath, srcPath)) changed = true;
      continue;
    }

    // Other children: symlink (Codex doesn't auto-discover, but runtime
    // reads follow symlinks).
    let currentTarget: string | null = null;
    let stat: fs.Stats | null = null;
    try {
      stat = fs.lstatSync(childPath);
    } catch {
      /* missing */
    }
    if (stat && !stat.isSymbolicLink()) {
      // Real file/dir in the way — leave alone (operator-placed).
      continue;
    }
    if (stat) {
      try {
        currentTarget = fs.readlinkSync(childPath);
      } catch {
        /* race */
      }
    }
    if (currentTarget === srcPath) continue;
    try {
      fs.unlinkSync(childPath);
    } catch {
      /* missing */
    }
    try {
      fs.symlinkSync(srcPath, childPath);
      changed = true;
    } catch {
      /* swallow */
    }
  }

  return { changed, refusedChildren };
}

/**
 * Copy SKILL.md from source to dst if source is newer (or dst missing).
 * Returns true if a copy was performed.
 *
 * Codex's skill auto-discovery requires SKILL.md to be a real file (not a
 * symlink) — see `mirrorSkillDir` comment. We re-copy on mtime drift so
 * marketplace updates propagate on the next sync invocation.
 */
function syncSkillMdCopy(dst: string, src: string): boolean {
  let srcStat: fs.Stats;
  try {
    srcStat = fs.statSync(src);
  } catch {
    return false;
  }
  // `copyFileSync` on a FIFO blocks until a writer appears, and on the host that
  // is the single event loop. A containment check cannot see this: the path is
  // inside the repository. Only a regular file is a SKILL.md.
  if (!srcStat.isFile()) return false;
  let dstStat: fs.Stats | null = null;
  try {
    dstStat = fs.lstatSync(dst);
  } catch {
    /* missing */
  }
  // If dst is a symlink (leftover from earlier mode), unlink it.
  if (dstStat?.isSymbolicLink()) {
    try {
      fs.unlinkSync(dst);
    } catch {
      /* race */
    }
    dstStat = null;
  }
  if (dstStat) {
    // mtime comparison — re-copy when source is strictly newer or size differs.
    if (dstStat.size === srcStat.size && dstStat.mtimeMs >= srcStat.mtimeMs) {
      return false;
    }
  }
  try {
    fs.copyFileSync(src, dst);
    return true;
  } catch {
    return false;
  }
}
