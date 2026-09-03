import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildNudgePrompt,
  buildTakeoverPrompt,
  isHandedOffPark,
  isWaitingOnHuman,
  namedHuman,
  NUDGE_TASK_QUIET_ARGS,
  SELF_HEAL_COOLDOWN_MS,
  SELF_HEAL_SCAN_INTERVAL_MS,
  shouldSkipSelfHealScan,
  sweepClaimsSelfHeal,
  wiredCandidates,
  type SelfHealDeps,
  type SelfHealTaskInput,
} from './self-heal.js';
import { readClaims } from '../../claims-board.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { log } from '../../log.js';

// Only needed by the one test that exercises the REAL createTask path; the rest
// inject a recording createTask and never reach dispatch.
vi.mock('../../cli/dispatch.js', () => ({ dispatch: vi.fn() }));

// A call-through wrapper, not a stub: every test but one gets the real
// classifier untouched. The one exception (`hostile re-read handling` below)
// needs to swap a claim's file for something hostile in the instant between
// `readClaims` classifying it `stale` and self-heal's own re-read of the same
// slug — the same race an agent racing the sweep would exploit — and a plain
// import gives no hook to do that from inside a synchronous call.
vi.mock('../../claims-board.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../claims-board.js')>();
  return { ...actual, readClaims: vi.fn(actual.readClaims) };
});

// The routing-stamp rung reads a per-session inbound DB through the mailbox
// module's read-only session. Only the FILE is stubbed — the action still runs
// the module's real `getLatestTaskRoutingStamp` against an in-memory DB, so the
// production SQL is what these tests exercise, not a stub. `db: null` stands
// for "this session has no mailbox", which the seam answers as `undefined`.
const stamp = vi.hoisted(() => ({ db: null as InstanceType<typeof Database> | null }));
vi.mock('../mailbox/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mailbox/index.js')>();
  const { getLatestTaskRoutingStamp } = await import('../mailbox/ops/reads.js');
  return {
    ...actual,
    readSessionInbound: <T>(
      _location: unknown,
      action: (mailbox: { getLatestTaskRoutingStamp: (seriesId: string) => unknown }) => T,
    ): T | undefined =>
      stamp.db === null
        ? undefined
        : action({ getLatestTaskRoutingStamp: (seriesId: string) => getLatestTaskRoutingStamp(stamp.db!, seriesId) }),
  };
});

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
  it('never NUDGES a "waiting on <person>" claim — the ladder is not for human-blocked work', async () => {
    // 20h claimed on a 4h ttl: stale past grace, but 16h past due — inside the
    // PARK_GRACE_MS suppression window, so still silent.
    const dir = root({
      blocked: claim(20, { note: 'waiting on the owner: which OAuth flow for the retry path?' }),
    });
    const d = deps(dir);

    const outcomes = await sweepClaimsSelfHeal(NOW, d);

    expect(outcomes).toEqual([]);
    expect(d.sent).toEqual([]);
    expect(readClaimFile(dir, 'blocked').auto_nudge_count).toBeUndefined();
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

  it('backs an unresolvable claim off for a day instead of re-deciding it every scan', async () => {
    // The hot loop this closes: 1035 "no deliverable target" warnings from 8
    // claims in one log, because nothing about a failed resolve was recorded.
    const dir = root({ seam: claim(30) });
    const d = deps(dir, { resolveOwner: async () => null });

    await sweepClaimsSelfHeal(NOW, d);
    expect(readClaimFile(dir, 'seam').auto_heal_unresolved_at).toBe(new Date(NOW).toISOString());

    // Next scan, minutes later: silent.
    expect(await sweepClaimsSelfHeal(NOW + SELF_HEAL_SCAN_INTERVAL_MS, d)).toEqual([]);

    // A day later it tries again — a backoff, never a giving-up. The rung is
    // untouched, so it is still the FIRST nudge that is owed.
    const [retry] = await sweepClaimsSelfHeal(NOW + SELF_HEAL_COOLDOWN_MS + 1, d);
    expect(retry).toMatchObject({ action: 'nudge', reason: 'owner-unresolved', applied: false });
    expect(readClaimFile(dir, 'seam').auto_nudge_count).toBeUndefined();
  });

  it('re-arms immediately when the claim is re-claimed into a thread that may resolve', async () => {
    const dir = root({
      seam: claim(30, { auto_heal_unresolved_at: new Date(NOW - HOUR).toISOString() }),
    });
    const d = deps(dir);

    const [outcome] = await sweepClaimsSelfHeal(NOW, d);

    // claimed_at (30h ago) is OLDER than the stamp, so the backoff holds.
    expect(outcome).toBeUndefined();

    const fresh = root({
      seam: claim(4, {
        // Re-claimed AFTER the failed resolve — new work, possibly a new thread.
        auto_heal_unresolved_at: new Date(NOW - 5 * HOUR).toISOString(),
        ttl_hours: 0,
      }),
    });
    const [reclaimed] = await sweepClaimsSelfHeal(NOW, deps(fresh));
    expect(reclaimed).toMatchObject({ action: 'nudge', reason: 'first-nudge', applied: true });
  });

  it('stamps nothing in shadow mode, so a dry run still reports every scan', async () => {
    const dir = root({ seam: claim(30) });
    const d = deps(dir, { resolveOwner: async () => null, enabled: false });

    await sweepClaimsSelfHeal(NOW, d);

    expect(readClaimFile(dir, 'seam').auto_heal_unresolved_at).toBeUndefined();
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
    expect(prompt).toContain('@-mentions whoever owes it');
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

  it('keeps mentioning a blocker (human or agent) as the ONE sanctioned post, self-contained', () => {
    const prompt = buildNudgePrompt(BOARD_CLAIM, 'x');

    // The mention is the delivery mechanism: notification for a human, wake for an agent.
    expect(prompt).toContain('post ONE message that @-mentions whoever owes it');
    expect(prompt).toContain('a human or another agent');
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

/**
 * `readClaims` never classifies a FIFO, an oversized file, or unparseable
 * JSON as `stale` in the first place — its own `readContainedFile` call
 * rejects all three before a `BoardClaim` is ever produced for that slug. So
 * reaching self-heal's OWN re-read of the same slug with one of those on disk
 * needs the file to still be a genuine, healthy, in-cap claim at the instant
 * `readClaims` classifies it, and hostile only a moment later — the exact
 * race an agent with write access to `claims/` (`container-runner.ts` mounts
 * it read-write; `work-claims/claim.sh` writes straight into it) could win
 * against the sweep. These tests reproduce that deterministically: the real
 * classifier runs first, then the file is swapped before control returns to
 * self-heal's loop.
 */
describe('sweepClaimsSelfHeal hostile re-read handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not block on a FIFO swapped in after classification, and skips it with a log', async () => {
    const dir = root({ trap: claim(30) });
    const file = path.join(dir, 'wg-a', 'claims', 'trap.json');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const { readClaims: real } = await vi.importActual<typeof import('../../claims-board.js')>('../../claims-board.js');

    // O_NONBLOCK, and this assertion is what stands on it: with a plain
    // `readFileSync` back in place, this test does not FAIL, it HANGS —
    // opening a FIFO for reading blocks until a writer appears, and that
    // happens before any regular-file check can reject it.
    vi.mocked(readClaims).mockImplementationOnce((workgroupId, now, r) => {
      const result = real(workgroupId, now, r); // classifies the REAL file, still regular
      fs.rmSync(file);
      execFileSync('mkfifo', [file]);
      return result;
    });

    const outcomes = await sweepClaimsSelfHeal(NOW, deps(dir));

    expect(outcomes).toEqual([]); // skipped — no decision, no action, nothing to report
    expect(warn).toHaveBeenCalledWith(
      'self-heal: not a regular file, emitting nothing',
      expect.objectContaining({ relative: 'trap.json' }),
    );
  });

  it('skips a claim grown past the read cap between classification and re-read', async () => {
    const dir = root({ trap: claim(30) });
    const file = path.join(dir, 'wg-a', 'claims', 'trap.json');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const { readClaims: real } = await vi.importActual<typeof import('../../claims-board.js')>('../../claims-board.js');

    vi.mocked(readClaims).mockImplementationOnce((workgroupId, now, r) => {
      const result = real(workgroupId, now, r); // classifies while still 2 KB, in cap
      fs.writeFileSync(file, JSON.stringify({ ...claim(30), note: 'x'.repeat(128 * 1024) }));
      return result;
    });

    const outcomes = await sweepClaimsSelfHeal(NOW, deps(dir));

    expect(outcomes).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'self-heal: file is larger than the read cap, emitting nothing',
      expect.objectContaining({ relative: 'trap.json', cap: 64 * 1024 }),
    );
  });

  it('still nudges an untouched healthy claim through the same re-read path', async () => {
    // The control: nothing about the re-read path changes for a claim nobody
    // tampered with — same nudge behaviour the `ladder` suite already covers,
    // asserted again here so it sits next to the hostile cases it must not
    // regress alongside.
    const dir = root({ seam: claim(30) });
    const d = deps(dir);

    const [outcome] = await sweepClaimsSelfHeal(NOW, d);

    expect(outcome).toMatchObject({ slug: 'seam', action: 'nudge', applied: true, target: 'ag-owner' });
    expect(d.sent).toHaveLength(1);
  });

  it('does not block on a FIFO swapped in during delivery, and THROWS rather than silently dropping the stamp', async () => {
    // `stampClaim`'s own re-read has a WIDER window than the classification
    // re-read above: it fires after `resolveOwner`, `resolveSibling` and
    // `createTask` are all awaited, so the swap has real elapsed time to
    // happen in, not a same-tick race. `createTask` is the hook here because
    // it is the last await before the stamp, and by the time it resolves the
    // nudge has already been DELIVERED — the fact the stamp exists to
    // remember. Unlike the classification path, silently skipping this stamp
    // would leave self-heal believing no nudge was ever sent: the next scan
    // would recompute `count === 0` and send a SECOND nudge for the same
    // rung, and go on doing that every scan forever. So this must throw, not
    // skip — verified below by asserting the promise rejects rather than
    // resolving with an empty outcome.
    const dir = root({ seam: claim(30) });
    const file = path.join(dir, 'wg-a', 'claims', 'seam.json');
    const d = deps(dir, {
      createTask: async (input: SelfHealTaskInput) => {
        fs.rmSync(file);
        execFileSync('mkfifo', [file]);
        return true;
      },
    });

    // Same discriminating signal as the classification-path FIFO test: with a
    // plain `readFileSync` back in `stampClaim`, this does not FAIL, it
    // HANGS — confirmed separately with an external `timeout`.
    await expect(sweepClaimsSelfHeal(NOW, d)).rejects.toThrow(/cannot stamp claim/);
  });
});

describe('wiredCandidates — where a claim can actually be reached', () => {
  beforeEach(() => {
    const db = initTestDb();
    db.exec(`
      CREATE TABLE agent_groups (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE,
        agent_provider TEXT, workgroup_id TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE messaging_groups (
        id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, platform_id TEXT NOT NULL,
        instance TEXT, name TEXT, created_at TEXT NOT NULL, UNIQUE(channel_type, platform_id)
      );
      CREATE TABLE messaging_group_agents (
        id TEXT PRIMARY KEY, messaging_group_id TEXT NOT NULL, agent_group_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL, messaging_group_id TEXT,
        thread_id TEXT, status TEXT DEFAULT 'active', created_at TEXT NOT NULL
      );
      CREATE TABLE task_thread_anchors (
        session_id TEXT NOT NULL, channel_type TEXT NOT NULL, platform_id TEXT NOT NULL,
        thread_platform_id TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, channel_type, platform_id)
      );
      INSERT INTO agent_groups VALUES ('ag-1', 'agent-a', 'agent-a', 'claude', 'wg-a', '2026-08-01T00:00:00Z');
      INSERT INTO messaging_groups VALUES ('mg-1', 'slack-example', 'slack:C0AAA', NULL, '#channel-a', '2026-08-01T00:00:00Z');
      INSERT INTO messaging_group_agents VALUES ('w-1', 'mg-1', 'ag-1', '2026-08-01T00:00:00Z');
      INSERT INTO sessions VALUES ('sess-task', 'ag-1', NULL, 'system:tasks:nightly-sweep-abcd', 'active', '2026-08-01T00:00:00Z');
    `);
  });

  afterEach(() => {
    closeDb();
    stamp.db?.close();
    stamp.db = null;
  });

  function anchor(channelType: string, platformId: string, threadPlatformId: string, createdAt: string): void {
    getDb()
      .prepare('INSERT INTO task_thread_anchors VALUES (?, ?, ?, ?, ?)')
      .run('sess-task', channelType, platformId, threadPlatformId, createdAt);
  }

  it('resolves a scheduled-task claim to the series owner and the room it talks in', async () => {
    // The 78% case: a `system:tasks:*` thread has no messaging group of its
    // own, so the channel join returns nothing and the claim was un-nudgeable
    // forever. The session row IS the owner; the anchor is where it speaks.
    anchor('slack-example', 'slack:C0AAA', '1787250153.097109', '2026-08-20T18:22:33Z');

    expect(await wiredCandidates('wg-a', 'system:tasks:nightly-sweep-abcd')).toEqual([
      {
        agentGroupId: 'ag-1',
        messagingGroupId: 'mg-1',
        name: 'agent-a',
        folder: 'agent-a',
        deliverThreadId: 'slack:C0AAA:1787250153.097109',
      },
    ]);
  });

  it('picks the newest anchor when a series has spoken in more than one room', async () => {
    anchor('slack-example', 'slack:C0AAA', '1111.0001', '2026-08-19T00:00:00Z');
    getDb()
      .prepare('INSERT INTO messaging_groups VALUES (?, ?, ?, NULL, ?, ?)')
      .run('mg-2', 'slack-example', 'slack:C0BBB', '#channel-b', '2026-08-01T00:00:00Z');
    getDb()
      .prepare('INSERT INTO messaging_group_agents VALUES (?, ?, ?, ?)')
      .run('w-2', 'mg-2', 'ag-1', '2026-08-01T00:00:00Z');
    anchor('slack-example', 'slack:C0BBB', '2222.0002', '2026-08-21T00:00:00Z');

    const [row] = await wiredCandidates('wg-a', 'system:tasks:nightly-sweep-abcd');
    expect(row.deliverThreadId).toBe('slack:C0BBB:2222.0002');
  });

  /** The series' routing stamp, on a real in-memory `messages_in`. */
  function stampRouting(platformId: string | null, channelType: string, threadId: string | null): void {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE messages_in (
      id TEXT PRIMARY KEY, seq INTEGER, kind TEXT, series_id TEXT,
      platform_id TEXT, channel_type TEXT, thread_id TEXT
    )`);
    db.prepare('INSERT INTO messages_in VALUES (?, 1, ?, ?, ?, ?, ?)').run(
      'row-1',
      'task',
      'nightly-sweep-abcd',
      platformId,
      channelType,
      threadId,
    );
    stamp.db = db;
  }

  it('prefers where the series LANDED over where its replies are addressed', async () => {
    // The two are not the same fact: an anchor is where output actually went,
    // the stamp is only where an unaddressed reply falls back to. Collapsing
    // them nudges into the default channel for any series that posts elsewhere.
    anchor('slack-example', 'slack:C0AAA', '1787250153.097109', '2026-08-20T18:22:33Z');
    stampRouting('slack:C0AAA', 'slack-example', null);

    const [row] = await wiredCandidates('wg-a', 'system:tasks:nightly-sweep-abcd');
    expect(row.deliverThreadId).toBe('slack:C0AAA:1787250153.097109');
  });

  it('falls back to the routing stamp when the series never anchored', async () => {
    stampRouting('slack:C0AAA', 'slack-example', null);

    expect(await wiredCandidates('wg-a', 'system:tasks:nightly-sweep-abcd')).toEqual([
      {
        agentGroupId: 'ag-1',
        messagingGroupId: 'mg-1',
        name: 'agent-a',
        folder: 'agent-a',
        // null, not undefined — the channel, with no thread. Anything that
        // collapses these two sends the nudge to the claim's task session.
        deliverThreadId: null,
      },
    ]);
  });

  it('resolves nothing rather than guessing when the series never posted and never routed', async () => {
    expect(await wiredCandidates('wg-a', 'system:tasks:nightly-sweep-abcd')).toEqual([]);
  });

  it('resolves nothing for an --isolated series, which stamped no routing on purpose', async () => {
    stampRouting(null, 'slack-example', null);
    expect(await wiredCandidates('wg-a', 'system:tasks:nightly-sweep-abcd')).toEqual([]);
  });

  it('never crosses a workgroup boundary', async () => {
    anchor('slack-example', 'slack:C0AAA', '1787250153.097109', '2026-08-20T18:22:33Z');
    expect(await wiredCandidates('wg-other', 'system:tasks:nightly-sweep-abcd')).toEqual([]);
  });

  it('still resolves an ordinary channel thread through the wiring join', async () => {
    const rows = await wiredCandidates('wg-a', 'slack:C0AAA:1786621514.008659');
    expect(rows).toEqual([{ agentGroupId: 'ag-1', messagingGroupId: 'mg-1', name: 'agent-a', folder: 'agent-a' }]);
  });
});

describe('human-blocked claims — a suppression window, not an exemption', () => {
  /** Parked `hoursAgo`, on a note that names a person. */
  function blocked(hoursAgo: number, extra: Record<string, unknown> = {}) {
    return claim(hoursAgo + 4, {
      status: 'parked',
      parked_at: new Date(NOW - hoursAgo * HOUR).toISOString(),
      note: 'waiting on the operator: approve the migration window before the freeze',
      ...extra,
    });
  }

  it('stays silent inside PARK_GRACE_MS', async () => {
    const d = deps(root({ held: blocked(20) }));

    expect(await sweepClaimsSelfHeal(NOW, d)).toEqual([]);
    expect(d.sent).toEqual([]);
  });

  it('escalates ONCE past the window, then never again', async () => {
    // The live bug: two claims parked on "waiting on <people>" for ~40h, still
    // rendering as a human owing a decision, with no notification ever sent.
    const dir = root({ held: blocked(40) });
    const d = deps(dir);

    const [outcome] = await sweepClaimsSelfHeal(NOW, d);

    expect(outcome).toMatchObject({ slug: 'held', action: 'escalate-human', applied: true, target: 'ag-owner' });
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].target).toEqual(OWNER);
    expect(d.sent[0].name).toBe('escalate held');

    // Stamped terminal on delivery — and stamped in the field effectiveState
    // actually reads, or the one-shot would repeat every day.
    const file = readClaimFile(dir, 'held');
    expect(file.auto_heal_exhausted_at).toBe(new Date(NOW).toISOString());
    expect(file.auto_nudged_at).toBe(new Date(NOW).toISOString());

    for (const later of [SELF_HEAL_COOLDOWN_MS + 1, 9 * SELF_HEAL_COOLDOWN_MS]) {
      const again = deps(dir);
      expect(await sweepClaimsSelfHeal(NOW + later, again)).toEqual([]);
      expect(again.sent).toEqual([]);
    }
  });

  it('demands an @-mention of the named human, because a bare name notifies nobody', async () => {
    const d = deps(root({ held: blocked(40) }));
    await sweepClaimsSelfHeal(NOW, d);

    const prompt = d.sent[0].prompt;
    expect(prompt).toContain('the operator');
    expect(prompt).toContain('👉 @<person>');
    expect(prompt).toContain('@-mentions the operator');
    // It must not read as a nudge: there is no work to push here.
    expect(prompt).not.toContain('Automatic nudge');
  });

  it('reads the person straight out of the note, however the note names them', () => {
    expect(namedHuman('waiting on the operator: approve the window')).toBe('the operator');
    expect(namedHuman('Waiting On the reviewer or the operator: pick one')).toBe('the reviewer or the operator');
    expect(namedHuman('waiting on somebody, eventually')).toBe('whoever you are waiting on');
  });

  it('does not burn the one escalation on a failed delivery', async () => {
    const dir = root({ held: blocked(40) });
    const d = deps(dir, { createTask: async () => false });

    expect(await sweepClaimsSelfHeal(NOW, d)).toMatchObject([{ applied: false, reason: 'delivery-failed' }]);
    expect(readClaimFile(dir, 'held').auto_heal_exhausted_at).toBeUndefined();
  });

  it('still refuses to guess a room when the claim has no thread', async () => {
    const d = deps(root({ held: blocked(40, { thread_id: undefined }) }));

    expect(await sweepClaimsSelfHeal(NOW, d)).toEqual([]);
    expect(d.sent).toEqual([]);
  });

  it('says nothing about a human-blocked claim that already declared itself finished', async () => {
    const d = deps(root({ held: blocked(40, { released_at: new Date(NOW - 20 * HOUR).toISOString() }) }));

    expect(await sweepClaimsSelfHeal(NOW, d)).toEqual([]);
    expect(d.sent).toEqual([]);
  });
});
