import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RECONCILE_LEDGER_ACTOR,
  _resetReconcileStateForTesting,
  decideReconcile,
  ledgerLine,
  parseGitHubRefs,
  reconcileMergedClaims,
  refKey,
  type GitHubRef,
  type RefLookup,
  type RefState,
} from './reconcile.js';

const REPO = 'org-a/repo-a';
const NOW = Date.parse('2026-08-22T19:00:00Z');

function root(claims: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-reconcile-'));
  const claimsDir = path.join(dir, 'wg-a', 'claims');
  fs.mkdirSync(claimsDir, { recursive: true });
  for (const [slug, body] of Object.entries(claims)) {
    fs.writeFileSync(path.join(claimsDir, `${slug}.json`), JSON.stringify(body, null, 2));
  }
  return dir;
}

function claim(extra: Record<string, unknown> = {}) {
  return {
    owner: 'agent-a',
    session_id: 'abcdef123456',
    claimed_at: '2026-08-21T02:13:59Z',
    ttl_hours: 4,
    note: 'scope guard seam',
    thread_id: 'slack:chan-1:1787277743.529519',
    ...extra,
  };
}

const claimsDirOf = (dir: string) => path.join(dir, 'wg-a', 'claims');
const exists = (dir: string, slug: string) => fs.existsSync(path.join(claimsDirOf(dir), `${slug}.json`));
const ledger = (dir: string) =>
  fs
    .readFileSync(path.join(claimsDirOf(dir), 'ledger.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

/** Every ref answers from this table; anything missing is `absent` (a 404). */
function lookupFrom(table: Record<number, RefState | RefLookup>) {
  return vi.fn(async (ref: GitHubRef): Promise<RefLookup> => {
    const hit = table[ref.number];
    if (!hit) return { state: 'absent' };
    return typeof hit === 'string' ? { state: hit } : hit;
  });
}

function deps(dir: string, table: Record<number, RefState | RefLookup>, over = {}) {
  return {
    root: dir,
    enabled: true,
    defaultRepo: () => REPO,
    lookup: lookupFrom(table),
    ...over,
  };
}

beforeEach(() => _resetReconcileStateForTesting());
afterEach(() => vi.restoreAllMocks());

describe('parseGitHubRefs', () => {
  it('reads the slug AND the note — neither alone is the whole claim', () => {
    // gh-963 encodes 963 in its slug but is only finished when the #956 in its
    // note lands. A parse that trusted either source alone would miss one.
    expect(parseGitHubRefs('gh-963', 'PR #956 mechanically ready', REPO).map(refKey)).toEqual([
      'org-a/repo-a#956',
      'org-a/repo-a#963',
    ]);
  });

  it('matches whole digit runs, so #9561 is never read as 956', () => {
    expect(parseGitHubRefs('', 'follow-up to #9561', REPO).map(refKey)).toEqual(['org-a/repo-a#9561']);
    expect(parseGitHubRefs('gh-9561', '', REPO).map(refKey)).toEqual(['org-a/repo-a#9561']);
  });

  it('takes a slug number only where the slug is naming a reference', () => {
    expect(parseGitHubRefs('proj-956-scope-guards', '', REPO).map(refKey)).toEqual(['org-a/repo-a#956']);
    expect(parseGitHubRefs('proj-gh-522-618-tieout', '', REPO).map(refKey)).toEqual(['org-a/repo-a#522']);
    expect(parseGitHubRefs('proj-smoke-pr941-fixes', '', REPO).map(refKey)).toEqual(['org-a/repo-a#941']);
    // A number buried in the name is part of the name. Once the repo reaches
    // #1800 this would otherwise start resolving to unrelated work.
    expect(parseGitHubRefs('team-outreach-deck-brand-1800-x', '', REPO)).toEqual([]);
    expect(parseGitHubRefs('proj-whats-new-817', '', REPO)).toEqual([]);
    // Leading zero / single digit: #1 is a real merged PR in any active repo.
    expect(parseGitHubRefs('team-pr966-01-brand-key', '', REPO).map(refKey)).toEqual(['org-a/repo-a#966']);
  });

  it('lets a reference name its own repository, and never double-counts it', () => {
    const refs = parseGitHubRefs('', 'see org-b/repo-b#42 and https://github.com/org-c/repo-c/pull/7', REPO);
    expect(refs.map(refKey)).toEqual(['org-c/repo-c#7', 'org-b/repo-b#42']);
    // 42 must NOT also register against the default repo.
    expect(refs.map(refKey)).not.toContain('org-a/repo-a#42');
  });

  it('yields nothing for bare numbers when no default repository is configured', () => {
    expect(parseGitHubRefs('gh-963', 'and #956', undefined)).toEqual([]);
    expect(parseGitHubRefs('gh-963', 'and org-b/repo-b#956', undefined).map(refKey)).toEqual(['org-b/repo-b#956']);
  });
});

describe('decideReconcile', () => {
  it('clears only on a verified merge', () => {
    expect(decideReconcile(['merged'])).toBe('clear');
    expect(decideReconcile(['closed'])).toBe('keep');
    expect(decideReconcile(['absent'])).toBe('keep');
    expect(decideReconcile([])).toBe('keep');
  });

  it('keeps a claim while anything it references is still open', () => {
    // The live false-positive class: gh-526's note cites a MERGED #520 that was
    // reviewed and found insufficient, and a human reopened the issue.
    expect(decideReconcile(['merged', 'open'])).toBe('keep');
    expect(decideReconcile(['open'])).toBe('keep');
  });

  it('does not let a dead branch block a real merge', () => {
    // proj-smoke-pr941-fixes cites #941, a "[smoke freeze] do not merge" branch
    // that was closed unmerged, alongside the #956 that shipped.
    expect(decideReconcile(['closed', 'merged'])).toBe('clear');
  });
});

describe('ledgerLine', () => {
  it('matches claim.sh ledger_append: key order, elisions, and pr as a number', () => {
    expect(
      ledgerLine({
        event: 'cleared_merged',
        slug: 'gh-963',
        owner: 'agent-a',
        by: RECONCILE_LEDGER_ACTOR,
        at: '2026-08-22T19:00:00.000Z',
        claimedAt: '2026-08-21T02:13:59Z',
        threadId: 'slack:chan-1:1',
        pr: 956,
        note: 'a note',
      }),
    ).toBe(
      '{"event":"cleared_merged","slug":"gh-963","owner":"agent-a","by":"host-claims-reconcile",' +
        '"at":"2026-08-22T19:00:00.000Z","claimed_at":"2026-08-21T02:13:59Z","thread_id":"slack:chan-1:1",' +
        '"pr":956,"note":"a note"}',
    );
  });

  it('elides the optional keys claim.sh elides, and keeps note last', () => {
    expect(ledgerLine({ event: 'cleared_merged', slug: 's', owner: 'o', by: 'b', at: 't', note: 'n' })).toBe(
      '{"event":"cleared_merged","slug":"s","owner":"o","by":"b","at":"t","note":"n"}',
    );
  });
});

describe('reconcileMergedClaims', () => {
  it('closes a claim whose PR merged — ledgers it, then deletes the file', async () => {
    const dir = root({
      'proj-956-scope-guards': claim({ status: 'parked', note: 'waiting on the operator: PR #956 ready' }),
    });

    const [outcome] = await reconcileMergedClaims(NOW, deps(dir, { 956: 'merged' }));

    expect(outcome).toMatchObject({ slug: 'proj-956-scope-guards', action: 'cleared', pr: 956, applied: true });
    // Closing is DELETING — a status flag would leave the row on the board.
    expect(exists(dir, 'proj-956-scope-guards')).toBe(false);
    expect(ledger(dir)).toEqual([
      {
        event: 'cleared_merged',
        slug: 'proj-956-scope-guards',
        owner: 'agent-a',
        by: RECONCILE_LEDGER_ACTOR,
        at: new Date(NOW).toISOString(),
        claimed_at: '2026-08-21T02:13:59Z',
        thread_id: 'slack:chan-1:1787277743.529519',
        pr: 956,
        note: 'waiting on the operator: PR #956 ready',
      },
    ]);
  });

  it('leaves a claim whose PR was closed WITHOUT merging', async () => {
    const dir = root({ 'gh-941': claim() });

    expect(await reconcileMergedClaims(NOW, deps(dir, { 941: 'closed' }))).toEqual([]);
    expect(exists(dir, 'gh-941')).toBe(true);
  });

  it('leaves every claim when GitHub errors — an outage must not empty the board', async () => {
    const dir = root({ 'gh-956': claim(), 'gh-963': claim({ note: 'PR #956 ready' }) });
    const lookup = vi.fn(async () => {
      throw new Error('GitHub returned 403 for org-a/repo-a#956');
    });

    expect(await reconcileMergedClaims(NOW, deps(dir, {}, { lookup }))).toEqual([]);
    expect(exists(dir, 'gh-956')).toBe(true);
    expect(exists(dir, 'gh-963')).toBe(true);
    expect(fs.existsSync(path.join(claimsDirOf(dir), 'ledger.ndjson'))).toBe(false);
  });

  it('does not read #9561 as a merged #956', async () => {
    const dir = root({ 'gh-9561': claim({ note: 'follow-up to #9561' }) });

    expect(await reconcileMergedClaims(NOW, deps(dir, { 956: 'merged' }))).toEqual([]);
    expect(exists(dir, 'gh-9561')).toBe(true);
  });

  it('keeps a claim whose issue a human reopened, however much merged around it', async () => {
    const dir = root({ 'gh-526': claim({ note: 'PR #520 merged but was found insufficient; reopened' }) });

    expect(await reconcileMergedClaims(NOW, deps(dir, { 520: 'merged', 526: 'open' }))).toEqual([]);
    expect(exists(dir, 'gh-526')).toBe(true);
  });

  it('never touches a claim that references nothing, and never calls GitHub for it', async () => {
    const dir = root({ 'related-accounts-honesty': claim({ note: 'no references here' }) });
    const d = deps(dir, { 1: 'merged' });

    expect(await reconcileMergedClaims(NOW, d)).toEqual([]);
    expect(d.lookup).not.toHaveBeenCalled();
    expect(exists(dir, 'related-accounts-honesty')).toBe(true);
  });

  it('reports but does not delete in shadow mode', async () => {
    const dir = root({ 'gh-956': claim() });

    const [outcome] = await reconcileMergedClaims(NOW, deps(dir, { 956: 'merged' }, { enabled: false }));

    expect(outcome).toMatchObject({ action: 'cleared', applied: false });
    expect(exists(dir, 'gh-956')).toBe(true);
    expect(fs.existsSync(path.join(claimsDirOf(dir), 'ledger.ndjson'))).toBe(false);
  });

  it('records the most recent merge when several references landed', async () => {
    const dir = root({ 'gh-956': claim({ note: 'follows #900' }) });

    const [outcome] = await reconcileMergedClaims(
      NOW,
      deps(dir, {
        900: { state: 'merged', mergedAt: '2026-08-01T00:00:00Z' },
        956: { state: 'merged', mergedAt: '2026-08-22T17:13:17Z' },
      }),
    );

    expect(outcome.pr).toBe(956);
  });

  it('asks GitHub once per terminal reference, however many scans and claims share it', async () => {
    const dir = root({
      'gh-963': claim({ note: 'PR #956 ready' }),
      'gh-964': claim({ note: 'PR #956 ready too' }),
    });
    const d = deps(dir, { 956: 'merged' });

    await reconcileMergedClaims(NOW, d);

    // 956 merged (terminal, cached) + 963 and 964 absent (terminal, cached).
    expect(d.lookup.mock.calls.map(([r]) => r.number).sort()).toEqual([956, 963, 964]);
    d.lookup.mockClear();
    await reconcileMergedClaims(NOW, deps(dir, {}, { lookup: d.lookup }));
    expect(d.lookup).not.toHaveBeenCalled();
  });

  it('leaves the claim in place when the ledger append fails', async () => {
    const dir = root({ 'gh-956': claim() });
    // A read-only claims directory: `flock` cannot create its lock file.
    fs.chmodSync(claimsDirOf(dir), 0o500);
    try {
      const [outcome] = await reconcileMergedClaims(NOW, deps(dir, { 956: 'merged' }));
      expect(outcome).toMatchObject({ action: 'kept', reason: 'ledger-failed', applied: false });
      expect(exists(dir, 'gh-956')).toBe(true);
    } finally {
      fs.chmodSync(claimsDirOf(dir), 0o700);
    }
  });
});
