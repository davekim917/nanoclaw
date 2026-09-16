/**
 * Reusable OpenCode-sync functions.
 *
 * Mirrors `codex-sync.ts:syncCodexSubagents()` for OpenCode siblings. Reads
 * the same Claude `.md` source (via `discoverClaudeSubagents`) and writes
 * OpenCode-format agent `.md` files to:
 *
 *   - `~/.config/opencode/agent/` (global — host's personal opencode session)
 *   - `~/.local/share/opencode-<folder>/agent/` per sibling that has an
 *     `auth.json` (so we don't write into half-set-up siblings). Per-sibling
 *     agents reach the container via the per-session XDG copy in
 *     `src/providers/opencode.ts` at spawn.
 *
 * Idempotent. Files this sync wrote carry the `# managed by nanoclaw
 * opencode-sync` YAML comment marker; pre-existing `.md` files without the
 * marker are left alone (manually-authored agents survive). Source-removed
 * agents have their managed `.md` cleaned up.
 *
 * Called by:
 *   - `src/plugin-updater.ts:refreshCodexPluginSurfaces` after `git pull`
 *     (still named "Codex" for back-compat; this module is called alongside)
 *   - `src/codex-sync-watcher.ts:runSync` on file-change debounce
 *   - One-shot `pnpm exec tsx scripts/sync-opencode-subagents.ts`
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { parseClaudeAgentMd } from './claude-agent-md.js';
import { discoverClaudeSubagents, type DiscoveredSubagent } from './claude-subagent-discovery.js';
import { formatOpenCodeAgentMd, isManagedOpenCodeAgent } from './opencode-agent-md.js';
import { log } from './log.js';
import {
  DEFAULT_DENY_PLUGINS,
  discoverPortableSkills,
  isWithinResolvedRoot,
  resolvePluginRoots,
  resolveRealPath,
  syncSkillSymlinks,
} from './plugin-skill-discovery.js';
import { loadPluginScopes, scopedPluginNames } from './plugin-scopes.js';

export interface OpenCodeSubagentsSyncResult {
  /** Every OpenCode agent/ dir we wrote into (global + per-group siblings). */
  targets: string[];
  /** Distinct Claude `.md` subagents found at the source. */
  discovered: number;
  /** Per-target file write counts, summed across every target. */
  writes: number;
  /** Per-target file unchanged counts, summed. */
  unchangedFiles: number;
  /** Per-target file removals, summed (stale managed `.md` cleaned up). */
  removedFiles: number;
  /** Agent names that had unmanaged `.md` in at least one target — skipped
   *  everywhere they collided. */
  skipped: string[];
}

export function syncOpenCodeSubagents(): OpenCodeSubagentsSyncResult {
  const sources = discoverClaudeSubagents();
  const targetDirs = discoverOpenCodeAgentTargets();
  let writes = 0;
  let unchangedFiles = 0;
  let removedFiles = 0;
  const skippedSet = new Set<string>();

  for (const target of targetDirs) {
    fs.mkdirSync(target, { recursive: true });
    const result = syncOneOpenCodeAgentsDir(target, sources);
    writes += result.created.length;
    unchangedFiles += result.unchanged.length;
    removedFiles += result.removed.length;
    for (const s of result.skipped) skippedSet.add(s);
  }

  return {
    targets: targetDirs,
    discovered: sources.length,
    writes,
    unchangedFiles,
    removedFiles,
    skipped: [...skippedSet],
  };
}

interface OneDirResult {
  created: string[];
  unchanged: string[];
  removed: string[];
  skipped: string[];
}

function syncOneOpenCodeAgentsDir(target: string, sources: DiscoveredSubagent[]): OneDirResult {
  const created: string[] = [];
  const unchanged: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];

  const desiredFiles = new Set<string>();

  for (const src of sources) {
    const mdPath = path.join(target, `${src.name}.md`);
    desiredFiles.add(`${src.name}.md`);

    if (fs.existsSync(mdPath)) {
      const existing = fs.readFileSync(mdPath, 'utf-8');
      if (!isManagedOpenCodeAgent(existing)) {
        skipped.push(src.name);
        continue;
      }
    }

    let agentText: string;
    try {
      agentText = fs.readFileSync(src.path, 'utf-8');
    } catch {
      continue;
    }
    const parsed = parseClaudeAgentMd(agentText);
    if (!parsed) {
      skipped.push(src.name);
      continue;
    }

    const newContent = formatOpenCodeAgentMd(parsed);
    let existing = '';
    try {
      existing = fs.readFileSync(mdPath, 'utf-8');
    } catch {
      /* fresh write */
    }
    if (existing === newContent) {
      unchanged.push(src.name);
      continue;
    }
    fs.writeFileSync(mdPath, newContent);
    created.push(src.name);
  }

  for (const entry of fs.readdirSync(target)) {
    if (!entry.endsWith('.md')) continue;
    if (desiredFiles.has(entry)) continue;
    const filePath = path.join(target, entry);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    if (!isManagedOpenCodeAgent(content)) continue;
    fs.unlinkSync(filePath);
    removed.push(entry.replace(/\.md$/, ''));
  }

  return { created, unchanged, removed, skipped };
}

/**
 * Find every OpenCode agent/ output directory. Always includes the global
 * `~/.config/opencode/agent/`. Adds `~/.local/share/opencode-<folder>/agent/`
 * for every per-group sibling dir that has an `auth.json` (so we don't write
 * into half-set-up siblings).
 *
 * Note: OpenCode reads from `$XDG_CONFIG_HOME/opencode/agent/` (singular
 * `agent` and plural `agents` both work, verified empirically against
 * opencode-ai@1.15.7). We canonicalize on the singular form. The XDG_DATA_HOME
 * tree is NOT a discovery path for agents — it's auth.json + opencode.db only.
 * Per-sibling auth lives at `~/.local/share/opencode-<folder>/auth.json`
 * (XDG_DATA), so we keep related per-sibling state in one host tree at
 * `~/.local/share/opencode-<folder>/{auth.json,agent/}`. The provider copies
 * agent/*.md into the per-session XDG_CONFIG copy at spawn.
 */
function discoverOpenCodeAgentTargets(): string[] {
  return discoverOpenCodeXdgTargets('agent');
}

/**
 * Find every OpenCode XDG subdir target for `<subdir>` (e.g. 'agent' or 'skill').
 * Returns the global host path `~/.config/opencode/<subdir>` plus
 * `~/.local/share/opencode-<folder>/<subdir>` for every sibling with auth.json.
 *
 * The per-sibling host tree lives under XDG_DATA (`~/.local/share/...`) by
 * convention (same place we cache auth.json + opencode.db). The provider
 * copies per-sibling `<subdir>/` content into the per-session XDG mount at
 * spawn (`<sessionDir>/opencode-xdg/opencode/<subdir>/`) so the container
 * sees real files at `$XDG_CONFIG_HOME/opencode/<subdir>/`.
 */
function discoverOpenCodeXdgTargets(subdir: string): string[] {
  const home = os.homedir();
  const targets: string[] = [path.join(home, '.config', 'opencode', subdir)];

  const siblingsRoot = path.join(home, '.local', 'share');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(siblingsRoot, { withFileTypes: true });
  } catch {
    return targets;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith('opencode-')) continue;
    const auth = path.join(siblingsRoot, entry.name, 'auth.json');
    if (!fs.existsSync(auth)) continue;
    targets.push(path.join(siblingsRoot, entry.name, subdir));
  }

  return targets;
}

export interface OpenCodeSkillSyncResult {
  /** Every OpenCode skill/ dir we wrote into (global + per-group siblings). */
  targets: string[];
  /** Distinct portable skills discovered under ~/plugins/ for runtime=opencode. */
  discovered: number;
  /** Per-target mirror dirs created (summed across targets). */
  created: number;
  /** Per-target mirror dirs unchanged. */
  unchanged: number;
  /** Per-target mirror dirs removed (no longer in desired set). */
  removed: number;
  /** Skill names a target preserved because non-managed content existed there. */
  skipped: string[];
  /**
   * Paths refused for resolving outside their own plugin repository
   * (`<skill>` or `<skill>/<child>`). Non-empty means a plugin holds a link
   * out of its tree — see the containment note on `syncSkillSymlinks`.
   */
  refused: string[];
}

/**
 * Mirror portable plugin skills into OpenCode's skill discovery path.
 *
 * Why this is OpenCode-specific (and now the ONLY plugin-skill mirror):
 *   - Codex loads `~/plugins` natively (marketplace + `~/.codex/plugins/cache`),
 *     so its mirror was retired — `syncCodexPluginSkills()` is deleted. The
 *     codex-filtered `~/.agents/skills/` set also omitted workflow-agents
 *     (codex loads it via `.codex-plugin/plugin.json`), so OpenCode could never
 *     have shared that mirror without missing /team-*.
 *   - OpenCode has no plugin loader for slash commands. The supported route
 *     for /team-* is "every SKILL.md becomes a command automatically" via
 *     `packages/opencode/src/command/index.ts` (verified in source).
 *   - OpenCode auto-scans `~/.config/opencode/{skill,skills}/` (OPENCODE_SKILL_PATTERN
 *     in `packages/opencode/src/skill/index.ts:24`). We write there + every
 *     `~/.local/share/opencode-<folder>/skill/` for the per-sibling sets.
 *
 * Discovery uses `runtime: 'opencode'` — its denylist excludes the Claude
 * workflow (which expects Claude's Agent tool) but allows workflow-agents
 * skills (runtime-agnostic prose; OpenCode dispatches via its `task` tool +
 * the subagents synced by syncOpenCodeSubagents).
 *
 * The per-sibling target gets symlinked children pointing at plugin sources;
 * the OpenCode provider copies the skill/ tree into the session XDG with
 * `dereference: true` so the container sees real files.
 */
export function syncOpenCodePluginSkills(): OpenCodeSkillSyncResult {
  const pluginsRoot = path.join(os.homedir(), 'plugins');
  // A workgroup-scoped plugin's skills are never mirrored. Every target here is
  // either the global dir, which any OpenCode group without its own falls back
  // to, or a per-sibling dir not keyed by workgroup (src/plugin-scopes.ts). They
  // are denied before discovery's first-plugin-wins name dedup, so a scoped
  // plugin can't shadow a same-named skill in an unscoped one, and the cleanup
  // pass prunes a copy made before scoping the next time this runs.
  const scoped = scopedPluginNames(loadPluginScopes());
  // The repository roots anything in this mirror may point into. Shared by the
  // skill mirror (via each skill's own `pluginRoot`) and the support-dir mirror
  // below, which has no single plugin in hand.
  const pluginRoots = resolvePluginRoots(pluginsRoot);
  const discovered = discoverPortableSkills(pluginsRoot, {
    runtime: 'opencode',
    denyPlugins: new Set([...DEFAULT_DENY_PLUGINS, ...scoped]),
  });
  const targets = discoverOpenCodeXdgTargets('skill');

  // Collect sibling support dirs (non-SKILL-md children of skills/ roots, e.g.
  // workflow-agents/skills/shared/codex-workflow-primitives.md) — referenced by
  // peer SKILL.md files via `../<sibling>/...` relative paths. Without this,
  // team-auto/SKILL.md's `../shared/codex-workflow-primitives.md` lookup
  // resolves to a missing file in the mirror.
  const supportDirs = collectSiblingSupportDirs(discovered);

  let created = 0;
  let unchanged = 0;
  let removed = 0;
  const skippedSet = new Set<string>();
  const refusedSet = new Set<string>();

  for (const target of targets) {
    const result = syncSkillSymlinks(target, discovered);
    created += result.created.length;
    unchanged += result.unchanged.length;
    removed += result.removed.length;
    for (const s of result.skipped) skippedSet.add(s);
    for (const r of result.refused) refusedSet.add(r);

    for (const [name, srcDir] of supportDirs) {
      const dstDir = path.join(target, name);
      // Don't trample a name we already wrote as a real skill mirror — skill
      // wins over support dir (extremely unlikely collision but cheap to guard).
      if (discovered.some((d) => d.name === name)) continue;
      for (const r of mirrorSupportDir(srcDir, dstDir, pluginRoots)) refusedSet.add(`${name}/${r}`);
    }
  }

  if (refusedSet.size > 0) {
    // Never silent: a skill quietly missing from an agent is the failure mode
    // a containment refusal must not have.
    log.warn('OpenCode skill mirror refused paths resolving outside their plugin repository', {
      refused: [...refusedSet],
    });
  }

  return {
    targets,
    discovered: discovered.length,
    created,
    unchanged,
    removed,
    skipped: [...skippedSet],
    refused: [...refusedSet],
  };
}

/**
 * Walk every plugin skills/ root represented in `discovered` and return the
 * non-SKILL-md child dirs that need mirroring as siblings (e.g. workflow-agents/
 * skills/shared/). Keyed by dir name; first-wins if multiple plugins share a
 * name (alphabetical by source plugin).
 */
function collectSiblingSupportDirs(discovered: ReturnType<typeof discoverPortableSkills>): Map<string, string> {
  const seenRoots = new Set<string>();
  const supportDirs = new Map<string, string>();

  for (const skill of [...discovered].sort((a, b) => a.skillDir.localeCompare(b.skillDir))) {
    // skill.skillDir = <plugin-root>/.../skills/<skill-name>
    const skillsRoot = path.dirname(skill.skillDir);
    if (seenRoots.has(skillsRoot)) continue;
    seenRoots.add(skillsRoot);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      const childPath = path.join(skillsRoot, entry.name);
      if (fs.existsSync(path.join(childPath, 'SKILL.md'))) continue; // it's a skill, handled separately
      if (supportDirs.has(entry.name)) continue;
      supportDirs.set(entry.name, childPath);
    }
  }
  return supportDirs;
}

/**
 * Mirror a support dir to its target as a real directory with per-child
 * symlinks (so plugin updates propagate without re-sync). Container provider
 * will copy with `dereference: true` so the container sees real files.
 *
 * Contained the same way the skill mirror is, and for the same reason: this
 * writes links a session copy later DEREFERENCES into a container, so a child
 * resolving outside every plugin repository would move host-only state across
 * that boundary. This writer has no single plugin in hand — the support dir is
 * a sibling of some skills root — so the whole set of roots is the boundary.
 * Returns the refused child names.
 */
function mirrorSupportDir(src: string, dst: string, pluginRoots: readonly string[]): string[] {
  const refused: string[] = [];
  fs.mkdirSync(dst, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  // Drop any stale entries we own.
  for (const existing of fs.readdirSync(dst)) {
    const existingPath = path.join(dst, existing);
    try {
      if (fs.lstatSync(existingPath).isSymbolicLink()) fs.unlinkSync(existingPath);
    } catch {
      /* race */
    }
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const srcEntry = path.join(src, entry.name);
    const resolved = resolveRealPath(srcEntry);
    if (resolved === null || !pluginRoots.some((root) => isWithinResolvedRoot(resolved, root))) {
      refused.push(entry.name);
      continue;
    }
    const dstEntry = path.join(dst, entry.name);
    try {
      fs.symlinkSync(srcEntry, dstEntry);
    } catch {
      /* already exists or race — best-effort */
    }
  }
  return refused;
}
