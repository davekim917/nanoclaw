import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, it, expect, vi } from 'vitest';

import { log } from '../../log.js';

import {
  deriveBoardAttentionItems,
  readReleaseBoardSource,
  type GateShipRecord,
  type ReleaseStateItem,
  type OpenPrState,
} from './board-attention.js';
import type { AttentionSourceDecl } from '../../attention-sources.js';
import type { BoardClaim } from '../../claims-board.js';

/**
 * Every identifier below is a FIXTURE identifier and must stay one.
 * `scripts/check-public-boundary.ts` scans this tree for real Slack channel
 * ids, real repo names and real people; its Slack rule only accepts ids
 * carrying one of a fixed set of synthetic words (`EXAMPLE`, `FIXTURE`,
 * `TEST`, …). Do not paste a live board's contents in here to "make the test
 * realistic" — the shapes are what the code reads, and the shapes are here.
 */
const WORKGROUP = 'example-labs';
const CHANNEL_KEY = 'slack:CEXAMPLE001';
const BINDING = { workgroupId: WORKGROUP, channelKey: CHANNEL_KEY };
const DECL: AttentionSourceDecl = { kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY };

function item(over: Partial<ReleaseStateItem> = {}): ReleaseStateItem {
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

function claim(over: Partial<BoardClaim> = {}): BoardClaim {
  return {
    slug: 'gh-1',
    owner: 'ollie',
    note: 'waiting on alice',
    threadId: null,
    state: 'parked',
    staleMs: 0,
    escalated: false,
    ...over,
  };
}

const ASOF = '2026-08-22T12:01:41Z';

describe('deriveBoardAttentionItems', () => {
  it('emits a board item for a mechanically-ready PR blocked on a human', () => {
    const out = deriveBoardAttentionItems([item()], ASOF, [], [], BINDING);
    expect(out).toEqual([
      {
        id: 'EXAMPLE-APP#817',
        channel_key: CHANNEL_KEY,
        title: "What's new digest",
        url: 'https://github.com/example-org/example-app/pull/817',
        workgroupId: WORKGROUP,
        claimState: 'parked',
        claimNote: 'waiting on alice: CI green, mergeable CLEAN',
        claimOwner: 'alice',
        participants: [],
        sessionCount: 0,
        since: '2026-08-13T00:00:00Z',
        nextAction: '@releasebot ship 817',
      },
    ]);
  });

  it('takes its channel and workgroup from the BINDING, never from the source item', () => {
    // The whole reason this producer can live in a public trunk: the install's
    // identifiers arrive in the declaration, so there is nothing here to leak.
    const out = deriveBoardAttentionItems([item()], ASOF, [], [], {
      workgroupId: 'other-workgroup',
      channelKey: 'discord:123456789012345678:123456789098765432',
    });
    expect(out[0]!.workgroupId).toBe('other-workgroup');
    expect(out[0]!.channel_key).toBe('discord:123456789012345678:123456789098765432');
  });

  it('drops items whose nextMover is not human', () => {
    const out = deriveBoardAttentionItems([item({ nextMover: 'agent' })], ASOF, [], [], BINDING);
    expect(out).toEqual([]);
  });

  it('drops non-pr items even when nextMover is human (no PR number to dedupe/board against)', () => {
    const out = deriveBoardAttentionItems(
      [item({ id: 'example-decision-chains-editable', kind: 'decision', url: null })],
      ASOF,
      [],
      [],
      BINDING,
    );
    expect(out).toEqual([]);
  });

  it('excludes a ship recorded at-or-after the snapshot asOf', () => {
    const shipped: GateShipRecord[] = [{ target: 'EXAMPLE-APP#817', ts: '2026-08-22T12:05:00Z' }];
    const out = deriveBoardAttentionItems([item()], ASOF, shipped, [], BINDING);
    expect(out).toEqual([]);
  });

  /**
   * The timestamps on both sides of this comparison are PARSED, never compared
   * as strings. `ts` is agent-written into a gates file and `asOf` comes off
   * the snapshot, so neither is guaranteed to be the ISO-UTC shape the other
   * is — and lexical order disagrees with chronological order in both
   * directions once an offset form or a naive form turns up.
   *
   * Both miscompares point the DANGEROUS way. A spurious "shipped since the
   * snapshot" adds the PR to the suppression set and a ready-to-ship row
   * silently disappears from the queue, which is the invisibility this whole
   * feed exists to end.
   */
  describe('ship timestamps are compared as instants, not as strings', () => {
    it('does not suppress on an offset-form stamp that only LOOKS later', () => {
      // 14:30+09:00 is 05:30Z — over six hours BEFORE the snapshot's 12:01:41Z.
      // As strings it sorts AFTER, so `>=` says "shipped since the snapshot"
      // and the ready PR vanishes. The two assertions below pin exactly that
      // disagreement, so this test cannot quietly stop being about it.
      const shipped: GateShipRecord[] = [{ target: 'EXAMPLE-APP#817', ts: '2026-08-22T14:30:00+09:00' }];
      expect('2026-08-22T14:30:00+09:00' >= ASOF).toBe(true); // lexically "later"…
      expect(Date.parse('2026-08-22T14:30:00+09:00')).toBeLessThan(Date.parse(ASOF)); // …chronologically earlier
      const out = deriveBoardAttentionItems([item()], ASOF, shipped, [], BINDING);
      expect(out).toHaveLength(1);
    });

    it('still suppresses on an offset-form stamp that is genuinely later', () => {
      const shipped: GateShipRecord[] = [{ target: 'EXAMPLE-APP#817', ts: '2026-08-22T16:30:00+02:00' }];
      expect(deriveBoardAttentionItems([item()], ASOF, shipped, [], BINDING)).toEqual([]);
    });

    it('suppresses nothing when a ship stamp will not parse', () => {
      const shipped: GateShipRecord[] = [{ target: 'EXAMPLE-APP#817', ts: 'whenever' }];
      expect(deriveBoardAttentionItems([item()], ASOF, shipped, [], BINDING)).toHaveLength(1);
    });

    it('suppresses nothing at all when the snapshot asOf will not parse', () => {
      // No reference point means no honest comparison. Showing a row one cycle
      // too long is visible and self-correcting; hiding one is not.
      const shipped: GateShipRecord[] = [{ target: 'EXAMPLE-APP#817', ts: '2999-01-01T00:00:00Z' }];
      expect(deriveBoardAttentionItems([item()], 'not-a-timestamp', shipped, [], BINDING)).toHaveLength(1);
    });
  });

  it('does NOT exclude a stale failed ship attempt from before the snapshot', () => {
    // Real shape from a live gates log: a "ship" action recorded weeks earlier
    // whose own raw text says "NOT MERGED — precondition unmet". The item is
    // still open (present in release-state.json, nextMover still human) at the
    // current snapshot, so a naive "any ship ever" exclusion would hide a PR
    // that is still blocked — the exact invisibility bug this feed exists to
    // fix. Two live PRs were in this state when the producer was written.
    const oldFailedAttempt: GateShipRecord[] = [{ target: 'EXAMPLE-ANALYTICS#96', ts: '2026-08-11T02:22:43Z' }];
    const out = deriveBoardAttentionItems(
      [item({ id: 'EXAMPLE-ANALYTICS#96', url: 'https://github.com/example-org/example-analytics/pull/96' })],
      ASOF,
      oldFailedAttempt,
      [],
      BINDING,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('EXAMPLE-ANALYTICS#96');
  });

  it.each([
    ['the bare slug', 'gh-956'],
    ['a trailing description', 'gh-956-scope-guards'],
    ['a prefix in front of it', 'example-gh-956-scope-guards'],
    ['a second PR number after it', 'gh-956-964-scope-guards'],
  ])('suppresses a board item when the claim slug carries gh-<n> with %s', (_label, slug) => {
    const claims = [claim({ slug, note: 'working the scope guard rewrite' })];
    const out = deriveBoardAttentionItems(
      [item({ id: 'EXAMPLE-APP#956', url: 'https://github.com/example-org/example-app/pull/956' })],
      ASOF,
      [],
      claims,
      BINDING,
    );
    expect(out).toEqual([]);
  });

  it('does not treat gh-<n> as a prefix of a longer number', () => {
    const claims = [claim({ slug: 'gh-9561-scope-guards', note: 'unrelated' })];
    const out = deriveBoardAttentionItems(
      [item({ id: 'EXAMPLE-APP#956', url: 'https://github.com/example-org/example-app/pull/956' })],
      ASOF,
      [],
      claims,
      BINDING,
    );
    expect(out).toHaveLength(1);
  });

  /**
   * The rule that replaced a loose `(^|-)<n>-` slug alternative. A claim slug
   * is an unconstrained filename, so that shape matched any incidental number
   * anywhere in any slug — every case below is a REAL live claim slug (with
   * the install's own prefix swapped for `example-`) that would have silently
   * deleted the named PR from the queue.
   *
   * These assert the SAFE direction. Suppressing here would hide real blocked
   * work with no trace; not suppressing at worst shows one PR twice, which is
   * visible and self-corrects. A claim on a PR whose slug does not say `gh`
   * has to name `#<n>` in its note — the case directly below.
   */
  it.each([
    ['1', 'sprint-1-planning'],
    ['1', 'step-1-of-3'],
    ['1', 'release-1-notes'],
    ['7', 'example-7-day-retention'],
    ['1800', 'example-outreach-deck-proximo-1800-la'],
    ['216', 'example-216-universe-group-activation'],
    ['902', 'example-ch-902-01'],
  ])('does NOT suppress PR #%s on the incidental number in slug %s', (n, slug) => {
    const claims = [claim({ slug, note: 'unrelated work' })];
    const out = deriveBoardAttentionItems(
      [item({ id: `EXAMPLE-APP#${n}`, url: `https://github.com/example-org/example-app/pull/${n}` })],
      ASOF,
      [],
      claims,
      BINDING,
    );
    expect(out.map((i) => i.id)).toEqual([`EXAMPLE-APP#${n}`]);
  });

  it('a non-gh slug still suppresses when its NOTE names the PR', () => {
    // The live counterpart of the slugs above: `<prefix>-956-scope-guards`
    // carries no `gh` token, but its note says `#956`. That note is what
    // suppression rests on now, and it is a claim the author actually wrote
    // rather than a number that happened to appear in a filename.
    const claims = [claim({ slug: 'example-956-scope-guards', note: 'waiting on alice: PR #956 mechanically ready' })];
    const out = deriveBoardAttentionItems(
      [item({ id: 'EXAMPLE-APP#956', url: 'https://github.com/example-org/example-app/pull/956' })],
      ASOF,
      [],
      claims,
      BINDING,
    );
    expect(out).toEqual([]);
  });

  it('suppresses a board item when a claim NOTE mentions #<n> even though the slug encodes a different number', () => {
    // Real live case: a claim file whose slug encodes an unrelated tracking
    // number while its note names the PR. Either match wins, because the claim
    // carries a richer reason and a real owner than the board item would.
    const claims = [
      claim({
        slug: 'gh-963',
        note: 'waiting on a human: PR #956 mechanically ready but the consequence lane has no recorded human ship',
      }),
    ];
    const out = deriveBoardAttentionItems(
      [item({ id: 'EXAMPLE-APP#956', url: 'https://github.com/example-org/example-app/pull/956' })],
      ASOF,
      [],
      claims,
      BINDING,
    );
    expect(out).toEqual([]);
  });

  it('does not false-positive on a note number that is a substring of a longer number', () => {
    const claims = [claim({ slug: 'gh-9561', note: 'something about #9561' })];
    const out = deriveBoardAttentionItems(
      [item({ id: 'EXAMPLE-APP#956', url: 'https://github.com/example-org/example-app/pull/956' })],
      ASOF,
      [],
      claims,
      BINDING,
    );
    expect(out).toHaveLength(1);
  });

  it.each([
    ['omits owner entirely', undefined],
    ['carries an explicit null owner — the live shape on XZO#956', null],
    ['carries whitespace', '   '],
  ])('says "a human" and leaves claimOwner null when the source item %s', (_label, owner) => {
    const out = deriveBoardAttentionItems([item({ owner })], ASOF, [], [], BINDING);
    expect(out[0]!.claimOwner).toBeNull();
    expect(out[0]!.claimNote).toBe('waiting on a human: CI green, mergeable CLEAN');
  });

  it.each([
    ['a named owner', 'alice' as string | null],
    ['no owner', null as string | null],
  ])('the claimNote satisfies the WAITING_ON_NOTE routing regex (/\\bwaiting on\\b/i) with %s', (_label, owner) => {
    // That regex is the ONLY thing that puts these rows in the needs_you lane.
    // A wording change that stops matching it produces rows that land nowhere.
    const out = deriveBoardAttentionItems([item({ owner })], ASOF, [], [], BINDING);
    expect(out[0]!.claimNote).toMatch(/\bwaiting on\b/i);
  });

  it('participants is always an empty array, never null/undefined', () => {
    const out = deriveBoardAttentionItems([item()], ASOF, [], [], BINDING);
    expect(out[0]!.participants).toEqual([]);
  });

  it('maps multiple ready PRs, skipping only the shipped/claimed ones', () => {
    const items = [
      item({ id: 'EXAMPLE-APP#907', url: 'https://github.com/example-org/example-app/pull/907' }),
      item({ id: 'EXAMPLE-APP#923', url: 'https://github.com/example-org/example-app/pull/923' }),
      item({ id: 'EXAMPLE-APP#956', url: 'https://github.com/example-org/example-app/pull/956' }),
    ];
    const claims = [claim({ slug: 'example-gh-956-scope-guards', note: 'on it' })];
    const out = deriveBoardAttentionItems(items, ASOF, [], claims, BINDING);
    expect(out.map((i) => i.id)).toEqual(['EXAMPLE-APP#907', 'EXAMPLE-APP#923']);
  });
});

/* ─── IO reader ────────────────────────────────────────────────────────────── */

const tmpdirs: string[] = [];

function board(files: { state?: unknown; gates?: Record<string, string> }): { groupsRoot: string; claimsRoot: string } {
  const groupsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-board-'));
  const claimsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-claims-'));
  tmpdirs.push(groupsRoot, claimsRoot);
  const dir = path.join(groupsRoot, WORKGROUP, 'releases');
  fs.mkdirSync(dir, { recursive: true });
  if (files.state !== undefined) {
    fs.writeFileSync(
      path.join(dir, 'release-state.json'),
      typeof files.state === 'string' ? files.state : JSON.stringify(files.state),
    );
  }
  if (files.gates) {
    fs.mkdirSync(path.join(dir, 'gates'), { recursive: true });
    for (const [name, body] of Object.entries(files.gates)) fs.writeFileSync(path.join(dir, 'gates', name), body);
  }
  return { groupsRoot, claimsRoot };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tmpdirs.length) fs.rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

describe('readReleaseBoardSource', () => {
  it('reads the declared root and returns the board asOf alongside the items', () => {
    const env = board({ state: { asOf: ASOF, items: [item()] } });
    const read = readReleaseBoardSource(DECL, WORKGROUP, Date.parse(ASOF), env);
    expect(read.asOf).toBe(ASOF);
    expect(read.items.map((i) => i.id)).toEqual(['EXAMPLE-APP#817']);
  });

  it('honours a non-default `root` from the declaration', () => {
    const groupsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-board-'));
    tmpdirs.push(groupsRoot);
    const dir = path.join(groupsRoot, WORKGROUP, 'desks', 'ship');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'release-state.json'), JSON.stringify({ asOf: ASOF, items: [item()] }));
    const read = readReleaseBoardSource({ ...DECL, root: 'desks/ship' }, WORKGROUP, Date.parse(ASOF), {
      groupsRoot,
      claimsRoot: groupsRoot,
    });
    expect(read.items).toHaveLength(1);
  });

  it('emits nothing with asOf null when the board file is absent', () => {
    // "No board" must stay distinguishable from "board says nothing is
    // blocked" — the second is a claim about the world, the first is not.
    const env = board({});
    expect(readReleaseBoardSource(DECL, WORKGROUP, Date.now(), env)).toEqual({ asOf: null, items: [] });
  });

  it('emits nothing with asOf null when the board file is malformed', () => {
    const env = board({ state: '{ this is not json' });
    expect(readReleaseBoardSource(DECL, WORKGROUP, Date.now(), env)).toEqual({ asOf: null, items: [] });
  });

  it('emits nothing when the board file parses but carries no asOf', () => {
    const env = board({ state: { items: [item()] } });
    expect(readReleaseBoardSource(DECL, WORKGROUP, Date.now(), env)).toEqual({ asOf: null, items: [] });
  });

  it('excludes an item shipped since the snapshot, reading the gates JSONL', () => {
    const env = board({
      state: { asOf: ASOF, items: [item()] },
      gates: {
        '2026-08-22.jsonl': [
          JSON.stringify({ action: 'ship', target: 'EXAMPLE-APP#817', ts: '2026-08-22T12:30:00Z' }),
          '',
        ].join('\n'),
      },
    });
    expect(readReleaseBoardSource(DECL, WORKGROUP, Date.now(), env).items).toEqual([]);
  });

  /**
   * `isSafeRelativeRoot` rejects `..` in the DECLARATION string, but the
   * declared root is a directory `container-runner.ts` bind-mounts read-write
   * into that workgroup's own containers. An agent can therefore replace it
   * (or any file under it) with a symlink into a SIBLING workgroup's folder,
   * and a string check cannot see that. These pin the resolved-path check.
   */
  describe('symlink containment', () => {
    /** Two workgroups under one groups root; WG's `releases` is the escape. */
    function twoWorkgroups(): { groupsRoot: string; victimDir: string; wgDir: string } {
      const groupsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-board-'));
      tmpdirs.push(groupsRoot);
      const victimDir = path.join(groupsRoot, 'other-workgroup', 'releases');
      fs.mkdirSync(victimDir, { recursive: true });
      fs.writeFileSync(
        path.join(victimDir, 'release-state.json'),
        JSON.stringify({ asOf: ASOF, items: [item({ title: 'SECRET neighbour board' })] }),
      );
      const wgDir = path.join(groupsRoot, WORKGROUP);
      fs.mkdirSync(wgDir, { recursive: true });
      return { groupsRoot, victimDir, wgDir };
    }

    // `dataRoot` is pinned to the same throwaway tree so these stay hermetic:
    // the resolver now also tries `<dataRoot>/workgroups/<wg>/<root>`, and
    // defaulting it to the live DATA_DIR would make the outcome depend on
    // whatever happens to exist on the host running the suite.
    const env = (groupsRoot: string) => ({ groupsRoot, claimsRoot: groupsRoot, dataRoot: groupsRoot });

    it('reads nothing when the declared root is a symlink to another workgroup', () => {
      const { groupsRoot, victimDir, wgDir } = twoWorkgroups();
      fs.symlinkSync(victimDir, path.join(wgDir, 'releases'), 'dir');
      expect(readReleaseBoardSource(DECL, WORKGROUP, Date.parse(ASOF), env(groupsRoot))).toEqual({
        asOf: null,
        items: [],
      });
    });

    it('reads nothing when release-state.json itself is the symlink', () => {
      // Pinning only the root would be a fix that looks complete: the root is
      // a directory the agent writes into, so the escape is one `ln -s` away.
      const { groupsRoot, victimDir, wgDir } = twoWorkgroups();
      const own = path.join(wgDir, 'releases');
      fs.mkdirSync(own, { recursive: true });
      fs.symlinkSync(path.join(victimDir, 'release-state.json'), path.join(own, 'release-state.json'));
      expect(readReleaseBoardSource(DECL, WORKGROUP, Date.parse(ASOF), env(groupsRoot))).toEqual({
        asOf: null,
        items: [],
      });
    });

    it('ignores a gates file that symlinks out, without blanking the feed', () => {
      const { groupsRoot, victimDir, wgDir } = twoWorkgroups();
      const own = path.join(wgDir, 'releases');
      fs.mkdirSync(path.join(own, 'gates'), { recursive: true });
      fs.writeFileSync(path.join(own, 'release-state.json'), JSON.stringify({ asOf: ASOF, items: [item()] }));
      fs.writeFileSync(
        path.join(victimDir, 'ship.jsonl'),
        JSON.stringify({ action: 'ship', target: 'EXAMPLE-APP#817', ts: '2026-08-22T12:30:00Z' }),
      );
      fs.symlinkSync(path.join(victimDir, 'ship.jsonl'), path.join(own, 'gates', '2026-08-22.jsonl'));
      // The escaping gates file is skipped, so its `ship` record never lands
      // and the item is still emitted — fail closed on the READ, not on the feed.
      const read = readReleaseBoardSource(DECL, WORKGROUP, Date.parse(ASOF), env(groupsRoot));
      expect(read.items.map((i) => i.id)).toEqual(['EXAMPLE-APP#817']);
    });

    it('a sibling directory sharing the workgroup name as a prefix is not "inside" it', () => {
      // `/groups/example-labs-evil` must not pass a containment check for
      // `/groups/example-labs` — the reason the test is prefix-plus-separator.
      const groupsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-board-'));
      tmpdirs.push(groupsRoot);
      const evil = path.join(groupsRoot, `${WORKGROUP}-evil`, 'releases');
      fs.mkdirSync(evil, { recursive: true });
      fs.writeFileSync(path.join(evil, 'release-state.json'), JSON.stringify({ asOf: ASOF, items: [item()] }));
      const wgDir = path.join(groupsRoot, WORKGROUP);
      fs.mkdirSync(wgDir, { recursive: true });
      fs.symlinkSync(evil, path.join(wgDir, 'releases'), 'dir');
      expect(readReleaseBoardSource(DECL, WORKGROUP, Date.parse(ASOF), env(groupsRoot))).toEqual({
        asOf: null,
        items: [],
      });
    });

    /**
     * The workgroup shared mount is the SECOND base.
     *
     * `reconcileWorkgroupSharedDirs` moves a shared dir into
     * `data/workgroups/<wg>/` and leaves the seed a CONTAINER-ABSOLUTE compat
     * symlink (`releases -> /workspace/workgroup/releases`) that deliberately
     * dangles on the host. Before this, the realpath under `groups/` failed and
     * the provider silently emitted nothing — a blank release board, which reads
     * as "nothing is blocked on a human". This is the case that would have made
     * moving `releases/` look like a regression.
     */
    it('reads the board from the workgroup shared mount when the seed symlink dangles', () => {
      const groupsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-board-'));
      const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-data-'));
      tmpdirs.push(groupsRoot, dataRoot);
      const shared = path.join(dataRoot, 'workgroups', WORKGROUP, 'releases');
      fs.mkdirSync(path.join(shared, 'gates'), { recursive: true });
      fs.writeFileSync(path.join(shared, 'release-state.json'), JSON.stringify({ asOf: ASOF, items: [item()] }));
      // Exactly what the migration leaves behind: unresolvable on the host.
      fs.mkdirSync(path.join(groupsRoot, WORKGROUP), { recursive: true });
      fs.symlinkSync('/workspace/workgroup/releases', path.join(groupsRoot, WORKGROUP, 'releases'));

      const read = readReleaseBoardSource(DECL, WORKGROUP, Date.parse(ASOF), {
        groupsRoot,
        claimsRoot: groupsRoot,
        dataRoot,
      });
      expect(read.asOf).toBe(ASOF);
      expect(read.items.map((i) => i.id)).toEqual(['EXAMPLE-APP#817']);
    });

    it('still reads the gates ledger after the move (the ship records keep filtering)', () => {
      // `board-attention` excludes an item once a `ship` record names it. That
      // read goes through the same containment seam, so it has to survive the
      // move too — otherwise shipped items silently reappear on the board.
      const groupsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-board-'));
      const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-data-'));
      tmpdirs.push(groupsRoot, dataRoot);
      const shared = path.join(dataRoot, 'workgroups', WORKGROUP, 'releases');
      fs.mkdirSync(path.join(shared, 'gates'), { recursive: true });
      fs.writeFileSync(path.join(shared, 'release-state.json'), JSON.stringify({ asOf: ASOF, items: [item()] }));
      fs.writeFileSync(
        path.join(shared, 'gates', '2026-08-22.jsonl'),
        JSON.stringify({ action: 'ship', target: 'EXAMPLE-APP#817', ts: '2026-08-22T12:30:00Z' }) + '\n',
      );
      fs.mkdirSync(path.join(groupsRoot, WORKGROUP), { recursive: true });
      fs.symlinkSync('/workspace/workgroup/releases', path.join(groupsRoot, WORKGROUP, 'releases'));

      const read = readReleaseBoardSource(DECL, WORKGROUP, Date.parse(ASOF), {
        groupsRoot,
        claimsRoot: groupsRoot,
        dataRoot,
      });
      expect(read.items).toHaveLength(0);
    });

    it('the groups root still WINS when both bases have a board', () => {
      // Order matters for an un-migrated install: nothing about adding a second
      // base may change which tree an existing deployment reads.
      const groupsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-board-'));
      const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-data-'));
      tmpdirs.push(groupsRoot, dataRoot);
      const own = path.join(groupsRoot, WORKGROUP, 'releases');
      fs.mkdirSync(own, { recursive: true });
      fs.writeFileSync(
        path.join(own, 'release-state.json'),
        JSON.stringify({ asOf: ASOF, items: [item({ title: 'from groups' })] }),
      );
      const shared = path.join(dataRoot, 'workgroups', WORKGROUP, 'releases');
      fs.mkdirSync(shared, { recursive: true });
      fs.writeFileSync(
        path.join(shared, 'release-state.json'),
        JSON.stringify({ asOf: ASOF, items: [item({ title: 'from shared' })] }),
      );

      const read = readReleaseBoardSource(DECL, WORKGROUP, Date.parse(ASOF), {
        groupsRoot,
        claimsRoot: groupsRoot,
        dataRoot,
      });
      expect(read.items[0].title).toContain('from groups');
    });

    it('reads nothing when the SHARED root symlinks into another workgroup', () => {
      // The security property, re-proved against the new base. Two bases is not
      // a wider boundary — each base is still one workgroup's own directory,
      // and containment is checked per-base.
      const groupsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-board-'));
      const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-data-'));
      tmpdirs.push(groupsRoot, dataRoot);
      const victim = path.join(dataRoot, 'workgroups', 'other-workgroup', 'releases');
      fs.mkdirSync(victim, { recursive: true });
      fs.writeFileSync(
        path.join(victim, 'release-state.json'),
        JSON.stringify({ asOf: ASOF, items: [item({ title: 'SECRET neighbour board' })] }),
      );
      fs.mkdirSync(path.join(dataRoot, 'workgroups', WORKGROUP), { recursive: true });
      fs.symlinkSync(victim, path.join(dataRoot, 'workgroups', WORKGROUP, 'releases'), 'dir');
      fs.mkdirSync(path.join(groupsRoot, WORKGROUP), { recursive: true });

      expect(
        readReleaseBoardSource(DECL, WORKGROUP, Date.parse(ASOF), { groupsRoot, claimsRoot: groupsRoot, dataRoot }),
      ).toEqual({ asOf: null, items: [] });
    });

    it('reads nothing when a FILE under the shared root symlinks into another workgroup', () => {
      // Leaf containment, re-proved against the new base: pinning only the root
      // leaves the escape one `ln -s` away on a directory agents write into.
      const groupsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-board-'));
      const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-data-'));
      tmpdirs.push(groupsRoot, dataRoot);
      const victim = path.join(dataRoot, 'workgroups', 'other-workgroup', 'releases');
      fs.mkdirSync(victim, { recursive: true });
      fs.writeFileSync(
        path.join(victim, 'release-state.json'),
        JSON.stringify({ asOf: ASOF, items: [item({ title: 'SECRET neighbour board' })] }),
      );
      const shared = path.join(dataRoot, 'workgroups', WORKGROUP, 'releases');
      fs.mkdirSync(shared, { recursive: true });
      fs.symlinkSync(path.join(victim, 'release-state.json'), path.join(shared, 'release-state.json'));
      fs.mkdirSync(path.join(groupsRoot, WORKGROUP), { recursive: true });

      expect(
        readReleaseBoardSource(DECL, WORKGROUP, Date.parse(ASOF), { groupsRoot, claimsRoot: groupsRoot, dataRoot }),
      ).toEqual({ asOf: null, items: [] });
    });

    it('a shared-tree sibling sharing the workgroup name as a prefix is not "inside" it', () => {
      const groupsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-board-'));
      const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-data-'));
      tmpdirs.push(groupsRoot, dataRoot);
      const evil = path.join(dataRoot, 'workgroups', `${WORKGROUP}-evil`, 'releases');
      fs.mkdirSync(evil, { recursive: true });
      fs.writeFileSync(path.join(evil, 'release-state.json'), JSON.stringify({ asOf: ASOF, items: [item()] }));
      fs.mkdirSync(path.join(dataRoot, 'workgroups', WORKGROUP), { recursive: true });
      fs.symlinkSync(evil, path.join(dataRoot, 'workgroups', WORKGROUP, 'releases'), 'dir');
      fs.mkdirSync(path.join(groupsRoot, WORKGROUP), { recursive: true });

      expect(
        readReleaseBoardSource(DECL, WORKGROUP, Date.parse(ASOF), { groupsRoot, claimsRoot: groupsRoot, dataRoot }),
      ).toEqual({ asOf: null, items: [] });
    });

    it('still reads a legitimate non-symlinked board (the check is not just "deny")', () => {

      const e = board({ state: { asOf: ASOF, items: [item()] } });
      const read = readReleaseBoardSource(DECL, WORKGROUP, Date.parse(ASOF), e);
      expect(read.asOf).toBe(ASOF);
      expect(read.items.map((i) => i.id)).toEqual(['EXAMPLE-APP#817']);
    });

    it('still reads a board reached through a symlink that stays INSIDE the workgroup', () => {
      // Containment, not "no symlinks": an install may legitimately symlink
      // `releases` to another directory in its own workgroup folder.
      const groupsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-board-'));
      tmpdirs.push(groupsRoot);
      const real = path.join(groupsRoot, WORKGROUP, 'desks', 'ship');
      fs.mkdirSync(real, { recursive: true });
      fs.writeFileSync(path.join(real, 'release-state.json'), JSON.stringify({ asOf: ASOF, items: [item()] }));
      fs.symlinkSync(real, path.join(groupsRoot, WORKGROUP, 'releases'), 'dir');
      const read = readReleaseBoardSource(DECL, WORKGROUP, Date.parse(ASOF), env(groupsRoot));
      expect(read.items).toHaveLength(1);
    });

    it('emits nothing rather than throwing when the workgroup folder does not exist', () => {
      const groupsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-board-'));
      tmpdirs.push(groupsRoot);
      expect(readReleaseBoardSource(DECL, WORKGROUP, Date.now(), env(groupsRoot))).toEqual({ asOf: null, items: [] });
    });
  });

  it('one unparseable gates line does not blank the feed', () => {
    const env = board({
      state: { asOf: ASOF, items: [item()] },
      gates: { '2026-08-22.jsonl': ['{ broken', JSON.stringify({ action: 'note', target: 'x', ts: ASOF })].join('\n') },
    });
    expect(readReleaseBoardSource(DECL, WORKGROUP, Date.now(), env).items).toHaveLength(1);
  });

  /**
   * `MAX_FILE_BYTES` bounds how big each gates file may be; nothing bounded how
   * MANY there are, and the directory is bind-mounted read-write into that
   * workgroup's own containers. The whole loop is synchronous on the
   * thread-list request path, so an unbounded file COUNT is an unbounded block
   * of the host's single event loop on every memo miss, for every viewer.
   *
   * The cap is 400 — over thirteen months of the desk's one-file-per-day
   * naming — and hitting it is LOUD on both channels: a `log.warn` and a
   * visible row. Silent truncation would be the same absence-as-fact bug this
   * seam keeps eliminating: the queue would look healthy while the source was
   * only being partly read.
   */
  describe('the gates directory has a bounded file count', () => {
    /** `n` gate files named so lexical order is chronological, oldest first. */
    function manyGates(n: number, extra: Record<string, string> = {}): Record<string, string> {
      const out: Record<string, string> = { ...extra };
      for (let i = 0; i < n; i++) out[`2000-01-01.${String(i).padStart(5, '0')}.jsonl`] = '';
      return out;
    }

    it('reads every file and emits no notice while the count is under the cap', () => {
      const env = board({ state: { asOf: ASOF, items: [item()] }, gates: manyGates(50) });
      const read = readReleaseBoardSource(DECL, WORKGROUP, Date.now(), env);
      expect(read.items.map((i) => i.id)).toEqual(['EXAMPLE-APP#817']);
    });

    it('reads only the newest files past the cap, and says so as a work item', () => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
      const env = board({ state: { asOf: ASOF, items: [item()] }, gates: manyGates(420) });
      const read = readReleaseBoardSource(DECL, WORKGROUP, Date.now(), env);

      const overflow = read.items.find((i) => i.id === 'gates-overflow');
      expect(overflow).toBeDefined();
      // `waiting on` verbatim is what routes it into `needs_you` rather than a
      // backlog nobody reads — the whole point of making it an item.
      expect(overflow!.claimNote).toContain('waiting on a human');
      expect(overflow!.claimNote).toContain('420');
      expect(overflow!.claimNote).toContain('20 are being ignored');
      // `since` is the snapshot's own asOf, never `now`: a row that re-dates
      // itself every poll is the first one the age-fair cap drops.
      expect(overflow!.since).toBe(ASOF);
      // And it never displaces the real blocked work.
      expect(read.items.map((i) => i.id)).toContain('EXAMPLE-APP#817');
      expect(warn).toHaveBeenCalledWith(
        'Release board gates: more gate files than the read cap, reading only the newest',
        expect.objectContaining({ total: 420, cap: 400, skipped: 20 }),
      );
    });

    it('keeps the NEWEST files, so the cap can only ever drop ones that could suppress nothing', () => {
      // `readdirSync` order is whatever the filesystem hands back, so an
      // unsorted cut would drop an arbitrary set — possibly the only file whose
      // records are at-or-after the snapshot's asOf, i.e. the only one that can
      // suppress anything at all. Sorting descending keeps it by construction.
      const ship = JSON.stringify({ action: 'ship', target: 'EXAMPLE-APP#817', ts: '2026-08-22T12:30:00Z' });
      vi.spyOn(log, 'warn').mockImplementation(() => {});
      const env = board({
        state: { asOf: ASOF, items: [item()] },
        gates: manyGates(420, { '2026-08-22.jsonl': ship }),
      });
      const read = readReleaseBoardSource(DECL, WORKGROUP, Date.now(), env);
      // The shipped PR is still suppressed: its file sorts newest and survives.
      expect(read.items.map((i) => i.id)).toEqual(['gates-overflow']);
    });
  });
});

describe('open-PR gate', () => {
  const board = [
    item({ id: 'REPO-A#956', nextMover: 'human', why: 'ready, no recorded ship' }),
    item({ id: 'REPO-A#1017', nextMover: 'human', why: 'ready, no recorded ship' }),
  ];
  const derive = (openPrs: OpenPrState) =>
    deriveBoardAttentionItems(board, ASOF, [], [], BINDING, openPrs).map((i) => i.id);

  it('drops a PR the watcher says is no longer open', () => {
    // #956 merged; a complete fetch that omits it is positive evidence.
    expect(derive({ 'REPO-A': { complete: true, open: [1017] } })).toEqual(['REPO-A#1017']);
  });

  it('keeps everything when the fetch was INCOMPLETE', () => {
    // The branch that never runs in normal operation. A short or failed fetch
    // must remove nothing — otherwise one bad network call silently empties the
    // queue of real blocked work.
    expect(derive({ 'REPO-A': { complete: false, open: [1017] } }).sort()).toEqual(['REPO-A#1017', 'REPO-A#956']);
  });

  it('gates per repo, not globally', () => {
    // A run can fetch one repo cleanly and fail on another; the clean one may
    // filter, the failed one may not.
    const mixed = [...board, item({ id: 'REPO-B#23', nextMover: 'human', why: 'ready' })];
    const out = deriveBoardAttentionItems(mixed, ASOF, [], [], BINDING, {
      'REPO-A': { complete: true, open: [1017] },
      'REPO-B': { complete: false, open: [] },
    }).map((i) => i.id);
    expect(out.sort()).toEqual(['REPO-A#1017', 'REPO-B#23']);
  });

  it('keeps everything when the state is absent or malformed', () => {
    expect(derive({}).length).toBe(2);
    expect(derive({ 'REPO-A': undefined }).length).toBe(2);
    expect(derive({ 'REPO-A': { complete: true } }).length).toBe(2);
  });
});
