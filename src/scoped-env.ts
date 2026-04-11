/**
 * Helpers for resolving scoped credential env-var names from .env, used by
 * readSecrets in container-runner.ts and resolveGithubTokenKey-like callers
 * in daily-notifications.ts.
 *
 * Two patterns are supported:
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
