import { describe, expect, it } from 'vitest';

import {
  normalizedCredentialFreeGithubOrigin,
  normalizedGithubRepositoryIdentity,
  planLegacyRepositoryCoalescing,
  repositoryOriginContainsCredentials,
} from './repository-migration-identity.js';

describe('legacy repository identity coalescing', () => {
  it('normalizes GitHub case and strips credentials without retaining them', () => {
    expect(normalizedGithubRepositoryIdentity('https://secret@github.com/Owner/Repo.git')).toBe(
      'github.com/owner/repo',
    );
  });

  it('classifies URL userinfo, query, and fragment as credentials and derives only a clean GitHub origin', () => {
    for (const origin of [
      'https://user:pass@github.com/Owner/Repo.git',
      'https://github.com/Owner/Repo.git?access_token=QUERY_SYNTHETIC_SECRET',
      'https://github.com/Owner/Repo.git#FRAGMENT_SYNTHETIC_SECRET',
    ]) {
      expect(repositoryOriginContainsCredentials(origin)).toBe(true);
      expect(normalizedCredentialFreeGithubOrigin(origin)).toBe('https://github.com/Owner/Repo');
      expect(normalizedGithubRepositoryIdentity(origin)).toBe('github.com/owner/repo');
    }
    expect(repositoryOriginContainsCredentials('https://github.com/Owner/Repo.git')).toBe(false);
  });

  it('coalesces snapshots and a unique case-only missing-admin alias into the largest anchored repository', () => {
    const plan = planLegacyRepositoryCoalescing([
      {
        key: 'wg\0XZO-ANALYTICS',
        workgroupId: 'wg',
        repo: 'XZO-ANALYTICS',
        physicalCount: 78,
        objectStoreCount: 1,
        observedOrigins: ['https://github.com/Example/XZO-ANALYTICS'],
      },
      {
        key: 'wg\0snapshot-106',
        workgroupId: 'wg',
        repo: 'snapshot-106',
        physicalCount: 0,
        objectStoreCount: 1,
        observedOrigins: ['https://github.com/example/xzo-analytics.git'],
      },
      {
        key: 'wg\0xzo-analytics',
        workgroupId: 'wg',
        repo: 'xzo-analytics',
        physicalCount: 1,
        objectStoreCount: 0,
        observedOrigins: [],
      },
    ]);
    expect(plan.get('wg\0snapshot-106')).toBe('wg\0XZO-ANALYTICS');
    expect(plan.get('wg\0xzo-analytics')).toBe('wg\0XZO-ANALYTICS');
  });

  it('does not merge a conflicting or ambiguous originless alias', () => {
    const plan = planLegacyRepositoryCoalescing([
      {
        key: 'wg\0Repo',
        workgroupId: 'wg',
        repo: 'Repo',
        physicalCount: 1,
        objectStoreCount: 0,
        observedOrigins: ['https://github.com/a/repo', 'https://github.com/b/repo'],
      },
      {
        key: 'wg\0repo',
        workgroupId: 'wg',
        repo: 'repo',
        physicalCount: 1,
        objectStoreCount: 0,
        observedOrigins: [],
      },
    ]);
    expect(plan.get('wg\0Repo')).toBe('wg\0Repo');
    expect(plan.get('wg\0repo')).toBe('wg\0repo');
  });
});
