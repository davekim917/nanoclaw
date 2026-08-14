import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import type { LegacyCheckoutCandidate } from './repository-migration.js';
import type { RepositoryWorkUnit } from './repository-workspaces.js';

export interface ReviewedMappingEntry {
  checkoutPath: string;
  workgroupId: string;
  repo: string;
  workUnitKey: string;
}

export interface AppliedMappingEvidence {
  sourcePath: string;
  sha256: string;
  applied: number;
}

export interface LoadedReviewedWorkUnitMappings extends AppliedMappingEvidence {
  entries: ReviewedMappingEntry[];
}

export function loadReviewedWorkUnitMappings(file?: string): LoadedReviewedWorkUnitMappings | null {
  if (!file) return null;
  const sourcePath = path.resolve(file);
  const stat = fs.lstatSync(sourcePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('reviewed work-unit mapping is not a regular file');
  if ((stat.mode & 0o022) !== 0) throw new Error('reviewed work-unit mapping must not be group/world writable');
  const bytes = fs.readFileSync(sourcePath);
  const value = JSON.parse(bytes.toString('utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('reviewed work-unit mapping is malformed');
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.mappings))
    throw new Error('reviewed work-unit mapping is malformed');
  if (Object.keys(record).some((key) => key !== 'version' && key !== 'mappings')) {
    throw new Error('reviewed work-unit mapping contains unknown top-level fields');
  }
  const mappings = record.mappings.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`reviewed work-unit mapping entry ${index} is malformed`);
    }
    const candidate = entry as Record<string, unknown>;
    const allowed = new Set(['checkoutPath', 'workgroupId', 'repo', 'workUnitKey']);
    if (Object.keys(candidate).some((key) => !allowed.has(key))) {
      throw new Error(`reviewed work-unit mapping entry ${index} contains unknown fields`);
    }
    for (const key of allowed) {
      if (typeof candidate[key] !== 'string' || candidate[key] === '') {
        throw new Error(`reviewed work-unit mapping entry ${index} requires ${key}`);
      }
    }
    if (!path.isAbsolute(candidate.checkoutPath as string)) {
      throw new Error(`reviewed work-unit mapping entry ${index} checkoutPath must be absolute`);
    }
    return candidate as unknown as ReviewedMappingEntry;
  });
  return {
    sourcePath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    applied: 0,
    entries: mappings,
  };
}

export function applyReviewedWorkUnitMappings(
  grouped: Map<string, LegacyCheckoutCandidate[]>,
  knownWorkUnits: Iterable<RepositoryWorkUnit>,
  loaded: LoadedReviewedWorkUnitMappings | null,
): AppliedMappingEvidence | null {
  if (!loaded) return null;
  const known = new Map<string, RepositoryWorkUnit>();
  for (const unit of knownWorkUnits) {
    const key = `${unit.workgroupId}\0${unit.key}`;
    const prior = known.get(key);
    if (prior && (prior.id !== unit.id || prior.kind !== unit.kind)) {
      throw new Error(`database work-unit identity collision: ${unit.workgroupId}/${unit.key}`);
    }
    known.set(key, unit);
  }
  const candidates = [...grouped.values()].flat();
  const byPath = new Map(candidates.map((candidate) => [path.resolve(candidate.checkoutPath), candidate]));
  const seen = new Set<string>();
  let applied = 0;
  for (const entry of loaded.entries) {
    const checkoutPath = path.resolve(entry.checkoutPath);
    if (seen.has(checkoutPath)) throw new Error(`duplicate reviewed mapping for checkout: ${checkoutPath}`);
    seen.add(checkoutPath);
    const candidate = byPath.get(checkoutPath);
    if (!candidate)
      throw new Error(`reviewed mapping references a checkout not present in current inventory: ${checkoutPath}`);
    if (candidate.workgroupId !== entry.workgroupId || candidate.repo !== entry.repo) {
      throw new Error(`reviewed mapping identity mismatch for checkout: ${checkoutPath}`);
    }
    const unit = known.get(`${entry.workgroupId}\0${entry.workUnitKey}`);
    if (!unit) {
      throw new Error(
        `reviewed mapping target is not a real work unit currently known to the database: ` +
          `${entry.workgroupId}/${entry.workUnitKey}`,
      );
    }
    candidate.workUnit = unit;
    applied += 1;
  }
  return {
    sourcePath: loaded.sourcePath,
    sha256: loaded.sha256,
    applied,
  };
}
