import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { readClaims, renderClaims, type BoardClaim } from './claims-board.js';

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
      'by-note': claim(9, { note: 'RELEASED, not done. Needs QA re-verification only.' }),
      'still-open': claim(9),
    });

    expect(readClaims('wg-a', NOW, dir).map((c) => c.slug)).toEqual(['still-open']);
  });

  it('truncates a paragraph-long note to its first sentence', () => {
    const dir = root({
      verbose: claim(1, { note: 'Dev activation verified live. OPEN: screenshots, migration decision. DO NOT flip prod.' }),
    });

    const note = readClaims('wg-a', NOW, dir)[0].note;

    expect(note).toBe('Dev activation verified live. …');
    expect(note).not.toContain('DO NOT flip prod');
  });
});

describe('renderClaims', () => {
  const claims: BoardClaim[] = [
    { slug: 'live-one', owner: 'kit', note: 'seam', threadId: null, state: 'live', staleMs: -2 * HOUR, escalated: false },
    { slug: 'gone', owner: 'ava', note: 'drift', threadId: 't', state: 'stale', staleMs: 3 * HOUR, escalated: true },
    { slug: 'soon', owner: 'bo', note: 'guard', threadId: null, state: 'expiring', staleMs: 30 * 60000, escalated: false },
  ];

  it('puts what needs a human first and live work last', () => {
    const out = renderClaims(claims).split('\n').filter((l) => l.startsWith('🔴') || l.startsWith('🟡') || l.startsWith('🟢'));

    expect(out[0]).toContain('Stale');
    expect(out[1]).toContain('Past TTL');
    expect(out[2]).toContain('Live');
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
});
