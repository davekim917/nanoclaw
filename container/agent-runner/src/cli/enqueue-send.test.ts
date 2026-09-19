/**
 * enqueue-send: idempotent insert-or-verify, attempt-scoped ids, attachment
 * staging, the separate controller-send budget, and parity with send_message's
 * row (routing + content) so the host treats both identically.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { writeMessageOut } from '../db/messages-out.js';
import { getInboundDb, getOutboundDb } from '../mailbox/sqlite/connection.js';
import { sendMessage } from '../mcp-tools/core.js';
import { setChatMute } from '../modules/mailbox/index.js';
import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';
import {
  CONTROLLER_SEND_BUDGET,
  EnqueueSendError,
  enqueueSend,
  main,
  parseEnqueueArgv,
  type EnqueueSendInput,
} from './enqueue-send.js';

const RUN = 'xzo-pr-pr7-aaaaaaaaaaaa-20260918T100000Z';
const KEY = 'a'.repeat(64);
let tmp: string;

function seedSessionRouting(channelType: string | null, platformId: string | null, threadId: string | null): void {
  const db = getInboundDb();
  db.exec(`CREATE TABLE IF NOT EXISTS session_routing (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    channel_type TEXT, platform_id TEXT, thread_id TEXT
  )`);
  db.prepare(
    'INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, ?)',
  ).run(channelType, platformId, threadId);
}

function seedDestination(name: string, channelType: string, platformId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, name, channelType, platformId);
}

function input(over: Partial<EnqueueSendInput> = {}): EnqueueSendInput {
  return {
    id: `${KEY}#1`,
    to: 'campaign-room',
    text: 'PR 7 smoke: root',
    threadKey: RUN,
    runId: RUN,
    fire: '2026-09-18T10:00:00Z',
    outboxRoot: path.join(tmp, 'outbox'),
    ...over,
  };
}

function rows(): Array<{ id: string; seq: number; content: string; platform_id: string; thread_id: string | null }> {
  return getOutboundDb().prepare('SELECT * FROM messages_out ORDER BY seq').all() as never;
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof EnqueueSendError) return err.code;
    throw err;
  }
  return 'ok';
}

beforeEach(() => {
  initTestSessionDb();
  seedDestination('campaign-room', 'slack', 'slack:C0SMOKE');
  seedSessionRouting('agent', 'ag-gate', 'system:tasks:pr-smoke-gate-7229');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enqueue-send-'));
});

afterEach(() => {
  setChatMute(false);
  closeSessionDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('insert-or-verify', () => {
  test('first call enqueues one odd-seq chat row carrying the run thread key', () => {
    const r = enqueueSend(input());
    expect(r.outcome).toBe('enqueued');
    const all = rows();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(`${KEY}#1`);
    expect(all[0].seq % 2).toBe(1);
    expect(all[0].platform_id).toBe('slack:C0SMOKE');
    expect(JSON.parse(all[0].content)).toEqual({ text: 'PR 7 smoke: root', threadKey: RUN });
  });

  test('re-running the same id and payload is a replay: same seq, one row, no budget spent', () => {
    const first = enqueueSend(input());
    const second = enqueueSend(input());
    expect(second).toEqual({ ok: true, outcome: 'replay', id: first.id, seq: first.seq });
    expect(rows()).toHaveLength(1);
    const budget = getOutboundDb()
      .prepare('SELECT value FROM session_state WHERE key = ?')
      .get(`controller_send_budget:${RUN}`) as { value: string };
    expect(JSON.parse(budget.value).total).toBe(1);
  });

  test('a different payload under an existing id is refused and never overwrites', () => {
    enqueueSend(input());
    const before = rows();
    expect(code(() => enqueueSend(input({ text: 'something else' })))).toBe('mismatch');
    expect(rows()).toEqual(before);
  });

  test('a new attempt is a new id and a new row', () => {
    enqueueSend(input());
    const r = enqueueSend(input({ id: `${KEY}#2` }));
    expect(r.outcome).toBe('enqueued');
    expect(rows().map((x) => x.id)).toEqual([`${KEY}#1`, `${KEY}#2`]);
  });

  test('sequences interleave with the runner writer without colliding and stay odd', async () => {
    enqueueSend(input());
    await writeMessageOut({
      id: 'agent-1',
      kind: 'chat',
      platform_id: 'slack:C0SMOKE',
      channel_type: 'slack',
      content: '{"text":"x"}',
    });
    getInboundDb()
      .prepare(`INSERT INTO messages_in (id, seq, kind, timestamp, content) VALUES ('in-1', 10, 'chat', ?, '{}')`)
      .run(new Date().toISOString());
    enqueueSend(input({ id: `${KEY}#2` }));
    const seqs = rows().map((x) => x.seq);
    expect(seqs).toEqual([1, 3, 11]);
  });
});

describe('input contract', () => {
  test('to, thread key, run id, fire and an attempt-scoped id are all required', () => {
    expect(code(() => enqueueSend(input({ to: '' })))).toBe('invalid');
    expect(code(() => enqueueSend(input({ to: 'nowhere' })))).toBe('invalid');
    expect(code(() => enqueueSend(input({ threadKey: '' })))).toBe('invalid');
    expect(code(() => enqueueSend(input({ threadKey: 'bad key' })))).toBe('invalid');
    expect(code(() => enqueueSend(input({ runId: '' })))).toBe('invalid');
    expect(code(() => enqueueSend(input({ fire: '' })))).toBe('invalid');
    expect(code(() => enqueueSend(input({ id: KEY })))).toBe('invalid');
    expect(code(() => enqueueSend(input({ id: `${KEY}#0` })))).toBe('invalid');
    expect(rows()).toHaveLength(0);
  });

  test('argv parsing refuses unknown and duplicate flags and --text with --text-file', () => {
    expect(() => parseEnqueueArgv(['--nope', 'x'])).toThrow(EnqueueSendError);
    expect(() => parseEnqueueArgv(['--to', 'a', '--to', 'b'])).toThrow(EnqueueSendError);
    expect(() => parseEnqueueArgv(['--text', 'a', '--text-file', '/tmp/x'])).toThrow(EnqueueSendError);
    const parsed = parseEnqueueArgv([
      '--id',
      `${KEY}#1`,
      '--to',
      'campaign-room',
      '--text',
      'hi',
      '--file',
      '/tmp/a.png',
    ]);
    expect(parsed.files).toEqual(['/tmp/a.png']);
  });
});

describe('controller-send budget', () => {
  test('per fire: the budget refuses past the cap and resets on the next fire', () => {
    for (let i = 1; i <= CONTROLLER_SEND_BUDGET.perFire; i++) enqueueSend(input({ id: `k${i}#1` }));
    expect(code(() => enqueueSend(input({ id: 'k-over#1' })))).toBe('budget');
    expect(enqueueSend(input({ id: 'k-next#1', fire: '2026-09-18T10:10:00Z' })).outcome).toBe('enqueued');
  });

  test('per run: the cap holds across fires; a replay still succeeds once it is spent', () => {
    for (let i = 1; i <= CONTROLLER_SEND_BUDGET.perRun; i++) {
      enqueueSend(input({ id: `k${i}#1`, fire: `fire-${Math.ceil(i / CONTROLLER_SEND_BUDGET.perFire)}` }));
    }
    expect(code(() => enqueueSend(input({ id: 'k-over#1', fire: 'fire-99' })))).toBe('budget');
    expect(enqueueSend(input({ id: 'k1#1', fire: 'fire-1' })).outcome).toBe('replay');
    // Another run has its own budget.
    const other = 'xzo-pr-pr8-bbbbbbbbbbbb-20260918T110000Z';
    expect(enqueueSend(input({ id: 'o1#1', runId: other, threadKey: other, fire: 'fire-99' })).outcome).toBe(
      'enqueued',
    );
  });

  test('per alarm fingerprint: at most the cap, then refused', () => {
    for (let i = 1; i <= CONTROLLER_SEND_BUDGET.perFingerprint; i++) {
      enqueueSend(input({ id: `a${i}#1`, fingerprint: 'gate_fetch_failed:7', fire: `f${i}` }));
    }
    expect(code(() => enqueueSend(input({ id: 'a-over#1', fingerprint: 'gate_fetch_failed:7', fire: 'f9' })))).toBe(
      'budget',
    );
  });

  test('an unreadable budget counter refuses rather than reading as nothing sent', () => {
    getOutboundDb()
      .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(`controller_send_budget:${RUN}`, '{not json', new Date().toISOString());
    expect(code(() => enqueueSend(input()))).toBe('budget');
    expect(rows()).toHaveLength(0);
  });

  test("is separate from the model's chat budget: a muted turn does not drop controller sends", () => {
    setChatMute(true);
    expect(enqueueSend(input()).outcome).toBe('enqueued');
    expect(rows()).toHaveLength(1);
  });
});

describe('attachments', () => {
  test('staged at <outbox>/<id>/<name> before the row, and named in the content', () => {
    const file = path.join(tmp, 'sheet.png');
    fs.writeFileSync(file, 'png-bytes');
    enqueueSend(input({ files: [file] }));
    expect(fs.readFileSync(path.join(tmp, 'outbox', `${KEY}#1`, 'sheet.png'), 'utf8')).toBe('png-bytes');
    expect(JSON.parse(rows()[0].content)).toEqual({ text: 'PR 7 smoke: root', files: ['sheet.png'], threadKey: RUN });
  });

  test('a replay does not re-stage (the host may already have delivered and cleared it)', () => {
    const file = path.join(tmp, 'sheet.png');
    fs.writeFileSync(file, 'png-bytes');
    enqueueSend(input({ files: [file] }));
    fs.rmSync(path.join(tmp, 'outbox', `${KEY}#1`), { recursive: true });
    expect(enqueueSend(input({ files: [file] })).outcome).toBe('replay');
    expect(fs.existsSync(path.join(tmp, 'outbox', `${KEY}#1`))).toBe(false);
  });

  test('same id, same file name, changed bytes: refused as a mismatch even after the staged copy is cleared', () => {
    const file = path.join(tmp, 'sheet.png');
    fs.writeFileSync(file, 'png-bytes');
    enqueueSend(input({ files: [file] }));
    // The host clears <outbox>/<id>/ after delivery; the digest record stays.
    fs.rmSync(path.join(tmp, 'outbox', `${KEY}#1`), { recursive: true });
    fs.writeFileSync(file, 'other-bytes');
    expect(code(() => enqueueSend(input({ files: [file] })))).toBe('mismatch');
    fs.writeFileSync(file, 'png-bytes');
    expect(enqueueSend(input({ files: [file] })).outcome).toBe('replay');
    expect(rows()).toHaveLength(1);
  });

  test('a row with files but no readable digest record never verifies as a replay', () => {
    const file = path.join(tmp, 'sheet.png');
    fs.writeFileSync(file, 'png-bytes');
    enqueueSend(input({ files: [file] }));
    getOutboundDb().prepare('DELETE FROM session_state WHERE key = ?').run(`controller_send_files:${KEY}#1`);
    expect(code(() => enqueueSend(input({ files: [file] })))).toBe('mismatch');
  });

  test("the send_file allowlist applies to the real path, so a symlink can't carry a host file out", () => {
    const link = path.join(tmp, 'passwd.png');
    fs.symlinkSync('/etc/passwd', link);
    expect(code(() => enqueueSend(input({ files: [link] })))).toBe('invalid');
    expect(code(() => enqueueSend(input({ files: ['relative.png'] })))).toBe('invalid');
    const empty = path.join(tmp, 'empty.png');
    fs.writeFileSync(empty, '');
    expect(code(() => enqueueSend(input({ files: [empty] })))).toBe('invalid');
    expect(rows()).toHaveLength(0);
    expect(fs.existsSync(path.join(tmp, 'outbox'))).toBe(false);
  });
});

describe('cli exit contract', () => {
  async function run(argv: string[]): Promise<{ exit: number; out: Record<string, unknown> }> {
    const writes: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const exit = await main(argv);
      return { exit, out: JSON.parse(writes.join('').trim().split('\n').pop() as string) };
    } finally {
      process.stdout.write = original;
      // main() stops the mailbox, which closes the in-memory pair: reopen it
      // with the same seed for the next call.
      initTestSessionDb();
    }
  }
  const base = (id: string, text = 'hi', fire = 'f1') => [
    '--id',
    id,
    '--to',
    'campaign-room',
    '--text',
    text,
    '--thread-key',
    RUN,
    '--run-id',
    RUN,
    '--fire',
    fire,
  ];

  test('0 enqueued, 2 invalid, 3 budget (with the alarm name), one JSON line each', async () => {
    const ok = await run(base(`${KEY}#1`));
    expect(ok).toMatchObject({ exit: 0, out: { ok: true, outcome: 'enqueued' } });
    const bad = await run(['--id', 'no-attempt', '--to', 'campaign-room']);
    expect(bad).toMatchObject({ exit: 2, out: { ok: false, code: 'invalid' } });
    initTestSessionDb();
    seedDestination('campaign-room', 'slack', 'slack:C0SMOKE');
    getOutboundDb()
      .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(
        `controller_send_budget:${RUN}`,
        JSON.stringify({ total: 99, fire: '', fireCount: 0, fingerprints: {} }),
        new Date().toISOString(),
      );
    const over = await run(base(`${KEY}#2`));
    expect(over).toMatchObject({ exit: 3, out: { ok: false, code: 'budget', alarm: 'controller_send_budget' } });
  });

  test('4 on a payload mismatch for an existing id', async () => {
    enqueueSend(input({ text: 'first' }));
    const r = await run(base(`${KEY}#1`, 'second'));
    expect(r).toMatchObject({ exit: 4, out: { ok: false, code: 'mismatch' } });
  });
});

describe('parity with send_message', () => {
  test('same routing and content as send_message for the same destination, text and thread key', async () => {
    for (const session of [
      ['agent', 'ag-gate', 'system:tasks:pr-smoke-gate-7229'],
      ['slack', 'slack:C0SMOKE', '1726650000.000100'],
    ] as const) {
      closeSessionDb();
      initTestSessionDb();
      seedDestination('campaign-room', 'slack', 'slack:C0SMOKE');
      seedSessionRouting(session[0], session[1], session[2]);
      await sendMessage.handler({ to: 'campaign-room', text: 'hello', thread_key: RUN });
      enqueueSend(input({ text: 'hello' }));
      const [viaTool, viaHelper] = getOutboundDb()
        .prepare('SELECT kind, channel_type, platform_id, thread_id, content FROM messages_out ORDER BY seq')
        .all();
      expect(viaHelper).toEqual(viaTool);
    }
  });
});
