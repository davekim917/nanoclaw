import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readClaims, renderClaims, type BoardClaim } from './claims-board.js';
import { log } from './log.js';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-08-13T12:00:00Z');

function root(claims: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-board-'));
  const claimsDir = path.join(dir, 'wg-a', 'claims');
  fs.mkdirSync(claimsDir, { recursive: true });
  for (const [slug, body] of Object.entries(claims)) {
    fs.writeFileSync(path.join(claimsDir, `${slug}.json`), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

/** claimed `hoursAgo` with a 4h ttl — so hoursAgo>4 is past TTL, >6 is past grace. */
function claim(hoursAgo: number, extra: Record<string, unknown> = {}) {
  return {
    owner: 'ava',
    claimed_at: new Date(NOW - hoursAgo * HOUR).toISOString(),
    ttl_hours: 4,
    note: 'wallet tie-out',
    ...extra,
  };
}

describe('readClaims', () => {
  it('classifies live, past-TTL-in-grace, and past-grace against the escalation rule', () => {
    const dir = root({ fresh: claim(1), expiring: claim(5), abandoned: claim(9) });

    const byslug = Object.fromEntries(readClaims('wg-a', NOW, dir).map((c) => [c.slug, c]));

    expect(byslug.fresh.state).toBe('live');
    expect(byslug.expiring.state).toBe('expiring');
    expect(byslug.abandoned.state).toBe('stale');
  });

  it('treats a claim with no parseable expiry as stale, never as an indefinite hold', () => {
    const dir = root({ broken: { owner: 'ghost', note: 'no timestamps' } });

    expect(readClaims('wg-a', NOW, dir)[0]).toMatchObject({ state: 'stale', owner: 'ghost' });
  });

  it('skips unparseable files instead of blanking the board', () => {
    const dir = root({ good: claim(1), garbage: '{not json' });

    const claims = readClaims('wg-a', NOW, dir);

    expect(claims).toHaveLength(1);
    expect(claims[0].slug).toBe('good');
  });

  it('carries thread_id and the escalated flag, and defaults a missing owner', () => {
    const dir = root({
      linked: claim(9, { thread_id: 'slack:C0AAA:1786621514.008659', escalated_at: '2026-08-13T10:00:00Z' }),
      anon: claim(1, { owner: undefined }),
    });

    const byslug = Object.fromEntries(readClaims('wg-a', NOW, dir).map((c) => [c.slug, c]));

    expect(byslug.linked).toMatchObject({ threadId: 'slack:C0AAA:1786621514.008659', escalated: true });
    expect(byslug.anon).toMatchObject({ owner: 'unknown', threadId: null, escalated: false });
  });

  it('returns nothing when the workgroup has no claims dir', () => {
    expect(readClaims('wg-absent', NOW, root({}))).toEqual([]);
  });

  /**
   * Finished work left on disk is the common case, not the edge case: 14 of 15
   * claims on the first render against real data were completed. Showing them
   * as abandoned would make the loudest section of the board the wrong one.
   */
  it('omits claims that declare themselves finished, however they said it', () => {
    const dir = root({
      'by-timestamp': claim(9, { released_at: '2026-08-12T10:00:00Z' }),
      'by-status': claim(9, { status: 'released' }),
      'by-note': claim(9, { note: 'RELEASED — merged as abc1234, branch deleted.' }),
      'still-open': claim(9),
    });

    expect(readClaims('wg-a', NOW, dir).map((c) => c.slug)).toEqual(['still-open']);
  });

  /**
   * The inverse, and the one that matters most: "released" is how agents say
   * they stepped OFF work, not that it finished. An earlier version of this
   * file asserted these were hidden — that assertion was the bug. Open work
   * with no owner is the single thing the board exists to show.
   */
  it('shows a claim whose note contradicts its own released flag', () => {
    const dir = root({
      parked: claim(9, {
        released_at: '2026-08-12T01:40:00Z',
        status: 'released',
        note: 'RELEASED, HELD not done. PR #768 open with do-not-merge, 8 review threads.',
      }),
    });

    expect(readClaims('wg-a', NOW, dir).map((c) => c.slug)).toEqual(['parked']);
  });

  it('classifies a parked claim regardless of TTL, with age since parked_at', () => {
    // claimed 100h ago on a 4h ttl — would be 'stale' by TTL alone.
    const dir = root({
      handoff: claim(100, { status: 'parked', parked_at: new Date(NOW - 3 * HOUR).toISOString(), ttl_hours: 4 }),
    });

    expect(readClaims('wg-a', NOW, dir)[0]).toMatchObject({ state: 'parked', staleMs: 3 * HOUR });
  });

  it('keeps an explicit operator pause visible without turning it stale', () => {
    const dir = root({
      held: claim(100, { status: 'paused', paused_at: new Date(NOW - 30 * HOUR).toISOString() }),
    });

    expect(readClaims('wg-a', NOW, dir)[0]).toMatchObject({ state: 'paused', staleMs: 30 * HOUR });
  });

  it('a park that nobody came back for decays to stale — parked is a waypoint, not a terminus', () => {
    const dir = root({
      // 30h parked, past the 24h grace: the handoff offer lapsed.
      lapsed: claim(100, { status: 'parked', parked_at: new Date(NOW - 30 * HOUR).toISOString() }),
    });
    expect(readClaims('wg-a', NOW, dir)[0]).toMatchObject({ state: 'stale', staleMs: 30 * HOUR });
  });

  it('a park with no ttl_hours still expires — the field being absent must not grant immortality', () => {
    const dir = root({
      forever: claim(100, { status: 'parked', parked_at: new Date(NOW - 90 * HOUR).toISOString() }),
    });
    expect(readClaims('wg-a', NOW, dir)[0].state).toBe('stale');
  });

  it('parking wins even when the note says "not done"', () => {
    const dir = root({
      handoff: claim(9, {
        status: 'parked',
        parked_at: new Date(NOW - 1 * HOUR).toISOString(),
        note: 'RELEASED, not done. Needs a QA re-verification run only.',
      }),
    });

    expect(readClaims('wg-a', NOW, dir).map((c) => c.slug)).toEqual(['handoff']);
    expect(readClaims('wg-a', NOW, dir)[0].state).toBe('parked');
  });

  it('defaults staleMs to 0 for a parked claim missing or with an unparseable parked_at', () => {
    const dir = root({
      missing: claim(9, { status: 'parked' }),
      bad: claim(9, { status: 'parked', parked_at: 'nope' }),
    });

    const byslug = Object.fromEntries(readClaims('wg-a', NOW, dir).map((c) => [c.slug, c]));

    expect(byslug.missing).toMatchObject({ state: 'parked', staleMs: 0 });
    expect(byslug.bad).toMatchObject({ state: 'parked', staleMs: 0 });
  });

  it('truncates a paragraph-long note to its first sentence', () => {
    const dir = root({
      verbose: claim(1, {
        note: 'Dev activation verified live. OPEN: screenshots, migration decision. DO NOT flip prod.',
      }),
    });

    const note = readClaims('wg-a', NOW, dir)[0].note;

    expect(note).toBe('Dev activation verified live. …');
    expect(note).not.toContain('DO NOT flip prod');
  });
});

describe('renderClaims', () => {
  const claims: BoardClaim[] = [
    {
      slug: 'live-one',
      owner: 'kit',
      note: 'seam',
      threadId: null,
      state: 'live',
      staleMs: -2 * HOUR,
      escalated: false,
    },
    { slug: 'gone', owner: 'ava', note: 'drift', threadId: 't', state: 'stale', staleMs: 3 * HOUR, escalated: true },
    {
      slug: 'soon',
      owner: 'bo',
      note: 'guard',
      threadId: null,
      state: 'expiring',
      staleMs: 30 * 60000,
      escalated: false,
    },
    {
      slug: 'handoff',
      owner: 'kit',
      note: 'stepped off',
      threadId: null,
      state: 'parked',
      staleMs: 5 * HOUR,
      escalated: false,
    },
    {
      slug: 'held',
      owner: 'ava',
      note: 'explicit operator hold',
      threadId: null,
      state: 'paused',
      staleMs: 5 * HOUR,
      escalated: false,
    },
  ];

  it('puts what needs a human first, parked next, and live work last', () => {
    const out = renderClaims(claims)
      .split('\n')
      .filter(
        (l) =>
          l.startsWith('🔴') || l.startsWith('⏸️') || l.startsWith('🅿️') || l.startsWith('🟡') || l.startsWith('🟢'),
      );

    expect(out[0]).toContain('Stale');
    expect(out[1]).toContain('Paused');
    expect(out[2]).toContain('Parked');
    expect(out[3]).toContain('Past TTL');
    expect(out[4]).toContain('Live');
  });

  it('renders parked age as "parked <duration>", not past-TTL phrasing', () => {
    const out = renderClaims(claims);

    expect(out).toContain('parked 5.0h');
    expect(out).not.toContain('5.0h past TTL');
  });

  it('renders an explicit hold as paused, not past-TTL work', () => {
    const out = renderClaims(claims);

    expect(out).toContain('paused 5.0h');
  });

  it('renders a thread link only when the claim recorded one', () => {
    const out = renderClaims(claims, (t) => (t === 't' ? 'https://acme.slack.com/archives/C0/p1' : null));

    expect(out).toContain('[thread](https://acme.slack.com/archives/C0/p1)');
    expect(out.match(/\[thread\]/g)).toHaveLength(1);
  });

  it('marks an escalated claim so a reader does not re-report it', () => {
    expect(renderClaims(claims)).toContain('_escalated_');
  });

  it('says remaining time for live work and elapsed time past TTL for the rest', () => {
    const out = renderClaims(claims);

    expect(out).toContain('2.0h left');
    expect(out).toContain('3.0h past TTL');
    expect(out).toContain('30m past TTL');
  });

  it('renders an explicit empty state rather than a bare heading', () => {
    expect(renderClaims([])).toContain('nothing claimed right now');
  });

  it('stamps a populated render with when it was drawn and what the source of truth is', () => {
    expect(renderClaims(claims)).toMatch(/_claims as of .+ — source of truth: the claims\/ directory_$/);
  });

  it('stamps the empty render too', () => {
    expect(renderClaims([])).toMatch(/_claims as of .+ — source of truth: the claims\/ directory_$/);
  });
});

/**
 * The claims directory is bind-mounted READ-WRITE into that workgroup's own
 * containers, and `readClaims` runs synchronously inside the thread-list
 * request the dashboard polls from every open viewer (`board-attention.ts`
 * calls it on every memo miss). So every property of every entry — its type,
 * its size, how many there are, where it points — is chosen by an agent, on
 * the host's single event loop.
 */
describe('readClaims hostile-directory handling', () => {
  const tmpdirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of tmpdirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  const claimsDirOf = (dir: string) => path.join(dir, 'wg-a', 'claims');

  it('does not block on a FIFO in the claims directory, and skips it with a log', () => {
    // O_NONBLOCK, and this assertion is what stands on it. Opening a FIFO for
    // reading BLOCKS until a writer shows up, and that open happens BEFORE any
    // regular-file check can reject it — so with `fs.readFileSync` back in
    // place this test does not FAIL, it HANGS, exactly as the host would hang:
    // every dashboard poll, every channel adapter and every sweep tick, for
    // every viewer, until a writer appeared. Planting one is one `mkfifo` in a
    // directory the agent already writes claims into.
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const dir = root({ healthy: claim(1) });
    tmpdirs.push(dir);
    execFileSync('mkfifo', [path.join(claimsDirOf(dir), 'trap.json')]);

    // The healthy claim still comes back — one hostile entry must not blank
    // the board, the same rule malformed JSON already had.
    expect(readClaims('wg-a', NOW, dir).map((c) => c.slug)).toEqual(['healthy']);
    expect(warn).toHaveBeenCalledWith(
      'Claims board: not a regular file, emitting nothing',
      expect.objectContaining({ relative: 'trap.json' }),
    );
  });

  it('skips a claim file larger than the read cap instead of reading it', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const dir = root({ healthy: claim(1) });
    tmpdirs.push(dir);
    // Valid JSON, just far too big to be a claim — so a skip can only come
    // from the size cap, never from the parse failing.
    fs.writeFileSync(
      path.join(claimsDirOf(dir), 'bloated.json'),
      JSON.stringify({ ...claim(9), note: 'x'.repeat(128 * 1024) }),
    );

    expect(readClaims('wg-a', NOW, dir).map((c) => c.slug)).toEqual(['healthy']);
    expect(warn).toHaveBeenCalledWith(
      'Claims board: file is larger than the read cap, emitting nothing',
      expect.objectContaining({ relative: 'bloated.json', cap: 64 * 1024 }),
    );
  });

  it('reads a verbose claim right up to the read cap', () => {
    // The other side of the cap: it must bound a hostile file without
    // truncating a merely wordy one.
    const dir = root({});
    tmpdirs.push(dir);
    const padded = { ...claim(1), note: 'wallet tie-out. ' + 'y'.repeat(32 * 1024) };
    fs.writeFileSync(path.join(claimsDirOf(dir), 'verbose.json'), JSON.stringify(padded));

    expect(readClaims('wg-a', NOW, dir).map((c) => c.slug)).toEqual(['verbose']);
  });

  it('keeps the OLDEST files when the count cap bites, and says so out loud', () => {
    // Silent truncation is the absence-as-fact bug: the board would still look
    // clean and nobody would learn it is only being partly read. And WHICH
    // files survive is the whole point — the board exists to surface work
    // nobody came back for, so a cut that dropped the least recently touched
    // claims would drop exactly what it is for.
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const dir = root({});
    tmpdirs.push(dir);
    const claimsDir = claimsDirOf(dir);
    // 501 claims: one over the cap, so exactly one must be dropped.
    //
    // mtime runs DESCENDING with the name, deliberately ANTI-correlated with
    // both creation order and alphabetical order: `c0000` is the newest file
    // and also the first one `readdir` reports, `c0500` is the oldest and the
    // last. So an as-listed cut and a name-ordered cut both drop `c0500` —
    // exactly the claim that most needs a human — and only an mtime-ordered
    // cut drops `c0000`. Getting this backwards is what makes the test pass on
    // a broken implementation, which it did on the first draft.
    for (let i = 0; i < 501; i++) {
      const file = path.join(claimsDir, `c${String(i).padStart(4, '0')}.json`);
      fs.writeFileSync(file, JSON.stringify(claim(9)));
      fs.utimesSync(file, new Date(NOW), new Date(NOW - (i + 1) * HOUR));
    }

    const slugs = readClaims('wg-a', NOW, dir).map((c) => c.slug);

    expect(slugs).toHaveLength(500);
    expect(slugs).not.toContain('c0000'); // newest — the one the cap drops
    expect(slugs).toContain('c0500'); // oldest — the one it must never drop
    expect(warn).toHaveBeenCalledWith('Claims board: more claim files than the read cap, reading only the oldest', {
      workgroupId: 'wg-a',
      total: 501,
      cap: 500,
      skipped: 1,
    });
  });

  it('skips a directory named like a claim without blanking the list', () => {
    // A non-regular entry that is not a FIFO: `open` on a directory succeeds,
    // so only the fstat check stands between it and a read that throws EISDIR
    // out of the request path.
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const dir = root({ healthy: claim(1), other: claim(5) });
    tmpdirs.push(dir);
    fs.mkdirSync(path.join(claimsDirOf(dir), 'imposter.json'));

    expect(
      readClaims('wg-a', NOW, dir)
        .map((c) => c.slug)
        .sort(),
    ).toEqual(['healthy', 'other']);
    expect(warn).toHaveBeenCalledWith(
      'Claims board: not a regular file, emitting nothing',
      expect.objectContaining({ relative: 'imposter.json' }),
    );
  });

  it('refuses a claim symlinked out of the claims directory', () => {
    // The claims directory is agent-writable, so a leaf symlink at a sibling
    // workgroup's claim is one `ln -s` — a cross-workgroup read through the
    // data-pool boundary, and one self-heal would then stamp in the WRONG
    // workgroup. Containment is decided from the open descriptor, not the path.
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const dir = root({ healthy: claim(1) });
    tmpdirs.push(dir);
    const otherWg = path.join(dir, 'wg-b', 'claims');
    fs.mkdirSync(otherWg, { recursive: true });
    fs.writeFileSync(path.join(otherWg, 'secret.json'), JSON.stringify(claim(9, { owner: 'sibling' })));
    fs.symlinkSync(path.join(otherWg, 'secret.json'), path.join(claimsDirOf(dir), 'secret.json'));

    expect(readClaims('wg-a', NOW, dir).map((c) => c.slug)).toEqual(['healthy']);
  });

  it('reads nothing when the claims DIRECTORY is a symlink out of the workgroup', () => {
    // The other half of the escape the leaf test covers. `claims/` is inside
    // the read-write mount, so it can be removed and replaced wholesale with a
    // symlink at a sibling workgroup's directory — and then EVERY row on this
    // board comes from the other workgroup, which self-heal and nudge would go
    // on to stamp and message about under the wrong workgroup's identity.
    const dir = root({ healthy: claim(1) });
    tmpdirs.push(dir);
    const otherWg = path.join(dir, 'wg-b', 'claims');
    fs.mkdirSync(otherWg, { recursive: true });
    fs.writeFileSync(path.join(otherWg, 'secret.json'), JSON.stringify(claim(9, { owner: 'sibling' })));
    fs.rmSync(claimsDirOf(dir), { recursive: true });
    fs.symlinkSync(otherWg, claimsDirOf(dir));

    expect(readClaims('wg-a', NOW, dir)).toEqual([]);
  });

  it('still reads a claims directory symlinked to somewhere INSIDE the workgroup', () => {
    // The assertion that makes the directory-level containment load-bearing
    // rather than decorative. Rejecting the escape above happens either way —
    // the per-file fd check catches it on its own, because every opened file
    // resolves outside the unresolved `claims/` string. What only the resolved
    // root gets right is the LEGITIMATE case: a `claims/` symlink that stays
    // inside the workgroup. Without resolving the directory first, every file
    // under it resolves outside the string the fd check compares against, and
    // the board silently blanks — the exact absence-as-fact failure, arrived at
    // from the safe side.
    const dir = root({});
    tmpdirs.push(dir);
    const real = path.join(dir, 'wg-a', 'real-claims');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'healthy.json'), JSON.stringify(claim(1)));
    fs.rmSync(claimsDirOf(dir), { recursive: true });
    fs.symlinkSync(real, claimsDirOf(dir));

    expect(readClaims('wg-a', NOW, dir).map((c) => c.slug)).toEqual(['healthy']);
  });

  it('reads a healthy directory exactly as before', () => {
    // The regression guard for everything above: none of the hardening may
    // change what an ordinary claims directory produces.
    const dir = root({ fresh: claim(1), expiring: claim(5), abandoned: claim(9) });
    tmpdirs.push(dir);

    const byslug = Object.fromEntries(readClaims('wg-a', NOW, dir).map((c) => [c.slug, c]));

    expect(Object.keys(byslug).sort()).toEqual(['abandoned', 'expiring', 'fresh']);
    expect(byslug.fresh).toMatchObject({ state: 'live', owner: 'ava', note: 'wallet tie-out' });
    expect(byslug.expiring.state).toBe('expiring');
    expect(byslug.abandoned.state).toBe('stale');
  });
});
