/**
 * Host-side container config for the `opencode` provider.
 *
 * OpenCode stores creds at `$XDG_DATA_HOME/opencode/auth.json` and session
 * state at `$XDG_DATA_HOME/opencode/opencode.db`. We pin XDG_DATA_HOME to a
 * per-session host directory (`<sessionDir>/opencode-xdg`) so:
 *
 * - Session state (opencode.db) stays per-session, no cross-session collisions.
 * - Auth, agent definitions, and skills reach the container via copy-at-spawn.
 *   Each surface independently prefers `~/.local/share/opencode-<folder>/`;
 *   auth falls back to `~/.local/share/opencode`, while definitions fall back
 *   to `~/.config/opencode`, so a scoped definition does not need scoped auth.
 *
 * Env passthrough covers the runtime-read OPENCODE_* selector vars (provider/
 * model) plus the optional per-group model capability declarations
 * (OPENCODE_MODEL_CAPABILITY_VARS). NO_PROXY / no_proxy are merged so
 * OpenCode's internal client can still reach 127.0.0.1 when HTTPS_PROXY is set
 * by OneCLI.
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

// Code-level opencode defaults — the floor under the per-group DB value
// (container_configs), mirroring DEFAULT_OPUS_MODEL etc. for claude in
// container-runner.ts. Default to the Go subscription (cheapest tier); Zen is
// opt-in via an explicit `opencode/*` model. Bump these when the fleet default
// moves (2026-09-15: glm-5.3-flash → deepseek-v4.1-flash). This is the ONLY
// place the default lives: the `provider_models` allowlist that once carried
// an `is_default` row was dropped by migration 039
// (`src/db/migrations/039-denied-models.ts:42`), so no DB row shadows it.
// DeepSeek models on Go are China-hosted and the OpenCode workspace must have
// opted in, or every request errors at the endpoint while `opencode models`
// still lists the slug. The provider is derived from the model prefix at
// runtime; the constant only guards a malformed override.
const DEFAULT_OPENCODE_MODEL = 'opencode-go/deepseek-v4.1-flash';
const DEFAULT_OPENCODE_PROVIDER = 'opencode-go';
const DEFAULT_OPENCODE_EFFORT = 'high';

/**
 * Skill names this group's `excludePlugins` SUB-PATH entries withhold from the
 * host-side OpenCode mirror.
 *
 * OpenCode receives skills by TWO paths, and the container-side one is not
 * enough on its own: the in-container mirror at `~/.agents/skills`
 * (`syncAgentSkillsMirror`, which honours `excludePlugins` in the container)
 * AND this copy of the host's per-sibling mirror into the session XDG. The host
 * mirror is built once for every sibling of a provider, with no agent group in
 * hand (`syncOpenCodePluginSkills`, `src/opencode-sync.ts`), so an excluded
 * sub-plugin's skills sit in it and would reach the group anyway — a sub-plugin
 * exclusion would be half-applied on exactly one provider.
 *
 * SUB-PATHS ONLY, deliberately. A TOP-LEVEL entry's skills also survive in this
 * mirror today, and that is a pre-existing, documented behaviour
 * (`.claude/skills/enable-agent-plugins/SKILL.md`: "drops the ruleset, keeps the
 * skills") that live groups are configured against — every OpenCode group on
 * this install carries top-level entries. Widening this filter to cover them
 * would silently withdraw skills those groups have today, which is a fleet
 * change, not this one's. The top-level gap stays as it was.
 *
 * The question this set answers is about the SOURCE the mirror published, not
 * about a name: the mirror holds exactly one directory per skill name, and the
 * copy either hands that directory to the group or does not. So each discovered
 * skill is asked the predicate directly, about the path the walk assembled for
 * it — `path.relative(pluginsRoot, skillDir)`, built from `readdirSync` names
 * by `discoverInPlugin`'s own `path.join`s, never a `realpath` and never a path
 * from another mount namespace, which is what `isExcludedPluginPath`'s contract
 * requires.
 *
 * An earlier revision took a DIFFERENCE of two walks — one with the list, one
 * without — and compared the NAMES that survived. That inverted the exclusion
 * in the case review r1 named: discovery keeps only the first plugin to claim a
 * name (first-plugin-wins in `discoverPortableSkills`,
 * `src/plugin-skill-discovery.ts`, alphabetical) and the mirror was built from
 * the UNFILTERED walk (`syncOpenCodePluginSkills`, `src/opencode-sync.ts`), so
 * when the excluded sub-plugin is a name's
 * FIRST provider the name survives the filtered walk — supplied by the later
 * plugin — while the bytes in the mirror are still the excluded one's. A
 * name-only comparison read that as "kept" and copied the excluded source
 * through. Comparing part of an identifier the producer guarantees unique in
 * full is the same mistake #826 r3 recorded for the composer's fragment keys.
 *
 * A name whose mirror copy IS the excluded source is therefore dropped even
 * when another plugin also provides it — the mirror holds the wrong one and
 * there is no other copy of that name in it. Nothing is lost: the later
 * plugin's copy reaches the group through the container-side mirror, which
 * discovers over `/workspace/plugins` with the same list and picks that source
 * up (`syncAgentSkillsMirror`,
 * `container/agent-runner/src/codex-companion-setup.ts`), and OpenCode
 * auto-loads `~/.agents/skills`.
 *
 * The population is the MIRROR'S, not one this reader derives: `discovered`
 * comes from `openCodeMirrorSkills`, the single walk the writer also uses
 * (`src/opencode-sync.ts`), and the spawn path passes the same array to this and
 * to `mirrorSourceRootsByName`. Deriving it here was #836: this walk denied only
 * the code-level plugins while the mirror also denies every workgroup-scoped one,
 * so a scoped plugin that claimed a skill name ahead of an excluded sub-plugin
 * won HERE (not excluded → not dropped) while the mirror, having denied it,
 * published the excluded sub-plugin's directory under that name — and the
 * excluded source was copied into the group.
 *
 * What remains is the direction that walks the CURRENT tree at all: this answers
 * about the source `~/plugins` would publish under each name NOW, and the mirror
 * was written by a different pass at a different time, so a managed entry left
 * stale by a rename between the two is judged by a path it no longer has.
 * `copyOpenCodeSkills` closes the direction that would withdraw content (it drops
 * only a dir the mirror writer published). Closing the other needs the writer to
 * record each entry's own SOURCE DIR beside the repository root it already
 * records (`MIRROR_SOURCE_ROOT_FILE`, `src/plugin-skill-discovery.ts`), since a
 * sub-path exclusion is about a path inside the repository and the root alone
 * cannot decide one — #852. Re-raise on a mirror left stale across a plugin
 * rename, or on any new reader that walks for itself instead of taking this
 * population.
 *
 * Returns an empty set for a group with no sub-path entry, which is every group
 * today: the copy below then behaves exactly as it did.
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

/**
 * The marker `syncSkillSymlinks` drops inside every mirror dir IT created is
 * `MIRROR_MARKER`, imported from `src/plugin-skill-discovery.ts` rather than
 * redeclared here: the writer and this reader must agree on one string, and a
 * local copy would drift silently — a renamed marker would make every
 * `existsSync` below answer false and the drop set would stop applying with
 * green tests. Its absence is how that writer itself distinguishes a directory
 * it published from one an operator or a native installer placed —
 * `isManagedMirror`, the same predicate that makes the sync pass SKIP a native
 * dir rather than overwrite it, and makes the cleanup pass leave one alone
 * rather than prune it (both in `src/plugin-skill-discovery.ts`).
 */

/**
 * Copy a host-owned skill tree without mutating it or following stale links,
 * omitting any top-level skill dir in `dropNames` — but only where that dir is
 * one the mirror writer published.
 *
 * The drop set is derived from a walk of `~/plugins` and therefore names a
 * SOURCE. A mirror entry, though, is not always the thing that walk found:
 * `syncSkillSymlinks` preserves a directory it did not create, so an
 * operator-placed or natively-installed `<mirror>/<name>` survives every sync
 * untouched. Dropping on the name alone would withdraw that content from the
 * session because an excluded plugin happens to publish the same name — the
 * over-broad-guard failure this line of work has recorded three times: refusing
 * a legitimate state instead of the bad input. So the drop is gated on the
 * writer's own marker, which is the only provenance the mirror carries.
 *
 * What that gate does NOT establish is which SOURCE inside its repository a
 * managed dir came from. `MIRROR_SOURCE_ROOT_FILE` records the repository, which
 * is what containment needs, but a sub-path exclusion is about a path INSIDE one
 * and every skill of a repo records the same root. So a managed entry left stale
 * by a rename is still judged by the drop set against the path the CURRENT tree
 * publishes under its name rather than the one it holds. Closing that means
 * recording the entry's own source dir beside the root — #852, not made here.
 */
/**
 * The containment roots for one top-level entry of the mirror. See the ordering
 * note at the `rootsFor` call site.
 */
function resolveRootsFor(
  source: string,
  name: string,
  allowedRoots: readonly string[],
  sourceRootsByName: ReadonlyMap<string, string>,
): readonly string[] {
  const dir = path.join(source, name);
  // Provenance belongs to a REAL DIRECTORY the mirror writers published. A
  // top-level file, or a symlink standing where a mirror dir would be (the
  // pre-mirror-dir legacy shape, which only a sync prunes), has a path the
  // writers never wrote: reading a record "inside" it would follow that link
  // into a plugin repository and let the PLUGIN choose the root — a record
  // saying `/` is wider than the union it replaced.
  let entry: fs.Stats | undefined;
  try {
    entry = fs.lstatSync(dir, { throwIfNoEntry: false });
  } catch {
    return [];
  }
  // A non-directory entry (a top-level file, or the pre-mirror-dir legacy
  // symlink shape) carries no record of its own, but the current walk may still
  // know the name — prefer that over the union.
  if (entry === undefined || !entry.isDirectory()) {
    const walkedEntry = sourceRootsByName.get(name);
    return walkedEntry === undefined ? allowedRoots : [walkedEntry];
  }

  const recorded = readMirrorSourceRoot(dir);
  if (recorded !== null) {
    const resolved = resolveRealPath(recorded);
    // A record is a claim about WHICH plugin repository, never about what counts
    // as one. Honour it only when it names a root that is still a plugin
    // repository now; a record pointing anywhere else is stale or planted.
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
  /** Skill names to omit, gated on the mirror writer's marker (see above). */
  dropNames?: ReadonlySet<string>;
  /**
   * The resolved plugin repository roots a link may resolve into when the
   * mirror dir holding it records no source root of its own —
   * `resolvePluginRoots(<plugins root>)`. REQUIRED, and with no default,
   * because the containment it carries is this copy's security boundary: an
   * omitted-means-allow-everything default is the one shape that would let a
   * caller reintroduce the escape silently. An empty array refuses every link,
   * which is the safe direction.
   *
   * A dir the mirror writer published is held to its ONE repository instead,
   * which is strictly tighter — see `MIRROR_SOURCE_ROOT_FILE` in
   * `src/plugin-skill-discovery.ts` for why a union is not enough for those.
   */
  allowedRoots: readonly string[];
  /**
   * Skill and support-dir name → resolved plugin repository, from a walk of the
   * CURRENT plugins tree (`mirrorSourceRootsByName`). Attributes a dir published
   * before the provenance record existed, which is every dir on an install that
   * predates it. Omitting it is safe but weaker: such a dir is then treated as
   * stale and its links refused, never widened.
   */
  sourceRootsByName?: ReadonlyMap<string, string>;
}

/**
 * Every mirror-dir name the CURRENT `~/plugins` tree would publish, mapped to
 * the resolved repository that publishes it — skills first, then the support
 * dirs the mirror writes alongside them (`collectSiblingSupportDirs`,
 * `src/opencode-sync.ts`), which are the same two populations
 * `syncOpenCodePluginSkills` writes.
 *
 * This answers about the tree as it is NOW, not about what the mirror holds, so
 * it is the FALLBACK for a dir carrying no provenance record — never an
 * override of one. Where the two disagree the record wins, because the record is
 * about the bytes in the mirror and this is not.
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
  // Support dirs are attributed by the SAME function the writer records from,
  // over the same plugin roots, so the record and this fallback cannot name
  // different owners for one mirror dir.
  for (const [name, { pluginRoot }] of collectSiblingSupportDirs([...discovered], resolvePluginRoots(pluginsRoot))) {
    if (roots.has(name)) continue;
    roots.set(name, pluginRoot);
  }
  return roots;
}

export function copyOpenCodeSkills(source: string, target: string, options: CopyOpenCodeSkillsOptions): void {
  const dropNames = options.dropNames ?? new Set<string>();
  const { allowedRoots } = options;
  const sourceRootsByName = options.sourceRootsByName ?? new Map<string, string>();
  // Per-mirror-dir containment roots, resolved once per name.
  //
  // The boundary for every link under a mirror dir is the ONE repository that
  // dir was published from, because a link NESTED below its top level is never
  // resolved by either writer (both check direct children only) and the union of
  // every plugin root would let such a link reach a DIFFERENT plugin —
  // including a workgroup-scoped one this mirror deliberately never published.
  //
  // Four answers, in descending order of how directly they know the source:
  //   1. the dir's own provenance record — authoritative about the bytes here;
  //      recorded-but-unresolvable yields NO roots rather than a wider set;
  //   2. the current walk's root for this name — the dirs on an install that
  //      predates the record have no record and MUST NOT silently keep the
  //      union, and nothing re-runs the mirror sync at boot
  //      (`syncOpenCodePluginSkills`'s only callers are the plugin-update path
  //      and the enable script), so this is what closes them;
  //   3. a MANAGED dir neither of those attributes is stale — its source left
  //      the tree — so refuse its links rather than widen;
  //   4. only an UNMANAGED, unattributed dir (operator-placed or natively
  //      installed, which no plugin can create in this mirror) falls back.
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
      // `<mirror>/<skill-name>/...` — the first segment is the skill name the
      // mirror published, which is what the drop set holds. `''` is the root.
      const rel = path.relative(source, sourcePath);
      const name = rel ? rel.split(path.sep)[0] : '';
      if (name && dropNames.has(name) && fs.existsSync(path.join(source, name, MIRROR_MARKER))) return false;
      const stat = fs.lstatSync(sourcePath, { throwIfNoEntry: false });
      if (stat === undefined) return false;
      // A real file or directory in the mirror is content the mirror writer
      // already contained; only a LINK can still reach out of the plugin tree.
      if (!stat.isSymbolicLink()) return true;
      // `dereference: true` means this copy READS whatever the link resolves
      // to and writes the bytes into a directory mounted into the container.
      // The writer contains what it creates (`syncSkillSymlinks`,
      // `src/plugin-skill-discovery.ts`), but a link in a plugin repository can
      // be repointed AFTER that sync and before this spawn, and this is the
      // only reader standing between that and the container. So containment is
      // re-decided here, against the resolved plugin roots, on a separator
      // boundary so a sibling named `<root>-evil` cannot prefix-match.
      const resolved = resolveRealPath(sourcePath);
      // Dangling — the pre-existing reason this filter exists: a stale link
      // must not wedge the spawn. Unchanged behaviour, no warning.
      if (resolved === null) return false;
      const roots = name ? rootsFor(name) : allowedRoots;
      if (!roots.some((root) => isWithinResolvedRoot(resolved, root))) {
        log.warn('OpenCode skill mirror link resolves outside its plugin repository; not copying it', {
          link: sourcePath,
          resolved,
        });
        return false;
      }
      // A FIFO, socket or device node passes containment and then makes
      // `cpSync` throw (`ERR_INTERNAL_ASSERTION` on node 22, measured), which
      // fails the whole spawn over one bad entry in one plugin. Refusing it
      // keeps the rest of the mirror. `syncSkillMdCopy` carries the same guard
      // for the copy it makes, where a FIFO genuinely does block the reader.
      const targetStat = fs.statSync(resolved, { throwIfNoEntry: false });
      if (targetStat === undefined || !(targetStat.isFile() || targetStat.isDirectory())) return false;
      return true;
    },
  });
}

/**
 * Per-group env passthrough, following the install-wide scoped-env convention:
 * `<VAR>_<FOLDER>` (folder upper-cased, `-` → `_`) wins over the bare `<VAR>`.
 * Mirrors container-runner's `resolveScopedEnv`, read off the spawn context's
 * env rather than `process.env` so a caller can supply its own.
 *
 * This is NOT the `.env` selector-var pattern removed above. Provider and model
 * are DB-authoritative (`container_configs`), so an env copy of those would be a
 * second source of truth. The model-capability declarations below have no DB
 * column at all — `.env` is their only channel, and an unset var leaves
 * OpenCode's own behavior untouched.
 */
export function resolveScopedOpenCodeEnv(
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
 * Model capability declarations the container provider reads at startup.
 *
 * `OPENCODE_MODEL_CONTEXT_LIMIT` + `OPENCODE_MODEL_OUTPUT_LIMIT` re-enable
 * auto-compaction for a model OpenCode's registry does not know: an undeclared
 * model resolves its context limit to 0, which silently disables compaction and
 * kills long sessions against a fixed-window backend. opencode requires both
 * halves, so a half-set pair is dropped by the container side.
 *
 * `OPENCODE_MODEL_INPUT_MODALITIES` (comma-separated: image, pdf, audio, video)
 * opens the gate that lets non-text file parts reach an undeclared model at all.
 *
 * All three are inert when unset, which is the default for every group.
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

/**
 * Resolve each host-owned OpenCode surface independently. A scoped auth.json
 * selects the credential, while scoped agent/ and skill/ dirs select only
 * their own definitions; neither decision may suppress the other fallbacks.
 */
function resolveOpenCodeSourcePaths(
  agentGroupFolder: string | undefined,
  agentGroupId: string,
  hostHome: string,
): OpenCodeSourcePaths {
  const scopedFolder = agentGroupFolder || agentGroupId;
  // Defense-in-depth: agent_groups.folder/id is operator-controlled but reaches
  // path.join here; reject anything that looks like traversal before forming
  // the scoped path. assertValidGroupFolder throws on '..', leading '/', or
  // reserved names — matches the validation applied elsewhere on group folders.
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
 * Env that points OpenCode at the staged XDG tree. Both vars name the same
 * mount: OpenCode reads creds from `$XDG_DATA_HOME/opencode/` and agents from
 * `$XDG_CONFIG_HOME/opencode/agent/`, and one tree serves both.
 *
 * Non-OpenCode containers get these too (see `stageOpenCodeAuth`). Nothing else
 * in the image reads them: `gcloud` keys on `CLOUDSDK_CONFIG`
 * (`container/agent-runner/src/gcp-auth-setup.ts:36`), the design-review
 * Chromium sets its own per-run XDG dirs
 * (`container/agent-runner/src/mcp-tools/design-review/render.ts:134`), the
 * `hex` wrapper exports its own `XDG_DATA_HOME` per invocation
 * (`container/hex-wrapper.sh`), `gh` authenticates from `GH_TOKEN` via the
 * entrypoint shim rather than a config file (`container/entrypoint.sh`), and
 * git reads `$HOME/.gitconfig` or `GIT_CONFIG_GLOBAL` (same file).
 *
 * `XDG_CONFIG_HOME` here is in fact DEAD for the runner and every child it
 * spawns: `container/entrypoint.sh:37` exports `XDG_CONFIG_HOME=/tmp/.chromium`
 * (a crashpad workaround) after Docker applies this env, so only
 * `XDG_DATA_HOME` survives. That is the one credential discovery needs —
 * `auth.json` lives under `$XDG_DATA_HOME/opencode/`. Both vars are still
 * declared: a `docker exec` shell skips the entrypoint and sees this pair.
 *
 * `OPENCODE_CONFIG` is what makes the staged default-model config
 * (`stagedOpenCodeConfig`, written beside `auth.json`) reach an agent shell:
 * with `XDG_CONFIG_HOME` clobbered, OpenCode's global-config lookup never
 * finds it (#887 — the #886 fix was verified from a `docker exec` shell, which
 * skips the entrypoint, and was dead for the runner's own children). The env
 * var names the file explicitly and survives the entrypoint, which re-exports
 * only `XDG_*`; OpenCode loads it as its "custom config" (opencode.ai/docs/config,
 * "Precedence order": 3 of 8, still below the inline `OPENCODE_CONFIG_CONTENT`
 * the OpenCode provider's own container runs on).
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
 * The global OpenCode config every container's staged XDG tree carries:
 * `$XDG_CONFIG_HOME/opencode/opencode.json`, holding only the fleet default
 * model. Without it a bare `opencode run` in a shell has no configured model and
 * no last-used one (the tree is fresh per session), so OpenCode falls to "the
 * first model by internal priority" across every provider it finds a credential
 * for — and in a Codex-group container, which also carries `OPENAI_API_KEY`,
 * that landed on an OpenAI model whose OpenCode OAuth entry on the host was
 * stale (#884, 2026-09-17: `Token refresh failed: 401`). The operator's rule:
 * headless OpenCode runs its default model unless asked for another.
 *
 * Safe for the OpenCode provider's own container: its full config travels as
 * `OPENCODE_CONFIG_CONTENT`, which OpenCode loads AFTER the global file and
 * merges over it (opencode.ai/docs/config, "Precedence order": global config
 * is 2 of 8, inline config is 6), and it sends its model per prompt besides.
 */
export const OPENCODE_STAGED_CONFIG_FILE = 'opencode.json';
export function stagedOpenCodeConfig(): string {
  return JSON.stringify({ $schema: 'https://opencode.ai/config.json', model: DEFAULT_OPENCODE_MODEL }, null, 2) + '\n';
}

/**
 * Stage the host OpenCode credential into a session-private XDG tree and return
 * the mount and env that reach it.
 *
 * AUTH plus the one-line default-model config, deliberately nothing more. Every
 * container carries this so any agent can drive `opencode` headless, and a
 * credential and a default model are all that takes — agent definitions,
 * skills and `opencode.db` are the OpenCode PROVIDER's session state and stay
 * with the provider's own contribution, which calls this for its auth step so
 * there is one copy of the staging logic rather than two.
 *
 * The directories were writable by the prior container, so every managed entry
 * is recreated without following a path that container may have replaced with a
 * symlink.
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
    // Subagents (managed by scripts/sync-opencode-subagents.ts): copy every
    // `.md` from the scoped host agent/ dir (or global fallback) into the session XDG. OpenCode
    // reads agents from `$XDG_CONFIG_HOME/opencode/agent/`; we point both
    // XDG_DATA_HOME and XDG_CONFIG_HOME at the same path below, so the agents
    // surface alongside auth.json + opencode.db. Per-session copy (not a host
    // bind mount) so sibling state stays read-only from the container's view
    // — agents on disk are owned by the host sync, not the running session.
    const targetAgentsDir = replaceUntrustedDirectory(opencodeSubdir, 'agent');
    for (const entry of fs.readdirSync(hostAgentsDir)) {
      if (!entry.endsWith('.md')) continue;
      fs.copyFileSync(path.join(hostAgentsDir, entry), path.join(targetAgentsDir, entry));
    }
  }

  removeUntrustedPathEntry(opencodeSubdir, 'skill');
  if (hostSkillsDir) {
    // Skills (managed by syncOpenCodePluginSkills in opencode-sync.ts): copy
    // the scoped skill/ tree (or global fallback) into the session XDG with
    // dereference:true. OpenCode's mirror dirs contain links to plugin source;
    // the container does not mount that source, so it needs real files.
    // A stale mirror link must not wedge the spawn, but this source is
    // host-owned authority. Filter the derived copy; never prune the source.
    const targetSkillsDir = replaceUntrustedDirectory(opencodeSubdir, 'skill');
    // The group's own exclusions, read from the file that is authoritative for
    // them (`groups/<folder>/container.json`, the same file the container reads
    // through its read-only mount). The mirror is shared across siblings; the
    // filter is per group. The walk reads the SAME root the mirror was built
    // from — `os.homedir()`, as `syncOpenCodePluginSkills` does
    // (`src/opencode-sync.ts`) — not `hostHome`: were the two ever to differ,
    // the walk would find nothing, the drop set would be empty, and the
    // exclusion would silently not apply.
    const pluginsRoot = path.join(os.homedir(), 'plugins');
    // ONE walk, shared by both readers below. They answer different questions
    // about the same mirror — which names to withhold, and which repository each
    // name came from — and a population each derived for itself is how the two
    // came to disagree (#836).
    const mirrorSkills = openCodeMirrorSkills(pluginsRoot);
    const dropNames = excludedOpenCodeSkillNames(
      pluginsRoot,
      splitExcludedPlugins(readContainerConfig(path.basename(ctx.groupDir)).excludePlugins),
      mirrorSkills,
    );
    // Containment for the dereferencing copy: the mirror is built from plugin
    // repositories and from nothing else, so a link resolving outside every one
    // of them is an escape, not a shape this feature has. Resolved from the
    // SAME root the mirror was built from, for the same reason the drop set is.
    copyOpenCodeSkills(hostSkillsDir, targetSkillsDir, {
      dropNames,
      allowedRoots: resolvePluginRoots(pluginsRoot),
      sourceRootsByName: mirrorSourceRootsByName(pluginsRoot, mirrorSkills),
    });
  }

  // Model + effort resolution mirrors the claude/codex template: a code-level
  // default (DEFAULT_OPENCODE_*) is the floor, the per-group DB value
  // (container_configs.model / .effort, set by `ncl groups config update` or
  // self-mod) overrides it. NO `.env` scoped vars — those were an opencode-only
  // anomaly (claude uses DEFAULT_OPUS_MODEL etc., never `.env`). Removing them
  // keeps one config pattern across all harnesses. The DB is authoritative; the
  // container reads OPENCODE_MODEL at startup, so an unread value would no-op.
  const dbConfig = await getContainerConfig(ctx.agentGroupId);
  const model = dbConfig?.model ?? DEFAULT_OPENCODE_MODEL;
  const slash = model.indexOf('/');
  const modelProvider = slash > 0 ? model.slice(0, slash) : DEFAULT_OPENCODE_PROVIDER;

  const env: Record<string, string> = {
    // XDG_DATA_HOME + XDG_CONFIG_HOME, both naming the one staged tree: agents
    // come from `$XDG_CONFIG_HOME/opencode/agent/` and creds from
    // `$XDG_DATA_HOME/opencode/` (verified empirically against
    // opencode-ai@1.15.7), so opencode.jsonc / agent/ / auth.json / opencode.db
    // all live in one /opencode-xdg/opencode/ tree and no second mount is
    // needed. Provider copies the per-sibling agent/*.md above.
    ...staged.env,
    // The child runtime adds opencode.ai only when the effective turn model
    // has a matching native auth record. The host cannot decide that from the
    // boot model because `-m` and channel defaults can change it later.
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, '127.0.0.1,localhost'),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, '127.0.0.1,localhost'),
  };
  env.OPENCODE_MODEL = model;

  // OPENCODE_PROVIDER is the opencode-INTERNAL billing/routing provider
  // (opencode=Zen /zen/v1 | opencode-go=Go /zen/go/v1 | nvidia | ...). DERIVE it
  // from the model slug's prefix so the two can never disagree (opencode
  // resolves `model:"<p>/<id>"` against the enabled providers). This is NOT
  // dbConfig.provider — that is the agent-RUNTIME selector (always "opencode"
  // for an opencode sibling; it picks the provider CLASS). Since `model` always
  // carries a prefix (DB value or DEFAULT_OPENCODE_MODEL), the fallback only
  // guards a malformed override.
  env.OPENCODE_PROVIDER = modelProvider;

  env.OPENCODE_EFFORT = dbConfig?.effort ?? DEFAULT_OPENCODE_EFFORT;

  // Model capability declarations — see OPENCODE_MODEL_CAPABILITY_VARS. Only
  // forwarded when actually set, so a group that declares nothing gets exactly
  // the env it got before.
  for (const varName of OPENCODE_MODEL_CAPABILITY_VARS) {
    const value = resolveScopedOpenCodeEnv(ctx.hostEnv, varName, ctx.agentGroupFolder);
    if (value !== undefined && value.trim() !== '') env[varName] = value;
  }
  // Endpoint routing is determined by the cred-key in auth.json + the model
  // slug prefix (opencode-go/* → /zen/go/v1, opencode/* → /zen/v1, nvidia/*
  // → NVIDIA, etc.). We do NOT pass OPENCODE_BASE_URL — OpenCode's provider
  // registry handles the URL automatically. (Removed 2026-05-23 after the
  // earlier "force Go billing via base URL" hack proved unnecessary.)

  return { mounts: staged.mounts, env };
});
