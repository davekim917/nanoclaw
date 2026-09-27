/**
 * `excludePlugins` validation, the covering relation, and the one predicate every consumer asks.
 *
 * DUPLICATED VERBATIM at `container/agent-runner/src/plugin-exclusions.ts` (the host reads
 * groups/<folder>/container.json, the container its read-only mount): logic must stay identical, and
 * `src/plugin-exclusions-parity.test.ts` fails on drift. Deliberately IMPORT-FREE so one byte-identical file
 * works in both package trees.
 *
 * Applied in the container, not the host: each walker answers in the namespace where its paths resolve, which
 * the host cannot predict (symlinks and mounts differ between namespaces).
 */

/**
 * One path segment: never empty, `.` or `..`. Deliberately NOT a character allowlist: entries are directory
 * basenames the operator did not choose (`c++-tools`), and refusing a legal name takes the group's spawn down.
 * Refused only: NUL and unpaired UTF-16 surrogates, which no filename can hold. Such an entry would pass the
 * shape checks, never match, and silently deliver an excluded plugin (and the credential mount riding on it).
 * `src/plugin-scopes.ts` keeps its narrower PLUGIN_NAME_RE on purpose (operator-authored policy): don't unify them.
 */
// `\p{Surrogate}` under the `u` flag matches a LONE surrogate only, so valid astral names pass.
const PLUGIN_PATH_SEGMENT_RE = /^(?!\.\.?$)[^\0\p{Surrogate}]+$/su;

/** Linux NAME_MAX, in BYTES (an astral character costs four). Hardcoded so the answer never depends on which filesystem is read. */
const NAME_MAX_BYTES = 255;

/**
 * Deepest accepted entry, in segments: the deepest any of the three sub-plugin walkers descends (claude.ts
 * `discoverPlugins`, codex-companion-setup.ts `findCodexSubPlugins`, plugin-skill-discovery.ts `discoverInPlugin`).
 */
const MAX_EXCLUDE_PLUGIN_DEPTH = 3;

/** Produced only by `splitExcludedPlugins`; asked only through `isExcludedPluginPath`. */
export interface ExcludedPlugins {
  /** Whole `~/plugins` entries: the repo is withheld entirely. */
  topLevel: Set<string>;
  /** Sub-plugin paths inside a repo that IS still delivered. */
  subPaths: Set<string>;
}

/**
 * Entries are a top-level `~/plugins` folder or a sub-plugin path. Fails closed and loudly: a silently dropped
 * exclusion is a fail-open (the operator believes a plugin is withheld while it is delivered).
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
        fail(
          'must be <plugin> or <plugin>/<sub>[/<sub2>] with no empty, "." or ".." segments and nothing a filename cannot hold',
        );
      }
      const bytes = Buffer.byteLength(segment, 'utf8');
      if (bytes > NAME_MAX_BYTES) {
        fail(`has a ${bytes}-byte path segment; no filename may exceed ${NAME_MAX_BYTES} bytes (NAME_MAX)`);
      }
    }
  }
  return value as string[];
}

/**
 * Shared by the mount builder, the always-on composer and all three container walkers, so none can disagree.
 * `subPaths` holds only entries no broader exclusion already covers.
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
 * THE predicate. `relPath` MUST be built from the walk's own directory names, `/`-separated, in the namespace
 * doing the walking: never a realpath, an absolute path, or a path from another mount namespace.
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
