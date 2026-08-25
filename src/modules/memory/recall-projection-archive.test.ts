/**
 * P2.5-AC1, real-corpus lane.
 *
 * The fixture lane (`recall-projection-read.test.ts`) proves equivalence over a
 * tree built to exercise the byte-identity long tail. It cannot prove it over a
 * REAL term distribution, and term distribution is what decides which
 * candidates the prefilter selects — the exact axis on which the projection
 * could diverge from the filesystem walk. So this lane runs the same
 * comparison over real user messages mined from the chat archive against the
 * largest real memory tree on the box.
 *
 * The two lanes are complements: the archive contains no empty query, no
 * 2000-character run, and no lone `?`, and the fixture contains no real term
 * distribution. Neither replaces the other.
 *
 * SKIPS ITSELF when the archive or the tree is absent, which is every machine
 * but a live host. That is deliberate: the corpus is real user conversation
 * containing credentials and private content, so it is mined at run time and
 * never written to disk, a fixture file, or a snapshot.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';

import {
  _resetRecallProjectionForTest,
  _resetTokenStreamCacheForTest,
  _setRecallProjectionTestHooks,
  readMemoryEvidence,
  warmRecallProjection,
  type ContextNotice,
  type PreTurnContext,
  type RecallCandidateStats,
} from './pre-turn-context.js';
import { buildAndPromoteProjection, projectionDir } from './recall-projection.js';

const ARCHIVE_DB = '/home/ubuntu/nanoclaw-v2/data/archive.db';
const ILLYSIUM_MEMORY = '/home/ubuntu/nanoclaw-v2/data/workgroups/illysium/memory';

/** Every agent group in the `illysium` workgroup — the largest store, worst case. */
const ILLYSIUM_AGENT_GROUPS = [
  'illysium-codex',
  'illysium-opencode',
  'ag-1776377699463-2axxhg',
  'ag-872a1347-1d17-4495-a121-3bd5e86941d3',
  'ag-c1035b15-6147-416f-8b82-427290c5c824',
  'ag-fc5bcf90-9209-469d-88d4-00dc93e18e18',
];

const SAMPLE_SIZE = 320;
const WORKGROUP = 'wg-archive';

const available = fs.existsSync(ARCHIVE_DB) && fs.existsSync(ILLYSIUM_MEMORY);

/**
 * Real user messages, deduped and sampled at a fixed stride over id order.
 *
 * Stride rather than `ORDER BY random()` so a mismatch is reproducible, and
 * over the whole id range rather than a `LIMIT` so the sample is not all
 * recent. The 12..600 band keeps out bare acknowledgements and multi-kilobyte
 * pastes; the fixture lane already covers both extremes deliberately.
 */
function mineQueries(): string[] {
  const db = new Database(ARCHIVE_DB, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT text FROM messages_archive
          WHERE role = 'user'
            AND agent_group_id IN (${ILLYSIUM_AGENT_GROUPS.map(() => '?').join(',')})
            AND length(text) BETWEEN 12 AND 600
          ORDER BY id`,
      )
      .all(...ILLYSIUM_AGENT_GROUPS) as { text: string }[];

    const seen = new Set<string>();
    const pool: string[] = [];
    for (const row of rows) {
      const text = row.text.trim();
      const key = text.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(key)) continue;
      seen.add(key);
      pool.push(text);
    }
    const stride = Math.max(1, Math.floor(pool.length / SAMPLE_SIZE));
    const sample: string[] = [];
    for (let index = 0; sample.length < SAMPLE_SIZE && index * stride < pool.length; index++) {
      sample.push(pool[index * stride]!);
    }
    return sample;
  } finally {
    db.close();
  }
}

interface Served {
  evidence: PreTurnContext['memoryEvidence'];
  notices: ContextNotice[];
  stats: RecallCandidateStats;
}

function serve(root: string, query: string): Served {
  const notices: ContextNotice[] = [];
  const stats: RecallCandidateStats = {
    factCandidates: 0,
    fileCandidates: 0,
    recallPath: 'fallback',
    recallReason: 'not-reached',
  };
  const evidence = readMemoryEvidence(root, WORKGROUP, query, notices, false, new Set<string>(), false, [], stats);
  return { evidence, notices, stats };
}

const temporary: string[] = [];
function scratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `recall-archive-${prefix}-`));
  temporary.push(dir);
  return dir;
}

afterAll(() => {
  _resetRecallProjectionForTest();
  _resetTokenStreamCacheForTest();
  while (temporary.length > 0) fs.rmSync(temporary.pop()!, { recursive: true, force: true });
});

describe.skipIf(!available)('P2.5-AC1 real-corpus differential equivalence (archive-mined)', () => {
  it('delivers byte-identical evidence and notices for every archive-mined query', () => {
    // A byte copy, not the live path. The live tree is being written by a real
    // curator: a mid-run write would turn later hits into `stale` and report a
    // flake as a mismatch. The copy IS the real tree, minus the race.
    const root = scratch('tree');
    fs.cpSync(ILLYSIUM_MEMORY, root, { recursive: true });

    const queries = mineQueries();
    // Precondition asserted, not assumed: an empty mine would pass vacuously.
    expect(queries.length).toBe(SAMPLE_SIZE);

    const empty = scratch('empty');
    const dataDir = scratch('data');
    buildAndPromoteProjection({ root, directory: projectionDir(WORKGROUP, dataDir) });

    // Frozen clock so a warm mark cannot expire partway through a run this
    // long, and a generous warm budget because the pass walks 585 real files.
    // Neither touches candidate selection — only whether the read is allowed.
    const attach = (dir: string): void => {
      _setRecallProjectionTestHooks({
        dataDir: dir,
        clock: () => 1_000_000,
        warmBudgetMs: 60_000,
        schedule: () => {},
      });
    };

    attach(dataDir);
    expect(warmRecallProjection(WORKGROUP, root)).toMatchObject({ warm: true, reason: 'warm' });

    const mismatches: Array<{ query: string; field: string; cold: string; projection: string }> = [];
    let compared = 0;
    let withEvidence = 0;
    let excerpts = 0;
    for (const query of queries) {
      // Cold: no projection on disk at all, so the turn walks the tree.
      attach(empty);
      _resetTokenStreamCacheForTest();
      const cold = serve(root, query);
      expect(cold.stats.recallPath).toBe('cold');

      attach(dataDir);
      const projected = serve(root, query);
      expect(projected.stats.recallPath).toBe('hit');

      for (const [field, left, right] of [
        ['evidence', JSON.stringify(cold.evidence), JSON.stringify(projected.evidence)],
        ['notices', JSON.stringify(cold.notices), JSON.stringify(projected.notices)],
      ] as const) {
        if (left !== right) mismatches.push({ query, field, cold: left, projection: right });
      }
      compared++;
      if (projected.evidence.excerpts.length > 0) withEvidence++;
      excerpts += projected.evidence.excerpts.length;
    }

    expect(compared).toBe(SAMPLE_SIZE);
    // Equality over two empty sets is not equivalence. Without this the lane
    // could pass by retrieving nothing 320 times — precisely the shape a broken
    // term prefilter would produce. Measured on the illysium tree: 320/320
    // queries retrieve, 1259 excerpts (3.9 per query). The floors sit far below
    // that so ordinary drift in the tree does not fail the lane.
    console.log(`archive-mined AC1: ${compared} compared, ${withEvidence} retrieved, ${excerpts} excerpts total`);
    expect(withEvidence).toBeGreaterThan(SAMPLE_SIZE / 2);
    expect(excerpts).toBeGreaterThan(SAMPLE_SIZE);
    // Report the query and both sides, not just a count: one mismatch is the
    // whole point of running this lane.
    expect(mismatches.map((row) => `${row.field} @ ${JSON.stringify(row.query.slice(0, 120))}`)).toEqual([]);
    // 320 pairs against a 585-file tree, and the cold half re-tokenizes every
    // candidate because the token cache is deliberately cleared each time.
    // Measured 513s on an idle box, 2118s under load, so the ceiling is set for
    // the loaded case — this lane is operator-run, not a CI gate.
  }, 3_600_000);
});
