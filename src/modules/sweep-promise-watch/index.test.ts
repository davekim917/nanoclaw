import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { latestOutboundChat } from '../mailbox/ops/recovery.js';
import type { Session } from '../../types.js';
import {
  _resetPromiseWatchForTesting,
  candidateReason,
  fileCapStore,
  MAX_AGE_MS,
  NUDGE_DAILY_CAP,
  promiseWatchMode,
  QUIET_MS,
  redact,
  scanOnce,
  type NudgeCapStore,
  type NudgeOutcome,
  type ScanDeps,
  type SessionSnapshot,
} from './index.js';

const NOW = Date.parse('2026-09-18T12:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function session(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    archived_at: null,
    container_status: 'stopped',
    last_active: iso(QUIET_MS + 120_000),
    created_at: iso(MAX_AGE_MS),
    ...over,
  } as Session;
}

function snap(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    latestChat: {
      id: 'msg-1',
      timestamp: iso(QUIET_MS + 60_000),
      text: "I'll confirm tomorrow the nightly succeeded.",
    },
    latestInboundAt: iso(QUIET_MS + 120_000),
    nextFutureProcessAfter: null,
    dueCount: 0,
    hasContinuation: false,
    ...over,
  };
}

describe('candidateReason — only a quiet, unarmed, agent-last session is asked about', () => {
  it('accepts the orphan shape', () => {
    expect(candidateReason(session('s'), snap(), NOW)).toBe('candidate');
  });

  it.each([
    ['not-active', session('s', { status: 'closed' }), snap()],
    ['archived', session('s', { archived_at: iso(1000) }), snap()],
    ['container-live', session('s', { container_status: 'running' }), snap()],
    ['no-chat', session('s'), snap({ latestChat: null })],
    ['activity-after', session('s', { last_active: iso(QUIET_MS) }), snap()],
    // A host writer that inserts directly (restart note) without bumping last_active.
    ['activity-after', session('s'), snap({ latestInboundAt: iso(QUIET_MS) })],
    // A tie counts as activity.
    ['activity-after', session('s', { last_active: iso(QUIET_MS + 60_000) }), snap()],
    ['too-recent', session('s'), snap({ latestChat: { id: 'm', timestamp: iso(QUIET_MS - 60_000), text: 'x' } })],
    [
      'too-old',
      session('s', { last_active: iso(MAX_AGE_MS + 120_000) }),
      snap({
        latestChat: { id: 'm', timestamp: iso(MAX_AGE_MS + 60_000), text: 'x' },
        latestInboundAt: iso(MAX_AGE_MS + 120_000),
      }),
    ],
    ['wake-due', session('s'), snap({ dueCount: 1 })],
    ['wake-pending', session('s'), snap({ nextFutureProcessAfter: new Date(NOW + 3_600_000).toISOString() })],
    ['continuation-saved', session('s'), snap({ hasContinuation: true })],
  ] as const)('rejects %s', (reason, s, sn) => {
    expect(candidateReason(s, sn, NOW)).toBe(reason);
  });
});

describe('scanOnce', () => {
  beforeEach(() => _resetPromiseWatchForTesting());

  function memoryCap(counts = new Map<string, number>()): NudgeCapStore {
    return {
      reserve: (d, cap) => {
        const n = counts.get(d) ?? 0;
        if (n >= cap) return false;
        counts.set(d, n + 1);
        return true;
      },
    };
  }

  function deps(over: Partial<ScanDeps> & { snaps?: Record<string, SessionSnapshot> } = {}) {
    const snaps = over.snaps ?? { a: snap() };
    const nudge = vi.fn(async (): Promise<NudgeOutcome> => 'nudged');
    const classify = vi.fn(async () => 0.95);
    const d: ScanDeps = {
      now: () => NOW,
      mode: 'nudge',
      listSessions: async () => Object.keys(snaps).map((id) => session(id)),
      snapshot: async (s) => snaps[s.id],
      classify,
      nudge,
      cap: memoryCap(),
      ...over,
    };
    return { d, nudge, classify };
  }

  it('nudges a confident promise once, and never asks about the same message twice', async () => {
    const { d, nudge, classify } = deps();
    expect(await scanOnce(d)).toEqual({ asked: 1, promises: 1, nudged: 1 });
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(nudge.mock.calls[0]).toEqual([
      expect.objectContaining({ id: 'a' }),
      'msg-1',
      expect.stringContaining("I'll confirm tomorrow"),
      0.95,
    ]);
    expect(await scanOnce(d)).toEqual({ asked: 0, promises: 0, nudged: 0 });
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('shadow mode decides but wakes nothing', async () => {
    const { d, nudge } = deps({ mode: 'shadow' });
    expect(await scanOnce(d)).toEqual({ asked: 1, promises: 1, nudged: 0 });
    expect(nudge).not.toHaveBeenCalled();
  });

  it('does not nudge below the threshold', async () => {
    const { d, nudge } = deps({ classify: async () => 0.6 });
    expect(await scanOnce(d)).toEqual({ asked: 1, promises: 0, nudged: 0 });
    expect(nudge).not.toHaveBeenCalled();
  });

  it('retries a message whose classification failed on the next scan', async () => {
    let fail = true;
    const { d } = deps({
      classify: async () => {
        if (fail) throw new Error('TypeSafe HTTP 503');
        return 0.95;
      },
    });
    expect(await scanOnce(d)).toEqual({ asked: 0, promises: 0, nudged: 0 });
    fail = false;
    expect(await scanOnce(d)).toEqual({ asked: 1, promises: 1, nudged: 1 });
  });

  it('counts a stale admission as decided but not nudged', async () => {
    const { d } = deps({ nudge: async () => 'stale' });
    expect(await scanOnce(d)).toEqual({ asked: 1, promises: 1, nudged: 0 });
    expect(await scanOnce(d)).toEqual({ asked: 0, promises: 0, nudged: 0 });
  });

  it('retries a message whose wake write failed, instead of marking it decided', async () => {
    let fail = true;
    const { d } = deps({
      nudge: async () => {
        if (fail) throw new Error('SQLITE_BUSY');
        return 'nudged';
      },
    });
    expect(await scanOnce(d)).toEqual({ asked: 1, promises: 1, nudged: 0 });
    fail = false;
    expect(await scanOnce(d)).toEqual({ asked: 1, promises: 1, nudged: 1 });
  });

  it('stops nudging at the daily cap', async () => {
    const snaps: Record<string, SessionSnapshot> = {};
    for (let i = 0; i < NUDGE_DAILY_CAP + 3; i++) {
      snaps[`s${i}`] = snap({ latestChat: { id: `m${i}`, timestamp: iso(QUIET_MS + 60_000), text: 'I will retry' } });
    }
    const { d, nudge } = deps({ snaps });
    expect((await scanOnce(d)).nudged).toBe(NUDGE_DAILY_CAP);
    expect(nudge).toHaveBeenCalledTimes(NUDGE_DAILY_CAP);
  });

  it('keeps the daily cap across a restart (the cap store outlives process state)', async () => {
    const cap = memoryCap(new Map([['2026-09-18', NUDGE_DAILY_CAP]]));
    _resetPromiseWatchForTesting();
    const { d, nudge } = deps({ cap });
    expect((await scanOnce(d)).nudged).toBe(0);
    expect(nudge).not.toHaveBeenCalled();
  });

  it('skips a session whose DBs cannot be read, and carries on', async () => {
    const { d } = deps({
      snaps: { a: snap(), b: snap() },
      snapshot: async (s) => {
        if (s.id === 'a') throw new Error('SQLITE_CANTOPEN');
        return snap({ latestChat: { id: 'm2', timestamp: iso(QUIET_MS + 60_000), text: "I'll rerun it" } });
      },
    });
    expect((await scanOnce(d)).nudged).toBe(1);
  });
});

describe('helpers', () => {
  it('is opt-in: anything but an explicit shadow/nudge is off', () => {
    expect(promiseWatchMode(undefined)).toBe('off');
    expect(promiseWatchMode('yes')).toBe('off');
    expect(promiseWatchMode('shadow')).toBe('shadow');
    expect(promiseWatchMode('nudge')).toBe('nudge');
  });

  it('redacts emails and phone-like numbers before the text leaves the host', () => {
    expect(redact('mail person@example.com or call +1 (555) 010-2345, PR #919')).toBe(
      'mail [email] or call [number], PR #919',
    );
  });

  it('reads the newest chat row, not a later status edit', () => {
    const db = new Database(':memory:');
    db.exec(
      'CREATE TABLE messages_out (id TEXT, seq INTEGER, in_reply_to TEXT, kind TEXT, timestamp TEXT, content TEXT)',
    );
    const ins = db.prepare('INSERT INTO messages_out VALUES (?, ?, ?, ?, ?, ?)');
    ins.run('c1', 1, 'in-1', 'chat', '2026-09-17T10:00:00Z', '{"text":"first"}');
    ins.run('c2', 3, 'in-2', 'chat', '2026-09-17T11:00:00Z', '{"text":"I will retry"}');
    ins.run('s1', 5, 'in-2', 'status', '2026-09-17T11:05:00Z', '{"text":"working"}');
    expect(latestOutboundChat(db)).toEqual({
      id: 'c2',
      timestamp: '2026-09-17T11:00:00Z',
      content: '{"text":"I will retry"}',
      in_reply_to: 'in-2',
    });
    db.close();
  });

  it('does not count activity from mid-turn rows written before the final chat', () => {
    // last_active bumped by a CLI response one minute before the agent's final message.
    const s = session('s', { last_active: iso(QUIET_MS + 120_000) });
    expect(candidateReason(s, snap(), NOW)).toBe('candidate');
  });

  it('reserves nudge slots per day in a file, and fails closed on a corrupt one', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-')), 'cap.json');
    const a = fileCapStore(file);
    expect(a.reserve('2026-09-18', 2)).toBe(true);
    expect(a.reserve('2026-09-18', 2)).toBe(true);
    expect(fileCapStore(file).reserve('2026-09-18', 2)).toBe(false); // survives a new store (restart)
    expect(fileCapStore(file).reserve('2026-09-19', 2)).toBe(true); // a new day starts over
    fs.writeFileSync(file, '{not json');
    expect(fileCapStore(file).reserve('2026-09-19', 2)).toBe(false);
  });
});
