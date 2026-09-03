import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// applyScheduleWake opens the calling session's real mailbox now — the
// delivery loop no longer lends it a handle (plan §4.5b) — so these tests run
// against a real temp session mailbox instead of an in-memory stand-in.
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-scheduled-wake',
    GROUPS_DIR: '/tmp/nanoclaw-test-scheduled-wake/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-scheduled-wake';

import { getDeliveryAction } from '../../delivery.js';
import { inboundDbPath, initSessionFolder } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { applyScheduleWake } from './index.js';

/** Open the session's real inbound.db the way the host would. */
function inbound(): Database.Database {
  return new Database(inboundDbPath('ag-test', 'sess-test'));
}

function makeInDb(withRouting = true): void {
  initSessionFolder('ag-test', 'sess-test');
  if (withRouting) {
    const db = inbound();
    try {
      db.prepare(
        "INSERT INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, 'slack', 'C-1', 'T-1')",
      ).run();
    } finally {
      db.close();
    }
  }
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

function fakeSession(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

function rows() {
  const db = inbound();
  try {
    return db.prepare("SELECT * FROM messages_in WHERE kind != 'system'").all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function allRows() {
  const db = inbound();
  try {
    return db.prepare('SELECT * FROM messages_in ORDER BY seq').all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

describe('schedule_wake delivery action', () => {
  const wakeId = '123e4567-e89b-42d3-a456-426614174000';

  it('registers the action', () => {
    expect(getDeliveryAction('schedule_wake')).toBeDefined();
  });

  it('writes a process_after row into the same session inbound.db', async () => {
    makeInDb();
    const fireAt = new Date(Date.now() + 15 * 60_000).toISOString();
    await applyScheduleWake(
      {
        action: 'schedule_wake',
        wake_id: wakeId,
        process_after: fireAt,
        prompt: 'Check CI for PR #207 and report status',
      },
      fakeSession(),
    );

    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe('chat');
    expect(r[0].status).toBe('pending');
    expect(r[0].trigger).toBe(0);
    expect(r[0].process_after).toBe(fireAt);
    expect(r[0].platform_id).toBe('C-1');
    expect(r[0].channel_type).toBe('slack');
    expect(r[0].thread_id).toBe('T-1');
    expect(r[0].id).toBe(`schedule-wake-${wakeId}`);
    const content = JSON.parse(r[0].content as string);
    expect(content.senderId).toBe('system');
    expect(content._system.kind).toBe('agent_scheduled_wake');
    expect(content.text).toContain('[system] Check CI for PR #207 and report status');
    // Delivery contract rides with every wake — see routing.selfWake in the runner.
    expect(content.text).toContain('bare final text is NOT delivered');
    const pair = allRows();
    expect(pair.map((row) => row.id)).toEqual([`recall-schedule-wake-${wakeId}`, `schedule-wake-${wakeId}`]);
    expect(pair.map((row) => row.trigger)).toEqual([0, 0]);
    expect(JSON.parse(pair[0].content as string)).toMatchObject({ subtype: 'recall_context', deferred: true });
  });

  it('uses the initiating inbound route instead of a stale session default', async () => {
    makeInDb();
    {
      const db = inbound();
      try {
        db.prepare(
          `INSERT INTO messages_in
             (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content, source_session_id)
           VALUES ('initiating-turn', 2, 'chat', ?, 'completed', 1, 'ag-peer', 'agent', NULL, '{}', 'sess-origin')`,
        ).run(new Date().toISOString());
      } finally {
        db.close();
      }
    }
    const fireAt = new Date(Date.now() + 60_000).toISOString();

    await applyScheduleWake(
      {
        action: 'schedule_wake',
        wake_id: wakeId,
        process_after: fireAt,
        prompt: 'ping',
        in_reply_to: 'initiating-turn',
      },
      fakeSession(),
    );

    const readback = inbound();
    const pair = (() => {
      try {
        return readback
          .prepare(
            `SELECT platform_id, channel_type, thread_id, source_session_id
             FROM messages_in WHERE id IN (?, ?) ORDER BY seq`,
          )
          .all(`recall-schedule-wake-${wakeId}`, `schedule-wake-${wakeId}`);
      } finally {
        readback.close();
      }
    })();
    expect(pair).toEqual([
      { platform_id: 'ag-peer', channel_type: 'agent', thread_id: null, source_session_id: 'sess-origin' },
      { platform_id: 'ag-peer', channel_type: 'agent', thread_id: null, source_session_id: 'sess-origin' },
    ]);
  });

  it('tolerates a session with no routing row', async () => {
    makeInDb(false);
    const fireAt = new Date(Date.now() + 60_000).toISOString();
    await applyScheduleWake(
      { action: 'schedule_wake', wake_id: wakeId, process_after: fireAt, prompt: 'ping' },
      fakeSession(),
    );
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0].platform_id).toBeNull();
  });

  it('rejects invalid payloads without writing or acknowledging success', async () => {
    makeInDb();
    const future = new Date(Date.now() + 60_000).toISOString();
    const tooFar = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString();
    for (const payload of [
      { action: 'schedule_wake', wake_id: wakeId, process_after: future, prompt: '' },
      { action: 'schedule_wake', wake_id: wakeId, process_after: future, prompt: 'x'.repeat(2001) },
      { action: 'schedule_wake', wake_id: 'not-a-uuid', process_after: future, prompt: 'ok' },
      { action: 'schedule_wake', wake_id: wakeId, process_after: 'not a date', prompt: 'ok' },
      { action: 'schedule_wake', wake_id: wakeId, process_after: tooFar, prompt: 'ok' },
      { action: 'schedule_wake', wake_id: wakeId, prompt: 'no time at all' },
      { action: 'schedule_wake', wake_id: wakeId, process_after: future, prompt: 'ok', in_reply_to: 42 },
      { action: 'schedule_wake', wake_id: wakeId, process_after: future, prompt: 'ok', extra: true },
    ]) {
      await expect(applyScheduleWake(payload, fakeSession())).rejects.toThrow('invalid payload');
    }
    expect(rows()).toHaveLength(0);
  });

  it('rejects a reply anchor outside the caller session', async () => {
    makeInDb();
    const future = new Date(Date.now() + 60_000).toISOString();
    await expect(
      applyScheduleWake(
        {
          action: 'schedule_wake',
          wake_id: wakeId,
          process_after: future,
          prompt: 'ok',
          in_reply_to: 'not-in-this-session',
        },
        fakeSession(),
      ),
    ).rejects.toThrow('invalid reply anchor');
    expect(rows()).toHaveLength(0);
  });

  it('delivers an overdue wake immediately instead of dropping it', async () => {
    makeInDb();
    const before = Date.now();
    const past = new Date(before - 60_000).toISOString();
    await applyScheduleWake(
      { action: 'schedule_wake', wake_id: wakeId, process_after: past, prompt: 'check now' },
      fakeSession(),
    );
    const processAfter = Date.parse(rows()[0].process_after as string);
    expect(processAfter).toBeGreaterThanOrEqual(before);
    expect(processAfter).toBeLessThanOrEqual(Date.now());
  });

  it('is idempotent when the same outbound action is replayed', async () => {
    makeInDb();
    const fireAt = new Date(Date.now() + 60_000).toISOString();
    const payload = { action: 'schedule_wake', wake_id: wakeId, process_after: fireAt, prompt: 'ping' };
    await applyScheduleWake(payload, fakeSession());
    await applyScheduleWake(payload, fakeSession());
    expect(rows()).toHaveLength(1);
  });

  it('accepts and idempotently derives an ID for a pre-wake_id payload', async () => {
    makeInDb();
    const payload = {
      action: 'schedule_wake',
      process_after: new Date(Date.now() + 60_000).toISOString(),
      prompt: 'legacy ping',
    };
    await applyScheduleWake(payload, fakeSession());
    await applyScheduleWake(payload, fakeSession());
    expect(rows()).toHaveLength(1);
    expect(rows()[0].id).toMatch(/^schedule-wake-legacy-[0-9a-f]{32}$/);
  });
});
