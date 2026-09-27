/**
 * Workgroup-scoped plugins: ~/plugins is fleet-wide by default, so a plugin carrying one tenant's content would
 * reach every new group unless excluded. A plugin named in data/plugin-scopes.json
 * (`{ "version": 1, "plugins": { "<dir name>": ["<workgroup id>", ...] } }`) is delivered only to groups in those
 * workgroups; `excludePlugins` still applies. No file scopes nothing; an unparseable file throws so the spawn
 * aborts; an empty list scopes a plugin to no workgroup. Enforced on every path plugin content takes into a
 * container: the plugin mount, the composed ruleset, the subagent and OpenCode skill mirrors (which never copy a
 * scoped plugin), and the capabilities snapshot.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

export const PLUGIN_SCOPES_POLICY_PATH = path.join(DATA_DIR, 'plugin-scopes.json');

// Same slug rule as WORKGROUP_ID_RE in src/workgroup-read-access.ts.
const WORKGROUP_ID_RE = /^[a-z][a-z0-9-]*$/;
// One ~/plugins directory name: no path separators, and not "." or "..".
const PLUGIN_NAME_RE = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;

export type PluginScopes = ReadonlyMap<string, ReadonlySet<string>>;

function fail(message: string): never {
  throw new Error(`Invalid plugin scope policy at ${PLUGIN_SCOPES_POLICY_PATH}: ${message}`);
}

export function parsePluginScopes(contents: string): PluginScopes {
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Invalid plugin scope policy at ${PLUGIN_SCOPES_POLICY_PATH}: JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('top level must be an object');
  const policy = raw as Record<string, unknown>;
  if (Object.keys(policy).some((key) => key !== 'version' && key !== 'plugins')) {
    fail('only version and plugins are allowed at the top level');
  }
  if (policy.version !== 1) fail('version must be 1');
  if (policy.plugins === null || typeof policy.plugins !== 'object' || Array.isArray(policy.plugins)) {
    fail('plugins must be an object keyed by plugin directory name');
  }
  const scopes = new Map<string, ReadonlySet<string>>();
  for (const [plugin, workgroups] of Object.entries(policy.plugins as Record<string, unknown>)) {
    if (!PLUGIN_NAME_RE.test(plugin)) fail(`${JSON.stringify(plugin)} is not a plugin directory name`);
    if (!Array.isArray(workgroups)) fail(`plugin ${JSON.stringify(plugin)} must map to an array of workgroup IDs`);
    const allowed = new Set<string>();
    for (const workgroup of workgroups) {
      if (typeof workgroup !== 'string' || !WORKGROUP_ID_RE.test(workgroup)) {
        fail(`plugin ${JSON.stringify(plugin)} lists ${JSON.stringify(workgroup)}, which is not a workgroup slug`);
      }
      allowed.add(workgroup);
    }
    scopes.set(plugin, allowed);
  }
  return scopes;
}

/** Reads the policy on every call, so an edit applies at the next spawn. */
export function loadPluginScopes(): PluginScopes {
  let contents: string;
  try {
    contents = fs.readFileSync(PLUGIN_SCOPES_POLICY_PATH, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw new Error(
      `Could not read plugin scope policy at ${PLUGIN_SCOPES_POLICY_PATH}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return parsePluginScopes(contents);
}

/** Whether an agent group in `workgroupId` may receive `plugin`. Unscoped plugins always may. */
export function pluginAllowedForWorkgroup(
  plugin: string,
  workgroupId: string | null | undefined,
  scopes: PluginScopes,
): boolean {
  const allowed = scopes.get(plugin);
  if (!allowed) return true;
  return typeof workgroupId === 'string' && allowed.has(workgroupId);
}

export function scopedPluginNames(scopes: PluginScopes): ReadonlySet<string> {
  return new Set(scopes.keys());
}

const warnedUnmatched = new Set<string>();

/** Warn once per name about scoped plugins matching no directory: a typo leaves the real plugin fleet-wide. */
export function warnUnmatchedPluginScopes(scopes: PluginScopes, pluginDirs: readonly string[]): void {
  for (const plugin of scopes.keys()) {
    if (pluginDirs.includes(plugin) || warnedUnmatched.has(plugin)) continue;
    warnedUnmatched.add(plugin);
    log.warn('Plugin scope names no ~/plugins directory; it enforces nothing until the names match', {
      plugin,
      policy: PLUGIN_SCOPES_POLICY_PATH,
    });
  }
}
