import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import Database from 'better-sqlite3';

import { EnrichmentRepository } from './enrichment-cache.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('EnrichmentRepository', () => {
  it('allows status readers to overlap semantic queue commits', () => {
    const root = mkdtempSync(join(tmpdir(), 'graphify-cache-concurrency-'));
    roots.push(root);
    const path = join(root, 'cache.db');
    const repo = new EnrichmentRepository(path);
    const reader = new Database(path, { readonly: true, fileMustExist: true });
    try {
      expect(reader.pragma('journal_mode', { simple: true })).toBe('wal');
      reader.exec('BEGIN');
      reader.prepare('SELECT count(*) FROM semantic_queue').get();
      expect(() =>
        repo.enqueue([
          {
            source: { id: 's', workgroupId: 'wg', kind: 'document', relativePath: 'a.md', contentHash: 'h' },
            segments: ['fresh knowledge'],
            priority: 1,
          },
        ]),
      ).not.toThrow();
    } finally {
      reader.exec('ROLLBACK');
      reader.close();
      repo.close();
    }
  });

  it('persists enrichment across daemon restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'graphify-cache-'));
    roots.push(root);
    const path = join(root, 'cache.db');
    const first = new EnrichmentRepository(path);
    first.put({
      sourceId: 's',
      workgroupId: 'wg',
      contentHash: 'h',
      semantic: { nodes: [{ id: 'n', name: 'metric', type: 'concept' }], edges: [], hyperedges: [] },
    });
    first.close();
    const second = new EnrichmentRepository(path);
    expect(second.load('wg')[0].semantic?.nodes[0].name).toBe('metric');
    expect(second.get('s')?.semantic?.nodes[0].name).toBe('metric');
    expect(second.hasCurrent('s', 'h', 'semantic')).toBe(true);
    expect(second.hasCurrent('s', 'wrong', 'semantic')).toBe(false);
    expect(second.hasCurrent('s', 'h', 'code')).toBe(false);
    second.close();
  });

  it('does not mix complementary enrichment layers across content hashes', () => {
    const root = mkdtempSync(join(tmpdir(), 'graphify-cache-hash-'));
    roots.push(root);
    const repo = new EnrichmentRepository(join(root, 'cache.db'));
    repo.put({
      sourceId: 's',
      workgroupId: 'wg',
      contentHash: 'old',
      semantic: { nodes: [{ id: 'old-semantic', name: 'Old', type: 'concept' }], edges: [], hyperedges: [] },
    });
    repo.put({
      sourceId: 's',
      workgroupId: 'wg',
      contentHash: 'new',
      code: { nodes: [{ id: 'new-code', name: 'New', type: 'function' }], edges: [], hyperedges: [] },
    });
    const [entry] = repo.load('wg');
    expect(entry).toEqual(expect.objectContaining({ sourceId: 's', contentHash: 'new', code: expect.any(Object) }));
    expect(entry.semantic).toBeUndefined();
    repo.close();
  });

  it('clears persisted cache and queued jobs for a full workgroup reindex', () => {
    const root = mkdtempSync(join(tmpdir(), 'graphify-cache-clear-'));
    roots.push(root);
    const repo = new EnrichmentRepository(join(root, 'cache.db'));
    repo.put({ sourceId: 's', workgroupId: 'wg', contentHash: 'h', code: { nodes: [], edges: [], hyperedges: [] } });
    repo.enqueue([
      {
        source: { id: 's', workgroupId: 'wg', kind: 'document', relativePath: 'a.md', contentHash: 'h' },
        segments: ['a'],
        priority: 1,
      },
    ]);
    repo.clearWorkgroup('wg');
    expect(repo.load('wg')).toEqual([]);
    expect(repo.pending('wg')).toBe(0);
    repo.close();
  });

  it('removes deleted sources and prunes stale workgroup enrichment in one transaction', () => {
    const root = mkdtempSync(join(tmpdir(), 'graphify-cache-prune-'));
    roots.push(root);
    const repo = new EnrichmentRepository(join(root, 'cache.db'));
    for (const sourceId of ['keep', 'remove', 'other-workgroup']) {
      const workgroupId = sourceId === 'other-workgroup' ? 'other' : 'wg';
      repo.put({
        sourceId,
        workgroupId,
        contentHash: 'h',
        semantic: { nodes: [], edges: [], hyperedges: [] },
      });
      repo.enqueue([
        {
          source: {
            id: sourceId,
            workgroupId,
            kind: 'document',
            relativePath: `${sourceId}.md`,
            contentHash: 'h',
          },
          segments: [sourceId],
          priority: 1,
        },
      ]);
    }

    repo.removeSources(['remove']);
    expect(repo.get('remove')).toBeUndefined();
    repo.pruneWorkgroup('wg', ['keep']);

    expect(repo.load('wg').map((entry) => entry.sourceId)).toEqual(['keep']);
    expect(repo.pending('wg')).toBe(1);
    expect(repo.get('other-workgroup')).toBeDefined();
    expect(repo.pending('other')).toBe(1);
    repo.close();
  });

  it('large corpus uses one bounded persisted semantic batch', () => {
    const root = mkdtempSync(join(tmpdir(), 'graphify-queue-'));
    roots.push(root);
    const repo = new EnrichmentRepository(join(root, 'queue.db'));
    repo.enqueue(
      Array.from({ length: 5_000 }, (_, index) => ({
        source: {
          id: `s${index}`,
          workgroupId: 'wg',
          kind: 'document' as const,
          relativePath: `${index}.md`,
          contentHash: 'h',
        },
        segments: ['x'.repeat(1024)],
        priority: 10,
      })),
    );
    const batch = repo.claimBatch();
    expect(batch.length).toBeLessThanOrEqual(25);
    expect(Buffer.byteLength(batch.flatMap((item) => item.segments).join('\n'))).toBeLessThanOrEqual(256 * 1024);
    expect(repo.pending('wg')).toBe(5_000);
    repo.close();
  });

  it('retries transient semantic failures with bounded backoff', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const root = mkdtempSync(join(tmpdir(), 'graphify-retry-'));
    roots.push(root);
    const repo = new EnrichmentRepository(join(root, 'queue.db'));
    repo.enqueue([
      {
        source: { id: 's', workgroupId: 'wg', kind: 'document', relativePath: 'a.md', contentHash: 'h' },
        segments: ['a'],
        priority: 1,
      },
    ]);
    expect(repo.claimBatch()).toHaveLength(1);
    repo.retry(['s'], 'transient');
    expect(repo.claimBatch()).toHaveLength(0);
    vi.advanceTimersByTime(5_001);
    expect(repo.claimBatch()).toHaveLength(1);
    repo.close();
    vi.useRealTimers();
  });

  it('does not consume retry budget when semantic work is preempted', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const root = mkdtempSync(join(tmpdir(), 'graphify-preempt-'));
    roots.push(root);
    const repo = new EnrichmentRepository(join(root, 'queue.db'));
    repo.enqueue([
      {
        source: { id: 's', workgroupId: 'wg', kind: 'document', relativePath: 'a.md', contentHash: 'h' },
        segments: ['a'],
        priority: 1,
      },
    ]);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(repo.claimBatch()).toHaveLength(1);
      repo.defer(['s']);
      vi.advanceTimersByTime(5_001);
    }
    expect(repo.claimBatch()).toHaveLength(1);
    repo.close();
    vi.useRealTimers();
  });

  it('repairs retry debt left by legacy preemption handling', () => {
    const root = mkdtempSync(join(tmpdir(), 'graphify-preempt-repair-'));
    roots.push(root);
    const path = join(root, 'queue.db');
    const original = new EnrichmentRepository(path);
    original.enqueue([
      {
        source: { id: 's', workgroupId: 'wg', kind: 'document', relativePath: 'a.md', contentHash: 'h' },
        segments: ['a'],
        priority: 1,
      },
    ]);
    original.close();
    const legacy = new Database(path);
    legacy
      .prepare("UPDATE semantic_queue SET state='failed', attempts=5, available_at=?, last_error='preempted'")
      .run('2025-01-01T00:00:00.000Z');
    legacy.close();

    const repaired = new EnrichmentRepository(path);
    expect(repaired.pending('wg')).toBe(1);
    expect(repaired.claimBatch()).toHaveLength(1);
    repaired.close();
  });
});
