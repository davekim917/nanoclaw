import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, it, expect } from 'vitest';

import {
  deriveBoardAttentionItems,
  readReleaseBoardSource,
  type GateShipRecord,
  type ReleaseStateItem,
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

  it('falls back to "unknown" owner when the source item omits it', () => {
    const out = deriveBoardAttentionItems([item({ owner: undefined })], ASOF, [], [], BINDING);
    expect(out[0]!.claimOwner).toBe('unknown');
    expect(out[0]!.claimNote).toMatch(/^waiting on unknown:/);
  });

  it('every emitted claimNote satisfies the WAITING_ON_NOTE routing regex (/\\bwaiting on\\b/i)', () => {
    const out = deriveBoardAttentionItems([item()], ASOF, [], [], BINDING);
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

    const env = (groupsRoot: string) => ({ groupsRoot, claimsRoot: groupsRoot });

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
});
