import path from 'path';
import fs from 'fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-write-outbound' };
});

import {
  graphifyRuntimeDir,
  sessionGraphifyCacheDir,
  threadGraphifyCacheDir,
  threadWorktreeDir,
  threadsBaseDir,
  initSessionFolder,
  inboundDbPath,
  outboundDbPath,
  sessionDir,
  writeOutboundDirect,
  writeSessionMessage,
} from './session-manager.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import { createSession } from './db/sessions.js';
import type { Session } from './types.js';

const AG = 'ag-test';
const SESS = 'sess-test';

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

describe('Graphify cache paths', () => {
  it('test_graphify_thread_cache_is_sibling_shared', () => {
    const threadId = 'slack:C0AJA89MN2E:1778800261.935259';
    const fromClaude = threadGraphifyCacheDir('slack:C0AJA89MN2E', threadId);
    const fromCodex = threadGraphifyCacheDir('slack:C0AJA89MN2E', threadId);

    expect(fromClaude).toBe(fromCodex);
    expect(fromClaude).toBe(path.join(threadsBaseDir(), 'slack_C0AJA89MN2E_1778800261.935259', 'graphify-cache'));
    expect(fromClaude).not.toContain(':');
    expect(threadGraphifyCacheDir('slack:C0AJA89MN2E', 'thread-a')).not.toBe(
      threadGraphifyCacheDir('slack:C0AJA89MN2E', 'thread-b'),
    );
  });

  it('test_graphify_session_cache_is_isolated', () => {
    const first = sessionGraphifyCacheDir('agent-a', 'session-a');
    const second = sessionGraphifyCacheDir('agent-a', 'session-b');

    expect(first).toBe(path.join(sessionDir('agent-a', 'session-a'), 'graphify-cache'));
    expect(first).not.toBe(second);
    expect(first).not.toContain('/workspace/agent');
  });

  it('test_graphify_runtime_dir_is_install_scoped', () => {
    expect(graphifyRuntimeDir()).toBe('/tmp/nanoclaw-test-write-outbound/graphify-runtime');
    expect(graphifyRuntimeDir()).not.toContain('/tmp/home');
    expect(graphifyRuntimeDir()).not.toContain('/workspace/agent');
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

/**
 * The `/debug` skill tells operators to `rm -rf` a session folder to reset a
 * stuck session. The sessions row survives, so the next message takes the
 * existing-session path and lands in `writeSessionMessage` with a missing
 * inbound.db. Without re-provisioning, better-sqlite3 throws on open and the
 * message is logged-and-dropped forever — the reset silently kills the chat.
 */
describe('writeSessionMessage re-provisions a deleted session folder', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: AG,
      name: 'Reset',
      folder: 'reset',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    const sess: Session = {
      id: SESS,
      agent_group_id: AG,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    };
    createSession(sess);
  });

  afterEach(() => {
    closeDb();
  });

  it('re-creates the folder + inbound.db and does not throw when the row still exists', async () => {
    // Operator resets a stuck session by deleting its folder; the row survives.
    fs.rmSync(sessionDir(AG, SESS), { recursive: true, force: true });
    expect(fs.existsSync(inboundDbPath(AG, SESS))).toBe(false);

    await expect(
      writeSessionMessage(AG, SESS, {
        id: 'after-reset-1',
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: 'slack:C1',
        channelType: 'slack',
        threadId: null,
        content: JSON.stringify({ text: 'still here?' }),
      }),
    ).resolves.not.toThrow();

    // The folder + inbound.db are back and the message landed.
    expect(fs.existsSync(inboundDbPath(AG, SESS))).toBe(true);
    const db = new Database(inboundDbPath(AG, SESS), { readonly: true });
    try {
      const row = db.prepare('SELECT id, content FROM messages_in WHERE id = ?').get('after-reset-1') as
        | { id: string; content: string }
        | undefined;
      expect(row?.id).toBe('after-reset-1');
      expect(JSON.parse(row!.content).text).toBe('still here?');
    } finally {
      db.close();
    }
  });
});
