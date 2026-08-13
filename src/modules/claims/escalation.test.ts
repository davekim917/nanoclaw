import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it, vi } from 'vitest';

import {
  ESCALATION_GRACE_MS,
  escalateClaim,
  findEscalationCandidates,
  isStalePastGrace,
  shouldEscalate,
  shouldSkipClaimsScan,
  type EscalationCandidate,
  type EscalationDeliveryDeps,
} from './escalation.js';

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse('2026-08-10T12:00:00.000Z');

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
});

describe('shouldSkipClaimsScan', () => {
  it('skips inside the 10-minute window', () => {
    expect(shouldSkipClaimsScan(NOW, NOW + 5 * 60_000)).toBe(true);
  });

  it('runs once at least 10 minutes have elapsed', () => {
    expect(shouldSkipClaimsScan(NOW, NOW + 10 * 60_000)).toBe(false);
  });

  it('always runs on the very first tick (lastRan=0)', () => {
    expect(shouldSkipClaimsScan(0, NOW)).toBe(false);
  });
});

function writeClaim(dir: string, slug: string, claim: Record<string, unknown>): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug}.json`);
  fs.writeFileSync(file, JSON.stringify(claim));
  return file;
}

function writeDest(root: string, workgroupId: string): void {
  fs.mkdirSync(path.join(root, workgroupId), { recursive: true });
  fs.writeFileSync(
    path.join(root, workgroupId, 'escalation.json'),
    JSON.stringify({ channelType: 'slack', platformId: 'C000TEST' }),
  );
}

describe('findEscalationCandidates', () => {
  it('skips a workgroup with no configured escalation destination', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-escalation-'));
    writeClaim(path.join(root, 'unknown-workgroup', 'claims'), 'seam-a', {
      owner: 'ava',
      claimed_at: iso(8 * HOUR_MS),
      ttl_hours: 4,
    });
    expect(findEscalationCandidates(root, NOW)).toEqual([]);
  });

  it('skips and logs unparseable claim JSON without throwing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-escalation-'));
    const dir = path.join(root, 'wg-a', 'claims');
    writeDest(root, 'wg-a');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not valid json');
    expect(() => findEscalationCandidates(root, NOW)).not.toThrow();
    expect(findEscalationCandidates(root, NOW)).toEqual([]);
  });

  it('excludes a fresh claim and a stale-but-inside-grace claim', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-escalation-'));
    const dir = path.join(root, 'wg-a', 'claims');
    writeDest(root, 'wg-a');
    writeClaim(dir, 'fresh', { owner: 'ava', claimed_at: iso(1 * HOUR_MS), ttl_hours: 4 });
    writeClaim(dir, 'inside-grace', { owner: 'ava', claimed_at: iso(5 * HOUR_MS), ttl_hours: 4 });
    expect(findEscalationCandidates(root, NOW)).toEqual([]);
  });

  it('includes a claim stale past grace, with the right slug and workgroup', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-escalation-'));
    const dir = path.join(root, 'wg-a', 'claims');
    writeDest(root, 'wg-a');
    writeClaim(dir, 'seam-publish-gate', { owner: 'ava', claimed_at: iso(8 * HOUR_MS), ttl_hours: 4 });
    const candidates = findEscalationCandidates(root, NOW);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ workgroupId: 'wg-a', slug: 'seam-publish-gate', staleMs: 4 * HOUR_MS });
  });

  it('a directory with no claims subdir at all is silently skipped', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-escalation-'));
    fs.mkdirSync(path.join(root, 'wg-a'), { recursive: true }); // no claims/ subdir
    writeDest(root, 'wg-a');
    expect(() => findEscalationCandidates(root, NOW)).not.toThrow();
    expect(findEscalationCandidates(root, NOW)).toEqual([]);
  });
});

function candidate(overrides: Partial<EscalationCandidate> = {}, file: string): EscalationCandidate {
  return {
    file,
    workgroupId: 'wg-a',
    slug: 'seam-publish-gate',
    claim: { owner: 'ava', claimed_at: iso(8 * HOUR_MS), ttl_hours: 4 },
    staleMs: 4 * HOUR_MS,
    dest: { channelType: 'slack', platformId: 'C000TEST' },
    ...overrides,
  };
}

describe('escalateClaim', () => {
  function deps(overrides: Partial<EscalationDeliveryDeps> = {}): EscalationDeliveryDeps {
    return {
      resolveMessagingGroup: vi.fn(() => ({ id: 'mg-dispatch' })),
      resolveSession: vi.fn(() => ({ agent_group_id: 'ag-1', id: 'sess-1' })),
      hasOutbound: vi.fn(() => true),
      writeMessage: vi.fn(),
      ...overrides,
    };
  }

  it('delivers via writeMessage and stamps escalated_at on success', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-escalation-'));
    const dir = path.join(root, 'wg-a', 'claims');
    const file = writeClaim(dir, 'seam-publish-gate', { owner: 'ava', claimed_at: iso(8 * HOUR_MS), ttl_hours: 4 });
    const d = deps();

    const result = escalateClaim(candidate({}, file), NOW, d);

    expect(result).toBe(true);
    expect(d.writeMessage).toHaveBeenCalledTimes(1);
    const [agentGroupId, sessionId, message] = (d.writeMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(agentGroupId).toBe('ag-1');
    expect(sessionId).toBe('sess-1');
    expect(message.channelType).toBe('slack');
    expect(message.platformId).toBe('C000TEST');
    expect(message.threadId).toBeNull();
    const body = JSON.parse(message.content) as { text: string };
    expect(body.text).toContain('seam-publish-gate');
    expect(body.text).toContain('ava');

    const stamped = JSON.parse(fs.readFileSync(file, 'utf8')) as { escalated_at?: string };
    expect(stamped.escalated_at).toBe(new Date(NOW).toISOString());
  });

  it('log-and-skip when no messaging group resolves for the destination', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-escalation-'));
    const dir = path.join(root, 'wg-a', 'claims');
    const file = writeClaim(dir, 'seam-publish-gate', {});
    const d = deps({ resolveMessagingGroup: vi.fn(() => undefined) });

    expect(escalateClaim(candidate({}, file), NOW, d)).toBe(false);
    expect(d.writeMessage).not.toHaveBeenCalled();
  });

  it('log-and-skip when no live session exists for the escalation channel', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-escalation-'));
    const dir = path.join(root, 'wg-a', 'claims');
    const file = writeClaim(dir, 'seam-publish-gate', {});
    const d = deps({ resolveSession: vi.fn(() => undefined) });

    expect(escalateClaim(candidate({}, file), NOW, d)).toBe(false);
    expect(d.writeMessage).not.toHaveBeenCalled();
  });

  it('log-and-skip when the resolved session has no outbound.db yet', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-escalation-'));
    const dir = path.join(root, 'wg-a', 'claims');
    const file = writeClaim(dir, 'seam-publish-gate', {});
    const d = deps({ hasOutbound: vi.fn(() => false) });

    expect(escalateClaim(candidate({}, file), NOW, d)).toBe(false);
    expect(d.writeMessage).not.toHaveBeenCalled();
  });

  /**
   * The alert renders one fact per line and carries only the note's first
   * sentence. Notes routinely run several hundred characters of handoff
   * detail, and the whole point of the summary is that a human can act on the
   * alert without reading a paragraph in a notification.
   */
  function textFor(claim: Record<string, unknown>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-escalation-'));
    const file = writeClaim(path.join(root, 'wg-a', 'claims'), 'seam-publish-gate', claim);
    const d = deps();
    escalateClaim(candidate({ claim }, file), NOW, d);
    const [, , message] = (d.writeMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    return (JSON.parse(message.content) as { text: string }).text;
  }

  it('renders owner, staleness and next step on their own lines', () => {
    const text = textFor({ owner: 'ava', claimed_at: iso(8 * HOUR_MS), ttl_hours: 4, note: 'Wallet tie-out.' });

    expect(text.split('\n')).toEqual([
      '⚠️ **Abandoned work claim** — `seam-publish-gate`',
      'Wallet tie-out.',
      '',
      '- **Owner:** ava',
      '- **Stale:** 4.0h past grace, on a 4h TTL',
      '- **Next:** nothing happens automatically — ava releases it, or anyone takes it over.',
    ]);
  });

  it('carries only the first sentence of a long note, marked as truncated', () => {
    const text = textFor({
      owner: 'ava',
      note: 'Dev activation verified already live, no change made.\nOPEN: UI screenshots, saved-id migration decision (owner unassigned). DO NOT flip prod.',
    });

    expect(text).toContain('Dev activation verified already live, no change made. …');
    expect(text).not.toContain('DO NOT flip prod');
  });

  it('caps a first sentence that is itself enormous', () => {
    const text = textFor({ owner: 'ava', note: `${'x'.repeat(400)}. tail` });
    const summary = text.split('\n')[1];

    expect(summary.endsWith(' …')).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(201);
  });

  it('omits the TTL clause when the claim carries no ttl_hours', () => {
    const text = textFor({ owner: 'ava', note: 'Untimed claim.' });

    expect(text.split('\n')).toContain('- **Stale:** 4.0h past grace');
  });
});
