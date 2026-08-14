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

  it('applies a reviewed retired-repository alias without reviving a standalone canonical', () => {
    const plan = planLegacyRepositoryCoalescing(
      [
        {
          key: 'illysium\0XZO',
          workgroupId: 'illysium',
          repo: 'XZO',
          physicalCount: 1,
          objectStoreCount: 1,
          observedOrigins: ['https://github.com/example/XZO'],
        },
        {
          key: 'illysium\0snapshot-XZO',
          workgroupId: 'illysium',
          repo: 'snapshot-XZO',
          physicalCount: 10,
          objectStoreCount: 1,
          observedOrigins: ['https://github.com/example/xzo.git'],
        },
        {
          key: 'illysium\0XZO-BACKEND',
          workgroupId: 'illysium',
          repo: 'XZO-BACKEND',
          physicalCount: 3,
          objectStoreCount: 0,
          observedOrigins: [],
        },
      ],
      [{ workgroupId: 'illysium', sourceRepo: 'XZO-BACKEND', destinationRepo: 'XZO' }],
    );
    expect(plan.get('illysium\0XZO-BACKEND')).toBe('illysium\0XZO');
    expect(plan.get('illysium\0snapshot-XZO')).toBe('illysium\0XZO');
  });

  it('pins an origin-unreadable reviewed destination ahead of a larger same-origin snapshot', () => {
    const plan = planLegacyRepositoryCoalescing(
      [
        {
          key: 'illysium\0XZO',
          workgroupId: 'illysium',
          repo: 'XZO',
          physicalCount: 1,
          objectStoreCount: 0,
          observedOrigins: [],
        },
        {
          key: 'illysium\0snapshot-XZO',
          workgroupId: 'illysium',
          repo: 'snapshot-XZO',
          physicalCount: 10,
          objectStoreCount: 1,
          observedOrigins: ['https://github.com/example/xzo.git'],
        },
        {
          key: 'illysium\0XZO-BACKEND',
          workgroupId: 'illysium',
          repo: 'XZO-BACKEND',
          physicalCount: 3,
          objectStoreCount: 0,
          observedOrigins: [],
        },
      ],
      [{ workgroupId: 'illysium', sourceRepo: 'XZO-BACKEND', destinationRepo: 'XZO' }],
    );
    expect([...plan.values()]).toEqual(['illysium\0XZO', 'illysium\0XZO', 'illysium\0XZO']);
  });

  it('rejects reviewed aliases with absent destinations and cycles', () => {
    const groups = [
      { key: 'wg\0a', workgroupId: 'wg', repo: 'a', physicalCount: 1, objectStoreCount: 0, observedOrigins: [] },
      { key: 'wg\0b', workgroupId: 'wg', repo: 'b', physicalCount: 1, objectStoreCount: 0, observedOrigins: [] },
    ];
    expect(() =>
      planLegacyRepositoryCoalescing(groups, [{ workgroupId: 'wg', sourceRepo: 'a', destinationRepo: 'missing' }]),
    ).toThrow(/destination is absent/);
    expect(() =>
      planLegacyRepositoryCoalescing(groups, [
        { workgroupId: 'wg', sourceRepo: 'a', destinationRepo: 'b' },
        { workgroupId: 'wg', sourceRepo: 'b', destinationRepo: 'a' },
      ]),
    ).toThrow(/cycle/);
  });
});
