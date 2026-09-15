/**
 * `excludePlugins` — validation, the covering relation, and the one predicate
 * every consumer asks.
 *
 * DUPLICATED VERBATIM at `container/agent-runner/src/plugin-exclusions.ts`.
 * The host reads the field out of `groups/<folder>/container.json`; the
 * container reads the same file through its read-only mount at
 * `/workspace/agent/container.json` and applies it inside its own namespace.
 * Logic must stay identical or the two sides disagree about what an operator's
 * entry means — `src/plugin-exclusions-parity.test.ts` fails on drift.
 *
 * Deliberately IMPORT-FREE. The host half is Node ESM, the container half is a
 * Bun package tree with no shared module resolution; a byte-identical file with
 * no imports is the only form that can be checked for parity mechanically.
 *
 * WHY THE CONTAINER, not the host. #826 tried to honour a sub-plugin entry
 * host-side, by binding an empty directory over the excluded path before the
 * container started. Three review rounds returned the same class of P1: the
 * host was predicting what three independent in-container walkers would
 * resolve, and the two namespaces disagree (a container-absolute symlink is
 * absent to the host's `statSync`, a nested pair emits a mountpoint under a
 * read-only bind, …). The mechanism came out. Each walker now answers the
 * question in the namespace where the paths actually resolve, against a path it
 * built itself — never a `realpath` of host state.
 */

/**
 * One path segment of an `excludePlugins` entry: a real directory name, never
 * empty, `.` or `..`. Shape only, for every entry at every depth.
 *
 * Deliberately NOT a slug allowlist, and deliberately not a character rule.
 * `excludePlugins` had no validation at all before this field grew sub-paths,
 * and the entries it holds are directory basenames the operator did not choose:
 * `scripts/enable-agent-plugin.ts` accepts any direct child of `~/plugins`
 * (`resolvePluginDir` checks only that the path is a directory whose parent is
 * the plugins root) and writes that basename straight into this list
 * (`applyOptOut`). A clone named `foo+bar` or `c++-tools` is an ordinary
 * directory, so an allowlist of `[A-Za-z0-9._-]` would refuse a config that
 * worked before and take the whole group's spawn down with it —
 * `readContainerConfig` throws on every read — which is a fail-closed guard
 * refusing a legitimate state rather than a bad input.
 *
 * Earlier revisions of #826 also refused a backslash, a control character and a
 * colon in a sub-path entry, because a sub-path was interpolated into a mask
 * mount's container path and thence into `-v <host>:<container>:ro`. That mask
 * mechanism is gone, and this PR does not bring it back: a sub-path entry is
 * still never interpolated into a mount argument. It is compared as a string
 * against a path each walker assembled from `readdirSync` names
 * (`isExcludedPluginPath`), and joined onto a host path whose result is then
 * `realpath`-contained (`src/claude-md-compose.ts`). Backslash, newline and DEL
 * are all legal bytes in a Linux directory name, so refusing them would be the
 * same accepted-set regression in a narrower place.
 *
 * What remains is what traversal actually needs: no empty segment, no `.` or
 * `..`, no absolute path, and the depth bound below. `/` cannot appear in a
 * segment at all — segments are the result of splitting on it.
 * `src/plugin-scopes.ts:44`'s narrower `PLUGIN_NAME_RE` governs an
 * operator-authored policy file and is left alone.
 */
const PLUGIN_PATH_SEGMENT_RE = /^(?!\.\.?$).+$/su;

/**
 * Deepest `excludePlugins` entry we accept, in path segments. Bounded by what
 * the three sub-plugin walkers actually descend to, so an entry can never name
 * a directory no walker would have looked at:
 *   - Claude: `<repo>/<sub>` and `<repo>/<sub>/<sub2>`
 *     (`discoverPlugins`, `container/agent-runner/src/providers/claude.ts`)
 *   - Codex: `<repo>/plugins/<sub>` and `<repo>/<sub>`
 *     (`findCodexSubPlugins`, `container/agent-runner/src/codex-companion-setup.ts`)
 *   - Skill mirror: `<repo>/plugins/<sub>/skills` and `<repo>/<sub>/skills`
 *     (`discoverInPlugin`, `container/agent-runner/src/plugin-skill-discovery.ts`)
 * Three is the maximum any of them reaches.
 */
const MAX_EXCLUDE_PLUGIN_DEPTH = 3;

/**
 * A validated `excludePlugins` list, split into the two shapes its consumers
 * need and with the covering relation already resolved. Produced only by
 * `splitExcludedPlugins`; asked only through `isExcludedPluginPath`.
 */
export interface ExcludedPlugins {
  /** Whole `~/plugins` entries: the repo is withheld entirely. */
  topLevel: Set<string>;
  /** Sub-plugin paths inside a repo that IS still delivered. */
  subPaths: Set<string>;
}

/**
 * Validate `excludePlugins`. Entries are either a top-level `~/plugins` folder
 * name (`bootstrap`) or a sub-plugin path relative to the plugins root
 * (`bootstrap/plugins/orchestrate`, `knowledge-work-plugins/data`).
 *
 * Fails closed and loudly: an entry that does not parse throws, naming the
 * entry, rather than being dropped. A silently-ignored exclusion is a
 * fail-open — the operator believes a plugin is withheld from a group while
 * the mount, the Claude SDK plugin list, the Codex registration and the
 * always-on ruleset all still deliver it.
 */
export function validateExcludePlugins(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('excludePlugins must be an array of plugin names or sub-plugin paths');
  for (const entry of value) {
    const fail = (why: string): never => {
      throw new Error(`excludePlugins entry ${JSON.stringify(entry)} ${why}`);
    };
    if (typeof entry !== 'string' || entry === '') fail('must be a non-empty string');
    const name = entry as string;
    if (name.startsWith('/')) fail('must be relative to ~/plugins, not an absolute path');
    const segments = name.split('/');
    if (segments.length > MAX_EXCLUDE_PLUGIN_DEPTH) {
      fail(`is deeper than ${MAX_EXCLUDE_PLUGIN_DEPTH} path segments, which no sub-plugin walker descends to`);
    }
    for (const segment of segments) {
      if (!PLUGIN_PATH_SEGMENT_RE.test(segment)) {
        fail('must be <plugin> or <plugin>/<sub>[/<sub2>] with no empty, "." or ".." segments');
      }
    }
  }
  return value as string[];
}

/**
 * Split a validated `excludePlugins` list into the two shapes its consumers
 * need: whole `~/plugins` entries to drop, and sub-plugin paths to withhold
 * inside a repo that IS still delivered. Shared by the mount builder
 * (`src/container-runner.ts`), the always-on composer
 * (`src/claude-md-compose.ts`) and all three container walkers, so none of them
 * can disagree about what an entry means.
 *
 * `subPaths` holds only the entries no broader exclusion already covers. A
 * sub-path under an excluded ancestor says nothing the ancestor has not already
 * said, so the covering relation is resolved once, here, rather than at each
 * consumer. Both ancestor shapes drop: a top-level entry (`bootstrap`, whose
 * repo is withheld whole) and a shallower sub-path (`bootstrap/plugins` over
 * `bootstrap/plugins/orchestrate`).
 */
export function splitExcludedPlugins(entries: readonly string[] | undefined): ExcludedPlugins {
  const topLevel = new Set<string>();
  const allSubPaths = new Set<string>();
  for (const entry of entries ?? []) {
    if (entry.includes('/')) allSubPaths.add(entry);
    else topLevel.add(entry);
  }
  const subPaths = new Set<string>();
  for (const subPath of allSubPaths) {
    const segments = subPath.split('/');
    // Strict ancestors only: the repo name (a top-level entry), then every
    // shallower sub-path. `i < segments.length` stops before the entry itself.
    let covered = topLevel.has(segments[0]);
    for (let i = 2; !covered && i < segments.length; i++) {
      covered = allSubPaths.has(segments.slice(0, i).join('/'));
    }
    if (!covered) subPaths.add(subPath);
  }
  return { topLevel, subPaths };
}

/**
 * THE predicate. True when `relPath` — a plugin repo name, or a sub-plugin path
 * relative to the plugins root, as the caller's own walk built it — is excluded
 * outright or lies under an excluded ancestor.
 *
 * `relPath` MUST be assembled from the walk's own directory names
 * (`<repo>`, `<repo>/<sub>`, `<repo>/plugins/<sub>`), separated by `/`, in the
 * namespace doing the walking. Never pass a `realpath`, an absolute path, or a
 * path resolved in a different mount namespace: the covering relation is string
 * containment on segments, and resolving the string first is exactly the
 * host-side prediction #826 removed.
 *
 * Ancestor coverage runs from the repo root down to and including `relPath`
 * itself, so excluding `bootstrap/plugins` withholds `bootstrap/plugins/x` and
 * `bootstrap/plugins/x/y` too. `splitExcludedPlugins` has already dropped the
 * redundant descendants, so this loop only ever matches a live entry.
 */
export function isExcludedPluginPath(relPath: string, excluded: ExcludedPlugins): boolean {
  const segments = relPath.split('/');
  if (excluded.topLevel.has(segments[0])) return true;
  // `i <= segments.length` includes the entry itself: an exact sub-path match.
  for (let i = 2; i <= segments.length; i++) {
    if (excluded.subPaths.has(segments.slice(0, i).join('/'))) return true;
  }
  return false;
}
