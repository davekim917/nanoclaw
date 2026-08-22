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

  it('suppresses a board item when a claim slug encodes the PR number', () => {
    const claims = [claim({ slug: 'example-956-scope-guards', note: 'working the scope guard rewrite' })];
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
    const claims = [claim({ slug: 'example-956-scope-guards', note: 'on it' })];
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

  it('one unparseable gates line does not blank the feed', () => {
    const env = board({
      state: { asOf: ASOF, items: [item()] },
      gates: { '2026-08-22.jsonl': ['{ broken', JSON.stringify({ action: 'note', target: 'x', ts: ASOF })].join('\n') },
    });
    expect(readReleaseBoardSource(DECL, WORKGROUP, Date.now(), env).items).toHaveLength(1);
  });
});
