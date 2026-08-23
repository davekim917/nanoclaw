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
  sourceStaleness,
  type AttentionItem,
} from './attention-sources.js';
import { threadChannelKey, UNKNOWN_CHANNEL_KEY } from './dashboard/api/threads.js';
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

/** "Now" for every staleness test, so no test depends on the wall clock. */
const NOW = Date.parse('2026-08-23T12:00:00Z');
/** 90 minutes before {@link NOW} — inside any cadence these tests declare. */
const FRESH = '2026-08-23T10:30:00Z';
/** Seven days before {@link NOW} — past every cadence these tests declare. */
const WEEK_OLD = '2026-08-16T12:00:00Z';

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

/** A defect register generated at `asOf`, carrying one `product-decision` row. */
function defectRegister(asOf: string): string {
  return [
    `*Generated ${asOf} by \`gen.py\`.*`,
    '',
    '## product-decision (1)',
    '',
    '- **[#201](https://github.com/example-org/example-app/issues/201)** · p1 · filed 2026-08-08 · A decision is owed',
  ].join('\n');
}

/** A defect register generated at `asOf` with NO open rows — the silent-generator case. */
function emptyDefectRegister(asOf: string): string {
  return [`*Generated ${asOf} by \`gen.py\`.*`, '', '## product-decision (0)', ''].join('\n');
}

/** Every item this workgroup emits at {@link NOW}, grouped by the source that produced it. */
function itemsByKind(groupsRoot: string): Map<string, AttentionItem[]> {
  const out = new Map<string, AttentionItem[]>();
  for (const item of readAttentionItems(WORKGROUP, NOW, { groupsRoot, claimsRoot: tmp('nc-attn-claims-') }).items) {
    out.set(item.sourceKind, [...(out.get(item.sourceKind) ?? []), item]);
  }
  return out;
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

  it('carries the optional per-provider `file` and `branch` through', () => {
    expect(
      parseAttentionSources(
        `[{"kind":"branch-ci","root":"releases","channel_key":"${CHANNEL_KEY}","file":"release-state.json","branch":"develop"}]`,
      ),
    ).toEqual([
      { kind: 'branch-ci', root: 'releases', channel_key: CHANNEL_KEY, file: 'release-state.json', branch: 'develop' },
    ]);
  });

  it('omits `file`/`branch` entirely when they are not declared, rather than setting them undefined', () => {
    expect(
      parseAttentionSources(`[{"kind":"release-board","root":"releases","channel_key":"${CHANNEL_KEY}"}]`)![0]!,
    ).not.toHaveProperty('file');
  });

  it.each([
    ['an absolute file', `[{"kind":"defect-register","root":"r","channel_key":"${CHANNEL_KEY}","file":"/etc/passwd"}]`],
    ['a traversing file', `[{"kind":"defect-register","root":"r","channel_key":"${CHANNEL_KEY}","file":"../x.md"}]`],
    ['a non-string file', `[{"kind":"defect-register","root":"r","channel_key":"${CHANNEL_KEY}","file":7}]`],
    ['an empty file', `[{"kind":"defect-register","root":"r","channel_key":"${CHANNEL_KEY}","file":""}]`],
    ['a non-string branch', `[{"kind":"branch-ci","root":"r","channel_key":"${CHANNEL_KEY}","branch":true}]`],
    ['a branch with a space', `[{"kind":"branch-ci","root":"r","channel_key":"${CHANNEL_KEY}","branch":"de v"}]`],
  ])('fails closed on %s', (_why, raw) => {
    // Present-and-wrong is malformed, exactly like a bad `root`: an operator
    // who typed a path wrong must not silently get a shorter feed that still
    // looks healthy.
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
    expect(read).toEqual({ items: [] });
    expect(debug).toHaveBeenCalledWith('Attention sources: none declared', expect.objectContaining({}));
  });

  it('emits nothing, and WARNS, on a malformed declaration', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    declare('[{"kind":"release-board","root":"../escape","channel_key":"slack:CEXAMPLE001"}]');
    const read = readAttentionItems(WORKGROUP, Date.now(), { groupsRoot: boardRoot([readyPr()]) });
    expect(read).toEqual({ items: [] });
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
    expect(after).toEqual({ items: [] });
  });

  it('shows a defect AND the PR that fixes it, even when they share a number', () => {
    // Different objects at different stages: the defect asks a human for a
    // ruling, the PR asks a human for a ship. They are also different GitHub
    // NAMESPACES, so number-matching one against the other would silently
    // delete real blocked work — the over-matching bug already fixed once on
    // the release-board side. The `defect:` namespace makes the collision
    // structurally impossible rather than relying on the numbers differing.
    const groupsRoot = boardRoot([readyPr({ id: 'EXAMPLE-APP#201' })]);
    fs.writeFileSync(
      path.join(groupsRoot, WORKGROUP, 'releases', 'defects.md'),
      [
        `*Generated ${ASOF} by \`gen.py\`.*`,
        '',
        '## product-decision (1)',
        '',
        '- **[#201](https://github.com/example-org/example-app/issues/201)** · p1 · filed 2026-08-08 · A decision is owed',
      ].join('\n'),
    );
    declare(
      JSON.stringify([
        { kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY },
        { kind: 'defect-register', root: 'releases', channel_key: CHANNEL_KEY, file: 'defects.md' },
      ]),
    );
    const read = readAttentionItems(WORKGROUP, Date.now(), { groupsRoot, claimsRoot: tmp('nc-attn-claims-') });
    expect(read.items.map((i) => i.id)).toEqual([
      `${ATTENTION_ITEM_PREFIX}EXAMPLE-APP#201`,
      `${ATTENTION_ITEM_PREFIX}defect:example-org/example-app#201`,
    ]);
    expect(read.items.map((i) => i.sourceKind)).toEqual(['release-board', 'defect-register']);
  });

  it('a stale source never drags a fresh sibling back with it — each row wears its OWN age', () => {
    // The regression this whole per-source design exists for. One generator
    // (`defects.md`) last ran a week before the board did; the aggregate this
    // seam used to return took the OLDEST contributor, so a board refreshed
    // ninety minutes ago reported as seven days old and no reader could tell
    // WHICH source had actually died.
    const groupsRoot = boardRoot([readyPr()], FRESH);
    fs.writeFileSync(path.join(groupsRoot, WORKGROUP, 'releases', 'defects.md'), defectRegister(WEEK_OLD));
    declare(
      JSON.stringify([
        { kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY },
        { kind: 'defect-register', root: 'releases', channel_key: CHANNEL_KEY, file: 'defects.md' },
      ]),
    );
    const byKind = itemsByKind(groupsRoot);
    expect(byKind.get('release-board')!.map((i) => i.sourceAsOf)).toEqual([FRESH]);
    expect(byKind.get('defect-register')!.map((i) => i.sourceAsOf)).toEqual([WEEK_OLD]);
  });

  it('stamps every new provider kind with an id that can never be read as a thread id', () => {
    const groupsRoot = boardRoot([]);
    const dir = path.join(groupsRoot, WORKGROUP, 'releases');
    fs.writeFileSync(
      path.join(dir, 'defects.md'),
      [
        `*Generated ${ASOF} by \`gen.py\`.*`,
        '',
        '## product-decision (1)',
        '',
        '- **[#201](https://github.com/example-org/example-app/issues/201)** · p1 · filed 2026-08-08 · A decision is owed',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(dir, 'open-questions.md'), '# Preamble\n\n## A standing argument\n\nbody\n');
    fs.writeFileSync(path.join(dir, 'ci.json'), JSON.stringify({ asOf: ASOF, develop_ci: 'failure' }));
    declare(
      JSON.stringify([
        { kind: 'defect-register', root: 'releases', channel_key: CHANNEL_KEY, file: 'defects.md' },
        { kind: 'open-questions', root: 'releases', channel_key: CHANNEL_KEY, file: 'open-questions.md' },
        { kind: 'branch-ci', root: 'releases', channel_key: CHANNEL_KEY, file: 'ci.json', branch: 'develop' },
      ]),
    );
    const read = readAttentionItems(WORKGROUP, Date.now(), { groupsRoot, claimsRoot: tmp('nc-attn-claims-') });
    expect(read.items.map((i) => i.sourceKind)).toEqual(['defect-register', 'open-questions', 'branch-ci']);
    for (const item of read.items) {
      expect(isAttentionItemId(item.id)).toBe(true);
      expect(item.sessionCount).toBe(0);
      expect(item.participants).toEqual([]);
      expect(item.channel_key).toBe(CHANNEL_KEY);
      expect(item.claimNote).toMatch(/\bwaiting on\b/i);
    }
  });

  it('one source that cannot read its file does not blank the others', () => {
    // A `branch-ci` declaration pointed at a markdown file: the JSON parse
    // fails, that source emits nothing and says so, and the sibling source on
    // the same list is still read in full. Half a feed and no feed are both
    // indistinguishable from healthy, so neither may happen quietly.
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const groupsRoot = boardRoot([]);
    const dir = path.join(groupsRoot, WORKGROUP, 'releases');
    fs.writeFileSync(
      path.join(dir, 'defects.md'),
      [
        `*Generated ${ASOF} by \`gen.py\`.*`,
        '',
        '## product-decision (1)',
        '',
        '- **[#201](https://github.com/example-org/example-app/issues/201)** · p1 · filed 2026-08-08 · A decision is owed',
      ].join('\n'),
    );
    declare(
      JSON.stringify([
        { kind: 'branch-ci', root: 'releases', channel_key: CHANNEL_KEY, file: 'defects.md', branch: 'develop' },
        { kind: 'defect-register', root: 'releases', channel_key: CHANNEL_KEY, file: 'defects.md' },
      ]),
    );
    const read = readAttentionItems(WORKGROUP, Date.now(), { groupsRoot, claimsRoot: tmp('nc-attn-claims-') });
    expect(read.items.map((i) => i.sourceKind)).toEqual(['defect-register']);
    expect(warn).toHaveBeenCalled();
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

/**
 * Per-source freshness, and the synthetic item a dead source produces.
 *
 * The bug these pin: the seam used to collapse every source's freshness into
 * ONE aggregate by taking the oldest, so a single generator that had stopped
 * running made the whole feed report as a week stale — a board refreshed ninety
 * minutes ago included — and no reader could tell which source had died.
 * "Everything is stale" is the same lie as "nothing is blocked".
 */
describe('per-source staleness', () => {
  /** A groups root with a fresh release board plus a `defects.md` you control. */
  function twoSources(opts: {
    defectAsOf: string;
    refreshHours?: number;
    register?: (asOf: string) => string;
  }): string {
    const groupsRoot = boardRoot([readyPr()], FRESH);
    fs.writeFileSync(
      path.join(groupsRoot, WORKGROUP, 'releases', 'defects.md'),
      (opts.register ?? defectRegister)(opts.defectAsOf),
    );
    declare(
      JSON.stringify([
        // The board declares a cadence too, and meets it — so this fixture also
        // proves a stale sibling cannot reach across and mark it.
        { kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY, refresh_hours: 6 },
        {
          kind: 'defect-register',
          root: 'releases',
          channel_key: CHANNEL_KEY,
          file: 'defects.md',
          ...(opts.refreshHours === undefined ? {} : { refresh_hours: opts.refreshHours }),
        },
      ]),
    );
    return groupsRoot;
  }

  /** The one synthetic notice among a source's items, or undefined. */
  function notice(items: AttentionItem[]): AttentionItem | undefined {
    return items.find((i) => i.id.startsWith(`${ATTENTION_ITEM_PREFIX}stale:`));
  }

  describe('sourceStaleness', () => {
    it('is null when no cadence is declared — absence is not evidence of freshness', () => {
      expect(sourceStaleness(WEEK_OLD, undefined, NOW)).toBeNull();
    });

    it('is null when the age is unknown — unknown is not stale', () => {
      expect(sourceStaleness(null, 6, NOW)).toBeNull();
    });

    it('is null on an unparseable timestamp — a fact about our parser, not about the generator', () => {
      expect(sourceStaleness('whenever', 6, NOW)).toBeNull();
    });

    it('is true past the cadence and false inside it, on the boundary the doc states', () => {
      const at = Date.parse(FRESH);
      // Strictly greater-than: exactly on the hour is not yet late.
      expect(sourceStaleness(FRESH, 1.5, at + 1.5 * 3_600_000)).toBe(false);
      expect(sourceStaleness(FRESH, 1.5, at + 1.5 * 3_600_000 + 1)).toBe(true);
    });
  });

  describe('refresh_hours validation', () => {
    it('carries a well-formed cadence through', () => {
      expect(
        parseAttentionSources(
          `[{"kind":"defect-register","root":"r","channel_key":"${CHANNEL_KEY}","refresh_hours":6}]`,
        ),
      ).toEqual([{ kind: 'defect-register', root: 'r', channel_key: CHANNEL_KEY, refresh_hours: 6 }]);
    });

    it('omits it entirely when undeclared, rather than setting it undefined', () => {
      expect(
        parseAttentionSources(`[{"kind":"release-board","root":"releases","channel_key":"${CHANNEL_KEY}"}]`)![0]!,
      ).not.toHaveProperty('refresh_hours');
    });

    it.each([
      ['a string cadence', `[{"kind":"d","root":"r","channel_key":"${CHANNEL_KEY}","refresh_hours":"6h"}]`],
      ['a zero cadence', `[{"kind":"d","root":"r","channel_key":"${CHANNEL_KEY}","refresh_hours":0}]`],
      ['a negative cadence', `[{"kind":"d","root":"r","channel_key":"${CHANNEL_KEY}","refresh_hours":-1}]`],
      ['a null cadence', `[{"kind":"d","root":"r","channel_key":"${CHANNEL_KEY}","refresh_hours":null}]`],
    ])('fails the workgroup closed on %s, exactly like a bad root', (_why, raw) => {
      // Degrading to "no claim" would be indistinguishable from the operator
      // having chosen not to declare a cadence, so a typo would silently take
      // the staleness signal away while looking like a healthy config.
      expect(parseAttentionSources(raw)).toBeNull();
    });
  });

  it('marks ONLY the rows from the stale source; a fresh sibling stays unmarked', () => {
    const byKind = itemsByKind(twoSources({ defectAsOf: WEEK_OLD, refreshHours: 24 }));
    expect(byKind.get('release-board')!.map((i) => i.sourceStale)).toEqual([false]);
    // The register's own row, plus the synthetic notice about the register.
    expect(byKind.get('defect-register')!.map((i) => i.sourceStale)).toEqual([true, true]);
  });

  it('makes NO staleness claim when the source declares no cadence — and emits no notice', () => {
    // Not "fresh", not "stale". Nobody said. A default here would either invent
    // a deadline every source is suddenly late for, or vouch for a generator
    // that died months ago.
    const items = itemsByKind(twoSources({ defectAsOf: WEEK_OLD })).get('defect-register')!;
    expect(items.map((i) => i.sourceStale)).toEqual([null]);
    expect(notice(items)).toBeUndefined();
  });

  it('emits no notice for a source whose asOf is unknown — unknown is not stale', () => {
    // A register with its `Generated` header stripped reports `asOf: null`. Its
    // rows are still real work and still emit; they just carry no claim.
    const groupsRoot = boardRoot([]);
    fs.writeFileSync(
      path.join(groupsRoot, WORKGROUP, 'releases', 'defects.md'),
      defectRegister(WEEK_OLD).split('\n').slice(1).join('\n'),
    );
    declare(
      JSON.stringify([
        { kind: 'defect-register', root: 'releases', channel_key: CHANNEL_KEY, file: 'defects.md', refresh_hours: 24 },
      ]),
    );
    const items = itemsByKind(groupsRoot).get('defect-register')!;
    expect(items.map((i) => i.sourceAsOf)).toEqual([null]);
    expect(items.map((i) => i.sourceStale)).toEqual([null]);
    expect(notice(items)).toBeUndefined();
  });

  it('emits EXACTLY ONE notice per stale source, however many rows that source produced', () => {
    const groupsRoot = boardRoot([]);
    fs.writeFileSync(
      path.join(groupsRoot, WORKGROUP, 'releases', 'defects.md'),
      [
        `*Generated ${WEEK_OLD} by \`gen.py\`.*`,
        '',
        '## product-decision (3)',
        '',
        '- **[#201](https://github.com/example-org/example-app/issues/201)** · p1 · filed 2026-08-08 · One',
        '- **[#202](https://github.com/example-org/example-app/issues/202)** · p1 · filed 2026-08-08 · Two',
        '- **[#203](https://github.com/example-org/example-app/issues/203)** · p2 · filed 2026-08-08 · Three',
      ].join('\n'),
    );
    declare(
      JSON.stringify([
        { kind: 'defect-register', root: 'releases', channel_key: CHANNEL_KEY, file: 'defects.md', refresh_hours: 24 },
      ]),
    );
    const items = itemsByKind(groupsRoot).get('defect-register')!;
    expect(items.filter((i) => i.id.startsWith(`${ATTENTION_ITEM_PREFIX}stale:`))).toHaveLength(1);
    expect(items).toHaveLength(4);
  });

  it('emits the notice even when the stale source produced NO rows at all', () => {
    // The case that matters most: a generator that stopped is at its most
    // invisible when its last output happened to be empty.
    const items = itemsByKind(
      twoSources({ defectAsOf: WEEK_OLD, refreshHours: 24, register: emptyDefectRegister }),
    ).get('defect-register')!;
    expect(items).toHaveLength(1);
    expect(notice(items)).toBeDefined();
  });

  it('routes the notice into `needs_you`, dates it from when the source went stale, and keeps a stable id', () => {
    const items = itemsByKind(twoSources({ defectAsOf: WEEK_OLD, refreshHours: 24 })).get('defect-register')!;
    const item = notice(items)!;

    // `waiting on` verbatim is the ONLY thing that routes a parked row into
    // `needs_you` (`WAITING_ON_NOTE` in threads.ts). Without it the notice
    // lands in `unassigned` and reads as backlog rather than as an alarm.
    expect(item.claimState).toBe('parked');
    expect(item.claimNote).toMatch(/\bwaiting on\b/i);
    expect(item.claimNote).toContain('defect-register');
    expect(item.claimNote).toContain('7d');
    // `since` is when it WENT stale, never the read time: the age-fair cap
    // keeps the OLDEST rows, so `now` would make a long-dead generator the
    // first row dropped.
    expect(item.since).toBe(WEEK_OLD);
    expect(item.sessionCount).toBe(0);
    expect(item.url).toBeNull();
    expect(item.channel_key).toBe(CHANNEL_KEY);
    // Derived from the declaration alone — no clock, no list position — so an
    // assignment reservation on it still matches on the next poll.
    expect(item.id).toBe(`${ATTENTION_ITEM_PREFIX}stale:defect-register:releases:defects.md`);
  });

  it('gives the notice an id that can never become a channel key', () => {
    const items = itemsByKind(twoSources({ defectAsOf: WEEK_OLD, refreshHours: 24 })).get('defect-register')!;
    const item = notice(items)!;
    // The `board:` stamp is what `threadChannelKey` gates on. Without it the
    // parser reads `stale:defect-register:...` as platform plus channel and
    // mints one fake sidebar bucket per dead source — the per-row bucket §3.2
    // forbids.
    expect(isAttentionItemId(item.id)).toBe(true);
    expect(threadChannelKey(item.id)).toBe(UNKNOWN_CHANNEL_KEY);
  });

  it('gives two sources of the same kind their own notices rather than collapsing them', () => {
    const groupsRoot = boardRoot([]);
    const dir = path.join(groupsRoot, WORKGROUP, 'releases');
    fs.writeFileSync(path.join(dir, 'defects.md'), emptyDefectRegister(WEEK_OLD));
    fs.writeFileSync(path.join(dir, 'other-defects.md'), emptyDefectRegister(WEEK_OLD));
    declare(
      JSON.stringify([
        { kind: 'defect-register', root: 'releases', channel_key: CHANNEL_KEY, file: 'defects.md', refresh_hours: 24 },
        {
          kind: 'defect-register',
          root: 'releases',
          channel_key: CHANNEL_KEY,
          file: 'other-defects.md',
          refresh_hours: 24,
        },
      ]),
    );
    expect(
      itemsByKind(groupsRoot)
        .get('defect-register')!
        .map((i) => i.id),
    ).toEqual([
      `${ATTENTION_ITEM_PREFIX}stale:defect-register:releases:defects.md`,
      `${ATTENTION_ITEM_PREFIX}stale:defect-register:releases:other-defects.md`,
    ]);
  });

  it('never suppresses a stale source own rows — the rule is mark, never hide', () => {
    const items = itemsByKind(twoSources({ defectAsOf: WEEK_OLD, refreshHours: 24 })).get('defect-register')!;
    expect(items.map((i) => i.id)).toContain(`${ATTENTION_ITEM_PREFIX}defect:example-org/example-app#201`);
  });
});
