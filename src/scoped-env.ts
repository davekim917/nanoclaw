/**
 * Helpers for parsing scoped tool entries (e.g. `gmail:illysium`) and
 * resolving the corresponding credential env-var names from .env.
 *
 * `extractToolScopes` lives here — not in container-runner.ts — so that
 * smaller modules like daily-notifications.ts can use it without pulling
 * in the whole container spawn path.
 *
 * `scopedEnvKey` supports two fallback modes:
 *   - 'bare':  unscoped → `${PREFIX}`,                  scoped → `${PREFIX}_${SCOPE}`
 *   - 'group': unscoped → `${PREFIX}_${GROUP}`,         scoped → `${PREFIX}_${SCOPE}`
 *
 * GitHub uses 'bare' (legacy: no group suffix when unscoped). Render and
 * browser-auth use either pattern depending on whether the unscoped form
 * should fall back to a group-folder suffix or stay bare.
 *
 * gcloud's multi-scope mapping (one env key per scope) and slack's
 * user-defined-suffix pattern do NOT fit either shape — those callers
 * stay open-coded.
 */
import { logger } from './logger.js';

// Safe scope pattern: alphanumeric, hyphens, underscores only. Rejects path
// traversal attempts like '../../.ssh' or absolute paths. Enforced inside
// extractToolScopes — unsafe scopes are dropped with a logged warning.
export const SAFE_SCOPE_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Extract scoped access entries from a tools array (e.g. `gmail:illysium` →
 * `['illysium']`). Returns the matched scopes and whether the tool is
 * scope-restricted (true when no bare `gmail` entry coexists alongside the
 * scoped ones). Unsafe scope values are dropped with a logged warning.
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
          logger.warn({ scope, toolName }, 'Rejecting unsafe tool scope value');
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

/**
 * Build a scoped credential env-var name.
 *
 * - When `isScoped` is true: returns `${prefix}_${scopes[0].toUpperCase()}`.
 * - When `isScoped` is false and `fallback === 'bare'`: returns `prefix`.
 * - When `isScoped` is false and `fallback === 'group'`: returns
 *   `${prefix}_${groupScope.toUpperCase()}` (and `groupScope` is required).
 */
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
    throw new Error(
      `scopedEnvKey: groupScope required when fallback='group' (prefix=${prefix})`,
    );
  }
  return `${prefix}_${opts.groupScope.toUpperCase()}`;
}

/**
 * Move a scoped secret value to its canonical generic key, deleting the
 * scoped entry. No-op when the scoped key equals the generic key (already
 * canonical) or when the scoped key is missing/empty.
 */
export function normalizeScopedSecret(
  secrets: Record<string, string>,
  scopedKey: string,
  genericKey: string,
): void {
  if (scopedKey !== genericKey && secrets[scopedKey]) {
    secrets[genericKey] = secrets[scopedKey];
    delete secrets[scopedKey];
  }
}
