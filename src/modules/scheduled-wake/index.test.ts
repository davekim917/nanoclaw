import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({
  TEST_DIR: globalThis.uniqueTmpRoot('scheduled-wake'),
}));

// applyScheduleWake opens the calling session's real mailbox now — the
// delivery loop no longer lends it a handle (plan §4.5b) — so these tests run
// against a real temp session mailbox instead of an in-memory stand-in.
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: TEST_DIR,
    GROUPS_DIR: `${TEST_DIR}/groups`,
  };
});

import { getDeliveryAction } from '../../delivery.js';
import { initSessionFolder } from '../../session-manager.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
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

  // Regression, PR #268 review: the handler must never call the provisioning
  // helper. `prepare()` opens the CONTAINER-owned outbound.db read-write to
  // apply its schema, which breaks the one-writer-per-file boundary, and the
  // request being handled was read out of that very mailbox, so it exists.
  it('never provisions a mailbox for a session that has none', async () => {
    const fireAt = new Date(Date.now() + 60_000).toISOString();
    await expect(
      applyScheduleWake(
        { action: 'schedule_wake', wake_id: wakeId, process_after: fireAt, prompt: 'ping' },
        fakeSession(),
      ),
    ).rejects.toThrow('session mailbox is gone');
    expect(fs.existsSync(`${TEST_DIR}/v2-sessions/ag-test/sess-test`)).toBe(false);
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

  it('coalesces 100 keyed calls with the first accepted time, prompt and route intact', async () => {
    makeInDb();
    const firstTime = new Date(Date.now() + 60_000).toISOString();
    const payload = {
      action: 'schedule_wake',
      wake_id: wakeId,
      dedupe_key: 'demo/42/head/worker-recovery',
      process_after: firstTime,
      prompt: 'first owned recovery',
    };
    await applyScheduleWake(payload, fakeSession());
    const firstPair = allRows();
    expect(firstPair).toHaveLength(2);
    expect(rows()[0].id).toMatch(/^schedule-wake-keyed-[0-9a-f]{64}$/);
    const db = inbound();
    try {
      db.prepare("UPDATE session_routing SET platform_id = 'C-NEW', thread_id = 'T-NEW'").run();
    } finally {
      db.close();
    }
    for (let i = 1; i < 100; i++) {
      await applyScheduleWake(
        {
          ...payload,
          wake_id: `123e4567-e89b-42d3-a456-${String(i).padStart(12, '0')}`,
          process_after: new Date(Date.now() + (i + 1) * 60_000).toISOString(),
          prompt: `later ${i}`,
        },
        fakeSession(),
      );
    }
    expect(allRows()).toEqual(firstPair);
  });

  it('does not rearm retained processing or terminal rows, including after reopening the mailbox', async () => {
    makeInDb();
    const payload = {
      action: 'schedule_wake',
      dedupe_key: 'one/check',
      prompt: 'check',
      process_after: new Date(Date.now() + 60_000).toISOString(),
    };
    await applyScheduleWake(payload, fakeSession());
    for (const status of ['processing', 'completed', 'cancelled', 'failed']) {
      const db = inbound();
      try {
        db.prepare("UPDATE messages_in SET status = ? WHERE kind = 'chat'").run(status);
      } finally {
        db.close();
      }
      const before = allRows();
      await applyScheduleWake({ ...payload, prompt: 'must not replace' }, fakeSession());
      expect(allRows()).toEqual(before);
    }
  });

  it('scopes keys to the caller session and keeps distinct purposes independent', async () => {
    makeInDb();
    const payload = {
      action: 'schedule_wake',
      dedupe_key: 'same/key',
      prompt: 'check',
      process_after: new Date(Date.now() + 60_000).toISOString(),
    };
    await applyScheduleWake(payload, fakeSession());
    await applyScheduleWake(payload, { ...fakeSession(), agent_provider: 'codex' });
    expect(rows()).toHaveLength(1);
    await applyScheduleWake({ ...payload, dedupe_key: 'other/key' }, fakeSession());
    expect(rows()).toHaveLength(2);
    initSessionFolder('ag-test', 'sess-other');
    await applyScheduleWake(payload, { ...fakeSession(), id: 'sess-other' });
    const other = new Database(inboundDbPath('ag-test', 'sess-other'));
    try {
      const r = other.prepare("SELECT id FROM messages_in WHERE kind = 'chat'").get() as { id: string };
      expect(r.id).toMatch(/^schedule-wake-keyed-/);
      expect(rows().map((row) => row.id)).not.toContain(r.id);
    } finally {
      other.close();
    }
  });

  it('validates duplicate reply anchors and all payload fields before coalescing', async () => {
    makeInDb();
    const payload = {
      action: 'schedule_wake',
      wake_id: wakeId,
      dedupe_key: 'valid/key',
      prompt: 'check',
      process_after: new Date(Date.now() + 60_000).toISOString(),
    };
    await applyScheduleWake(payload, fakeSession());
    const first = allRows();
    await expect(applyScheduleWake({ ...payload, in_reply_to: 'foreign-anchor' }, fakeSession())).rejects.toThrow(
      'invalid reply anchor',
    );
    for (const override of [{ wake_id: 'bad' }, { prompt: '' }, { process_after: 'bad' }, { extra: true }]) {
      await expect(applyScheduleWake({ ...payload, ...override }, fakeSession())).rejects.toThrow('invalid payload');
    }
    expect(allRows()).toEqual(first);
  });

  it('validates key boundaries without silently creating unkeyed requests', async () => {
    makeInDb();
    const payload = {
      action: 'schedule_wake',
      prompt: 'check',
      process_after: new Date(Date.now() + 60_000).toISOString(),
    };
    for (const dedupe_key of [
      '',
      null,
      undefined,
      5,
      {},
      'x'.repeat(201),
      ' x',
      'x ',
      'x\n',
      'x\t',
      'x\0',
      'café',
      '/key',
    ]) {
      await expect(applyScheduleWake({ ...payload, dedupe_key }, fakeSession())).rejects.toThrow('invalid payload');
    }
    expect(allRows()).toHaveLength(0);
    for (const dedupe_key of ['a', 'A' + 'b'.repeat(199), 'demo#42/head._:1/recovery-1']) {
      await applyScheduleWake({ ...payload, dedupe_key }, fakeSession());
    }
    expect(rows()).toHaveLength(3);
  });

  it('serializes same-host delivery calls into one complete keyed pair', async () => {
    makeInDb();
    const payload = {
      action: 'schedule_wake',
      dedupe_key: 'same/host',
      prompt: 'check',
      process_after: new Date(Date.now() + 60_000).toISOString(),
    };
    await Promise.all([applyScheduleWake(payload, fakeSession()), applyScheduleWake(payload, fakeSession())]);
    expect(allRows()).toHaveLength(2);
    expect(rows()).toHaveLength(1);
  });

  it('keeps a separately armed deadline after the one unchanged recovery is consumed', async () => {
    makeInDb();
    const deadline = {
      action: 'schedule_wake',
      dedupe_key: 'demo/42/head/deadline',
      prompt: 'Owner must diagnose or escalate unresolved work',
      process_after: new Date(Date.now() + 600_000).toISOString(),
    };
    const recovery = {
      ...deadline,
      dedupe_key: 'demo/42/head/worker-recovery',
      prompt: 'One recovery check',
      process_after: new Date(Date.now() + 60_000).toISOString(),
    };
    await applyScheduleWake(deadline, fakeSession());
    const firstDeadline = rows()[0];
    await applyScheduleWake(recovery, fakeSession());
    const db = inbound();
    try {
      db.prepare("UPDATE messages_in SET status = 'completed' WHERE kind = 'chat' AND id != ?").run(firstDeadline.id);
    } finally {
      db.close();
    }
    await applyScheduleWake(recovery, fakeSession());
    await applyScheduleWake(
      { ...deadline, process_after: new Date(Date.now() + 900_000).toISOString() },
      fakeSession(),
    );
    expect(rows()).toHaveLength(2);
    expect(rows().find((row) => row.id === firstDeadline.id)).toEqual(firstDeadline);
    expect(rows().filter((row) => row.status === 'completed')).toHaveLength(1);
  });
});
