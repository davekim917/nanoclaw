import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../../config.js';
import { enforceHermeticity } from '../../test-hermeticity.js';
import { readSessionTranscript } from './sessions.js';

// This suite writes real session DB files to exercise `readSessionTranscript`
// against the actual on-disk layout — both sides (the fixture writer here and
// `sessions.js`'s own DATA_DIR-relative path resolution) must agree on where
// that layout lives. Unmocked, DATA_DIR resolves to the checkout's own
// `data/` tree, which on a live install is production session state (issue
// #305).
const { TEST_DATA_DIR } = vi.hoisted(() => ({ TEST_DATA_DIR: uniqueTmpRoot('session-transcript') }));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: TEST_DATA_DIR };
});

enforceHermeticity();

/**
 * `readSessionTranscript` against REAL session DB files, because the two things
 * that matter about it only exist at that level: it is deliberately best-effort
 * (a row it cannot understand must still deliver its text), and it is the one
 * place the inbound author is lifted off the stored content JSON.
 *
 * `sessions.test.ts` mocks `fs` module-wide, so this lives in its own file.
 *
 * Every fixture is synthetic. The content SHAPES are taken from the live
 * `messages_in` schema — `chat-sdk` rows carry an `author` object, legacy `chat`
 * rows carry `sender`/`senderId`, and `system`/`task` rows carry neither — but
 * none of the values are.
 */

const AG = 'ag-transcript-fixture';
const SESS = 'sess-transcript-fixture';
const dir = path.join(DATA_DIR, 'v2-sessions', AG, SESS);

interface Row {
  seq: number;
  kind: string;
  content: string;
}

function writeSide(file: 'inbound.db' | 'outbound.db', table: 'messages_in' | 'messages_out', rows: Row[]): void {
  const db = new Database(path.join(dir, file));
  db.exec(`CREATE TABLE ${table} (seq INTEGER PRIMARY KEY, kind TEXT, timestamp TEXT, content TEXT)`);
  const ins = db.prepare(`INSERT INTO ${table} (seq, kind, timestamp, content) VALUES (?, ?, ?, ?)`);
  for (const r of rows) ins.run(r.seq, r.kind, `2026-08-20T10:00:0${r.seq}.000Z`, r.content);
  db.close();
}

beforeAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  writeSide('inbound.db', 'messages_in', [
    // A person, chat-sdk shape.
    {
      seq: 2,
      kind: 'chat-sdk',
      content: JSON.stringify({
        text: 'is the retry path merged?',
        sender: 'fixturehuman',
        senderName: 'Fixture Human',
        senderId: 'UTESTHUMAN01',
        author: {
          userId: 'UTESTHUMAN01',
          userName: 'fixturehuman',
          fullName: 'Fixture Human',
          isBot: false,
          isMe: false,
        },
      }),
    },
    // A sibling agent posting into the same room — inbound, but not a person.
    {
      seq: 4,
      kind: 'chat-sdk',
      content: JSON.stringify({
        text: 'picking this up',
        author: { userId: 'BTESTSIBLING01', fullName: 'Fixture Sibling', isBot: true, isMe: false },
      }),
    },
    // Host-generated: `system` kind carries no author fields at all.
    { seq: 6, kind: 'system', content: JSON.stringify({ subtype: 'context-refresh', text: 'context refreshed' }) },
    // Host writing to itself — `host-sweep.ts` stamps a literal `system` sender.
    {
      seq: 8,
      kind: 'chat',
      content: JSON.stringify({ text: 'container restarted', sender: 'system', senderId: 'system' }),
    },
    // Not JSON at all. THE row this reader's contract exists for.
    { seq: 10, kind: 'chat', content: 'raw text that was never JSON' },
    // JSON, but truncated mid-object — the other way a blob goes malformed.
    { seq: 12, kind: 'chat', content: '{"text":"half a mes' },
  ]);

  writeSide('outbound.db', 'messages_out', [
    { seq: 3, kind: 'chat', content: JSON.stringify({ text: 'merged an hour ago' }) },
    // Outbound must stay untouched even when the blob happens to carry the
    // fields the inbound resolver reads.
    {
      seq: 5,
      kind: 'chat',
      content: JSON.stringify({ text: 'echoed', sender: 'fixturehuman', author: { fullName: 'Fixture Human' } }),
    },
  ]);
});

afterAll(() => {
  fs.rmSync(path.join(DATA_DIR, 'v2-sessions', AG), { recursive: true, force: true });
});

describe('readSessionTranscript carries the inbound author', () => {
  const bySeq = () => new Map(readSessionTranscript(AG, SESS).map((e) => [e.seq, e]));

  it('lifts a human off the stored content, with a stable id and not-a-bot', () => {
    expect(bySeq().get(2)!.author).toEqual({ name: 'Fixture Human', id: 'UTESTHUMAN01', is_bot: false });
  });

  it('separates a sibling agent from a person', () => {
    expect(bySeq().get(4)!.author).toEqual({ name: 'Fixture Sibling', id: 'BTESTSIBLING01', is_bot: true });
  });

  it('leaves a host-generated inbound with no author rather than inventing one', () => {
    const e = bySeq();
    // Neither carries a speaker, and both still carry their text.
    expect(e.get(6)!.author).toBeNull();
    expect(e.get(6)!.text).toBe('context refreshed');
    expect(e.get(8)!.author).toBeNull();
    expect(e.get(8)!.text).toBe('container restarted');
  });

  it('never throws on a malformed blob, and still delivers its text', () => {
    const e = bySeq();
    // Not JSON: the raw content IS the text, exactly as before this change.
    expect(e.get(10)!.text).toBe('raw text that was never JSON');
    expect(e.get(10)!.author).toBeNull();
    // Truncated JSON: same.
    expect(e.get(12)!.text).toBe('{"text":"half a mes');
    expect(e.get(12)!.author).toBeNull();
  });

  it('leaves the outbound side exactly as it was — author is always null there', () => {
    const e = bySeq();
    expect(e.get(3)!).toMatchObject({ direction: 'out', text: 'merged an hour ago', author: null });
    // The agent's identity rides on `agent_name` at the thread layer; a stray
    // author-shaped field in an outbound blob must not become a speaker.
    expect(e.get(5)!.author).toBeNull();
  });

  it('still returns the merged, additive shape the older session view reads', () => {
    const all = readSessionTranscript(AG, SESS);
    expect(all.map((e) => e.seq)).toEqual([12, 10, 8, 6, 5, 4, 3, 2]);
    // Every pre-existing field is still present and unchanged in type.
    for (const e of all) {
      expect(Object.keys(e).sort()).toEqual(['author', 'direction', 'kind', 'seq', 'text', 'timestamp']);
      expect(typeof e.text).toBe('string');
    }
  });

  it('returns an empty array for a session with no DB files at all', () => {
    expect(readSessionTranscript(AG, 'sess-does-not-exist')).toEqual([]);
  });
});
