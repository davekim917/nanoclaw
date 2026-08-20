import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildNudgePrompt,
  buildTakeoverPrompt,
  isHandedOffPark,
  isWaitingOnHuman,
  NUDGE_TASK_QUIET_ARGS,
  SELF_HEAL_COOLDOWN_MS,
  SELF_HEAL_SCAN_INTERVAL_MS,
  shouldSkipSelfHealScan,
  sweepClaimsSelfHeal,
  type SelfHealDeps,
  type SelfHealTaskInput,
} from './self-heal.js';

// Only needed by the one test that exercises the REAL createTask path; the rest
// inject a recording createTask and never reach dispatch.
vi.mock('../../cli/dispatch.js', () => ({ dispatch: vi.fn() }));

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-08-20T12:00:00Z');

function root(claims: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-'));
  const claimsDir = path.join(dir, 'wg-a', 'claims');
  fs.mkdirSync(claimsDir, { recursive: true });
  for (const [slug, body] of Object.entries(claims)) {
    fs.writeFileSync(path.join(claimsDir, `${slug}.json`), JSON.stringify(body, null, 2));
  }
  return dir;
}

/** claimed `hoursAgo` with a 4h ttl — >6h ago is stale past the 2h grace. */
function claim(hoursAgo: number, extra: Record<string, unknown> = {}) {
  return {
    owner: 'ava',
    claimed_at: new Date(NOW - hoursAgo * HOUR).toISOString(),
    ttl_hours: 4,
    note: 'wallet tie-out seam',
    thread_id: 'slack:C0AAA:1786621514.008659',
    ...extra,
  };
}

function readClaimFile(dir: string, slug: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'wg-a', 'claims', `${slug}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
}

/** A board row in the state the prompt builders are asked about. */
const BOARD_CLAIM = {
  slug: 'seam',
  owner: 'ava',
  note: 'wallet tie-out',
  threadId: 'slack:C0AAA:1',
  state: 'stale' as const,
  staleMs: 30 * HOUR,
  escalated: false,
};

const OWNER = { agentGroupId: 'ag-owner', messagingGroupId: 'mg-1', name: 'ava' };
const SIBLING = { agentGroupId: 'ag-sib', messagingGroupId: 'mg-1', name: 'bo' };

/** Fully resolvable targets + a recording createTask. Flags default to armed. */
function deps(dir: string, over: Partial<SelfHealDeps> = {}): SelfHealDeps & { sent: SelfHealTaskInput[] } {
  const sent: SelfHealTaskInput[] = [];
  return {
    root: dir,
    enabled: true,
    takeoverEnabled: true,
    resolveOwner: vi.fn(async () => OWNER),
    resolveSibling: vi.fn(async () => SIBLING),
    createTask: vi.fn(async (input: SelfHealTaskInput) => {
      sent.push(input);
      return true;
    }),
    sent,
    ...over,
  };
}

describe('exclusions — the claims self-heal must never touch', () => {
  it('never nudges a "waiting on <person>" claim, however stale', async () => {
    const dir = root({
      blocked: claim(30, { note: 'waiting on the owner: which OAuth flow for the retry path?' }),
    });
    const d = deps(dir);

    const outcomes = await sweepClaimsSelfHeal(NOW, d);

    expect(outcomes).toEqual([]);
    expect(d.sent).toEqual([]);
    expect(readClaimFile(dir, 'blocked').auto_nudge_count).toBeUndefined();
  });

  it('excludes a waiting-on note even when it is parked and decayed past PARK_GRACE_MS', async () => {
    const dir = root({
      parked: claim(80, {
        status: 'parked',
        parked_at: new Date(NOW - 40 * HOUR).toISOString(),
        note: 'Waiting on the operator: approve the migration window',
      }),
    });
    const d = deps(dir);

    expect(await sweepClaimsSelfHeal(NOW, d)).toEqual([]);
    expect(d.sent).toEqual([]);
  });

  it('only anchors the exclusion at the start — prose that mentions waiting is not the discipline', () => {
    expect(isWaitingOnHuman('waiting on the owner: pick a flow')).toBe(true);
    expect(isWaitingOnHuman('  Waiting On Dana')).toBe(true);
    expect(isWaitingOnHuman('rewrote the parser while waiting on CI')).toBe(false);
  });

  it('never nudges a claim already parked WITH a handoff note, however far past PARK_GRACE_MS', async () => {
    const dir = root({
      handed: claim(80, {
        status: 'parked',
        parked_at: new Date(NOW - 40 * HOUR).toISOString(),
        note: 'not done: schema landed, handlers still TODO — start at src/wallet/tieout.ts',
      }),
    });
    const d = deps(dir);

    expect(await sweepClaimsSelfHeal(NOW, d)).toEqual([]);
    expect(d.sent).toEqual([]);
    expect(readClaimFile(dir, 'handed').auto_nudge_count).toBeUndefined();
  });

  it('still nudges a park whose note says nothing — that is abandonment, not a handoff', async () => {
    const dir = root({
      dumped: claim(80, {
        status: 'parked',
        parked_at: new Date(NOW - 40 * HOUR).toISOString(),
        note: 'parked',
      }),
    });
    const d = deps(dir);

    const [outcome] = await sweepClaimsSelfHeal(NOW, d);
    expect(outcome).toMatchObject({ slug: 'dumped', action: 'nudge', applied: true });
    expect(d.sent).toHaveLength(1);
  });

  it('separates a handoff note from a walk-away by whether it names state AND next step', () => {
    expect(isHandedOffPark({ status: 'parked', note: 'not done: schema done, handlers TODO' })).toBe(true);
    expect(isHandedOffPark({ status: 'Parked', note: 'publish-gate seam, PR #733' })).toBe(true);
    expect(isHandedOffPark({ status: 'parked', note: 'parked' })).toBe(false);
    expect(isHandedOffPark({ status: 'parked', note: 'not done' })).toBe(false);
    expect(isHandedOffPark({ status: 'parked', note: '   ' })).toBe(false);
    expect(isHandedOffPark({ status: 'parked' })).toBe(false);
    // Only a PARKED claim gets the exemption — a live claim with a long note is
    // still just a claim someone stopped working.
    expect(isHandedOffPark({ note: 'schema done, handlers still TODO, start here' })).toBe(false);
  });

  it('never nudges a claim with no thread_id — there is no honest room to guess', async () => {
    const dir = root({ roomless: claim(30, { thread_id: undefined }) });
    const d = deps(dir);

    expect(await sweepClaimsSelfHeal(NOW, d)).toEqual([]);
    expect(d.sent).toEqual([]);
  });

  it('never nudges a claim that declares itself finished, or one that is not yet stale', async () => {
    const dir = root({
      done: claim(30, { released_at: new Date(NOW - 20 * HOUR).toISOString(), status: 'done' }),
      fresh: claim(1),
      ingrace: claim(5),
    });
    const d = deps(dir);

    expect(await sweepClaimsSelfHeal(NOW, d)).toEqual([]);
    expect(d.sent).toEqual([]);
  });
});

describe('ladder', () => {
  it('nudges the owner in the claim thread on the first stale scan', async () => {
    const dir = root({ seam: claim(30) });
    const d = deps(dir);

    const [outcome] = await sweepClaimsSelfHeal(NOW, d);

    expect(outcome).toMatchObject({ slug: 'seam', action: 'nudge', applied: true, target: 'ag-owner' });
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].target).toEqual(OWNER);
    expect(d.sent[0].claim.threadId).toBe('slack:C0AAA:1786621514.008659');
    expect(d.sent[0].prompt).toContain('Automatic nudge 1 of 2');
  });

  it('holds the second nudge until the cooldown elapses, then sends it', async () => {
    const dir = root({ seam: claim(30) });
    const d = deps(dir);
    await sweepClaimsSelfHeal(NOW, d);

    expect(await sweepClaimsSelfHeal(NOW + 6 * HOUR, deps(dir))).toEqual([]);

    const later = deps(dir);
    const [outcome] = await sweepClaimsSelfHeal(NOW + SELF_HEAL_COOLDOWN_MS + 1000, later);
    expect(outcome).toMatchObject({ action: 'nudge', applied: true });
    expect(later.sent[0].prompt).toContain('Automatic nudge 2 of 2');
    expect(readClaimFile(dir, 'seam').auto_nudge_count).toBe(2);
  });

  it('takes over with a SIBLING one cooldown after the second nudge, then exhausts', async () => {
    const dir = root({
      seam: claim(30, { auto_nudge_count: 2, auto_nudged_at: new Date(NOW - 25 * HOUR).toISOString() }),
    });
    const d = deps(dir);

    const [takeover] = await sweepClaimsSelfHeal(NOW, d);

    expect(takeover).toMatchObject({ action: 'takeover', applied: true, target: 'ag-sib' });
    expect(d.sent[0].target).toEqual(SIBLING);
    expect(d.sent[0].prompt).toContain('claim.sh take seam');

    const after = deps(dir);
    const [exhausted] = await sweepClaimsSelfHeal(NOW + 2 * SELF_HEAL_COOLDOWN_MS, after);
    expect(exhausted).toMatchObject({ action: 'exhaust', applied: true });
    expect(after.sent).toEqual([]);
    expect(readClaimFile(dir, 'seam').auto_heal_exhausted_at).toBeTruthy();

    // Exhausted is terminal — it stays red on the board, and nothing fires again.
    const done = deps(dir);
    expect(await sweepClaimsSelfHeal(NOW + 9 * SELF_HEAL_COOLDOWN_MS, done)).toEqual([]);
    expect(done.sent).toEqual([]);
  });

  it('is idempotent within a scan window — a second scan re-sends nothing', async () => {
    const dir = root({ seam: claim(30) });
    await sweepClaimsSelfHeal(NOW, deps(dir));
    const second = deps(dir);

    expect(await sweepClaimsSelfHeal(NOW + 60_000, second)).toEqual([]);
    expect(second.sent).toEqual([]);
    expect(readClaimFile(dir, 'seam').auto_nudge_count).toBe(1);
  });

  it('does not burn a rung when delivery fails', async () => {
    const dir = root({ seam: claim(30) });
    const d = deps(dir, { createTask: async () => false });

    const [outcome] = await sweepClaimsSelfHeal(NOW, d);

    expect(outcome).toMatchObject({ applied: false, reason: 'delivery-failed' });
    expect(readClaimFile(dir, 'seam').auto_nudge_count).toBeUndefined();
  });

  it('restarts the ladder when the claim is re-claimed after a nudge', async () => {
    const dir = root({
      seam: claim(30, {
        auto_nudge_count: 2,
        auto_nudged_at: new Date(NOW - 40 * HOUR).toISOString(),
        // re-taken AFTER the last stamp → a fresh owner, a fresh ladder
        claimed_at: new Date(NOW - 20 * HOUR).toISOString(),
      }),
    });
    const d = deps(dir);

    const [outcome] = await sweepClaimsSelfHeal(NOW, d);

    expect(outcome).toMatchObject({ action: 'nudge', reason: 'first-nudge' });
    expect(d.sent[0].prompt).toContain('Automatic nudge 1 of 2');
    expect(readClaimFile(dir, 'seam').auto_nudge_count).toBe(1);
  });

  it('skips rather than guesses when the owner cannot be resolved to a wired agent group', async () => {
    const dir = root({ seam: claim(30) });
    const d = deps(dir, { resolveOwner: async () => null });

    const [outcome] = await sweepClaimsSelfHeal(NOW, d);

    expect(outcome).toMatchObject({ applied: false, reason: 'owner-unresolved' });
    expect(d.sent).toEqual([]);
    expect(readClaimFile(dir, 'seam').auto_nudge_count).toBeUndefined();
  });
});

describe('flags', () => {
  it('shadow mode detects and reports but spawns nothing and stamps nothing', async () => {
    const dir = root({ seam: claim(30) });
    const d = deps(dir, { enabled: false });

    const [outcome] = await sweepClaimsSelfHeal(NOW, d);

    expect(outcome).toMatchObject({ slug: 'seam', action: 'nudge', applied: false, target: 'ag-owner' });
    expect(d.sent).toEqual([]);
    expect(readClaimFile(dir, 'seam').auto_nudge_count).toBeUndefined();
  });

  it('blocks takeover when only the takeover sub-flag is off', async () => {
    const dir = root({
      seam: claim(30, { auto_nudge_count: 2, auto_nudged_at: new Date(NOW - 25 * HOUR).toISOString() }),
    });
    const d = deps(dir, { takeoverEnabled: false });

    const [outcome] = await sweepClaimsSelfHeal(NOW, d);

    expect(outcome).toMatchObject({ action: 'takeover', applied: false, reason: 'takeover-disabled' });
    expect(d.sent).toEqual([]);
    expect(readClaimFile(dir, 'seam').auto_nudge_count).toBe(2);
  });

  it('still nudges when only the takeover sub-flag is off', async () => {
    const dir = root({ seam: claim(30) });
    const d = deps(dir, { takeoverEnabled: false });

    expect((await sweepClaimsSelfHeal(NOW, d))[0]).toMatchObject({ action: 'nudge', applied: true });
    expect(d.sent).toHaveLength(1);
  });
});

describe('accountability', () => {
  // Acting silently is the named worst case: after ANY action there must be a
  // durable artifact on the claim itself saying what happened and when.
  it('leaves a stamp on the claim file naming the action and its time', async () => {
    const dir = root({ seam: claim(30) });

    await sweepClaimsSelfHeal(NOW, deps(dir));

    const after = readClaimFile(dir, 'seam');
    expect(after.auto_nudge_count).toBe(1);
    expect(after.auto_nudged_at).toBe(new Date(NOW).toISOString());
    // The stamp is additive — the claim's own fields survive verbatim.
    expect(after.owner).toBe('ava');
    expect(after.note).toBe('wallet tie-out seam');
  });

  it('names the claim and the three-option contract in the prompt the agent receives', async () => {
    const dir = root({ seam: claim(30) });
    const d = deps(dir);

    await sweepClaimsSelfHeal(NOW, d);

    const prompt = d.sent[0].prompt;
    expect(prompt).toContain('`seam`');
    expect(prompt).toContain('claim.sh release seam');
    expect(prompt).toContain('naming the human who owns that blocker');
  });
});

describe('anti-noise — a nudge must produce work, not chat', () => {
  it('tells the agent to post NOTHING when it finishes, releases or parks', () => {
    const prompt = buildNudgePrompt(BOARD_CLAIM, 'x');

    expect(prompt).toContain('Post NOTHING for 1 or 2');
    // The clause that produced 22 channel posts in a day.
    expect(prompt).not.toContain('say here');
    expect(prompt).not.toContain('say so here');
    expect(prompt).not.toContain('and say so');
  });

  it('keeps naming a human blocker as the ONE sanctioned post, self-contained', () => {
    const prompt = buildNudgePrompt(BOARD_CLAIM, 'x');

    expect(prompt).toContain('post ONE message naming the human');
    expect(prompt).toContain('ONLY sanctioned post');
    // The delivery caveat: a nudge task's post lands top-level in a channel, so
    // the message has to carry its own context.
    expect(prompt).toContain('stand alone');
    expect(prompt).toContain('which claim');
    // And it must not leave the agent room to hedge by posting anyway.
    expect(prompt).toContain('Do not hedge');
  });

  it('never tells a takeover to announce that it took the claim', () => {
    const prompt = buildTakeoverPrompt(BOARD_CLAIM);

    expect(prompt).toContain('Post nothing: the take rewrites the owner on the board');
    expect(prompt).toContain('Post ONE message saying why this should NOT be taken over');
    expect(prompt).not.toContain('say here that you own it now');
  });

  it('enforces it at the write layer too — one chat send, no streaming status', () => {
    // Instructions demonstrably do not hold on their own; these are the
    // agent-runner-side caps the nudge task is actually created with.
    expect(NUDGE_TASK_QUIET_ARGS).toEqual({ quiet_status: true, chat_limit: 1 });
    // NOT mute_chat — that would silence the human-blocker post too.
    expect(NUDGE_TASK_QUIET_ARGS).not.toHaveProperty('mute_chat');
  });

  it('the REAL task-create path carries those caps into tasks-create', async () => {
    const { dispatch } = await import('../../cli/dispatch.js');
    vi.mocked(dispatch).mockResolvedValue({ id: 'x', ok: true, data: { series_id: 's' } } as never);
    const dir = root({ seam: claim(30) });

    // No createTask override — this exercises defaultCreateTask.
    await sweepClaimsSelfHeal(NOW, {
      root: dir,
      enabled: true,
      resolveOwner: async () => OWNER,
      resolveSibling: async () => SIBLING,
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dispatch).mock.calls[0]![0].args).toMatchObject({
      group: 'ag-owner',
      quiet_status: true,
      chat_limit: 1,
    });
  });
});

describe('prompt builders', () => {
  const board = BOARD_CLAIM;

  it('shares one contract between the human and autonomous nudge paths', () => {
    const human = buildNudgePrompt(board, 'Pushed forward by an operator via the Observatory');
    const auto = buildNudgePrompt(board, 'Automatic nudge 1 of 2 from the host (self-heal)');

    expect(human).toContain('Pushed forward by an operator via the Observatory');
    expect(auto).toContain('Automatic nudge 1 of 2');
    // Everything after the origin clause is identical — that is the point.
    expect(human.slice(human.indexOf('the claim'))).toBe(auto.slice(auto.indexOf('the claim')));
  });

  it('labels a parked claim by when it was parked, not as overdue', () => {
    const prompt = buildNudgePrompt({ ...board, state: 'parked' }, 'x');
    expect(prompt).toContain('30h since parked');
    expect(buildNudgePrompt(board, 'x')).toContain('30h past due');
  });

  it('offers takeover only two options, and never "finish it"', () => {
    const prompt = buildTakeoverPrompt(board);
    expect(prompt).toContain('owned by ava');
    expect(prompt).toContain('claim.sh take seam');
    expect(prompt).not.toContain('1. Finish it');
  });
});

describe('throttle', () => {
  beforeEach(async () => {
    const { _resetSelfHealThrottleForTesting } = await import('./self-heal.js');
    _resetSelfHealThrottleForTesting();
  });

  it('gates the production scan to once per interval', () => {
    expect(shouldSkipSelfHealScan(NOW, NOW + 60_000)).toBe(true);
    expect(shouldSkipSelfHealScan(NOW, NOW + SELF_HEAL_SCAN_INTERVAL_MS)).toBe(false);
    expect(shouldSkipSelfHealScan(0, NOW)).toBe(false);
  });

  it('injecting a root bypasses the production scan throttle so tests stay deterministic', async () => {
    const dir = root({ seam: claim(30) });
    // Two scans a minute apart both run the detection (the second finds nothing
    // to do because of the stamp, not because of the throttle).
    expect((await sweepClaimsSelfHeal(NOW, deps(dir)))[0].applied).toBe(true);
    expect(await sweepClaimsSelfHeal(NOW + 1000, deps(dir))).toEqual([]);
  });
});
