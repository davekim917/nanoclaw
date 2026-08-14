import path from 'path';

import {
  type LoadedReviewedRecoveryDecisions,
  type ReviewedCheckoutRecoveryDecision,
  type ReviewedOriginSelection,
  type ReviewedRepositoryAlias,
} from './repository-migration-recovery.js';

export interface MergedReviewedRecoveryDecisions {
  version: 2;
  checkouts: ReviewedCheckoutRecoveryDecision[];
  origins: ReviewedOriginSelection[];
  repositoryAliases: ReviewedRepositoryAlias[];
}

function checkoutKey(decision: ReviewedCheckoutRecoveryDecision): string {
  return path.resolve(decision.checkoutPath);
}

function originKey(decision: ReviewedOriginSelection): string {
  return `${decision.workgroupId}\0${decision.repo}`;
}

function aliasKey(decision: ReviewedRepositoryAlias): string {
  return `${decision.workgroupId}\0${decision.sourceRepo}`;
}

function sameDecision(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function mergeReviewedRecoveryDecisions(input: {
  bases: LoadedReviewedRecoveryDecisions[];
  overrides: LoadedReviewedRecoveryDecisions[];
}): MergedReviewedRecoveryDecisions {
  const checkouts = new Map<string, ReviewedCheckoutRecoveryDecision>();
  const origins = new Map<string, ReviewedOriginSelection>();
  const repositoryAliases = new Map<string, ReviewedRepositoryAlias>();

  const addBase = <T>(target: Map<string, T>, key: string, decision: T, description: string): void => {
    const existing = target.get(key);
    if (existing === undefined) {
      target.set(key, decision);
      return;
    }
    if (!sameDecision(existing, decision)) {
      throw new Error(`conflicting base recovery decisions for ${description}; supply one reviewed override`);
    }
  };

  for (const source of input.bases) {
    for (const decision of source.checkouts) {
      addBase(checkouts, checkoutKey(decision), decision, path.resolve(decision.checkoutPath));
    }
    for (const decision of source.origins) {
      addBase(origins, originKey(decision), decision, `${decision.workgroupId}/${decision.repo}`);
    }
    for (const decision of source.repositoryAliases) {
      addBase(repositoryAliases, aliasKey(decision), decision, `${decision.workgroupId}/${decision.sourceRepo}`);
    }
  }

  const overriddenCheckouts = new Set<string>();
  const overriddenOrigins = new Set<string>();
  const overriddenAliases = new Set<string>();
  for (const source of input.overrides) {
    for (const decision of source.checkouts) {
      const key = checkoutKey(decision);
      if (overriddenCheckouts.has(key)) throw new Error(`duplicate checkout override: ${key}`);
      overriddenCheckouts.add(key);
      checkouts.set(key, decision);
    }
    for (const decision of source.origins) {
      const key = originKey(decision);
      if (overriddenOrigins.has(key)) {
        throw new Error(`duplicate origin override: ${decision.workgroupId}/${decision.repo}`);
      }
      overriddenOrigins.add(key);
      origins.set(key, decision);
    }
    for (const decision of source.repositoryAliases) {
      const key = aliasKey(decision);
      if (overriddenAliases.has(key)) {
        throw new Error(`duplicate repository alias override: ${decision.workgroupId}/${decision.sourceRepo}`);
      }
      overriddenAliases.add(key);
      repositoryAliases.set(key, decision);
    }
  }

  return {
    version: 2,
    checkouts: [...checkouts.values()].sort((left, right) =>
      path.resolve(left.checkoutPath).localeCompare(path.resolve(right.checkoutPath)),
    ),
    origins: [...origins.values()].sort((left, right) => originKey(left).localeCompare(originKey(right))),
    repositoryAliases: [...repositoryAliases.values()].sort((left, right) =>
      aliasKey(left).localeCompare(aliasKey(right)),
    ),
  };
}
