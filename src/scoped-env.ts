/**
 * Scoped tool + credential env helpers (ported from v1).
 *
 * Container-runner reads a per-agent-group `tools` array from container.json.
 * Each entry is either bare (`snowflake`) or scoped (`snowflake:sunday`).
 * Scoping gates which credentials the agent's mounts expose — e.g.
 * `snowflake:sunday` stages a filtered `connections.toml` containing only
 * the `[connections.sunday]` section and its referenced private keys.
 *
 * Fallback modes for `scopedEnvKey`:
 *   - 'bare':  unscoped → `${PREFIX}`,           scoped → `${PREFIX}_${SCOPE}`
 *   - 'group': unscoped → `${PREFIX}_${GROUP}`,  scoped → `${PREFIX}_${SCOPE}`
 *
 * GitHub uses 'bare' (no group-folder suffix when unscoped). Render / browser
 * auth use either pattern depending on whether the unscoped form should fall
 * back to a group-folder-keyed secret. Gcloud's multi-scope mapping and
 * Slack's user-defined-suffix pattern don't fit either shape and stay
 * open-coded at their call sites.
 */
import { log } from './log.js';

/**
 * Safe scope pattern: alphanumeric + dashes + underscores only. Rejects
 * anything that could traverse out of the expected credential dir (path
 * separators, parent refs, shell metachars). Enforced inside
 * `extractToolScopes` — unsafe values are dropped with a warning.
 */
export const SAFE_SCOPE_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Check whether a tool is enabled for a group, by bare name or by any scope.
 * Returns true when `tools` is undefined (no filter configured → all on)
 * so existing installs without a `tools` field keep working unchanged.
 */
export function isToolEnabled(tools: string[] | undefined, name: string): boolean {
  if (!tools) return true;
  return tools.some((t) => t === name || t.startsWith(name + ':'));
}

/**
 * Pull scope values for a tool out of a `tools` array. A tools entry like
 * `gmail:illysium` contributes the scope `illysium`. Scopes failing
 * SAFE_SCOPE_RE are dropped (logged). `isScoped` is true when the caller
 * listed ONLY scoped forms (no bare entry) — i.e. the agent does not have
 * access to every scope.
 */
export function extractToolScopes(
  tools: string[] | undefined,
  toolName: string,
): { scopes: string[]; isScoped: boolean } {
  const scopes =
    tools
      ?.filter((t) => t.startsWith(`${toolName}:`))
      .map((t) => t.split(':')[1])
      .filter((scope) => {
        if (!SAFE_SCOPE_RE.test(scope)) {
          log.warn('Rejecting unsafe tool scope value', { scope, toolName });
          return false;
        }
        return true;
      }) ?? [];
  return {
    scopes,
    isScoped: scopes.length > 0 && !tools?.includes(toolName),
  };
}

export type ScopeFallback = 'bare' | 'group';

export function scopedEnvKey(
  prefix: string,
  opts: {
    scopes: string[];
    isScoped: boolean;
    fallback: ScopeFallback;
    groupScope?: string;
  },
): string {
  if (opts.isScoped) {
    return `${prefix}_${opts.scopes[0].toUpperCase()}`;
  }
  if (opts.fallback === 'bare') {
    return prefix;
  }
  if (!opts.groupScope) {
    throw new Error(`scopedEnvKey: groupScope required when fallback='group' (prefix=${prefix})`);
  }
  return `${prefix}_${opts.groupScope.toUpperCase()}`;
}

export function normalizeScopedSecret(secrets: Record<string, string>, scopedKey: string, genericKey: string): void {
  if (scopedKey !== genericKey && secrets[scopedKey]) {
    secrets[genericKey] = secrets[scopedKey];
    delete secrets[scopedKey];
  }
}

/**
 * Filter INI/TOML-style config sections. Splits on section headers (`[name]`)
 * and keeps only allowed ones. Used for AWS `~/.aws/{credentials,config}` and
 * Snowflake `connections.toml`.
 *
 * `headerTransform` lets AWS config strip the `profile ` prefix from
 * `[profile foo]` so `foo` can be matched against the allowlist.
 * `alwaysInclude` keeps structural sections like `[default]` that the CLI
 * needs even when the agent is scoped to specific profiles.
 */
export function filterConfigSections(
  content: string,
  allowed: string[],
  opts?: {
    headerTransform?: (header: string) => string;
    alwaysInclude?: Set<string>;
  },
): string {
  const sections = content.split(/^(?=\[)/m);
  return sections
    .filter((section) => {
      const match = section.match(/^\[([^\]]+)\]/);
      if (!match) return !section.trim(); // keep blank preamble only
      const header = match[1].trim();
      if (opts?.alwaysInclude?.has(header)) return true;
      const name = opts?.headerTransform?.(header) ?? header;
      return allowed.includes(name);
    })
    .join('');
}
