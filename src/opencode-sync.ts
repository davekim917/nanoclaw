/**
 * OpenCode sibling of `codex-sync.ts`: converts the Claude `.md` subagents into OpenCode agent files in the global
 * `~/.config/opencode/agent/` and in `~/.local/share/opencode-<folder>/agent/` for each sibling with an
 * `auth.json` (the provider copies those into the session XDG at spawn). Only files carrying the managed marker
 * are overwritten or pruned; hand-written agents survive.
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
  MIRROR_OWNED_CHILDREN,
  type DiscoveredSkill,
  discoverPortableSkills,
  isWithinResolvedRoot,
  resolvePluginRoots,
  resolveRealPath,
  syncSkillSymlinks,
  writeMirrorSourceRoot,
} from './plugin-skill-discovery.js';
import { loadPluginScopes, scopedPluginNames } from './plugin-scopes.js';

export interface OpenCodeSubagentsSyncResult {
  targets: string[];
  discovered: number;
  writes: number;
  unchangedFiles: number;
  removedFiles: number;
  /** Names with an unmanaged `.md` in at least one target; skipped wherever they collided. */
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
 * OpenCode reads agents from `$XDG_CONFIG_HOME/opencode/agent/` (singular canonicalized); XDG_DATA is not an agent
 * discovery path, so per-sibling files live beside auth.json and are copied in at spawn.
 */
function discoverOpenCodeAgentTargets(): string[] {
  return discoverOpenCodeXdgTargets('agent');
}

/** `~/.config/opencode/<subdir>` plus `~/.local/share/opencode-<folder>/<subdir>` per sibling with auth.json. */
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
  targets: string[];
  discovered: number;
  created: number;
  unchanged: number;
  removed: number;
  /** Names a target preserved because non-managed content existed there. */
  skipped: string[];
  /** `<skill>` or `<skill>/<child>` paths refused for resolving outside their plugin repository. */
  refused: string[];
}

/**
 * The deny set every walk of this mirror's population must use (code-level denials plus workgroup-scoped plugins):
 * discovery keeps only the FIRST plugin to claim a name, so walks with different deny sets name different owners.
 */
function openCodeMirrorDenyPlugins(): Set<string> {
  // Scoped plugins are never mirrored: every target is either global or a per-sibling dir not keyed by workgroup.
  // Denied before first-wins dedup, so a scoped plugin cannot shadow an unscoped one.
  return new Set([...DEFAULT_DENY_PLUGINS, ...scopedPluginNames(loadPluginScopes())]);
}

/** The one population every reader of the mirror must use (see openCodeMirrorDenyPlugins). */
export function openCodeMirrorSkills(pluginsRoot: string): DiscoveredSkill[] {
  return discoverPortableSkills(pluginsRoot, {
    runtime: 'opencode',
    delivery: { nativePluginLoading: false, mirrorIsSoleDelivery: true },
    denyPlugins: openCodeMirrorDenyPlugins(),
  });
}

/**
 * Mirror portable plugin skills into OpenCode's skill path, the only plugin-skill mirror (Codex loads `~/plugins`
 * natively). OpenCode has no plugin loader; every mirrored SKILL.md becomes a slash command.
 */
export function syncOpenCodePluginSkills(): OpenCodeSkillSyncResult {
  const pluginsRoot = path.join(os.homedir(), 'plugins');
  const pluginRoots = resolvePluginRoots(pluginsRoot);
  const discovered = openCodeMirrorSkills(pluginsRoot);
  const targets = discoverOpenCodeXdgTargets('skill');

  // Non-skill children of skills/ roots, referenced by peer SKILL.md files via `../<sibling>/...`.
  const supportDirs = collectSiblingSupportDirs(discovered, pluginRoots);

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

    for (const [name, { dir: srcDir }] of supportDirs) {
      const dstDir = path.join(target, name);
      if (discovered.some((d) => d.name === name)) continue;
      for (const r of mirrorSupportDir(srcDir, dstDir, pluginRoots)) refusedSet.add(`${name}/${r}`);
    }
  }

  if (refusedSet.size > 0) {
    // Never silent: a skill quietly missing from an agent is worse than a refusal.
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

/** Non-skill child dirs of each skills/ root, keyed by name; first plugin (alphabetical) wins. */
export function collectSiblingSupportDirs(
  discovered: ReturnType<typeof discoverPortableSkills>,
  pluginRoots: readonly string[],
): Map<string, { dir: string; pluginRoot: string }> {
  const seenRoots = new Set<string>();
  const supportDirs = new Map<string, { dir: string; pluginRoot: string }>();

  for (const skill of [...discovered].sort((a, b) => a.skillDir.localeCompare(b.skillDir))) {
    // A single-skill repo's skill dir IS its repo root, whose parent is the plugins root, not a skills root:
    // treating it as one would publish every other plugin repo (scoped ones included) as a support dir.
    if (skill.skillDir === skill.pluginRoot) continue;
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
      if (fs.existsSync(path.join(childPath, 'SKILL.md'))) continue;
      if (supportDirs.has(entry.name)) continue;
      // The repository that CONTAINS the directory, which writer and reader must derive identically.
      const owner = supportDirRoot(childPath, pluginRoots);
      if (owner === undefined) continue;
      supportDirs.set(entry.name, { dir: childPath, pluginRoot: owner });
    }
  }
  return supportDirs;
}

/**
 * Shared by the support-dir writer and the session copy's attribution walk (`mirrorSourceRootsByName`), which
 * must agree on owners or the reader refuses content the record allows.
 */
function supportDirRoot(dir: string, pluginRoots: readonly string[]): string | undefined {
  const resolved = resolveRealPath(dir);
  if (resolved === null) return undefined;
  return pluginRoots.find((root) => isWithinResolvedRoot(resolved, root));
}

/**
 * Real dir with per-child symlinks (plugin updates propagate; the provider copies with `dereference: true`).
 * Every child must resolve inside the ONE plugin repo containing `src`, since the session copy dereferences these
 * into a container. Returns refused child names (all of them when `src` is in no plugin repo).
 */
function mirrorSupportDir(src: string, dst: string, pluginRoots: readonly string[]): string[] {
  const refused: string[] = [];
  const ownRoot = supportDirRoot(src, pluginRoots);
  fs.mkdirSync(dst, { recursive: true });
  // Provenance record, so the session copy contains nested links against this repo rather than the union.
  if (ownRoot !== undefined) writeMirrorSourceRoot(dst, ownRoot);
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const existing of fs.readdirSync(dst)) {
    if (MIRROR_OWNED_CHILDREN.has(existing)) continue;
    const existingPath = path.join(dst, existing);
    try {
      if (fs.lstatSync(existingPath).isSymbolicLink()) fs.unlinkSync(existingPath);
    } catch {
      /* race */
    }
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (MIRROR_OWNED_CHILDREN.has(entry.name)) continue;
    const srcEntry = path.join(src, entry.name);
    const resolved = resolveRealPath(srcEntry);
    if (resolved === null || ownRoot === undefined || !isWithinResolvedRoot(resolved, ownRoot)) {
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
