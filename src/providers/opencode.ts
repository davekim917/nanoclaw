/**
 * Host-side container config for the `opencode` provider. XDG_DATA_HOME is pinned to a per-session host dir so
 * opencode.db stays per-session; auth, agent definitions and skills are copied in at spawn. Each surface prefers
 * `~/.local/share/opencode-<folder>/` independently: auth falls back to `~/.local/share/opencode`, definitions to
 * `~/.config/opencode`. NO_PROXY is merged so OpenCode still reaches 127.0.0.1 behind OneCLI's HTTPS_PROXY.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readContainerConfig } from '../container-config.js';
import { getContainerConfig } from '../db/container-configs.js';
import {
  assertRealDirectory,
  removeUntrustedPathEntry,
  replaceUntrustedDirectory,
  replaceUntrustedFile,
} from '../fs-safety.js';
import { assertValidGroupFolder } from '../group-folder.js';
import { log } from '../log.js';
import { collectSiblingSupportDirs, openCodeMirrorSkills } from '../opencode-sync.js';
import { isExcludedPluginPath, splitExcludedPlugins, type ExcludedPlugins } from '../plugin-exclusions.js';
import {
  MIRROR_MARKER,
  type DiscoveredSkill,
  isWithinResolvedRoot,
  readMirrorSourceRoot,
  resolvePluginRoots,
  resolveRealPath,
} from '../plugin-skill-discovery.js';
import { registerProviderContainerConfig, type VolumeMount } from './provider-container-registry.js';

// The ONLY place the fleet default lives; no DB row shadows it. DeepSeek models on Go are China-hosted: the OpenCode
// workspace must have opted in, or every request errors while `opencode models` still lists the slug. The provider
// is derived from the model prefix at runtime; the constant only guards a malformed override.
const DEFAULT_OPENCODE_MODEL = 'opencode-go/deepseek-v4.1-flash';
const DEFAULT_OPENCODE_PROVIDER = 'opencode-go';
const DEFAULT_OPENCODE_EFFORT = 'high';

/**
 * Skill names this group's `excludePlugins` SUB-PATH entries withhold from the host-side OpenCode mirror. The mirror
 * is built once per provider with no group in hand, so without this a sub-plugin exclusion would be half-applied on
 * this one provider. SUB-PATHS ONLY, deliberately: top-level entries keep their skills in this mirror (documented in
 * enable-agent-plugins, and live groups are configured against it).
 * Each skill's own source path is tested, never names compared across two walks: discovery is first-plugin-wins, so
 * a surviving name can still be served by the excluded source's bytes. Such a name is dropped even when another plugin
 * provides it; that copy still arrives through the container-side mirror. `discovered` must be the mirror writer's own
 * population (`openCodeMirrorSkills`), shared with `mirrorSourceRootsByName`; a reader that walks for itself
 * disagrees with the mirror. Known gap: a managed entry left stale by a plugin rename is judged by the path the
 * current tree publishes under its name.
 */
export function excludedOpenCodeSkillNames(
  pluginsRoot: string,
  excluded: ExcludedPlugins,
  discovered: readonly DiscoveredSkill[] = openCodeMirrorSkills(pluginsRoot),
): Set<string> {
  if (excluded.subPaths.size === 0) return new Set();
  const subPathsOnly: ExcludedPlugins = { topLevel: new Set(), subPaths: excluded.subPaths };
  const dropped = new Set<string>();
  for (const skill of discovered) {
    if (isExcludedPluginPath(path.relative(pluginsRoot, skill.skillDir), subPathsOnly)) dropped.add(skill.name);
  }
  return dropped;
}

/** Containment roots for one top-level mirror entry; the order is explained at the `rootsFor` call site. */
function resolveRootsFor(
  source: string,
  name: string,
  allowedRoots: readonly string[],
  sourceRootsByName: ReadonlyMap<string, string>,
): readonly string[] {
  const dir = path.join(source, name);
  // Provenance belongs only to a REAL DIRECTORY the writers published: reading a record "inside" a symlink would let
  // the plugin choose the root.
  let entry: fs.Stats | undefined;
  try {
    entry = fs.lstatSync(dir, { throwIfNoEntry: false });
  } catch {
    return [];
  }
  // A non-directory entry has no record of its own; prefer the current walk over the union.
  if (entry === undefined || !entry.isDirectory()) {
    const walkedEntry = sourceRootsByName.get(name);
    return walkedEntry === undefined ? allowedRoots : [walkedEntry];
  }

  const recorded = readMirrorSourceRoot(dir);
  if (recorded !== null) {
    const resolved = resolveRealPath(recorded);
    // A record names WHICH plugin repository, never what counts as one: honour it only if it is still one now.
    return resolved !== null && allowedRoots.includes(resolved) ? [resolved] : [];
  }
  const walked = sourceRootsByName.get(name);
  if (walked !== undefined) return [walked];
  try {
    if (fs.lstatSync(path.join(dir, MIRROR_MARKER), { throwIfNoEntry: false }) !== undefined) return [];
  } catch {
    return [];
  }
  return allowedRoots;
}

export interface CopyOpenCodeSkillsOptions {
  /** Gated on the mirror writer's marker. */
  dropNames?: ReadonlySet<string>;
  /**
   * Resolved plugin repository roots a link may resolve into when its mirror dir records no source root. REQUIRED,
   * with no default: this containment is the copy's security boundary. An empty array refuses every link. A dir the
   * mirror writer published is held to its ONE recorded repository instead.
   */
  allowedRoots: readonly string[];
  /**
   * Name → resolved repository from a walk of the CURRENT tree, attributing dirs published before provenance records
   * existed. When omitted, such a dir is treated as stale and its links refused, never widened.
   */
  sourceRootsByName?: ReadonlyMap<string, string>;
}

/**
 * Every mirror-dir name the CURRENT plugins tree would publish (skills, then support dirs), mapped to its resolved
 * repository. A FALLBACK for a dir with no provenance record, never an override: the record describes the mirror's
 * bytes and this does not.
 */
export function mirrorSourceRootsByName(
  pluginsRoot: string,
  discovered: readonly DiscoveredSkill[] = openCodeMirrorSkills(pluginsRoot),
): Map<string, string> {
  const roots = new Map<string, string>();
  for (const skill of discovered) {
    const resolved = resolveRealPath(skill.pluginRoot);
    if (resolved !== null) roots.set(skill.name, resolved);
  }
  // Attributed by the same function the writer records from, so the two cannot name different owners.
  for (const [name, { pluginRoot }] of collectSiblingSupportDirs([...discovered], resolvePluginRoots(pluginsRoot))) {
    if (roots.has(name)) continue;
    roots.set(name, pluginRoot);
  }
  return roots;
}

/**
 * Copies a host-owned skill tree without mutating it or following stale links. A `dropNames` entry is dropped only
 * where the writer's marker shows the mirror published that dir: an operator-placed or native dir of the same name
 * must not be withdrawn.
 */
export function copyOpenCodeSkills(source: string, target: string, options: CopyOpenCodeSkillsOptions): void {
  const dropNames = options.dropNames ?? new Set<string>();
  const { allowedRoots } = options;
  const sourceRootsByName = options.sourceRootsByName ?? new Map<string, string>();
  // Each link is contained to the ONE repository its mirror dir came from: the writers never resolve nested links, and
  // the union of plugin roots would let one reach another plugin, including a workgroup-scoped one this mirror never
  // published. In order: the dir's provenance record (recorded but unresolvable yields NO roots); the current walk's
  // root for the name (nothing re-runs the mirror sync at boot, so pre-record dirs rely on it); a MANAGED dir neither
  // attributes is stale and gets none; only an UNMANAGED, unattributed dir falls back to the union.
  const rootsByName = new Map<string, readonly string[]>();
  const rootsFor = (name: string): readonly string[] => {
    const cached = rootsByName.get(name);
    if (cached !== undefined) return cached;
    const roots = resolveRootsFor(source, name, allowedRoots, sourceRootsByName);
    rootsByName.set(name, roots);
    return roots;
  };
  fs.cpSync(source, target, {
    recursive: true,
    dereference: true,
    force: true,
    filter: (sourcePath) => {
      // The first segment is the skill name the mirror published; `''` is the root.
      const rel = path.relative(source, sourcePath);
      const name = rel ? rel.split(path.sep)[0] : '';
      if (name && dropNames.has(name) && fs.existsSync(path.join(source, name, MIRROR_MARKER))) return false;
      const stat = fs.lstatSync(sourcePath, { throwIfNoEntry: false });
      if (stat === undefined) return false;
      // Only a LINK can still reach out of the plugin tree.
      if (!stat.isSymbolicLink()) return true;
      // `dereference: true` copies whatever the link resolves to into a container mount, and a plugin link can be
      // repointed after the mirror sync, so containment is re-decided here on a separator boundary.
      const resolved = resolveRealPath(sourcePath);
      // Dangling: a stale link must not wedge the spawn.
      if (resolved === null) return false;
      const roots = name ? rootsFor(name) : allowedRoots;
      if (!roots.some((root) => isWithinResolvedRoot(resolved, root))) {
        log.warn('OpenCode skill mirror link resolves outside its plugin repository; not copying it', {
          link: sourcePath,
          resolved,
        });
        return false;
      }
      // A FIFO, socket or device node passes containment and then makes `cpSync` throw, failing the whole spawn.
      const targetStat = fs.statSync(resolved, { throwIfNoEntry: false });
      if (targetStat === undefined || !(targetStat.isFile() || targetStat.isDirectory())) return false;
      return true;
    },
  });
}

/**
 * `<VAR>_<FOLDER>` (upper-cased, `-` → `_`) wins over `<VAR>`, as in container-runner's `resolveScopedEnv`. Only for
 * the model-capability declarations, which have no DB column; provider and model are DB-authoritative.
 */
function resolveScopedOpenCodeEnv(
  hostEnv: NodeJS.ProcessEnv,
  baseName: string,
  folder: string | undefined,
): string | undefined {
  if (folder) {
    const scoped = hostEnv[`${baseName}_${folder.toUpperCase().replace(/-/g, '_')}`];
    if (scoped !== undefined) return scoped;
  }
  return hostEnv[baseName];
}

/**
 * Read by the container provider at startup; inert when unset. CONTEXT_LIMIT and OUTPUT_LIMIT re-enable
 * auto-compaction for a model OpenCode's registry does not know (an undeclared model's limit is 0, which silently
 * disables it); a half-set pair is dropped. INPUT_MODALITIES (image, pdf, audio, video) lets non-text parts reach an
 * undeclared model at all.
 */
const OPENCODE_MODEL_CAPABILITY_VARS = [
  'OPENCODE_MODEL_CONTEXT_LIMIT',
  'OPENCODE_MODEL_OUTPUT_LIMIT',
  'OPENCODE_MODEL_INPUT_MODALITIES',
] as const;

function mergeNoProxy(current: string | undefined, additions: string): string {
  if (!current?.trim()) return additions;
  const parts = new Set(
    current
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) {
    const trimmed = addition.trim();
    if (trimmed) parts.add(trimmed);
  }
  return [...parts].join(',');
}

interface OpenCodeSourcePaths {
  authFile: string;
  agentsDir: string;
  skillsDir: string;
}

/** Each surface resolves independently: a scoped auth.json must not suppress the definition fallbacks, or vice versa. */
function resolveOpenCodeSourcePaths(
  agentGroupFolder: string | undefined,
  agentGroupId: string,
  hostHome: string,
): OpenCodeSourcePaths {
  const scopedFolder = agentGroupFolder || agentGroupId;
  // folder/id reaches path.join, so traversal is rejected before the scoped path is formed.
  assertValidGroupFolder(scopedFolder);
  const scoped = path.join(hostHome, '.local', 'share', `opencode-${scopedFolder}`);
  const shared = path.join(hostHome, '.local', 'share', 'opencode');
  const config = path.join(hostHome, '.config', 'opencode');
  const scopedAuth = path.join(scoped, 'auth.json');
  const scopedAgents = path.join(scoped, 'agent');
  const scopedSkills = path.join(scoped, 'skill');

  return {
    authFile: fs.existsSync(scopedAuth) ? scopedAuth : path.join(shared, 'auth.json'),
    agentsDir: fs.existsSync(scopedAgents) ? scopedAgents : path.join(config, 'agent'),
    skillsDir: fs.existsSync(scopedSkills) ? scopedSkills : path.join(config, 'skill'),
  };
}

/** Container path the session XDG tree is mounted at, for every provider. */
export const OPENCODE_XDG_CONTAINER_PATH = '/opencode-xdg';

/**
 * Points OpenCode at the staged tree: creds under `$XDG_DATA_HOME/opencode/`, agents under
 * `$XDG_CONFIG_HOME/opencode/agent/`. Non-OpenCode containers get these too; nothing else in the image reads them.
 * `XDG_CONFIG_HOME` is DEAD for the runner and its children, since the entrypoint re-exports it after Docker applies
 * this env; both are still declared for `docker exec` shells, which skip the entrypoint. `OPENCODE_CONFIG` names the
 * staged default-model config explicitly for that reason; it ranks below the inline `OPENCODE_CONFIG_CONTENT` the
 * OpenCode provider's own container uses.
 */
export const OPENCODE_XDG_ENV: Readonly<Record<string, string>> = Object.freeze({
  XDG_DATA_HOME: OPENCODE_XDG_CONTAINER_PATH,
  XDG_CONFIG_HOME: OPENCODE_XDG_CONTAINER_PATH,
  OPENCODE_CONFIG: `${OPENCODE_XDG_CONTAINER_PATH}/opencode/opencode.json`,
});

export interface StagedOpenCodeAuth {
  mounts: VolumeMount[];
  env: Readonly<Record<string, string>>;
  /** `<sessionDir>/opencode-xdg/opencode` — where the provider adds the rest. */
  opencodeSubdir: string;
}

/**
 * The global config in every staged tree, holding only the fleet default model. Without it a headless `opencode run`
 * picks "the first model by internal priority" across every credential it finds (in a Codex container, an OpenAI
 * model with a stale OAuth entry). Safe for the OpenCode provider's own container, whose inline
 * `OPENCODE_CONFIG_CONTENT` merges over this file.
 */
export const OPENCODE_STAGED_CONFIG_FILE = 'opencode.json';
function stagedOpenCodeConfig(): string {
  return JSON.stringify({ $schema: 'https://opencode.ai/config.json', model: DEFAULT_OPENCODE_MODEL }, null, 2) + '\n';
}

/**
 * Stages the host OpenCode credential and default-model config into a session-private XDG tree, and nothing more:
 * every container gets this so any agent can drive `opencode` headless, while agents, skills and opencode.db belong to
 * the OpenCode provider's contribution, which reuses this for its auth step. The dirs were writable by the prior
 * container, so every managed entry is recreated without following a path it may have replaced with a symlink.
 */
export function stageOpenCodeAuth(
  sessionDir: string,
  agentGroupFolder: string | undefined,
  agentGroupId: string,
  hostHome: string | undefined,
): StagedOpenCodeAuth {
  const opencodeDir = path.join(sessionDir, 'opencode-xdg');
  const opencodeSubdir = path.join(opencodeDir, 'opencode');
  if (fs.lstatSync(opencodeDir, { throwIfNoEntry: false }) === undefined)
    fs.mkdirSync(opencodeDir, { recursive: true });
  assertRealDirectory(opencodeDir);
  if (fs.lstatSync(opencodeSubdir, { throwIfNoEntry: false }) === undefined) fs.mkdirSync(opencodeSubdir);
  assertRealDirectory(opencodeSubdir);

  let authContents: Buffer | null = null;
  if (hostHome) {
    const source = resolveOpenCodeSourcePaths(agentGroupFolder, agentGroupId, hostHome);
    if (fs.existsSync(source.authFile)) authContents = fs.readFileSync(source.authFile);
  }
  if (authContents) replaceUntrustedFile(opencodeSubdir, 'auth.json', authContents);
  else removeUntrustedPathEntry(opencodeSubdir, 'auth.json');
  replaceUntrustedFile(opencodeSubdir, OPENCODE_STAGED_CONFIG_FILE, stagedOpenCodeConfig());

  return {
    mounts: [{ hostPath: opencodeDir, containerPath: OPENCODE_XDG_CONTAINER_PATH, readonly: false }],
    env: OPENCODE_XDG_ENV,
    opencodeSubdir,
  };
}

registerProviderContainerConfig('opencode', async (ctx) => {
  const hostHome = ctx.hostEnv.HOME || os.homedir();
  const staged = stageOpenCodeAuth(ctx.sessionDir, ctx.agentGroupFolder, ctx.agentGroupId, hostHome);
  const opencodeSubdir = staged.opencodeSubdir;

  let hostAgentsDir: string | null = null;
  let hostSkillsDir: string | null = null;
  if (hostHome) {
    const source = resolveOpenCodeSourcePaths(ctx.agentGroupFolder, ctx.agentGroupId, hostHome);
    if (fs.existsSync(source.agentsDir)) hostAgentsDir = source.agentsDir;
    if (fs.existsSync(source.skillsDir)) hostSkillsDir = source.skillsDir;
  }

  removeUntrustedPathEntry(opencodeSubdir, 'agent');
  if (hostAgentsDir) {
    // Copied per session, not bind-mounted, so the host-synced definitions stay read-only from the container's view.
    const targetAgentsDir = replaceUntrustedDirectory(opencodeSubdir, 'agent');
    for (const entry of fs.readdirSync(hostAgentsDir)) {
      if (!entry.endsWith('.md')) continue;
      fs.copyFileSync(path.join(hostAgentsDir, entry), path.join(targetAgentsDir, entry));
    }
  }

  removeUntrustedPathEntry(opencodeSubdir, 'skill');
  if (hostSkillsDir) {
    // Dereferenced: the mirror's links point at plugin source the container does not mount. A stale link must not
    // wedge the spawn, and the host-owned source is never pruned; only the copy is filtered.
    const targetSkillsDir = replaceUntrustedDirectory(opencodeSubdir, 'skill');
    // Exclusions come from the authoritative container.json. The walk uses `os.homedir()`, the root the mirror was
    // built from, not `hostHome`: were they to differ, the drop set would be silently empty.
    const pluginsRoot = path.join(os.homedir(), 'plugins');
    // ONE walk shared by both readers, so they cannot disagree about the mirror's population.
    const mirrorSkills = openCodeMirrorSkills(pluginsRoot);
    const dropNames = excludedOpenCodeSkillNames(
      pluginsRoot,
      splitExcludedPlugins(readContainerConfig(path.basename(ctx.groupDir)).excludePlugins),
      mirrorSkills,
    );
    // The mirror is built only from plugin repositories, so a link resolving outside all of them is an escape.
    copyOpenCodeSkills(hostSkillsDir, targetSkillsDir, {
      dropNames,
      allowedRoots: resolvePluginRoots(pluginsRoot),
      sourceRootsByName: mirrorSourceRootsByName(pluginsRoot, mirrorSkills),
    });
  }

  // The code-level default is the floor and the DB value overrides it. No `.env` scoped model/provider vars: the DB is
  // authoritative.
  const dbConfig = await getContainerConfig(ctx.agentGroupId);
  const model = dbConfig?.model ?? DEFAULT_OPENCODE_MODEL;
  const slash = model.indexOf('/');
  const modelProvider = slash > 0 ? model.slice(0, slash) : DEFAULT_OPENCODE_PROVIDER;

  const env: Record<string, string> = {
    ...staged.env,
    // The child runtime adds opencode.ai only when the effective turn model has a native auth record; the host cannot
    // decide that from the boot model, since `-m` and channel defaults can change it.
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, '127.0.0.1,localhost'),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, '127.0.0.1,localhost'),
  };
  env.OPENCODE_MODEL = model;

  // opencode's INTERNAL billing/routing provider (opencode = Zen, opencode-go = Go, nvidia, ...), derived from the
  // model prefix so the two cannot disagree. NOT dbConfig.provider, which selects the agent runtime.
  env.OPENCODE_PROVIDER = modelProvider;

  env.OPENCODE_EFFORT = dbConfig?.effort ?? DEFAULT_OPENCODE_EFFORT;

  for (const varName of OPENCODE_MODEL_CAPABILITY_VARS) {
    const value = resolveScopedOpenCodeEnv(ctx.hostEnv, varName, ctx.agentGroupFolder);
    if (value !== undefined && value.trim() !== '') env[varName] = value;
  }
  // No OPENCODE_BASE_URL: routing follows the auth.json key and the model prefix.

  return { mounts: staged.mounts, env };
});
