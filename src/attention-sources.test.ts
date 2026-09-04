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
import { deriveThreadState, threadChannelKey, UNKNOWN_CHANNEL_KEY } from './dashboard/api/threads.js';
import { closeDb, getRawDb, initTestDb } from './db/connection.js';
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
  getRawDb().prepare(`UPDATE workgroups SET attention_sources = ? WHERE id = ?`).run(value, WORKGROUP);
}

beforeEach(async () => {
  clearAttentionMemo();
  await initTestDb();
  const db = getRawDb();
  runMigrations(db);
  db.prepare(
    `INSERT OR IGNORE INTO workgroups (id, display_name, onecli_secrets, created_at)
     VALUES (?, ?, '[]', '2026-08-01T00:00:00.000Z')`,
  ).run(WORKGROUP, 'Example Labs');
});

afterEach(async () => {
  vi.restoreAllMocks();
  clearAttentionMemo();
  await closeDb();
  while (tmpdirs.length) fs.rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

describe('parseAttentionSources', () => {
  it('reads a well-formed declaration, and reports no defect', () => {
    expect(
      parseAttentionSources(`[{"kind":"release-board","root":"releases","channel_key":"${CHANNEL_KEY}"}]`),
    ).toEqual({ decls: [{ kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY }], defects: [] });
  });

  it('treats NULL and empty as "declared nothing", not as malformed', () => {
    expect(parseAttentionSources(null)).toEqual({ decls: [], defects: [] });
    expect(parseAttentionSources(undefined)).toEqual({ decls: [], defects: [] });
    expect(parseAttentionSources('   ')).toEqual({ decls: [], defects: [] });
  });

  it.each([
    ['not json at all', '{ nope', 'attention_sources'],
    ['a JSON object rather than an array', '{"kind":"release-board"}', 'attention_sources'],
    ['an entry that is not an object', '["release-board"]', 'declaration'],
    ['a missing kind', `[{"root":"releases","channel_key":"${CHANNEL_KEY}"}]`, 'kind'],
    ['an empty kind', `[{"kind":"  ","root":"releases","channel_key":"${CHANNEL_KEY}"}]`, 'kind'],
    ['a missing root', `[{"kind":"release-board","channel_key":"${CHANNEL_KEY}"}]`, 'root'],
    ['an absolute root', `[{"kind":"release-board","root":"/etc","channel_key":"${CHANNEL_KEY}"}]`, 'root'],
    ['a traversing root', `[{"kind":"release-board","root":"../../etc","channel_key":"${CHANNEL_KEY}"}]`, 'root'],
    [
      'a channel_key with no platform segment',
      '[{"kind":"release-board","root":"releases","channel_key":"C1"}]',
      'channel_key',
    ],
  ])('drops the source and names the field on %s', (_why, raw, field) => {
    const parsed = parseAttentionSources(raw);
    expect(parsed.decls).toEqual([]);
    expect(parsed.defects.map((d) => d.field)).toEqual([field]);
    // Every one of these names bytes the provider has to read, or the room its
    // rows have to land in. Without them the source genuinely cannot be read.
    expect(parsed.defects.map((d) => d.disablesSource)).toEqual([true]);
  });

  it('carries the optional per-provider `file` and `branch` through', () => {
    expect(
      parseAttentionSources(
        `[{"kind":"branch-ci","root":"releases","channel_key":"${CHANNEL_KEY}","file":"release-state.json","branch":"develop"}]`,
      ).decls,
    ).toEqual([
      { kind: 'branch-ci', root: 'releases', channel_key: CHANNEL_KEY, file: 'release-state.json', branch: 'develop' },
    ]);
  });

  it('omits `file`/`branch` entirely when they are not declared, rather than setting them undefined', () => {
    expect(
      parseAttentionSources(`[{"kind":"release-board","root":"releases","channel_key":"${CHANNEL_KEY}"}]`).decls[0]!,
    ).not.toHaveProperty('file');
  });

  it.each([
    [
      'an absolute file',
      `[{"kind":"defect-register","root":"r","channel_key":"${CHANNEL_KEY}","file":"/etc/passwd"}]`,
      'file',
    ],
    [
      'a traversing file',
      `[{"kind":"defect-register","root":"r","channel_key":"${CHANNEL_KEY}","file":"../x.md"}]`,
      'file',
    ],
    ['a non-string file', `[{"kind":"defect-register","root":"r","channel_key":"${CHANNEL_KEY}","file":7}]`, 'file'],
    ['an empty file', `[{"kind":"defect-register","root":"r","channel_key":"${CHANNEL_KEY}","file":""}]`, 'file'],
    ['a non-string branch', `[{"kind":"branch-ci","root":"r","channel_key":"${CHANNEL_KEY}","branch":true}]`, 'branch'],
    [
      'a branch with a space',
      `[{"kind":"branch-ci","root":"r","channel_key":"${CHANNEL_KEY}","branch":"de v"}]`,
      'branch',
    ],
  ])('drops the source and names the field on %s', (_why, raw, field) => {
    // Present-and-wrong points the provider at bytes that are not there, so the
    // source is unreadable — exactly like a bad `root`.
    const parsed = parseAttentionSources(raw);
    expect(parsed.decls).toEqual([]);
    expect(parsed.defects.map((d) => d.field)).toEqual([field]);
    expect(parsed.defects.map((d) => d.disablesSource)).toEqual([true]);
  });

  it('disables ONLY the malformed declaration — its siblings keep working', () => {
    // The bug this shape exists to end. This used to return `null` for the
    // WHOLE workgroup the moment any one entry failed any check, so one typo
    // deleted every real row the workgroup had — and an empty queue reads as
    // "nothing is blocked on a human", the one lie this feature prevents.
    const raw = JSON.stringify([
      { kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY },
      { kind: 'release-board', root: '../escape', channel_key: CHANNEL_KEY },
      { kind: 'defect-register', root: 'releases', channel_key: CHANNEL_KEY, file: 'defects.md' },
    ]);
    const parsed = parseAttentionSources(raw);
    expect(parsed.decls.map((d) => d.root)).toEqual(['releases', 'releases']);
    expect(parsed.defects.map((d) => [d.index, d.field])).toEqual([[1, 'root']]);
  });

  it('names the broken declaration by whatever of it parsed, not only by the failing field', () => {
    // A declaration whose `root` is unusable may still have named a perfectly
    // good `kind` and `channel_key`. Reporting the failing field alone would
    // leave the operator hunting which of four entries it meant.
    const parsed = parseAttentionSources(
      `[{"kind":"defect-register","root":"../escape","channel_key":"${CHANNEL_KEY}","file":"defects.md"}]`,
    );
    expect(parsed.defects[0]).toMatchObject({
      index: 0,
      kind: 'defect-register',
      root: '../escape',
      file: 'defects.md',
      channelKey: CHANNEL_KEY,
      field: 'root',
    });
  });

  it('still reports a declaration too broken to name itself, by position', () => {
    // An unnameable error is still an error the operator must see. Position is
    // the only handle such an entry has, so it is the only case that may use it.
    const parsed = parseAttentionSources(
      JSON.stringify([{ kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY }, 42]),
    );
    expect(parsed.decls).toHaveLength(1);
    expect(parsed.defects).toMatchObject([{ index: 1, kind: null, field: 'declaration' }]);
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

  it('reports a malformed declaration as a work item instead of blanking the workgroup', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    declare(`[{"kind":"release-board","root":"../escape","channel_key":"${CHANNEL_KEY}"}]`);
    const read = readAttentionItems(WORKGROUP, NOW, { groupsRoot: boardRoot([readyPr()]) });
    // The source really is unreadable, so it emits no board rows — but the feed
    // is NOT silent about why.
    expect(read.items.map((i) => i.id)).toEqual([`${ATTENTION_ITEM_PREFIX}misconfigured:release-board:../escape:root`]);
    expect(warn).toHaveBeenCalledWith(
      'Attention sources: malformed declaration, reporting it as a work item',
      expect.objectContaining({ workgroupId: WORKGROUP, field: 'root' }),
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
        ).decls,
      ).toEqual([{ kind: 'defect-register', root: 'r', channel_key: CHANNEL_KEY, refresh_hours: 6 }]);
    });

    it('omits it entirely when undeclared, rather than setting it undefined', () => {
      expect(
        parseAttentionSources(`[{"kind":"release-board","root":"releases","channel_key":"${CHANNEL_KEY}"}]`).decls[0]!,
      ).not.toHaveProperty('refresh_hours');
    });

    it.each([
      ['a string cadence', `[{"kind":"d","root":"r","channel_key":"${CHANNEL_KEY}","refresh_hours":"6h"}]`],
      ['a zero cadence', `[{"kind":"d","root":"r","channel_key":"${CHANNEL_KEY}","refresh_hours":0}]`],
      ['a negative cadence', `[{"kind":"d","root":"r","channel_key":"${CHANNEL_KEY}","refresh_hours":-1}]`],
      ['a null cadence', `[{"kind":"d","root":"r","channel_key":"${CHANNEL_KEY}","refresh_hours":null}]`],
    ])('keeps the source and drops only the claim on %s', (_why, raw) => {
      // A cadence names no bytes — it gates a display marker and nothing else,
      // so it can only ever cost the marker. Degrading SILENTLY to "no claim"
      // would still be wrong (indistinguishable from an operator who chose not
      // to declare one), which is what the defect is for.
      const parsed = parseAttentionSources(raw);
      expect(parsed.decls).toEqual([{ kind: 'd', root: 'r', channel_key: CHANNEL_KEY }]);
      expect(parsed.defects.map((d) => [d.field, d.disablesSource])).toEqual([['refresh_hours', false]]);
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

/**
 * A misconfigured declaration, and the row that reports it.
 *
 * The bug these pin: `parseAttentionSources` used to return `null` — meaning the
 * WHOLE workgroup emitted nothing — the moment ANY single declaration failed ANY
 * check, `refresh_hours` included. A one-character typo in a display-only cadence
 * hint (`"6h"` for `6`) therefore deleted every real work item that workgroup
 * had, and the operator saw an empty queue, which reads as "nothing is blocked on
 * a human" — the single failure mode this whole feature exists to prevent.
 *
 * The rule now: no config error may ever reduce the feed to silence. Three
 * states, not two — healthy, explicitly-not-declared, and
 * misconfigured-and-saying-so.
 */
describe('misconfigured declarations', () => {
  /** The `misconfigured:` notices among a read's items. */
  function notices(items: AttentionItem[]): AttentionItem[] {
    return items.filter((i) => i.id.startsWith(`${ATTENTION_ITEM_PREFIX}misconfigured:`));
  }

  /** Everything that is NOT a notice — the real work the feed must never lose. */
  function work(items: AttentionItem[]): string[] {
    return items.filter((i) => !i.id.startsWith(`${ATTENTION_ITEM_PREFIX}misconfigured:`)).map((i) => i.id);
  }

  function read(groupsRoot: string): AttentionItem[] {
    return readAttentionItems(WORKGROUP, NOW, { groupsRoot, claimsRoot: tmp('nc-attn-claims-') }).items;
  }

  /** A groups root with a release board AND a defect register, both readable. */
  function twoReadableSources(): string {
    const groupsRoot = boardRoot([readyPr()], FRESH);
    fs.writeFileSync(path.join(groupsRoot, WORKGROUP, 'releases', 'defects.md'), defectRegister(FRESH));
    return groupsRoot;
  }

  it('one malformed declaration does not suppress its siblings', () => {
    // Three declarations, one typo. The other two are perfectly readable and
    // their items are real blocked work; subtracting them to signal a bad field
    // is disproportionate, and an empty queue is the lie the queue prevents.
    declare(
      JSON.stringify([
        { kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY },
        { kind: 'defect-register', root: '../escape', channel_key: CHANNEL_KEY, file: 'defects.md' },
        { kind: 'defect-register', root: 'releases', channel_key: CHANNEL_KEY, file: 'defects.md' },
      ]),
    );
    expect(work(read(twoReadableSources()))).toEqual([
      `${ATTENTION_ITEM_PREFIX}EXAMPLE-APP#817`,
      `${ATTENTION_ITEM_PREFIX}defect:example-org/example-app#201`,
    ]);
  });

  it('a bad `refresh_hours` still emits the source items, with NO staleness claim', () => {
    // A cadence is a display marker. It may gate the marker; it may never gate
    // the rows. `null` and not `false`: unknown is not fresh.
    declare(
      JSON.stringify([{ kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY, refresh_hours: '6h' }]),
    );
    const items = read(twoReadableSources());
    const board = items.filter((i) => i.id === `${ATTENTION_ITEM_PREFIX}EXAMPLE-APP#817`);
    expect(board).toHaveLength(1);
    expect(board[0]!.sourceStale).toBeNull();
    expect(board[0]!.sourceAsOf).toBe(FRESH);
    // …and the bad value is not silent, which is the concern the old
    // fail-closed rule was protecting.
    expect(notices(items).map((i) => i.id)).toEqual([
      `${ATTENTION_ITEM_PREFIX}misconfigured:release-board:releases:refresh_hours`,
    ]);
  });

  it('an unusable `file` emits no items for that source, but still emits the notice', () => {
    // The other half of the distinction: this declaration names bytes that are
    // not there, so the source genuinely cannot be read and emitting nothing
    // for it is correct — emitting nothing ABOUT it is not.
    declare(
      JSON.stringify([{ kind: 'defect-register', root: 'releases', channel_key: CHANNEL_KEY, file: '../defects.md' }]),
    );
    const items = read(twoReadableSources());
    expect(work(items)).toEqual([]);
    expect(items.map((i) => i.id)).toEqual([
      `${ATTENTION_ITEM_PREFIX}misconfigured:defect-register:releases:../defects.md:file`,
    ]);
    expect(items[0]!.sourceKind).toBe('defect-register');
    expect(items[0]!.claimNote).toContain('emitting no items at all');
  });

  it('emits EXACTLY ONE notice per malformed declaration', () => {
    // Two broken entries, two notices — one each, never one per bad field
    // restating the same entry.
    declare(
      JSON.stringify([
        { kind: 'release-board', root: '/absolute', channel_key: CHANNEL_KEY, refresh_hours: 'nope' },
        { kind: 'defect-register', root: 'releases', channel_key: CHANNEL_KEY, file: 'defects.md', refresh_hours: 0 },
      ]),
    );
    const items = read(twoReadableSources());
    expect(notices(items).map((i) => i.id)).toEqual([
      `${ATTENTION_ITEM_PREFIX}misconfigured:release-board:/absolute:root`,
      `${ATTENTION_ITEM_PREFIX}misconfigured:defect-register:releases:defects.md:refresh_hours`,
    ]);
  });

  it('still emits a notice for a declaration too broken to name at all', () => {
    // Not an object, no usable `kind`: position is the only handle it has, and
    // an unnameable error is still an error the operator must see.
    declare(JSON.stringify(['release-board', { kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY }]));
    const items = read(twoReadableSources());
    expect(notices(items).map((i) => i.id)).toEqual([`${ATTENTION_ITEM_PREFIX}misconfigured:#0:declaration`]);
    // The healthy sibling still emits, which is the whole point.
    expect(work(items)).toContain(`${ATTENTION_ITEM_PREFIX}EXAMPLE-APP#817`);
    // With no `kind` to stamp, provenance says what it is rather than inventing
    // a plausible provider name.
    expect(notices(items)[0]!.sourceKind).toBe('attention-source');
    // And with no `channel_key` to route to, it lands in the same nowhere
    // bucket the thread parser uses. Nobody is wired to nowhere.
    expect(notices(items)[0]!.channel_key).toBe(UNKNOWN_CHANNEL_KEY);
  });

  it('emits a notice even when the whole column is unreadable', () => {
    declare('{ not json');
    expect(read(twoReadableSources()).map((i) => i.id)).toEqual([
      `${ATTENTION_ITEM_PREFIX}misconfigured:declaration:attention_sources`,
    ]);
  });

  it('routes the notice into `needs_you`, and dates it so the age cap can never cut it', () => {
    declare(
      JSON.stringify([{ kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY, refresh_hours: '6h' }]),
    );
    const item = notices(read(twoReadableSources()))[0]!;

    // `waiting on` verbatim is the ONLY thing that routes a parked row into
    // `needs_you` (`WAITING_ON_NOTE` in threads.ts). Without it the notice
    // lands in `unassigned` and reads as backlog rather than as an alarm.
    expect(item.claimState).toBe('parked');
    expect(item.claimNote).toMatch(/\bwaiting on\b/i);
    expect(
      deriveThreadState({
        sessionCount: item.sessionCount,
        claimState: item.claimState,
        claimNote: item.claimNote ?? '',
        needsOperator: false,
        containerStatus: 'unknown',
        providerStatus: null,
        toolStartedAtMs: null,
        lastOutputAtMs: null,
        now: NOW,
      }),
    ).toBe('needs_you');

    // Actionable in the operator's own terms: which workgroup, which
    // declaration, which field, what it costs, and that staleness is unchecked.
    expect(item.claimNote).toContain(WORKGROUP);
    expect(item.claimNote).toContain('release-board');
    expect(item.claimNote).toContain('refresh_hours');
    expect(item.claimNote).toContain('carry no staleness marker');
    expect(item.claimNote).toContain('staleness is not being checked for it');
    expect(item.nextAction).toContain('refresh_hours');
    expect(item.url).toBeNull();
    expect(item.channel_key).toBe(CHANNEL_KEY);

    // `since` is a SENTINEL, not a measurement: there is no "when it broke"
    // timestamp anywhere in this path. `now` would be the plausible lie — it
    // re-dates on every poll, and `cappedByAge` keeps the OLDEST rows, so a
    // perpetually-fresh notice is the FIRST one dropped when the cap bites.
    expect(item.since).toBe('1970-01-01T00:00:00.000Z');
    expect(Date.parse(item.since)).toBe(0);

    // No staleness claim of its own — the seam knows the declaration is broken,
    // not anything about the bytes behind it.
    expect(item.sourceAsOf).toBeNull();
    expect(item.sourceStale).toBeNull();
  });

  it('gives the notice an id that can never become a channel key', () => {
    declare(
      JSON.stringify([{ kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY, refresh_hours: '6h' }]),
    );
    const item = notices(read(twoReadableSources()))[0]!;
    // The `board:` stamp is what `threadChannelKey` gates on. Without it the
    // parser reads `misconfigured:release-board:...` as platform plus channel
    // and mints one fake sidebar bucket per broken declaration — the per-row
    // bucket §3.2 forbids.
    expect(isAttentionItemId(item.id)).toBe(true);
    expect(threadChannelKey(item.id)).toBe(UNKNOWN_CHANNEL_KEY);
  });

  it('keeps the id stable across polls, so an assignment reservation survives', () => {
    declare(
      JSON.stringify([{ kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY, refresh_hours: '6h' }]),
    );
    const groupsRoot = twoReadableSources();
    const first = notices(read(groupsRoot))[0]!.id;
    clearAttentionMemo();
    const later = readAttentionItems(WORKGROUP, NOW + 10 * ATTENTION_MEMO_TTL_MS, {
      groupsRoot,
      claimsRoot: tmp('nc-attn-claims-'),
    }).items;
    expect(notices(later)[0]!.id).toBe(first);
  });

  it('emits no notices at all for a fully valid workgroup', () => {
    declare(
      JSON.stringify([
        { kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY, refresh_hours: 6 },
        { kind: 'defect-register', root: 'releases', channel_key: CHANNEL_KEY, file: 'defects.md', refresh_hours: 6 },
      ]),
    );
    const items = read(twoReadableSources());
    expect(notices(items)).toEqual([]);
    expect(items.map((i) => i.id)).toEqual([
      `${ATTENTION_ITEM_PREFIX}EXAMPLE-APP#817`,
      `${ATTENTION_ITEM_PREFIX}defect:example-org/example-app#201`,
    ]);
  });
});
