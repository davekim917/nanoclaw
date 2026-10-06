/**
 * Plugin-skill discovery for Codex/OpenCode parity, shared by the host script and container-side setup.
 *
 * Per-plugin preference order (first match per skill name wins):
 *   1. `<plugin>/.agents/skills/<name>/SKILL.md`   (runtime-agnostic canonical)
 *   2. `<plugin>/skills/<name>/SKILL.md`
 *   3. `<plugin>/SKILL.md`                         (single-skill, name = plugin)
 *   4. `<plugin>/plugin/skills/<name>/SKILL.md`
 *   5. `<plugin>/<plugin>-cursor-integration/skills/<name>/SKILL.md`
 *   6. `<plugin>/<plugin>-claude-plugin/skills/<name>/SKILL.md`
 *
 * Codex-native plugin skill roots are skipped: mirroring them creates a second same-named install path.
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
function resolveRealPath(target: string): string | null {
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
function isWithinResolvedRoot(resolved: string, resolvedRoot: string): boolean {
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

/** Resolved repository roots a mirror may point into, one per plugin dir (resolved so symlinked checkouts work). */
function resolvePluginRoots(pluginsRoot: string): string[] {
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

/** Plugins skipped entirely: Claude-only runtime functionality. */
const DEFAULT_DENY_PLUGINS = new Set<string>([
  // bootstrap is walked with the finer-grained DENY_SUB_PLUGIN_SKILL_DIRS instead.
  // codex: Codex-plugin internal skills, already loaded via the codex Claude plugin.
  'codex',
  // design-artifact-loop ships in-tree; its standalone skill's cwd-based paths conflict with the in-container tool.
  'design-artifact-loop',
]);

/**
 * Per-runtime sub-plugin skill roots to ignore (`<plugin>/<sub-plugin-skills-segment>`). Deny a root for a
 * runtime ONLY when that runtime loads it through another path; skills that can't be invoked but can be read as
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
    // workflow-agents is NOT denied: opencode has no codex-plugin loader, and the skill text still helps.
  ]),
};

const AGENT_RUNTIMES = ['claude', 'codex', 'opencode'] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

export function isAgentRuntime(value: unknown): value is AgentRuntime {
  return (AGENT_RUNTIMES as readonly unknown[]).includes(value);
}

// Most-conservative fallback, for back-compat only; callers should pass `runtime`.
const DEFAULT_RUNTIME: AgentRuntime = 'claude';

/** Runtime-specific skill copies; the `.agents/skills/` canonical version is preferred. */
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
 * A plugin shipping `.codex-plugin/plugin.json` is loaded natively by Codex (skills plus its MCP server);
 * mirroring it would duplicate every skill without the MCP server. Orthogonal to `.nanoclaw-plugin.json`
 * `denySiblings`: a Codex-native plugin stays delivered to Codex, just not through the mirror.
 */
function loadedNativelyByCodex(pluginRootDir: string): boolean {
  return fs.existsSync(path.join(pluginRootDir, '.codex-plugin', 'plugin.json'));
}

/**
 * `~/plugins/<plugin>/.nanoclaw-plugin.json` is the single source of truth for which sibling providers get a
 * plugin (default all; `denySiblings` is the exception list). Re-read on every reconcile and spawn.
 */
export function readPluginDenySiblings(pluginDir: string): Set<AgentRuntime> {
  try {
    const raw = fs.readFileSync(path.join(pluginDir, '.nanoclaw-plugin.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { denySiblings?: unknown };
    const list = Array.isArray(parsed.denySiblings) ? parsed.denySiblings : [];
    return new Set(list.filter(isAgentRuntime));
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

/** One plugin folder's portable skills in preference order, each name once. */
function discoverInPlugin(
  pluginDir: string,
  pluginName: string,
  denySubPluginSkillDirs: Set<string>,
  delivery: SkillDelivery,
  excluded: ExcludedPlugins,
): DiscoveredSkill[] {
  const skills = new Map<string, DiscoveredSkill>();

  // Applied per plugin root: the top-level plugin (rules 1-6) and each sub-plugin (rules 7-8).
  const skipCodexNative = (root: string) => delivery.nativePluginLoading && loadedNativelyByCodex(root);
  const doTopLevel = !skipCodexNative(pluginDir);

  // Exclusions are asked ONCE, at `recordCandidate`, the seam every layout rule ends at: a per-rule check is one
  // a new layout rule forgets. `relPath` is built from this walk's own names, never a realpath.
  const excludedCandidate = (skillDir: string): boolean => {
    const rel = path.relative(pluginDir, skillDir);
    return isExcludedPluginPath(rel ? `${pluginName}/${rel.split(path.sep).join('/')}` : pluginName, excluded);
  };

  const recordCandidate = (skillDir: string) => {
    if (!hasSkillMd(skillDir)) return;
    if (excludedCandidate(skillDir)) return;
    if (!isUserInvocable(skillDir) && !delivery.mirrorIsSoleDelivery) return;
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

  // 8. marketplace monorepos: <plugin>/<sub>/skills/<name>/, gated on `<sub>/.claude-plugin/plugin.json` (the
  //    signal Claude's discoverPlugins uses).
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

/** What the target runtime's skill loading already does, declared by the caller: this module never asks by provider name. */
interface SkillDelivery {
  /** The runtime loads plugin skills natively, so the mirror must not list a plugin it loads a second time. */
  nativePluginLoading: boolean;
  /** The mirror is the runtime's only skill delivery, so it also carries `user-invocable:false` helper skills. */
  mirrorIsSoleDelivery: boolean;
}

const NO_PROVIDER_FACTS: SkillDelivery = { nativePluginLoading: false, mirrorIsSoleDelivery: false };

export interface DiscoverOptions {
  /** Plugins to skip entirely (matched against folder name) */
  denyPlugins?: Set<string>;
  /** Skills to skip by name (regardless of source plugin) */
  denySkills?: Set<string>;
  /** Paths or path components that should never be traversed (runtime-specific dirs) */
  denyDirSegments?: Set<string>;
  /** Selects the sub-plugin denylist. Defaults to 'codex' for back-compat. */
  runtime?: AgentRuntime;
  /** Defaults to no provider facts: nothing skipped, no helper skills. */
  delivery?: SkillDelivery;
  /** A group's split `excludePlugins`, honoured for both shapes. Host callers build unscoped mirrors and pass none. */
  excludePlugins?: ExcludedPlugins;
}

/** Every portable skill to expose to the target runtime. No filesystem writes. */
export function discoverPortableSkills(pluginsRoot: string, options: DiscoverOptions = {}): DiscoveredSkill[] {
  if (!isDirectory(pluginsRoot)) return [];

  const denyPlugins = options.denyPlugins ?? DEFAULT_DENY_PLUGINS;
  const denySkills = options.denySkills ?? new Set<string>();
  const runtime = options.runtime ?? DEFAULT_RUNTIME;
  const denySubPluginSkillDirs = DENY_SUB_PLUGIN_SKILL_DIRS_BY_RUNTIME[runtime];
  const delivery = options.delivery ?? NO_PROVIDER_FACTS;

  const excluded = options.excludePlugins ?? splitExcludedPlugins(undefined);

  const allSkills = new Map<string, DiscoveredSkill>();
  for (const pluginName of fs.readdirSync(pluginsRoot)) {
    if (denyPlugins.has(pluginName)) continue;
    if (isExcludedPluginPath(pluginName, excluded)) continue;
    if (RUNTIME_SPECIFIC_DIRS.has(pluginName)) continue;
    const pluginDir = path.join(pluginsRoot, pluginName);
    if (!isDirectory(pluginDir)) continue;
    if (readPluginDenySiblings(pluginDir).has(runtime)) continue;
    for (const skill of discoverInPlugin(pluginDir, pluginName, denySubPluginSkillDirs, delivery, excluded)) {
      if (denySkills.has(skill.name)) continue;
      if (skill.skillDir.includes('/deprecated/')) continue;
      // First plugin wins by name (alphabetical).
      if (!allSkills.has(skill.name)) allSkills.set(skill.name, skill);
    }
  }
  return [...allSkills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Reconcile a target skills dir against a discovered skill set. Codex auto-discovery skips symlinked skill
 * dirs, so each skill is a REAL dir holding per-child symlinks (SKILL.md itself is copied). Converges on every
 * run; a dir with real non-mirror files (operator-placed or native install) is left alone.
 *
 * CONTAINMENT: a mirrored path is one a plugin chose and is read into agent-visible state, so anything resolving
 * outside its own `pluginRoot` is refused. Refusals are returned, not logged, so this file stays logic-identical
 * to its host twin. A refused name is not desired, so the cleanup pass prunes it.
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

  // Cleanup pass: drop managed mirror dirs whose name is no longer desired.
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

  for (const [name, { skillDir: srcDir, resolvedRoot }] of desired) {
    const skillDirAtDst = path.join(dst, name);

    let dstStat: fs.Stats | null = null;
    try {
      dstStat = fs.lstatSync(skillDirAtDst);
    } catch {
      /* missing */
    }

    if (dstStat?.isSymbolicLink()) {
      // Legacy top-level symlink: replace with a managed mirror.
      try {
        fs.unlinkSync(skillDirAtDst);
      } catch {
        /* race */
      }
      dstStat = null;
    }

    if (dstStat?.isDirectory() && !isManagedMirror(skillDirAtDst)) {
      // Native install present: don't touch it.
      skipped.push(name);
      continue;
    }

    const mirrored = mirrorSkillDir(skillDirAtDst, srcDir, resolvedRoot);
    for (const child of mirrored.refusedChildren) refused.push(`${name}/${child}`);
    const changed = mirrored.changed;
    if (dstStat?.isDirectory()) {
      if (changed) {
        // Reported as `created`: callers only distinguish new from unchanged.
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
 * Marker in every mirror dir we create; a native install never has it. It means managed and nothing else:
 * provenance lives in `MIRROR_SOURCE_ROOT_FILE`, which `isManagedMirror` must not key on.
 */
const MIRROR_MARKER = '.nanoclaw-managed';

/**
 * Provenance: the ONE repository a mirror dir was published from. The session copy (`copyOpenCodeSkills`)
 * contains nested links against this root, not the union of every plugin, which would let a nested link reach a
 * different (possibly workgroup-scoped, never-published) plugin. Separate from `MIRROR_MARKER` because the
 * support-dir mirror needs provenance but must not read as a managed skill mirror.
 */
const MIRROR_SOURCE_ROOT_FILE = '.nanoclaw-source-root';

/** Names this mirror owns in its own dirs. A plugin child using one is never mirrored. */
const MIRROR_OWNED_CHILDREN: ReadonlySet<string> = new Set([MIRROR_MARKER, MIRROR_SOURCE_ROOT_FILE]);

/** JSON-encoded so a directory name containing a newline can neither forge nor truncate the record. */
function formatMirrorSourceRoot(resolvedRoot: string): string {
  return `${JSON.stringify(resolvedRoot)}\n`;
}

/**
 * Replace anything that is not already exactly the record. lstat first and unlink a non-regular entry: writing
 * through a plugin-planted symlink would trust a plugin-authored record and write into the plugin's repo.
 */
function writeMirrorSourceRoot(mirrorDir: string, resolvedRoot: string): boolean {
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

/** null = no provenance recorded (never "any root"). lstat-gated so a symlink in its place is not read as a record. */
function readMirrorSourceRoot(mirrorDir: string): string | null {
  const file = path.join(mirrorDir, MIRROR_SOURCE_ROOT_FILE);
  let stat: fs.Stats | undefined;
  try {
    // Catch everything: the path has a caller-supplied directory component (ENOTDIR, EACCES), and one bad entry
    // must not fail a whole spawn.
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

/** Managed = contains our marker; empty dirs count as managed. Anything else is preserved verbatim. */
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
 * Materialize a real dir: SKILL.md COPIED (Codex skips a symlinked SKILL.md), every other child symlinked.
 * Each child is resolved against `resolvedRoot` first; one leaving the plugin's repository (or dangling) is
 * refused and named in `refusedChildren`.
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
  // Rewritten when it differs, so older dirs and moved plugins self-heal.
  if (writeMirrorSourceRoot(dstDir, resolvedRoot)) changed = true;

  let srcEntries: string[];
  try {
    srcEntries = fs.readdirSync(srcDir);
  } catch {
    return { changed, refusedChildren };
  }

  // Decided before the removal pass so a child refused now is also pruned from an earlier run's dst.
  const allowedChildren: string[] = [];
  for (const child of srcEntries) {
    // Never take our own record names from the source: a plugin shipping one would land in our provenance slot.
    if (MIRROR_OWNED_CHILDREN.has(child)) continue;
    const resolvedChild = resolveRealPath(path.join(srcDir, child));
    if (resolvedChild === null || !isWithinResolvedRoot(resolvedChild, resolvedRoot)) {
      refusedChildren.push(child);
      continue;
    }
    allowedChildren.push(child);
  }
  const desiredChildren = new Set(allowedChildren);

  // Remove stale children; only our own writes (symlinks and the SKILL.md copy).
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
        fs.unlinkSync(childPath);
        changed = true;
      }
    } catch {
      /* missing */
    }
  }

  for (const child of allowedChildren) {
    const childPath = path.join(dstDir, child);
    const srcPath = path.join(srcDir, child);

    if (child === 'SKILL.md') {
      if (syncSkillMdCopy(childPath, srcPath)) changed = true;
      continue;
    }

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

/** Copy SKILL.md when the source is newer or a different size (Codex needs a real file). Returns true if copied. */
function syncSkillMdCopy(dst: string, src: string): boolean {
  let srcStat: fs.Stats;
  try {
    srcStat = fs.statSync(src);
  } catch {
    return false;
  }
  // `copyFileSync` on a FIFO blocks the host's single event loop until a writer appears: only a regular file is a SKILL.md.
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
