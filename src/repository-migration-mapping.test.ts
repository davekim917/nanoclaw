import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyReviewedWorkUnitMappings, loadReviewedWorkUnitMappings } from './repository-migration-mapping.js';
import type { LegacyCheckoutCandidate } from './repository-migration.js';
import { resolveRepositoryWorkUnit } from './repository-workspaces.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-mapping-'));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function unit(threadId: string) {
  return resolveRepositoryWorkUnit({
    workgroupId: 'wg-a',
    sessionId: `session-${threadId}`,
    platformId: 'slack:C1',
    messagingGroupId: 'mg-a',
    threadId,
  });
}

function writeMapping(value: unknown): string {
  const file = path.join(root, 'mapping.json');
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return file;
}

describe('reviewed legacy checkout mapping', () => {
  it('maps an exact physical checkout only to a real database work unit and emits hash evidence', () => {
    const checkoutPath = path.join(root, 'legacy');
    fs.mkdirSync(checkoutPath);
    const fallback = { workgroupId: 'wg-a', kind: 'session' as const, key: 'session:legacy:x', id: 'x' };
    const candidate: LegacyCheckoutCandidate = { workgroupId: 'wg-a', repo: 'dbt', checkoutPath, workUnit: fallback };
    const target = unit('thread-1');
    const file = writeMapping({
      version: 1,
      mappings: [{ checkoutPath, workgroupId: 'wg-a', repo: 'dbt', workUnitKey: target.key }],
    });

    const evidence = applyReviewedWorkUnitMappings(
      new Map([['wg-a\0dbt', [candidate]]]),
      [target],
      loadReviewedWorkUnitMappings(file),
    );
    expect(candidate.workUnit).toEqual(target);
    expect(evidence).toMatchObject({ sourcePath: file, applied: 1 });
    expect(evidence?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects stale paths, unknown work units, and writable mapping files without changing candidates', () => {
    const checkoutPath = path.join(root, 'legacy');
    fs.mkdirSync(checkoutPath);
    const fallback = { workgroupId: 'wg-a', kind: 'session' as const, key: 'session:legacy:x', id: 'x' };
    const candidate: LegacyCheckoutCandidate = { workgroupId: 'wg-a', repo: 'dbt', checkoutPath, workUnit: fallback };
    const grouped = new Map([['wg-a\0dbt', [candidate]]]);

    const unknown = writeMapping({
      version: 1,
      mappings: [{ checkoutPath, workgroupId: 'wg-a', repo: 'dbt', workUnitKey: 'thread:unknown' }],
    });
    expect(() =>
      applyReviewedWorkUnitMappings(grouped, [unit('thread-1')], loadReviewedWorkUnitMappings(unknown)),
    ).toThrow(/not a real work unit/);
    expect(candidate.workUnit).toBe(fallback);

    fs.chmodSync(unknown, 0o622);
    expect(() => loadReviewedWorkUnitMappings(unknown)).toThrow(/group\/world writable/);
  });
});
