import path from 'path';
import fs from 'fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-write-outbound' };
});

import {
  threadWorktreeDir,
  threadsBaseDir,
  initSessionFolder,
  outboundDbPath,
  writeOutboundDirect,
} from './session-manager.js';

describe('threadWorktreeDir', () => {
  it('uses thread_id directly as the key when present', () => {
    const got = threadWorktreeDir('slack:C0AJA89MN2E', 'slack:C0AJA89MN2E:1778800261.935259');
    expect(got).toBe(path.join(threadsBaseDir(), 'slack_C0AJA89MN2E_1778800261.935259', 'worktrees'));
  });

  it('produces NO colons in the path (Docker -v safety)', () => {
    // Docker's -v flag treats `:` as source:target:options separator.
    // A colon anywhere in the host path causes Docker to reject with exit 125.
    const got = threadWorktreeDir('slack:C0AJA89MN2E', 'slack:C0AJA89MN2E:1778800261.935259');
    expect(got).not.toContain(':');
  });

  it('two siblings on different channelTypes but same platform_id resolve to same path', () => {
    // This is the cross-bot share invariant: illie (slack-illysium) and
    // illie-codex (slack-illiecodex) both see the same Slack channel, so they
    // get the same platform_id and the same thread_id from chat-sdk-bridge.
    // The mg ids differ (one per channelType), but the worktree path must
    // match for shared collaboration.
    const tid = 'slack:C0AJA89MN2E:1778800261.935259';
    const fromIllie = threadWorktreeDir('slack:C0AJA89MN2E', tid);
    const fromCodex = threadWorktreeDir('slack:C0AJA89MN2E', tid);
    expect(fromIllie).toBe(fromCodex);
  });

  it('falls back to dm-<platform_id> when threadId is null', () => {
    const got = threadWorktreeDir('slack:D0AK1BR5J92', null);
    expect(got).toBe(path.join(threadsBaseDir(), 'dm-slack_D0AK1BR5J92', 'worktrees'));
  });

  it('two siblings in the same DM (different mgs, same platform_id) share path', () => {
    const a = threadWorktreeDir('slack:D0AK1BR5J92', null);
    const b = threadWorktreeDir('slack:D0AK1BR5J92', null);
    expect(a).toBe(b);
  });

  it('strips dangerous characters via fsSlug', () => {
    const got = threadWorktreeDir('slack:weird*chan?', 'slack:weird*chan?:thread\\bad');
    expect(got).not.toContain('*');
    expect(got).not.toContain('?');
    expect(got).not.toContain(':');
    expect(got).not.toContain('\\');
  });
});

/**
 * Tests for session-manager's direct outbound write path.
 *
 * Drives the real `writeOutboundDirect` entry against a real session folder
 * on disk. A previous implementation opened the outbound DB through
 * `openOutboundDb` (readonly: true), so every INSERT threw SQLITE_READONLY
 * and the command-gate denial path silently never delivered. Goes red if the
 * open call reverts to the readonly form.
 */
describe('writeOutboundDirect', () => {
  const TEST_DIR = '/tmp/nanoclaw-test-write-outbound';
  const AG = 'ag-test';
  const SESS = 'sess-test';

  function readMessagesOut(): Array<{ id: string; seq: number; kind: string; content: string }> {
    const db = new Database(outboundDbPath(AG, SESS), { readonly: true });
    try {
      return db.prepare('SELECT id, seq, kind, content FROM messages_out ORDER BY seq').all() as Array<{
        id: string;
        seq: number;
        kind: string;
        content: string;
      }>;
    } finally {
      db.close();
    }
  }

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    initSessionFolder(AG, SESS);
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('inserts into messages_out with an even host-side seq (requires a writable outbound.db)', () => {
    // With a readonly open this very call throws SQLITE_READONLY.
    writeOutboundDirect(AG, SESS, {
      id: 'denial-1',
      kind: 'chat',
      platformId: 'slack:C1',
      channelType: 'slack',
      threadId: null,
      content: JSON.stringify({ text: 'Admin commands are restricted.' }),
    });

    const rows = readMessagesOut();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('denial-1');
    expect(rows[0].seq).toBe(2);
    expect(rows[0].seq % 2).toBe(0); // host uses even seq numbers
    expect(JSON.parse(rows[0].content).text).toBe('Admin commands are restricted.');
  });

  it('keeps host seq numbers even across multiple writes and ignores duplicate ids', () => {
    writeOutboundDirect(AG, SESS, {
      id: 'denial-1',
      kind: 'chat',
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{"text":"first"}',
    });
    writeOutboundDirect(AG, SESS, {
      id: 'denial-2',
      kind: 'chat',
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{"text":"second"}',
    });
    // INSERT OR IGNORE — a delivery retry with the same id must not throw or duplicate.
    writeOutboundDirect(AG, SESS, {
      id: 'denial-1',
      kind: 'chat',
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{"text":"retry"}',
    });

    const rows = readMessagesOut();
    expect(rows.map((r) => r.id)).toEqual(['denial-1', 'denial-2']);
    expect(rows.map((r) => r.seq)).toEqual([2, 4]);
  });
});
