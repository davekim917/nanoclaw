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

export interface DiscoveredSkill {
  /** Skill name (used as `~/.codex/skills/<name>/` link basename) */
  name: string;
  /** Absolute path to the skill directory containing SKILL.md */
  skillDir: string;
  /** Plugin folder it came from */
  plugin: string;
}

/**
 * Plugins to skip entirely. These wrap Claude-only runtime functionality
 * (Skill tool, Agent tool, slash-command machinery).
 */
const DEFAULT_DENY_PLUGINS = new Set<string>([
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
    // workflow-agents: same skill names as the Claude workflow; the Claude
    // runtime already loads its own `bootstrap/plugins/workflow/skills` via
    // the Claude plugin marketplace, so mirroring the codex variant would be
    // a name-collision duplicate.
    'bootstrap/plugins/workflow-agents/skills',
  ]),
  codex: new Set<string>([
    // Claude workflow: requires Claude's Skill/Agent tool.
    'bootstrap/plugins/workflow/skills',
    // Codex workflow: installed through `.codex-plugin/plugin.json`, not the
    // legacy skills mirror. Same-name collision would make precedence ambiguous.
    'bootstrap/plugins/workflow-agents/skills',
  ]),
  opencode: new Set<string>([
    // Claude workflow: requires Claude's Skill/Agent tool.
    'bootstrap/plugins/workflow/skills',
    // workflow-agents is NOT denied for opencode — there's no native codex-plugin
    // loader on opencode, and surfacing the skill TEXT gives the agent
    // awareness of /team-* patterns even without the spawn_task harness
    // (which is a separate runtime gap).
  ]),
};

export type AgentRuntime = 'claude' | 'codex' | 'opencode';

/**
 * Default runtime when none is specified. 'claude' is intentionally chosen as
 * the most-conservative fallback: every runtime is allowed to see Claude's
 * `bootstrap/plugins/workflow/skills` (since the workflow-claude denylist
 * targets the codex-loaded path, not the Claude-loaded one). Callers should
 * still pass `runtime` explicitly; the default exists only for back-compat
 * with pre-runtime-split callers that haven't been updated.
 */
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
): DiscoveredSkill[] {
  const skills = new Map<string, DiscoveredSkill>();

  const recordCandidate = (skillDir: string) => {
    if (!hasSkillMd(skillDir)) return;
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
    skills.set(name, { name, skillDir, plugin: pluginName });
  };

  // 1. .agents/skills/<name>/
  const agentsSkillsDir = path.join(pluginDir, '.agents', 'skills');
  if (isDirectory(agentsSkillsDir)) {
    for (const sub of fs.readdirSync(agentsSkillsDir)) {
      recordCandidate(path.join(agentsSkillsDir, sub));
    }
  }

  // 2. skills/<name>/
  const topSkillsDir = path.join(pluginDir, 'skills');
  if (isDirectory(topSkillsDir)) {
    for (const sub of fs.readdirSync(topSkillsDir)) {
      recordCandidate(path.join(topSkillsDir, sub));
    }
  }

  // 3. <plugin>/SKILL.md (single-skill plugin)
  recordCandidate(pluginDir);

  // 4. plugin/skills/<name>/ (impeccable's `plugin/` subdir)
  const pluginSubDir = path.join(pluginDir, 'plugin', 'skills');
  if (isDirectory(pluginSubDir)) {
    for (const sub of fs.readdirSync(pluginSubDir)) {
      recordCandidate(path.join(pluginSubDir, sub));
    }
  }

  // 5. <plugin>-cursor-integration/skills/<name>/
  const cursorDir = path.join(pluginDir, `${pluginName}-cursor-integration`, 'skills');
  if (isDirectory(cursorDir)) {
    for (const sub of fs.readdirSync(cursorDir)) {
      recordCandidate(path.join(cursorDir, sub));
    }
  }

  // 6. <plugin>-claude-plugin/skills/<name>/ (last resort)
  const claudePluginDir = path.join(pluginDir, `${pluginName}-claude-plugin`, 'skills');
  if (isDirectory(claudePluginDir)) {
    for (const sub of fs.readdirSync(claudePluginDir)) {
      recordCandidate(path.join(claudePluginDir, sub));
    }
  }

  // 7. multi-plugin repos: <plugin>/plugins/<sub>/skills/<name>/
  //    Common in davekim917/bootstrap. Respect runtime-specific denylist.
  const multiPluginDir = path.join(pluginDir, 'plugins');
  if (isDirectory(multiPluginDir)) {
    for (const sub of fs.readdirSync(multiPluginDir)) {
      const subKey = `${pluginName}/plugins/${sub}/skills`;
      if (denySubPluginSkillDirs.has(subKey)) continue;
      const subSkillsDir = path.join(multiPluginDir, sub, 'skills');
      if (!isDirectory(subSkillsDir)) continue;
      for (const skillName of fs.readdirSync(subSkillsDir)) {
        recordCandidate(path.join(subSkillsDir, skillName));
      }
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
   * Target agent runtime. Selects the appropriate sub-plugin denylist
   * (different runtimes have different native plugin loaders, so a sub-plugin
   * may be denied for one runtime and surfaced for another).
   * Defaults to 'codex' for back-compat with the original Codex-parity caller.
   */
  runtime?: AgentRuntime;
}

/**
 * Walk a plugins root and return every portable skill we'd want to expose to
 * the target runtime. Pure function — no filesystem writes. Caller decides
 * what to do with the results (typically: symlink each `skillDir` into
 * `<runtime-home>/skills/<name>/` or `~/.agents/skills/<name>/`).
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

  const allSkills = new Map<string, DiscoveredSkill>();
  for (const pluginName of fs.readdirSync(pluginsRoot)) {
    if (denyPlugins.has(pluginName)) continue;
    if (RUNTIME_SPECIFIC_DIRS.has(pluginName)) continue;
    const pluginDir = path.join(pluginsRoot, pluginName);
    if (!isDirectory(pluginDir)) continue;
    // Skip deprecated subtree contents — they live at <plugin>/deprecated/ and
    // shouldn't appear as portable skills.
    for (const skill of discoverInPlugin(pluginDir, pluginName, denySubPluginSkillDirs, allowNonInvocable)) {
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
 *   so on every re-run it converges. A native install (e.g. `gitnexus setup`
 *   wrote real files there) is preserved verbatim.
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
} {
  fs.mkdirSync(dst, { recursive: true });

  const desired = new Map(skills.map((s) => [s.name, s.skillDir] as const));

  const created: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];
  const skipped: string[] = [];

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
  for (const [name, srcDir] of desired) {
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
      // Native install present (e.g. gitnexus setup wrote real files).
      // Don't touch it.
      skipped.push(name);
      continue;
    }

    const changed = mirrorSkillDir(skillDirAtDst, srcDir);
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

  return { created, removed, unchanged, skipped };
}

/**
 * Marker file we drop inside every mirror dir we create. Lets us
 * distinguish our writes from native installs (e.g. `gitnexus setup`)
 * without ambiguity — a native install never has this file.
 */
const MIRROR_MARKER = '.nanoclaw-managed';

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
 * Returns `true` if anything changed.
 */
function mirrorSkillDir(dstDir: string, srcDir: string): boolean {
  let changed = false;
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
    return false; // caller should have filtered this case
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

  let srcEntries: string[] = [];
  try {
    srcEntries = fs.readdirSync(srcDir);
  } catch {
    return changed;
  }
  const desiredChildren = new Set(srcEntries);

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
    if (child === MIRROR_MARKER) continue; // preserve our marker
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

  // Sync each source child into dst.
  for (const child of srcEntries) {
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

  return changed;
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
