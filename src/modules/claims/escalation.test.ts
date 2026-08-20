import { describe, expect, it } from 'vitest';

import { declaresItselfFinished, ESCALATION_GRACE_MS, isStalePastGrace, shouldEscalate } from './escalation.js';

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse('2026-08-10T12:00:00.000Z'); // noon UTC

function iso(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

describe('isStalePastGrace', () => {
  it('is not stale when the claim has not even hit its own TTL yet', () => {
    // claimed 1h ago, ttl 4h → expires in 3h
    const { stale } = isStalePastGrace(iso(1 * HOUR_MS), 4, NOW);
    expect(stale).toBe(false);
  });

  it('is not stale (for escalation purposes) when past TTL but still inside the grace window', () => {
    // claimed 5h ago, ttl 4h → expired 1h ago; grace is 2h
    const { stale, staleMs } = isStalePastGrace(iso(5 * HOUR_MS), 4, NOW);
    expect(stale).toBe(false);
    expect(staleMs).toBe(1 * HOUR_MS);
  });

  it('is stale once past TTL by more than the grace window', () => {
    // claimed 8h ago, ttl 4h → expired 4h ago; grace is 2h
    const { stale, staleMs } = isStalePastGrace(iso(8 * HOUR_MS), 4, NOW);
    expect(stale).toBe(true);
    expect(staleMs).toBe(4 * HOUR_MS);
  });

  it('is exactly at the grace boundary → not stale (strict >)', () => {
    const claimedAgo = 4 * HOUR_MS + ESCALATION_GRACE_MS; // expired exactly ESCALATION_GRACE_MS ago
    const { stale } = isStalePastGrace(iso(claimedAgo), 4, NOW);
    expect(stale).toBe(false);
  });

  it('treats unparseable claimed_at or non-finite ttl as not stale', () => {
    expect(isStalePastGrace('not-a-date', 4, NOW).stale).toBe(false);
    expect(isStalePastGrace(iso(8 * HOUR_MS), Number.NaN, NOW).stale).toBe(false);
  });
});

describe('shouldEscalate', () => {
  it('false when fresh', () => {
    expect(shouldEscalate({ claimed_at: iso(1 * HOUR_MS), ttl_hours: 4 }, NOW)).toBe(false);
  });

  it('false when stale but inside grace', () => {
    expect(shouldEscalate({ claimed_at: iso(5 * HOUR_MS), ttl_hours: 4 }, NOW)).toBe(false);
  });

  it('true when stale past grace with no prior escalation', () => {
    expect(shouldEscalate({ claimed_at: iso(8 * HOUR_MS), ttl_hours: 4 }, NOW)).toBe(true);
  });

  it('deduped — false when already escalated and never re-claimed since', () => {
    const claim = { claimed_at: iso(8 * HOUR_MS), ttl_hours: 4, escalated_at: iso(1 * HOUR_MS) };
    expect(shouldEscalate(claim, NOW)).toBe(false);
  });

  it('escalates again when re-claimed (takeover) after the prior escalation', () => {
    const claim = {
      claimed_at: iso(8 * HOUR_MS), // re-claim timestamp, now itself stale-past-grace again
      ttl_hours: 4,
      escalated_at: iso(20 * HOUR_MS), // escalation happened BEFORE this claimed_at
    };
    expect(shouldEscalate(claim, NOW)).toBe(true);
  });

  it('missing/malformed required fields never escalate', () => {
    expect(shouldEscalate({}, NOW)).toBe(false);
    expect(shouldEscalate({ claimed_at: iso(8 * HOUR_MS) }, NOW)).toBe(false); // no ttl_hours
    expect(shouldEscalate({ ttl_hours: 4 }, NOW)).toBe(false); // no claimed_at
  });

  // The documented release is `rm` the file, but agents also stamp completion
  // in place and leave the file as an audit trail. On the first live batch
  // (2026-08-12) two of four alerts were claims carrying released_at AND
  // status "done" — one naming the merge commit that closed it.
  /**
   * "Released" is how agents say they stepped OFF work, not that it is done.
   * Both fixtures are real claims from 2026-08-13 that carried released_at and
   * status:"released" over genuinely open work — one an open do-not-merge PR
   * with 8 unresolved review threads. Filtering these was the bug: unowned
   * open work is the exact state this badge exists to surface.
   */
  describe('a claim whose note contradicts its own released flag still escalates', () => {
    for (const note of [
      'RELEASED, not done. Needs a QA re-verification run only.',
      'RELEASED, HELD not done. PR #768 open with do-not-merge, 8 review threads.',
      'Done with my part; the migration is NOT COMPLETE.',
    ]) {
      it(`escalates: ${note.slice(0, 34)}…`, () => {
        expect(
          shouldEscalate(
            {
              owner: 'ava',
              claimed_at: iso(9 * HOUR_MS),
              ttl_hours: 4,
              released_at: '2026-08-12T01:40:00Z',
              status: 'released',
              note,
            },
            NOW,
          ),
        ).toBe(true);
      });
    }

    it('still treats an uncontradicted release as finished', () => {
      expect(
        shouldEscalate(
          {
            owner: 'ava',
            claimed_at: iso(9 * HOUR_MS),
            ttl_hours: 4,
            status: 'released',
            note: 'RELEASED — merged as abc1234.',
          },
          NOW,
        ),
      ).toBe(false);
    });
  });

  describe('a claim that declares itself finished never escalates', () => {
    const stale = { claimed_at: iso(8 * HOUR_MS), ttl_hours: 4 };

    it('released_at set', () => {
      expect(shouldEscalate({ ...stale, released_at: iso(2 * HOUR_MS) }, NOW)).toBe(false);
    });

    it('status done / released / complete, case and padding insensitive', () => {
      for (const status of ['done', 'Released', ' COMPLETE ', 'completed']) {
        expect(shouldEscalate({ ...stale, status }, NOW)).toBe(false);
      }
    });

    it('note opening with RELEASED', () => {
      expect(shouldEscalate({ ...stale, note: 'RELEASED. PR #757 merged at 15:17:47Z' }, NOW)).toBe(false);
    });

    it('the exact live shape that misfired — released_at + status + note together', () => {
      const claim = {
        claimed_at: '2026-08-11T15:05:00Z',
        released_at: '2026-08-11T15:21:00Z',
        ttl_hours: 0,
        status: 'done',
        note: 'RELEASED. PR #757 merged by davekim917 at 15:17:47Z (squash, ab61511f).',
      };
      expect(shouldEscalate(claim, Date.parse('2026-08-12T04:18:25Z'))).toBe(false);
    });

    it('still escalates a live claim whose note merely mentions a release elsewhere', () => {
      // Only a note that OPENS with "released" counts — otherwise any claim
      // discussing a release would silence its own alarm.
      const claim = { ...stale, note: 'blocked until the 172 migration is released to dev' };
      expect(shouldEscalate(claim, NOW)).toBe(true);
    });

    it('an in-progress status is not a finished one', () => {
      for (const status of ['active', 'in_progress', 'blocked', '']) {
        expect(shouldEscalate({ ...stale, status }, NOW)).toBe(true);
      }
    });
  });

  describe('a parked claim never escalates', () => {
    it('false when stale past grace, case/padding-insensitive', () => {
      for (const status of ['parked', 'Parked', ' PARKED ']) {
        expect(shouldEscalate({ claimed_at: iso(8 * HOUR_MS), ttl_hours: 4, status }, NOW)).toBe(false);
      }
    });

    it('is not treated as finished by declaresItselfFinished', () => {
      // Parked is neither the abandonment state (badge) nor the completion
      // state (board filter) — it must not collapse into either.
      expect(declaresItselfFinished({ status: 'parked' })).toBe(false);
    });
  });
});
