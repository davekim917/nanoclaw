import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  normalizedCredentialFreeGithubOrigin,
  repositoryOriginContainsCredentials,
} from './repository-migration-identity.js';

export type MissingAdminRecoveryAction = 'restore-visible-state' | 'archive-visible-state';

export type ReviewedCheckoutSelection = 'synthesized-visible-state' | 'exact-git-admin';

export interface ReviewedCheckoutRecoveryDecision {
  checkoutPath: string;
  workgroupId: string;
  repo: string;
  action: MissingAdminRecoveryAction;
  selection: ReviewedCheckoutSelection;
  /** Exact per-worktree admin when its raw index still exists. */
  selectedGitDir?: string;
  selectedCommonGitDir: string;
  /** Null preserves an unborn exact-admin checkout. Synthetic recovery always has a commit. */
  selectedHead: string | null;
  selectedBranch: string | null;
  /** Required for exact-admin selection, including null when the original index is absent. */
  selectedIndexSha256?: string | null;
  /** Required only when the selected Git store was built as a reviewed recovery seed. */
  externalSeedGitDirSha256?: string;
  /** Optional additional reviewed object store used to seed an otherwise unborn repository canonical. */
  supplementalSeedGitDir?: string;
  supplementalSeedGitDirSha256?: string;
  /** Required for a linked-worktree pointer; absent for a standalone .git directory. */
  gitPointerSha256?: string;
  visibleStateSha256: string;
}

/** @deprecated Use ReviewedCheckoutRecoveryDecision. */
export type ReviewedMissingAdminRecoveryDecision = ReviewedCheckoutRecoveryDecision;

export interface ReviewedOriginSelection {
  workgroupId: string;
  repo: string;
  observedOriginsSha256: string;
  selectedOrigin: string | null;
  /** Explicit operator decision to preserve this repository as recovery evidence only. */
  archiveOnly?: true;
}

export interface LoadedReviewedRecoveryDecisions {
  sourcePath: string;
  sha256: string;
  checkouts: ReviewedCheckoutRecoveryDecision[];
  origins: ReviewedOriginSelection[];
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function recoverySeedGitDirSha256(directory: string): string {
  const root = fs.realpathSync(directory);
  const records: Array<{ path: string; mode: number; size: number; sha256: string }> = [];
  const walk = (current: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const absolute = path.join(current, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`recovery seed Git directory contains a symlink: ${absolute}`);
      if (stat.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!stat.isFile()) throw new Error(`recovery seed Git directory contains a special file: ${absolute}`);
      const bytes = fs.readFileSync(absolute);
      records.push({
        path: path.relative(root, absolute),
        mode: stat.mode & 0o7777,
        size: bytes.length,
        sha256: sha256(bytes),
      });
    }
  };
  walk(root);
  return sha256(JSON.stringify(records));
}

function requireSha256(value: unknown, location: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${location} must be a lowercase SHA-256 digest`);
  }
}

function requireIdentity(record: Record<string, unknown>, location: string): void {
  for (const key of ['workgroupId', 'repo']) {
    if (typeof record[key] !== 'string' || record[key] === '') throw new Error(`${location} requires ${key}`);
  }
}

function credentialFreeGithubOrigin(value: unknown, location: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`${location} selectedOrigin must be a string or null`);
  if (process.env.NANOCLAW_REPOSITORY_ALLOW_LOCAL_ORIGIN === '1' && path.isAbsolute(value)) return value;
  if (repositoryOriginContainsCredentials(value)) {
    throw new Error(`${location} selectedOrigin must be credential-free HTTPS github.com`);
  }
  const normalized = normalizedCredentialFreeGithubOrigin(value);
  if (!normalized) throw new Error(`${location} selectedOrigin must be credential-free HTTPS github.com`);
  return normalized;
}

export function loadReviewedRecoveryDecisions(file?: string): LoadedReviewedRecoveryDecisions | null {
  if (!file) return null;
  const sourcePath = path.resolve(file);
  const stat = fs.lstatSync(sourcePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('reviewed recovery decision is not a regular file');
  if ((stat.mode & 0o022) !== 0) throw new Error('reviewed recovery decision must not be group/world writable');
  const bytes = fs.readFileSync(sourcePath);
  const value = JSON.parse(bytes.toString('utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('reviewed recovery decision is malformed');
  const root = value as Record<string, unknown>;
  if (root.version !== 2 || !Array.isArray(root.checkouts) || !Array.isArray(root.origins)) {
    throw new Error('reviewed recovery decision is malformed');
  }
  if (Object.keys(root).some((key) => !['version', 'checkouts', 'origins'].includes(key))) {
    throw new Error('reviewed recovery decision contains unknown top-level fields');
  }

  const checkouts = root.checkouts.map((entry, index) => {
    const location = `reviewed checkout recovery decision ${index}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${location} is malformed`);
    const record = entry as Record<string, unknown>;
    const allowed = new Set([
      'checkoutPath',
      'workgroupId',
      'repo',
      'action',
      'selection',
      'selectedGitDir',
      'selectedCommonGitDir',
      'selectedHead',
      'selectedBranch',
      'selectedIndexSha256',
      'externalSeedGitDirSha256',
      'supplementalSeedGitDir',
      'supplementalSeedGitDirSha256',
      'gitPointerSha256',
      'visibleStateSha256',
    ]);
    if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error(`${location} contains unknown fields`);
    requireIdentity(record, location);
    if (typeof record.checkoutPath !== 'string' || !path.isAbsolute(record.checkoutPath)) {
      throw new Error(`${location} checkoutPath must be absolute`);
    }
    if (record.action !== 'restore-visible-state' && record.action !== 'archive-visible-state') {
      throw new Error(`${location} has an invalid action`);
    }
    if (record.selection !== 'synthesized-visible-state' && record.selection !== 'exact-git-admin') {
      throw new Error(`${location} has an invalid selection`);
    }
    if (typeof record.selectedCommonGitDir !== 'string' || !path.isAbsolute(record.selectedCommonGitDir)) {
      throw new Error(`${location} selectedCommonGitDir must be absolute`);
    }
    if (
      record.selectedHead !== null &&
      (typeof record.selectedHead !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(record.selectedHead))
    ) {
      throw new Error(`${location} selectedHead must be a full Git object ID or null`);
    }
    if (record.selectedBranch !== null && (typeof record.selectedBranch !== 'string' || record.selectedBranch === '')) {
      throw new Error(`${location} selectedBranch must be a non-empty string or null`);
    }
    requireSha256(record.visibleStateSha256, `${location} visibleStateSha256`);
    if (record.gitPointerSha256 !== undefined) requireSha256(record.gitPointerSha256, `${location} gitPointerSha256`);
    if (record.selection === 'exact-git-admin') {
      if (typeof record.selectedGitDir !== 'string' || !path.isAbsolute(record.selectedGitDir)) {
        throw new Error(`${location} exact-git-admin selection requires absolute selectedGitDir`);
      }
      if (record.selectedIndexSha256 !== null) {
        requireSha256(record.selectedIndexSha256, `${location} selectedIndexSha256`);
      }
      if (!Object.prototype.hasOwnProperty.call(record, 'selectedIndexSha256')) {
        throw new Error(`${location} exact-git-admin selection requires selectedIndexSha256`);
      }
      if (record.externalSeedGitDirSha256 !== undefined) {
        throw new Error(`${location} exact-git-admin selection cannot use externalSeedGitDirSha256`);
      }
    } else {
      if (record.selectedGitDir !== undefined || record.selectedIndexSha256 !== undefined) {
        throw new Error(`${location} synthesized selection cannot specify exact Git-admin fields`);
      }
      if (record.selectedHead === null || record.selectedBranch === null || record.gitPointerSha256 === undefined) {
        throw new Error(
          `${location} synthesized selection requires selectedHead, selectedBranch, and gitPointerSha256`,
        );
      }
    }
    if (record.externalSeedGitDirSha256 !== undefined) {
      requireSha256(record.externalSeedGitDirSha256, `${location} externalSeedGitDirSha256`);
    }
    const hasSupplementalPath = record.supplementalSeedGitDir !== undefined;
    const hasSupplementalHash = record.supplementalSeedGitDirSha256 !== undefined;
    if (hasSupplementalPath !== hasSupplementalHash) {
      throw new Error(`${location} supplemental seed path and checksum must be supplied together`);
    }
    if (hasSupplementalPath) {
      if (typeof record.supplementalSeedGitDir !== 'string' || !path.isAbsolute(record.supplementalSeedGitDir)) {
        throw new Error(`${location} supplementalSeedGitDir must be absolute`);
      }
      requireSha256(record.supplementalSeedGitDirSha256, `${location} supplementalSeedGitDirSha256`);
    }
    return record as unknown as ReviewedCheckoutRecoveryDecision;
  });

  const origins = root.origins.map((entry, index) => {
    const location = `reviewed origin decision ${index}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${location} is malformed`);
    const record = entry as Record<string, unknown>;
    if (
      Object.keys(record).some(
        (key) => !['workgroupId', 'repo', 'observedOriginsSha256', 'selectedOrigin', 'archiveOnly'].includes(key),
      )
    ) {
      throw new Error(`${location} contains unknown fields`);
    }
    requireIdentity(record, location);
    requireSha256(record.observedOriginsSha256, `${location} observedOriginsSha256`);
    const selectedOrigin = credentialFreeGithubOrigin(record.selectedOrigin, location);
    if (record.archiveOnly !== undefined && record.archiveOnly !== true) {
      throw new Error(`${location} archiveOnly must be true when supplied`);
    }
    if (record.archiveOnly === true && record.selectedOrigin !== null) {
      throw new Error(`${location} archiveOnly requires selectedOrigin null`);
    }
    return { ...record, selectedOrigin } as unknown as ReviewedOriginSelection;
  });

  const missingPaths = new Set<string>();
  for (const decision of checkouts) {
    const resolved = path.resolve(decision.checkoutPath);
    if (missingPaths.has(resolved)) throw new Error(`duplicate reviewed checkout recovery decision: ${resolved}`);
    missingPaths.add(resolved);
  }
  const originKeys = new Set<string>();
  for (const decision of origins) {
    const key = `${decision.workgroupId}\0${decision.repo}`;
    if (originKeys.has(key))
      throw new Error(`duplicate reviewed origin decision: ${decision.workgroupId}/${decision.repo}`);
    originKeys.add(key);
  }
  return { sourcePath, sha256: sha256(bytes), checkouts, origins };
}

export function observedOriginsSha256(origins: Iterable<string | null>): string {
  return sha256(JSON.stringify([...new Set(origins)].sort((a, b) => String(a).localeCompare(String(b)))));
}

export function selectReviewedOrigin(input: {
  workgroupId: string;
  repo: string;
  observedOrigins: Array<string | null>;
  decision?: ReviewedOriginSelection;
}): string | null {
  const unique = [...new Set(input.observedOrigins)];
  if (!input.decision) {
    if (unique.length !== 1) {
      throw new Error(
        `origin conflict (${unique.length} distinct values; observed set sha256 ${observedOriginsSha256(unique)}); ` +
          `supply a reviewed origin decision`,
      );
    }
    const selected = unique[0] ?? null;
    const selectedIsLocal =
      typeof selected === 'string' &&
      process.env.NANOCLAW_REPOSITORY_ALLOW_LOCAL_ORIGIN === '1' &&
      path.isAbsolute(selected);
    const normalizedSelected =
      selected === null
        ? null
        : selectedIsLocal
          ? selected
          : repositoryOriginContainsCredentials(selected)
            ? null
            : normalizedCredentialFreeGithubOrigin(selected);
    if (selected !== null && normalizedSelected === null) {
      throw new Error(
        `observed origin is not credential-free HTTPS github.com (observed set sha256 ${observedOriginsSha256(unique)}); ` +
          `supply a reviewed origin decision`,
      );
    }
    return normalizedSelected;
  }
  if (input.decision.workgroupId !== input.workgroupId || input.decision.repo !== input.repo) {
    throw new Error(`reviewed origin decision identity mismatch for ${input.workgroupId}/${input.repo}`);
  }
  const observedHash = observedOriginsSha256(unique);
  if (observedHash !== input.decision.observedOriginsSha256) {
    throw new Error(`reviewed origin decision is stale for ${input.workgroupId}/${input.repo}`);
  }
  return credentialFreeGithubOrigin(input.decision.selectedOrigin, 'reviewed origin decision');
}
