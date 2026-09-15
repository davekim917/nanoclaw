/**
 * The container's own read of `excludePlugins`.
 *
 * `groups/<folder>/container.json` is bind-mounted read-only at
 * `/workspace/agent/container.json` (`src/container-runner.ts`, the
 * `containerJsonPath` mount). The host writes the field; every walker in here
 * honours it in its own mount namespace, against paths it assembled itself —
 * see `plugin-exclusions.ts` for why the host cannot do this for us.
 *
 * Deliberately NOT read through `config.ts`. `loadConfig` swallows a read or
 * parse failure and continues on defaults (`config.ts`, the catch around
 * `readFileSync`), which is right for a model name and wrong for an exclusion:
 * "I could not read the file" would become "nothing is excluded", and every
 * walker would then register the plugin the operator withheld. A read that
 * cannot answer throws, and no caller here catches it — the spawn fails loudly
 * instead of silently delivering what was excluded.
 *
 * Reachability of that throw: the host validates the same field with the same
 * code before it ever spawns (`readContainerConfig` → `validateExcludePlugins`,
 * `src/container-config.ts`), and the mount is created by the spawn path, so a
 * throw here means the file changed under the mount or the mount is gone.
 */
import fs from 'fs';

import { splitExcludedPlugins, validateExcludePlugins, type ExcludedPlugins } from './plugin-exclusions.js';

export const CONTAINER_CONFIG_PATH = '/workspace/agent/container.json';

function log(msg: string): void {
  console.error(`[excluded-plugins] ${msg}`);
}

let cached: ExcludedPlugins | null = null;

/**
 * Parse `excludePlugins` out of an already-read container.json body. Exported
 * for tests and for `loadExcludedPlugins`; applies the SAME validator the host
 * applied before the spawn, so an entry the host accepted cannot be read
 * differently here.
 */
export function parseExcludedPlugins(raw: string): ExcludedPlugins {
  const parsed = JSON.parse(raw) as { excludePlugins?: unknown };
  return splitExcludedPlugins(validateExcludePlugins(parsed.excludePlugins));
}

/**
 * Read and memoize the group's exclusions.
 *
 * ENOENT — and only ENOENT — is "no exclusions": a container.json that is not
 * there cannot have declared any, and dev/test containers run without one.
 * Every other failure (unreadable mount, malformed JSON, an entry that does not
 * validate) throws, because each of those is a file that MIGHT have carried an
 * exclusion we would be dropping.
 */
export function loadExcludedPlugins(configPath = CONTAINER_CONFIG_PATH): ExcludedPlugins {
  if (cached && configPath === CONTAINER_CONFIG_PATH) return cached;
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      const empty = splitExcludedPlugins(undefined);
      if (configPath === CONTAINER_CONFIG_PATH) cached = empty;
      return empty;
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `could not read ${configPath} to apply excludePlugins — refusing to treat that as "nothing excluded": ${detail}`,
    );
  }
  const split = parseExcludedPlugins(raw);
  if (split.topLevel.size || split.subPaths.size) {
    // Logged once per container, at the only place the list is read.
    //
    // This is the ONLY observability an exclusion gets, and it deliberately
    // reports what was DECLARED, not what was found: an entry naming a
    // sub-plugin this checkout does not carry (never cloned, renamed, typo) is
    // a no-op, and the walkers below simply never meet that path. Refusing the
    // spawn over it would take the whole group down for a line with no effect —
    // the #826 shape — and "warn that it matched nothing" would mean asking
    // three walkers to report back so one of them could decide the operator was
    // wrong. The declared list plus each walker's own output is enough to tell
    // an applied entry from an inert one.
    log(
      `excludePlugins: ${[...split.topLevel, ...split.subPaths].sort().join(', ')} ` +
        `(read from ${configPath}; applied by every plugin walker in this container)`,
    );
  }
  if (configPath === CONTAINER_CONFIG_PATH) cached = split;
  return split;
}

/** Reset the memo — tests only. */
export function _resetExcludedPlugins(): void {
  cached = null;
}
