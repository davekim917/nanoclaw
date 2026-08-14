export interface LegacyRepositoryIdentityGroup {
  key: string;
  workgroupId: string;
  repo: string;
  physicalCount: number;
  objectStoreCount: number;
  observedOrigins: Array<string | null>;
}

export interface ReviewedLegacyRepositoryAlias {
  workgroupId: string;
  sourceRepo: string;
  destinationRepo: string;
}

export function repositoryOriginContainsCredentials(origin: string | null): boolean {
  if (!origin) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '';
}

/**
 * Derive the only network origin shape migration may serialize or configure.
 * Legacy credentials are deliberately discarded here; callers that need to
 * classify their presence must use repositoryOriginContainsCredentials first.
 */
export function normalizedCredentialFreeGithubOrigin(origin: string | null): string | null {
  if (!origin) return null;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') return null;
  const pathname = parsed.pathname.replace(/\.git\/?$/i, '').replace(/^\/+|\/+$/g, '');
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  return `https://github.com/${parts[0]}/${parts[1]}`;
}

export function normalizedGithubRepositoryIdentity(origin: string | null): string | null {
  const normalizedOrigin = normalizedCredentialFreeGithubOrigin(origin);
  if (!normalizedOrigin) return null;
  const parsed = new URL(normalizedOrigin);
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
  return `github.com/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
}

/**
 * Legacy local directory names are not repository identities. Coalesce every
 * bucket that resolves to the same GitHub repository, then attach an
 * origin-unreadable case-only alias only when exactly one anchored identity in
 * that workgroup has the same repository basename.
 */
export function planLegacyRepositoryCoalescing(
  groups: LegacyRepositoryIdentityGroup[],
  reviewedAliases: ReviewedLegacyRepositoryAlias[] = [],
): Map<string, string> {
  const result = new Map(groups.map((group) => [group.key, group.key]));
  const knownKeys = new Set(groups.map((group) => group.key));
  const explicit = new Map<string, string>();
  const pinnedDestinations = new Set<string>();
  for (const alias of reviewedAliases) {
    const sourceKey = `${alias.workgroupId}\0${alias.sourceRepo}`;
    const destinationKey = `${alias.workgroupId}\0${alias.destinationRepo}`;
    if (!knownKeys.has(sourceKey)) {
      throw new Error(`reviewed repository alias source is absent: ${sourceKey.replace('\0', '/')}`);
    }
    if (!knownKeys.has(destinationKey)) {
      throw new Error(`reviewed repository alias destination is absent: ${destinationKey.replace('\0', '/')}`);
    }
    if (explicit.has(sourceKey)) {
      throw new Error(`duplicate reviewed repository alias: ${sourceKey.replace('\0', '/')}`);
    }
    explicit.set(sourceKey, destinationKey);
    pinnedDestinations.add(destinationKey);
  }
  const resolveExplicit = (key: string): string => {
    const seen = new Set<string>();
    let current = key;
    while (explicit.has(current)) {
      if (seen.has(current)) throw new Error(`reviewed repository alias cycle includes ${current.replace('\0', '/')}`);
      seen.add(current);
      current = explicit.get(current)!;
    }
    return current;
  };
  for (const sourceKey of explicit.keys()) resolveExplicit(sourceKey);

  const identityBuckets = new Map<string, LegacyRepositoryIdentityGroup[]>();
  const identityForKey = new Map<string, string>();
  for (const group of groups) {
    const identities = new Set(
      group.observedOrigins.map(normalizedGithubRepositoryIdentity).filter((entry): entry is string => entry !== null),
    );
    if (identities.size !== 1) continue;
    const identity = [...identities][0];
    identityForKey.set(group.key, identity);
    const key = `${group.workgroupId}\0${identity}`;
    const bucket = identityBuckets.get(key) ?? [];
    bucket.push(group);
    identityBuckets.set(key, bucket);
  }

  const canonicalByIdentity = new Map<string, LegacyRepositoryIdentityGroup>();
  for (const [identityKey, bucket] of identityBuckets) {
    const pinned = bucket.filter((entry) => pinnedDestinations.has(entry.key));
    if (pinned.length > 1) {
      throw new Error(`multiple reviewed repository aliases pin one identity: ${identityKey.replace('\0', '/')}`);
    }
    bucket.sort(
      (a, b) =>
        b.physicalCount + b.objectStoreCount - (a.physicalCount + a.objectStoreCount) || a.key.localeCompare(b.key),
    );
    const canonical = pinned[0] ?? bucket[0];
    canonicalByIdentity.set(identityKey, canonical);
    for (const group of bucket) result.set(group.key, canonical.key);
  }

  for (const pinnedKey of pinnedDestinations) {
    if (identityForKey.has(pinnedKey)) continue;
    const pinned = groups.find((group) => group.key === pinnedKey)!;
    const aliases = [...canonicalByIdentity.entries()].filter(([identityKey]) => {
      const separator = identityKey.indexOf('\0');
      const workgroupId = identityKey.slice(0, separator);
      const identity = identityKey.slice(separator + 1);
      return workgroupId === pinned.workgroupId && identity.split('/').at(-1) === pinned.repo.toLowerCase();
    });
    if (aliases.length !== 1) continue;
    const [identityKey, priorCanonical] = aliases[0];
    for (const [key, value] of result) {
      if (value === priorCanonical.key) result.set(key, pinned.key);
    }
    canonicalByIdentity.set(identityKey, pinned);
  }

  for (const group of groups) {
    if (identityForKey.has(group.key) || pinnedDestinations.has(group.key)) continue;
    const aliases = [...canonicalByIdentity.entries()].filter(([identityKey]) => {
      const separator = identityKey.indexOf('\0');
      const workgroupId = identityKey.slice(0, separator);
      const identity = identityKey.slice(separator + 1);
      return workgroupId === group.workgroupId && identity.split('/').at(-1) === group.repo.toLowerCase();
    });
    if (aliases.length === 1) result.set(group.key, aliases[0][1].key);
  }

  for (const [sourceKey] of explicit) {
    const automaticSource = result.get(sourceKey) ?? sourceKey;
    const destinationKey = resolveExplicit(sourceKey);
    for (const [key, value] of result) {
      if (key === sourceKey || value === automaticSource) result.set(key, destinationKey);
    }
  }
  return result;
}
