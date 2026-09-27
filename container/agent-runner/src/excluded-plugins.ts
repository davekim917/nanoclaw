/**
 * The container's own read of `excludePlugins`, deliberately NOT via `config.ts`: `loadConfig` falls back to
 * defaults on a read failure, which here would mean "nothing excluded" and deliver withheld plugins. A read
 * that cannot answer throws, and nothing catches it.
 */
import fs from 'fs';

import { splitExcludedPlugins, validateExcludePlugins, type ExcludedPlugins } from './plugin-exclusions.js';

const CONTAINER_CONFIG_PATH = '/workspace/agent/container.json';

function log(msg: string): void {
  console.error(`[excluded-plugins] ${msg}`);
}

let cached: ExcludedPlugins | null = null;

/**
 * Applies the host's own validator. A non-object root (array, number, null) throws instead of reading as
 * "nothing declared": `[{"excludePlugins": [...]}]` would otherwise fail open.
 */
export function parseExcludedPlugins(raw: string): ExcludedPlugins {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const shape = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
    throw new Error(
      `container.json did not parse to a JSON object (got ${shape}) — refusing to read that as "nothing excluded"`,
    );
  }
  return splitExcludedPlugins(validateExcludePlugins((parsed as { excludePlugins?: unknown }).excludePlugins));
}

/** ENOENT, and only ENOENT, means no exclusions; every other failure throws, since it might have carried one. */
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
    // Reports what was declared: when ~/plugins exists the host already refused a spawn whose entry matched
    // nothing; without it nothing is mounted, so there is nothing to withhold.
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
