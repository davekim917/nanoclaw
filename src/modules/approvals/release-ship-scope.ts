/**
 * Canonical scope for the one choice-card meaning owned by the host: a human
 * release authorization.  The runner has an equivalent transport validator,
 * but every authority decision and receipt write re-validates through here.
 */
export interface ReleaseShipScope {
  purpose: 'release_ship';
  repository: string;
  pullRequest: number;
  base: string;
  headSha: string;
}

const REPOSITORY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
// Intentionally reject ASCII controls, including those not covered by whitespace.
// eslint-disable-next-line no-control-regex
const BASE_RE = /^[^\s\x00-\x1F\x7F]{1,255}$/;
const HEAD_RE = /^[a-f0-9]{40}$/;
const KEYS = ['purpose', 'repository', 'pullRequest', 'base', 'headSha'] as const;

/** Return a host-canonical scope or a deliberately non-specific validation error. */
export function parseReleaseShipScope(value: unknown): ReleaseShipScope | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== KEYS.length || keys.some((key) => !KEYS.includes(key as (typeof KEYS)[number]))) return undefined;
  if (record.purpose !== 'release_ship') return undefined;
  if (typeof record.repository !== 'string' || !REPOSITORY_RE.test(record.repository)) return undefined;
  if (typeof record.pullRequest !== 'number' || !Number.isSafeInteger(record.pullRequest) || record.pullRequest <= 0) {
    return undefined;
  }
  if (typeof record.base !== 'string' || !BASE_RE.test(record.base)) return undefined;
  if (typeof record.headSha !== 'string' || !HEAD_RE.test(record.headSha)) return undefined;
  return {
    purpose: 'release_ship',
    repository: record.repository,
    pullRequest: record.pullRequest,
    base: record.base,
    headSha: record.headSha,
  };
}

/** Stable key order makes the durable field deterministic and cross-language friendly. */
export function releaseShipScopeJson(scope: ReleaseShipScope): string {
  return JSON.stringify({
    purpose: scope.purpose,
    repository: scope.repository,
    pullRequest: scope.pullRequest,
    base: scope.base,
    headSha: scope.headSha,
  });
}
