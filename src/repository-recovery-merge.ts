import path from 'path';

import {
  type LoadedReviewedRecoveryDecisions,
  type ReviewedCheckoutRecoveryDecision,
  type ReviewedOriginSelection,
} from './repository-migration-recovery.js';

export interface MergedReviewedRecoveryDecisions {
  version: 2;
  checkouts: ReviewedCheckoutRecoveryDecision[];
  origins: ReviewedOriginSelection[];
}

function checkoutKey(decision: ReviewedCheckoutRecoveryDecision): string {
  return path.resolve(decision.checkoutPath);
}

function originKey(decision: ReviewedOriginSelection): string {
  return `${decision.workgroupId}\0${decision.repo}`;
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
  }

  const overriddenCheckouts = new Set<string>();
  const overriddenOrigins = new Set<string>();
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
  }

  return {
    version: 2,
    checkouts: [...checkouts.values()].sort((left, right) =>
      path.resolve(left.checkoutPath).localeCompare(path.resolve(right.checkoutPath)),
    ),
    origins: [...origins.values()].sort((left, right) => originKey(left).localeCompare(originKey(right))),
  };
}
