import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { log } from './log.js';
import {
  ATTENTION_MEMO_TTL_MS,
  ATTENTION_ITEM_PREFIX,
  clearAttentionMemo,
  isAttentionItemId,
  parseAttentionSources,
  readAttentionItems,
} from './attention-sources.js';
import { closeDb, getDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';

/**
 * Fixture identifiers ONLY. `scripts/check-public-boundary.ts` scans this tree
 * for live channel ids, workgroup names and people; its Slack rule accepts only
 * ids carrying a synthetic word (`EXAMPLE`, `FIXTURE`, `TEST`, …).
 */
const WORKGROUP = 'example-labs';
const CHANNEL_KEY = 'slack:CEXAMPLE001';
const ASOF = '2026-08-22T12:01:41Z';

const tmpdirs: string[] = [];

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpdirs.push(dir);
  return dir;
}

/** A groups root holding one release board for {@link WORKGROUP}. */
function boardRoot(items: unknown[], asOf: string = ASOF): string {
  const root = tmp('nc-attn-groups-');
  const dir = path.join(root, WORKGROUP, 'releases');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'release-state.json'), JSON.stringify({ asOf, items }));
  return root;
}

function readyPr(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'EXAMPLE-APP#817',
    kind: 'pr',
    nextMover: 'human',
    owner: 'alice',
    why: 'CI green, mergeable CLEAN',
    since: '2026-08-13T00:00:00Z',
    url: 'https://github.com/example-org/example-app/pull/817',
    title: "What's new digest",
    nextAction: '@releasebot ship 817',
    ...over,
  };
}

function declare(value: string | null): void {
  getDb().prepare(`UPDATE workgroups SET attention_sources = ? WHERE id = ?`).run(value, WORKGROUP);
}

beforeEach(() => {
  clearAttentionMemo();
  const db = initTestDb();
  runMigrations(db);
  db.prepare(
    `INSERT OR IGNORE INTO workgroups (id, display_name, onecli_secrets, created_at)
     VALUES (?, ?, '[]', '2026-08-01T00:00:00.000Z')`,
  ).run(WORKGROUP, 'Example Labs');
});

afterEach(() => {
  vi.restoreAllMocks();
  clearAttentionMemo();
  closeDb();
  while (tmpdirs.length) fs.rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

describe('parseAttentionSources', () => {
  it('reads a well-formed declaration', () => {
    expect(
      parseAttentionSources(`[{"kind":"release-board","root":"releases","channel_key":"${CHANNEL_KEY}"}]`),
    ).toEqual([{ kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY }]);
  });

  it('treats NULL and empty as "declared nothing", not as malformed', () => {
    expect(parseAttentionSources(null)).toEqual([]);
    expect(parseAttentionSources(undefined)).toEqual([]);
    expect(parseAttentionSources('   ')).toEqual([]);
  });

  it.each([
    ['not json at all', '{ nope'],
    ['a JSON object rather than an array', '{"kind":"release-board"}'],
    ['an entry that is not an object', '["release-board"]'],
    ['a missing kind', `[{"root":"releases","channel_key":"${CHANNEL_KEY}"}]`],
    ['an empty kind', `[{"kind":"  ","root":"releases","channel_key":"${CHANNEL_KEY}"}]`],
    ['a missing root', `[{"kind":"release-board","channel_key":"${CHANNEL_KEY}"}]`],
    ['an absolute root', `[{"kind":"release-board","root":"/etc","channel_key":"${CHANNEL_KEY}"}]`],
    ['a traversing root', `[{"kind":"release-board","root":"../../etc","channel_key":"${CHANNEL_KEY}"}]`],
    ['a channel_key with no platform segment', '[{"kind":"release-board","root":"releases","channel_key":"C1"}]'],
  ])('fails closed on %s', (_why, raw) => {
    expect(parseAttentionSources(raw)).toBeNull();
  });

  it('fails closed on the WHOLE list when only one entry is malformed — never a partial list', () => {
    // A partial feed is indistinguishable from a healthy short one. An operator
    // who mistypes one entry must not silently lose the others' items while
    // believing they are still watching.
    const raw = JSON.stringify([
      { kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY },
      { kind: 'release-board', root: '../escape', channel_key: CHANNEL_KEY },
    ]);
    expect(parseAttentionSources(raw)).toBeNull();
  });
});

describe('readAttentionItems', () => {
  it('emits items for a declared source', () => {
    declare(JSON.stringify([{ kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY }]));
    const groupsRoot = boardRoot([readyPr()]);
    const read = readAttentionItems(WORKGROUP, Date.now(), { groupsRoot, claimsRoot: tmp('nc-attn-claims-') });
    expect(read.asOf).toBe(ASOF);
    expect(read.items).toHaveLength(1);
    expect(read.items[0]!.channel_key).toBe(CHANNEL_KEY);
    expect(read.items[0]!.sourceKind).toBe('release-board');
    expect(read.items[0]!.sourceAsOf).toBe(ASOF);
  });

  it('stamps the item id so it can never be read as a thread id', () => {
    declare(JSON.stringify([{ kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY }]));
    const groupsRoot = boardRoot([readyPr()]);
    const read = readAttentionItems(WORKGROUP, Date.now(), { groupsRoot, claimsRoot: tmp('nc-attn-claims-') });
    expect(read.items[0]!.id).toBe(`${ATTENTION_ITEM_PREFIX}EXAMPLE-APP#817`);
    expect(isAttentionItemId(read.items[0]!.id)).toBe(true);
  });

  it('emits nothing, and says so, when nothing is declared', () => {
    const debug = vi.spyOn(log, 'debug').mockImplementation(() => {});
    declare(null);
    const read = readAttentionItems(WORKGROUP, Date.now(), { groupsRoot: boardRoot([readyPr()]) });
    expect(read).toEqual({ asOf: null, items: [] });
    expect(debug).toHaveBeenCalledWith('Attention sources: none declared', expect.objectContaining({}));
  });

  it('emits nothing, and WARNS, on a malformed declaration', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    declare('[{"kind":"release-board","root":"../escape","channel_key":"slack:CEXAMPLE001"}]');
    const read = readAttentionItems(WORKGROUP, Date.now(), { groupsRoot: boardRoot([readyPr()]) });
    expect(read).toEqual({ asOf: null, items: [] });
    expect(warn).toHaveBeenCalledWith(
      'Attention sources: malformed declaration, emitting nothing for this workgroup',
      expect.objectContaining({ workgroupId: WORKGROUP }),
    );
  });

  it('ignores an unknown kind with a warning rather than throwing, and still reads the known ones', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    declare(
      JSON.stringify([
        { kind: 'from-a-newer-trunk', root: 'findings', channel_key: CHANNEL_KEY },
        { kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY },
      ]),
    );
    const groupsRoot = boardRoot([readyPr()]);
    let read!: ReturnType<typeof readAttentionItems>;
    expect(() => {
      read = readAttentionItems(WORKGROUP, Date.now(), { groupsRoot, claimsRoot: tmp('nc-attn-claims-') });
    }).not.toThrow();
    expect(read.items).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      'Attention sources: unknown kind, ignoring this source',
      expect.objectContaining({ kind: 'from-a-newer-trunk' }),
    );
  });

  it('returns the memoized read inside the TTL, without re-reading the files', () => {
    declare(JSON.stringify([{ kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY }]));
    const groupsRoot = boardRoot([readyPr()]);
    const claimsRoot = tmp('nc-attn-claims-');
    const t0 = Date.parse(ASOF);
    const first = readAttentionItems(WORKGROUP, t0, { groupsRoot, claimsRoot });
    expect(first.items).toHaveLength(1);

    // Delete the board out from under it: only a cache hit can still answer.
    fs.rmSync(path.join(groupsRoot, WORKGROUP, 'releases'), { recursive: true, force: true });
    expect(readAttentionItems(WORKGROUP, t0 + ATTENTION_MEMO_TTL_MS - 1, { groupsRoot, claimsRoot })).toBe(first);
  });

  it('re-reads once the TTL has elapsed', () => {
    declare(JSON.stringify([{ kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY }]));
    const groupsRoot = boardRoot([readyPr()]);
    const claimsRoot = tmp('nc-attn-claims-');
    const t0 = Date.parse(ASOF);
    expect(readAttentionItems(WORKGROUP, t0, { groupsRoot, claimsRoot }).items).toHaveLength(1);

    fs.rmSync(path.join(groupsRoot, WORKGROUP, 'releases'), { recursive: true, force: true });
    const after = readAttentionItems(WORKGROUP, t0 + ATTENTION_MEMO_TTL_MS, { groupsRoot, claimsRoot });
    expect(after).toEqual({ asOf: null, items: [] });
  });

  it('keeps the TTL far below the claim TTL horizon', () => {
    // The asymmetry is the point, not the IO saving. A slightly-stale memo can
    // briefly suppress a board item behind an expired claim (safe: a duplicate
    // avoided). The inverse — a memo old enough to have missed a claim being
    // TAKEN — shows the same PR twice under two identities, which the dedupe
    // exists to prevent. Four hours is the shortest claim TTL in use.
    expect(ATTENTION_MEMO_TTL_MS).toBeLessThan(4 * 60 * 60 * 1000 * 0.1);
    // …and well under the ~30-minute regeneration cadence of the source, so
    // freshness stays bounded by the watcher rather than by this cache.
    expect(ATTENTION_MEMO_TTL_MS).toBeLessThan(30 * 60 * 1000 * 0.25);
  });
});
