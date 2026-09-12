/**
 * Workgroup-scoped plugins: opt-in delivery for a ~/plugins entry that carries
 * one tenant's content.
 *
 * ~/plugins is fleet-wide by default. Every group mounts every entry unless its
 * container.json `excludePlugins` names it (the plugin loop in buildMounts,
 * src/container-runner.ts), so a group created tomorrow would receive a
 * client's plugin unless someone remembered to exclude it. A plugin named in
 * this host-owned policy is delivered only to agent groups in the workgroups
 * it lists. Plugins it does not name keep the fleet-wide default, and
 * `excludePlugins` still applies on top of both.
 *
 * Policy file: data/plugin-scopes.json
 *   { "version": 1, "plugins": { "<plugin directory name>": ["<workgroup id>", ...] } }
 *
 * No file means no scoped plugins. A file that exists but does not parse
 * throws, the rule data/workgroup-read-access.json follows
 * (src/workgroup-read-access.ts): the spawn aborts instead of guessing which
 * plugins were meant to be scoped. An empty list scopes a plugin to no
 * workgroup at all.
 *
 * Enforced on every path plugin content takes into a container:
 * - the plugin mount (Claude and Codex, which registers plugins from that mount);
 * - the always-on ruleset composed for Codex and OpenCode (src/claude-md-compose.ts);
 * - the Codex and OpenCode subagent mirrors (src/claude-subagent-discovery.ts) and
 *   the OpenCode skill mirror (src/opencode-sync.ts), which never copy a scoped
 *   plugin's agents or skills because none of their targets is keyed by workgroup;
 * - the capabilities snapshot, which names a scoped plugin only inside its
 *   workgroups (src/capabilities.ts).
 * A scoped name that matches no ~/plugins directory enforces nothing, so the
 * mount loop warns about it once per process.
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

/** Plugin directory name → the workgroups it may be delivered to. */
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

/**
 * Warn, once per process per name, about each scoped plugin that matches no
 * directory in `pluginDirs`. Such a scope enforces nothing: a typo or a clone
 * under a different directory name leaves the real plugin fleet-wide.
 */
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
