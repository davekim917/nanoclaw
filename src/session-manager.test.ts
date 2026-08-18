import path from 'path';
import fs from 'fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { CAPABILITY_STATE } = vi.hoisted(() => ({
  CAPABILITY_STATE: { revision: 'initial' },
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-write-outbound' };
});

vi.mock('./capabilities.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./capabilities.js')>();
  return {
    ...actual,
    buildSessionServicesSnapshot: (...args: Parameters<typeof actual.buildSessionServicesSnapshot>) => {
      const snapshot = actual.buildSessionServicesSnapshot(...args);
      return {
        ...snapshot,
        services: [
          ...snapshot.services,
          {
            name: `Test capability ${CAPABILITY_STATE.revision}`,
            declaredTools: [],
            scopes: [],
            credentialPaths: [],
          },
        ],
      };
    },
  };
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
  sessionMessageExists,
  writeOutboundDirect,
  writeSessionMessage,
  writeSessionMessageIfNew,
  isAdmissiblePreTurnTrigger,
  reconcilePendingUpgradeContexts,
} from './session-manager.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup, getDb } from './db/index.js';
import { createSession } from './db/sessions.js';
import { insertDeferredMessageWithContextIfNew } from './db/session-db.js';
import { insertRecurrence, insertTaskRow, type RecurringMessage } from './modules/scheduling/db.js';
import type { Session } from './types.js';

const AG = 'ag-test';
const SESS = 'sess-test';

async function admitDueTaskContexts(db: Database.Database, agentGroupId: string, sessionId: string): Promise<number> {
  const module = (await import('./session-manager.js')) as typeof import('./session-manager.js') & {
    admitDueTaskContexts: (db: Database.Database, agentGroupId: string, sessionId: string) => number;
  };
  return module.admitDueTaskContexts(db, agentGroupId, sessionId);
}

async function admitPendingUpgradeContexts(
  db: Database.Database,
  agentGroupId: string,
  sessionId: string,
): Promise<number> {
  const module = (await import('./session-manager.js')) as typeof import('./session-manager.js') & {
    admitPendingUpgradeContexts: (db: Database.Database, agentGroupId: string, sessionId: string) => number;
  };
  return module.admitPendingUpgradeContexts(db, agentGroupId, sessionId);
}

async function deferMessageForFreshContextRetry(
  db: Database.Database,
  messageId: string,
  backoffSec: number,
): Promise<void> {
  const module = (await import('./session-manager.js')) as typeof import('./session-manager.js') & {
    deferMessageForFreshContextRetry: (db: Database.Database, messageId: string, backoffSec: number) => void;
  };
  module.deferMessageForFreshContextRetry(db, messageId, backoffSec);
}

describe('threadWorktreeDir', () => {
  it('uses thread_id directly as the key when present', () => {
    const got = threadWorktreeDir('slack:CTEST00004', 'slack:CTEST00004:1778800261.935259');
    expect(got).toBe(path.join(threadsBaseDir(), 'slack_CTEST00004_1778800261.935259', 'worktrees'));
  });

  it('produces NO colons in the path (Docker -v safety)', () => {
    // Docker's -v flag treats `:` as source:target:options separator.
    // A colon anywhere in the host path causes Docker to reject with exit 125.
    const got = threadWorktreeDir('slack:CTEST00004', 'slack:CTEST00004:1778800261.935259');
    expect(got).not.toContain(':');
  });

  it('two siblings on different channelTypes but same platform_id resolve to same path', () => {
    // This is the cross-bot share invariant: helper (slack-example-labs) and
    // helper-codex (slack-helpercodex) both see the same Slack channel, so they
    // get the same platform_id and the same thread_id from chat-sdk-bridge.
    // The mg ids differ (one per channelType), but the worktree path must
    // match for shared collaboration.
    const tid = 'slack:CTEST00004:1778800261.935259';
    const fromHelper = threadWorktreeDir('slack:CTEST00004', tid);
    const fromCodex = threadWorktreeDir('slack:CTEST00004', tid);
    expect(fromHelper).toBe(fromCodex);
  });

  it('falls back to dm-<platform_id> when threadId is null', () => {
    const got = threadWorktreeDir('slack:DTEST00009', null);
    expect(got).toBe(path.join(threadsBaseDir(), 'dm-slack_DTEST00009', 'worktrees'));
  });

  it('two siblings in the same DM (different mgs, same platform_id) share path', () => {
    const a = threadWorktreeDir('slack:DTEST00009', null);
    const b = threadWorktreeDir('slack:DTEST00009', null);
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
    const threadId = 'slack:CTEST00004:1778800261.935259';
    const fromClaude = threadGraphifyCacheDir('slack:CTEST00004', threadId);
    const fromCodex = threadGraphifyCacheDir('slack:CTEST00004', threadId);

    expect(fromClaude).toBe(fromCodex);
    expect(fromClaude).toBe(path.join(threadsBaseDir(), 'slack_CTEST00004_1778800261.935259', 'graphify-cache'));
    expect(fromClaude).not.toContain(':');
    expect(threadGraphifyCacheDir('slack:CTEST00004', 'thread-a')).not.toBe(
      threadGraphifyCacheDir('slack:CTEST00004', 'thread-b'),
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
    fs.rmSync(sessionDir(AG, SESS), { recursive: true, force: true });
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: AG,
      name: 'Reset',
      folder: 'reset',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    getDb()
      .prepare(`INSERT INTO workgroups (id, display_name, created_at) VALUES ('reset','Reset',?)`)
      .run(new Date().toISOString());
    getDb().prepare(`UPDATE agent_groups SET workgroup_id = 'reset' WHERE id = ?`).run(AG);
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

  it('treats a missing inbound DB as unseen without creating it', () => {
    fs.rmSync(sessionDir(AG, SESS), { recursive: true, force: true });

    expect(sessionMessageExists(AG, SESS, 'next-platform-message')).toBe(false);
    expect(fs.existsSync(sessionDir(AG, SESS))).toBe(false);
  });

  it('deduplicates replayed platform message ids before they can create a second agent turn', async () => {
    const input = {
      id: 'discord-message-1:ag-test',
      kind: 'chat-sdk',
      timestamp: '2026-07-21T18:18:00.000Z',
      platformId: 'discord:g:c',
      channelType: 'discord',
      threadId: 'discord:g:c:t',
      content: JSON.stringify({ text: '@Example Agent recover this' }),
    };
    await expect(writeSessionMessageIfNew(AG, SESS, input)).resolves.toBe(true);
    await expect(writeSessionMessageIfNew(AG, SESS, input)).resolves.toBe(false);

    const db = new Database(inboundDbPath(AG, SESS), { readonly: true });
    try {
      const row = db.prepare('SELECT COUNT(*) AS count FROM messages_in WHERE id = ?').get(input.id) as {
        count: number;
      };
      expect(row.count).toBe(1);
    } finally {
      db.close();
    }
  });

  it('finishes an idempotent replay when identical attachment bytes survived an interrupted insert', async () => {
    const messageId = 'discord-attachment-replay:ag-test';
    const filename = 'evidence.txt';
    const bytes = Buffer.from('same attachment bytes');
    const inboxDir = path.join(sessionDir(AG, SESS), 'inbox', messageId);
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, filename), bytes);

    await expect(
      writeSessionMessageIfNew(AG, SESS, {
        id: messageId,
        kind: 'chat-sdk',
        timestamp: '2026-07-21T18:18:00.000Z',
        platformId: 'discord:g:c',
        channelType: 'discord',
        threadId: 'discord:g:c:t',
        content: JSON.stringify({
          text: 'recover the attachment',
          attachments: [{ name: filename, data: bytes.toString('base64') }],
        }),
      }),
    ).resolves.toBe(true);

    const db = new Database(inboundDbPath(AG, SESS), { readonly: true });
    try {
      const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get(messageId) as { content: string };
      const parsed = JSON.parse(row.content) as { attachments: Array<{ data?: string; localPath?: string }> };
      expect(parsed.attachments[0]).toEqual({
        name: filename,
        localPath: `inbox/${messageId}/${filename}`,
      });
    } finally {
      db.close();
    }
  });

  it('keeps duplicate ids strict for non-channel host writes', async () => {
    const input = {
      id: 'system-message-1',
      kind: 'system',
      timestamp: '2026-07-21T18:18:00.000Z',
      content: JSON.stringify({ text: 'wake once' }),
    };
    await expect(writeSessionMessage(AG, SESS, input)).resolves.toBeUndefined();
    await expect(writeSessionMessage(AG, SESS, input)).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it('test_write_inserts_recall_then_trigger_atomically', async () => {
    const input = {
      id: 'paired-message',
      kind: 'chat-sdk',
      timestamp: '2026-07-25T00:00:00.000Z',
      platformId: 'discord:g:c',
      channelType: 'discord',
      threadId: 'discord:g:c:t',
      content: JSON.stringify({ text: 'Where is the project context?' }),
    };
    await expect(writeSessionMessageIfNew(AG, SESS, input)).resolves.toBe(true);

    const db = new Database(inboundDbPath(AG, SESS), { readonly: true });
    try {
      const rows = db
        .prepare(
          `SELECT id, seq, kind, trigger, platform_id, channel_type, thread_id, timestamp, content
             FROM messages_in
            WHERE id IN ('recall-paired-message', 'paired-message')
            ORDER BY seq`,
        )
        .all() as Array<Record<string, unknown>>;
      expect(rows.map((row) => row.id)).toEqual(['recall-paired-message', 'paired-message']);
      expect((rows[1]!.seq as number) - (rows[0]!.seq as number)).toBe(2);
      expect(rows[0]).toMatchObject({
        kind: 'system',
        trigger: 0,
        platform_id: input.platformId,
        channel_type: input.channelType,
        thread_id: input.threadId,
        timestamp: input.timestamp,
      });
      expect(JSON.parse(rows[0]!.content as string)).toMatchObject({ subtype: 'recall_context' });
    } finally {
      db.close();
    }
  });

  it('emits one bootstrap per provider context epoch and suppresses unchanged warm evidence', async () => {
    const memoryRoot = path.join('/tmp/nanoclaw-test-write-outbound', 'workgroups', 'reset', 'memory');
    fs.mkdirSync(path.join(memoryRoot, 'facts'), { recursive: true });
    fs.writeFileSync(path.join(memoryRoot, 'index.md'), '# Canon\nJordan owns deployment.');
    fs.writeFileSync(path.join(memoryRoot, 'facts', 'owner.md'), '# Deployment owner\nJordan owns deployment.');
    const message = (id: string) => ({
      id,
      kind: 'chat-sdk',
      timestamp: '2026-07-25T00:00:00.000Z',
      content: JSON.stringify({ text: 'Who owns deployment?' }),
    });

    await writeSessionMessage(AG, SESS, message('epoch-first'));
    const inbound = new Database(inboundDbPath(AG, SESS));
    const outbound = new Database(outboundDbPath(AG, SESS));
    try {
      inbound
        .prepare(`UPDATE messages_in SET status = 'completed' WHERE id IN ('recall-epoch-first', 'epoch-first')`)
        .run();
      outbound
        .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
        .run('continuation:claude', 'claude-context-1', new Date().toISOString());
      outbound
        .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
        .run('memory_context_epoch:claude', '0', new Date().toISOString());

      await writeSessionMessage(AG, SESS, message('epoch-warm'));
      const first = JSON.parse(
        (
          inbound.prepare('SELECT content FROM messages_in WHERE id = ?').get('recall-epoch-first') as {
            content: string;
          }
        ).content,
      );
      const warm = JSON.parse(
        (
          inbound.prepare('SELECT content FROM messages_in WHERE id = ?').get('recall-epoch-warm') as {
            content: string;
          }
        ).content,
      );
      expect(first.trustedCapabilities).toMatchObject({ agentGroupId: AG });
      expect(first.memoryEvidence.core.map((row: { path: string }) => row.path)).toEqual(['index.md']);
      expect(first.memoryEvidence.excerpts.map((row: { path: string }) => row.path)).toContain('facts/owner.md');
      expect(warm).not.toHaveProperty('trustedCapabilities');
      expect(warm.memoryEvidence.core).toEqual([]);
      expect(warm.memoryEvidence.excerpts).toEqual([]);
      expect(warm.notices.some((notice: { code: string }) => notice.code === 'evidence-already-delivered')).toBe(true);

      outbound
        .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
        .run('memory_context_epoch:claude', '1', new Date().toISOString());
      await writeSessionMessage(AG, SESS, message('epoch-reset'));
      const reset = JSON.parse(
        (
          inbound.prepare('SELECT content FROM messages_in WHERE id = ?').get('recall-epoch-reset') as {
            content: string;
          }
        ).content,
      );
      expect(reset.contextEpoch).toBe(1);
      expect(reset.trustedCapabilities).toMatchObject({ agentGroupId: AG });
      expect(reset.memoryEvidence.core.map((row: { path: string }) => row.path)).toEqual(['index.md']);
      expect(reset.memoryEvidence.excerpts.map((row: { path: string }) => row.path)).toContain('facts/owner.md');
    } finally {
      outbound.close();
      inbound.close();
    }
  });

  it('treats input queued behind a pending clear as a fresh provider context', async () => {
    const memoryRoot = path.join('/tmp/nanoclaw-test-write-outbound', 'workgroups', 'reset', 'memory');
    fs.mkdirSync(path.join(memoryRoot, 'facts'), { recursive: true });
    fs.writeFileSync(path.join(memoryRoot, 'index.md'), '# Canon\nJordan owns deployment.');
    fs.writeFileSync(path.join(memoryRoot, 'facts', 'owner.md'), '# Deployment owner\nJordan owns deployment.');
    const message = (id: string, text: string) => ({
      id,
      kind: 'chat-sdk',
      timestamp: '2026-07-25T00:00:00.000Z',
      content: JSON.stringify({ text }),
    });

    await writeSessionMessage(AG, SESS, message('clear-epoch-first', 'Who owns deployment?'));
    const inbound = new Database(inboundDbPath(AG, SESS));
    const outbound = new Database(outboundDbPath(AG, SESS));
    try {
      inbound
        .prepare(
          `UPDATE messages_in SET status = 'completed'
            WHERE id IN ('recall-clear-epoch-first', 'clear-epoch-first')`,
        )
        .run();
      outbound
        .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
        .run('continuation:claude', 'claude-context-before-clear', new Date().toISOString());
      outbound
        .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
        .run('memory_context_epoch:claude', '0', new Date().toISOString());

      await writeSessionMessage(AG, SESS, message('clear-epoch-command', '/clear'));
      const insertNoise = inbound.prepare(
        `INSERT INTO messages_in
           (id, seq, kind, timestamp, status, content, trigger, on_wake)
         VALUES (?, ?, 'chat-sdk', ?, 'pending', ?, 0, 0)`,
      );
      let seq = (inbound.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages_in').get() as { seq: number }).seq;
      inbound.transaction(() => {
        for (let index = 0; index < 300; index++) {
          seq += 2;
          insertNoise.run(
            `clear-epoch-noise-${index}`,
            seq,
            '2026-07-25T00:00:00.000Z',
            JSON.stringify({ text: `queued non-triggering context ${index}` }),
          );
        }
      })();
      await writeSessionMessage(AG, SESS, message('clear-epoch-followup', 'Who owns deployment?'));

      const followup = JSON.parse(
        (
          inbound.prepare('SELECT content FROM messages_in WHERE id = ?').get('recall-clear-epoch-followup') as {
            content: string;
          }
        ).content,
      );
      expect(followup.trustedCapabilities).toMatchObject({ agentGroupId: AG });
      expect(followup.memoryEvidence.core.map((row: { path: string }) => row.path)).toEqual(['index.md']);
      expect(followup.memoryEvidence.excerpts.map((row: { path: string }) => row.path)).toContain('facts/owner.md');
    } finally {
      outbound.close();
      inbound.close();
    }
  });

  it('does not repeat the bootstrap after more than 256 recall rows in one provider epoch', async () => {
    const memoryRoot = path.join('/tmp/nanoclaw-test-write-outbound', 'workgroups', 'reset', 'memory');
    fs.mkdirSync(memoryRoot, { recursive: true });
    fs.writeFileSync(path.join(memoryRoot, 'index.md'), '# Canon\nBootstrap once.');
    const message = (id: string) => ({
      id,
      kind: 'chat-sdk',
      timestamp: '2026-07-25T00:00:00.000Z',
      content: JSON.stringify({ text: 'What is current?' }),
    });

    await writeSessionMessage(AG, SESS, message('long-epoch-first'));
    const inbound = new Database(inboundDbPath(AG, SESS));
    const outbound = new Database(outboundDbPath(AG, SESS));
    try {
      inbound
        .prepare(
          `UPDATE messages_in SET status = 'completed' WHERE id IN ('recall-long-epoch-first', 'long-epoch-first')`,
        )
        .run();
      outbound
        .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
        .run('continuation:claude', 'claude-context-long', new Date().toISOString());
      outbound
        .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
        .run('memory_context_epoch:claude', '0', new Date().toISOString());

      const insertNoise = inbound.prepare(
        `INSERT INTO messages_in
           (id, seq, kind, timestamp, status, content, trigger, on_wake)
         VALUES (?, ?, 'system', ?, 'completed', ?, 0, 0)`,
      );
      let seq = (inbound.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages_in').get() as { seq: number }).seq;
      inbound.transaction(() => {
        for (let index = 0; index < 300; index++) {
          seq += 2;
          insertNoise.run(
            `recall-long-epoch-noise-${index}`,
            seq,
            '2026-07-25T00:00:00.000Z',
            JSON.stringify({
              subtype: 'recall_context',
              provider: 'claude',
              contextEpoch: 0,
              memoryEvidence: { core: [], excerpts: [] },
              conversationEvidence: { excerpts: [] },
              notices: [],
            }),
          );
        }
      })();

      await writeSessionMessage(AG, SESS, message('long-epoch-warm'));
      const warm = JSON.parse(
        (
          inbound.prepare('SELECT content FROM messages_in WHERE id = ?').get('recall-long-epoch-warm') as {
            content: string;
          }
        ).content,
      );
      expect(warm).not.toHaveProperty('trustedCapabilities');
      expect(warm.memoryEvidence.core).toEqual([]);
    } finally {
      outbound.close();
      inbound.close();
    }
  });

  it('keeps task ingress inert until the due-time recall seam admits it', async () => {
    await writeSessionMessage(AG, SESS, {
      id: 'scheduled-through-session-manager',
      kind: 'task',
      timestamp: '2026-07-25T00:00:00.000Z',
      content: JSON.stringify({ prompt: 'run later' }),
      processAfter: '2099-01-01T00:00:00.000Z',
    });

    const inbound = new Database(inboundDbPath(AG, SESS), { readonly: true });
    try {
      expect(
        inbound
          .prepare(
            `SELECT id, kind, trigger
               FROM messages_in
              WHERE id IN ('recall-scheduled-through-session-manager', 'scheduled-through-session-manager')
              ORDER BY seq`,
          )
          .all(),
      ).toEqual([{ id: 'scheduled-through-session-manager', kind: 'task', trigger: 0 }]);
    } finally {
      inbound.close();
    }
  });

  it('test_duplicate_ingress_inserts_neither_row_twice', async () => {
    const input = {
      id: 'duplicate-pair',
      kind: 'chat-sdk',
      timestamp: '2026-07-25T00:00:00.000Z',
      content: JSON.stringify({ text: 'pair once' }),
    };

    await expect(writeSessionMessageIfNew(AG, SESS, input)).resolves.toBe(true);
    await expect(writeSessionMessageIfNew(AG, SESS, input)).resolves.toBe(false);

    const db = new Database(inboundDbPath(AG, SESS), { readonly: true });
    try {
      expect(
        db
          .prepare(`SELECT id FROM messages_in WHERE id IN ('recall-duplicate-pair', 'duplicate-pair') ORDER BY seq`)
          .all(),
      ).toEqual([{ id: 'recall-duplicate-pair' }, { id: 'duplicate-pair' }]);
    } finally {
      db.close();
    }
  });

  it('pairs pending and processing upgrade turns exactly once while leaving scheduled tasks untouched', async () => {
    initSessionFolder(AG, SESS);
    const db = new Database(inboundDbPath(AG, SESS));
    const insertTurn = db.prepare(
      `INSERT INTO messages_in
         (id,seq,kind,timestamp,status,trigger,platform_id,channel_type,thread_id,content,on_wake)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    insertTurn.run(
      'pending-before-upgrade',
      2,
      'chat-sdk',
      '2026-07-25T23:47:02.398Z',
      'pending',
      1,
      'slack:C1',
      'slack',
      'slack:C1:T1',
      JSON.stringify({ text: 'preserve this pending turn' }),
      0,
    );
    insertTurn.run(
      'processing-before-upgrade',
      4,
      'chat-sdk',
      '2026-07-25T23:47:03.398Z',
      'processing',
      1,
      'slack:C1',
      'slack',
      'slack:C1:T1',
      JSON.stringify({ text: 'recover this interrupted turn' }),
      0,
    );
    insertTaskRow(db, {
      id: 'task-before-upgrade',
      seriesId: 'task-before-upgrade',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: null,
      content: JSON.stringify({ prompt: 'wait for the scheduled-task admission seam' }),
    });
    const scheduledBefore = db
      .prepare('SELECT status, trigger FROM messages_in WHERE id = ?')
      .get('task-before-upgrade');
    const memoryRoot = path.join('/tmp/nanoclaw-test-write-outbound', 'workgroups', 'reset', 'memory');
    fs.mkdirSync(path.join(memoryRoot, 'system'), { recursive: true });
    fs.writeFileSync(path.join(memoryRoot, 'index.md'), '# Current canon\nupgrade-cutover context');
    fs.writeFileSync(path.join(memoryRoot, 'system', 'definition.md'), '# Definition\nfresh upgrade context');

    expect(await admitPendingUpgradeContexts(db, AG, SESS)).toBe(2);
    const pairs = db
      .prepare(
        `SELECT id,seq,kind,status,trigger,content
           FROM messages_in
          WHERE id IN (?,?,?,?)
          ORDER BY seq`,
      )
      .all(
        'recall-pending-before-upgrade',
        'pending-before-upgrade',
        'recall-processing-before-upgrade',
        'processing-before-upgrade',
      ) as Array<{
      id: string;
      seq: number;
      kind: string;
      status: string;
      trigger: number;
      content: string;
    }>;
    expect(pairs.map((row) => row.id)).toEqual([
      'recall-pending-before-upgrade',
      'pending-before-upgrade',
      'recall-processing-before-upgrade',
      'processing-before-upgrade',
    ]);
    for (let index = 0; index < pairs.length; index += 2) {
      expect(pairs[index + 1]!.seq - pairs[index]!.seq).toBe(2);
      expect(pairs[index]).toMatchObject({ kind: 'system', status: 'pending', trigger: 0 });
      expect(pairs[index + 1]).toMatchObject({ kind: 'chat-sdk', status: 'pending', trigger: 1 });
      expect(JSON.parse(pairs[index]!.content)).toMatchObject({
        subtype: 'recall_context',
        provider: 'claude',
        contextEpoch: 0,
      });
    }
    const firstUpgradeRecall = JSON.parse(pairs[0]!.content);
    const secondUpgradeRecall = JSON.parse(pairs[2]!.content);
    expect(firstUpgradeRecall.trustedCapabilities).toMatchObject({ agentGroupId: AG });
    expect(JSON.stringify(firstUpgradeRecall.memoryEvidence)).toContain('upgrade-cutover context');
    expect(secondUpgradeRecall).not.toHaveProperty('trustedCapabilities');
    expect(secondUpgradeRecall.memoryEvidence.core).toEqual([]);
    expect(db.prepare('SELECT status, trigger FROM messages_in WHERE id = ?').get('task-before-upgrade')).toEqual(
      scheduledBefore,
    );
    expect(db.prepare('SELECT id FROM messages_in WHERE id = ?').get('recall-task-before-upgrade')).toBeUndefined();

    expect(await admitPendingUpgradeContexts(db, AG, SESS)).toBe(0);
    expect(
      (
        db
          .prepare('SELECT COUNT(*) AS count FROM messages_in WHERE id LIKE ? OR id IN (?,?)')
          .get('recall-%-before-upgrade', 'pending-before-upgrade', 'processing-before-upgrade') as { count: number }
      ).count,
    ).toBe(4);
    db.close();
  });

  it('upgrades a legacy inbound schema before startup reconciliation admits fresh context', () => {
    const legacySessionId = 'sess-legacy-memory-upgrade';
    createSession({
      id: legacySessionId,
      agent_group_id: AG,
      messaging_group_id: null,
      // Distinct thread: the beforeEach already seeded an active NULL/NULL
      // session on AG, and migration 049 folds NULLs into the unique triple.
      thread_id: 'thr-legacy-upgrade',
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-07-25T23:47:00.000Z',
    });
    const legacyPath = inboundDbPath(AG, legacySessionId);
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE messages_in (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        platform_id TEXT,
        channel_type TEXT,
        thread_id TEXT,
        content TEXT NOT NULL,
        process_after TEXT,
        recurrence TEXT
      )
    `);
    legacy
      .prepare(
        `INSERT INTO messages_in
           (id,seq,kind,timestamp,status,platform_id,channel_type,thread_id,content)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'legacy-pending',
        2,
        'chat-sdk',
        '2026-07-25T23:47:02.398Z',
        'pending',
        'slack:C1',
        'slack',
        'slack:C1:T1',
        JSON.stringify({ text: 'admit me after the schema upgrade' }),
      );
    legacy.close();

    const memoryRoot = path.join('/tmp/nanoclaw-test-write-outbound', 'workgroups', 'reset', 'memory');
    fs.mkdirSync(path.join(memoryRoot, 'system'), { recursive: true });
    fs.writeFileSync(path.join(memoryRoot, 'index.md'), '# Current canon\nlegacy upgrade context');
    fs.writeFileSync(path.join(memoryRoot, 'system', 'definition.md'), '# Definition\nfresh legacy context');

    expect(reconcilePendingUpgradeContexts(getDb(), ['reset'])).toEqual({ sessions: 1, admitted: 1 });

    const verified = new Database(legacyPath, { readonly: true });
    try {
      const columns = new Set(
        (verified.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      );
      for (const column of ['series_id', 'trigger', 'source_session_id', 'on_wake']) {
        expect(columns.has(column), `missing lazy-migrated column ${column}`).toBe(true);
      }
      const rows = verified
        .prepare('SELECT id,seq,status,trigger,on_wake FROM messages_in ORDER BY seq')
        .all() as Array<{ id: string; seq: number; status: string; trigger: number; on_wake: number }>;
      expect(rows.map((row) => row.id)).toEqual(['recall-legacy-pending', 'legacy-pending']);
      expect(rows[1]!.seq - rows[0]!.seq).toBe(2);
      expect(rows[0]).toMatchObject({ status: 'pending', trigger: 0, on_wake: 0 });
      expect(rows[1]).toMatchObject({ status: 'pending', trigger: 1, on_wake: 0 });
    } finally {
      verified.close();
    }
  });

  it('admits nothing while a repository ingress fence is active, then admits after release', async () => {
    // Admission sets trigger = 1, which a fenced row may never carry. Without
    // the fence check this aborts the whole sweep for the session on the guard.
    initSessionFolder(AG, SESS);
    const fencedDb = new Database(inboundDbPath(AG, SESS));
    insertTaskRow(fencedDb, {
      id: 'task-fenced',
      seriesId: 'task-fenced',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: null,
      content: JSON.stringify({ prompt: 'deferred by the fence' }),
    });

    const { activateRepoIngressFence, releaseRepoIngressFence } = await import('./db/session-db.js');
    const fence = activateRepoIngressFence(fencedDb, 'repository-activation:test');

    expect(await admitDueTaskContexts(fencedDb, AG, SESS)).toBe(0);
    expect(
      (fencedDb.prepare('SELECT trigger FROM messages_in WHERE id = ?').get('task-fenced') as { trigger: number })
        .trigger,
    ).toBe(0);

    releaseRepoIngressFence(fencedDb, 'repository-activation:test', fence.generation);
    expect(await admitDueTaskContexts(fencedDb, AG, SESS)).toBe(1);
    fencedDb.close();
  });

  it('admits a first scheduled fire as one fresh adjacent pair and is idempotent on sweep retry', async () => {
    initSessionFolder(AG, SESS);
    const db = new Database(inboundDbPath(AG, SESS));
    insertTaskRow(db, {
      id: 'task-first-fire',
      seriesId: 'task-first-fire',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: null,
      content: JSON.stringify({ prompt: 'use the current task context' }),
    });

    const memoryRoot = path.join('/tmp/nanoclaw-test-write-outbound', 'workgroups', 'reset', 'memory');
    fs.mkdirSync(path.join(memoryRoot, 'system'), { recursive: true });
    fs.writeFileSync(path.join(memoryRoot, 'index.md'), '# Current canon\nfirst-fire context written after scheduling');
    fs.writeFileSync(path.join(memoryRoot, 'system', 'definition.md'), '# Definition\nfresh on every admission');

    expect(await admitDueTaskContexts(db, AG, SESS)).toBe(1);
    const pair = db
      .prepare('SELECT id, seq, kind, trigger, content FROM messages_in WHERE id IN (?, ?) ORDER BY seq')
      .all('recall-task-first-fire', 'task-first-fire') as Array<{
      id: string;
      seq: number;
      kind: string;
      trigger: number;
      content: string;
    }>;
    expect(pair.map((row) => row.id)).toEqual(['recall-task-first-fire', 'task-first-fire']);
    expect(pair[1]!.seq - pair[0]!.seq).toBe(2);
    expect(pair[0]).toMatchObject({ kind: 'system', trigger: 0 });
    expect(pair[1]).toMatchObject({ kind: 'task', trigger: 1 });
    const recall = JSON.parse(pair[0]!.content);
    expect(recall).toMatchObject({
      subtype: 'recall_context',
      trustedCapabilities: { agentGroupId: AG },
    });
    expect(recall.trustedCapabilities.services).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Exa' })]),
    );
    expect(JSON.stringify(recall.memoryEvidence)).toContain('first-fire context written after scheduling');

    expect(await admitDueTaskContexts(db, AG, SESS)).toBe(0);
    expect(
      (
        db
          .prepare('SELECT COUNT(*) AS count FROM messages_in WHERE id IN (?, ?)')
          .get('recall-task-first-fire', 'task-first-fire') as { count: number }
      ).count,
    ).toBe(2);
    db.close();
  });

  it('replaces a due lifecycle marker with fresh recall before waking it', async () => {
    initSessionFolder(AG, SESS);
    const db = new Database(inboundDbPath(AG, SESS));
    const wakeId = 'host-restart-1';
    expect(
      insertDeferredMessageWithContextIfNew(db, {
        id: wakeId,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: AG,
        channelType: 'agent',
        threadId: null,
        content: JSON.stringify({
          text: '[system] account for interrupted work',
          sender: 'system',
          senderId: 'system',
          _system: { kind: 'agent_host_restart' },
        }),
        processAfter: null,
        recurrence: null,
        onWake: 1,
      }),
    ).toBe(true);

    const marker = JSON.parse(
      (db.prepare('SELECT content FROM messages_in WHERE id = ?').get(`recall-${wakeId}`) as { content: string })
        .content,
    );
    expect(marker).toEqual({ subtype: 'recall_context', deferred: true });

    expect(await admitDueTaskContexts(db, AG, SESS)).toBe(1);
    const pair = db
      .prepare('SELECT id, kind, trigger, on_wake, content FROM messages_in WHERE id IN (?, ?) ORDER BY seq')
      .all(`recall-${wakeId}`, wakeId) as Array<{
      id: string;
      kind: string;
      trigger: number;
      on_wake: number;
      content: string;
    }>;
    expect(pair.map((row) => row.id)).toEqual([`recall-${wakeId}`, wakeId]);
    expect(pair.map((row) => row.trigger)).toEqual([0, 1]);
    // The inert pair is protected by on_wake=1 until admission. Once the host
    // makes it wakeable, both halves must be visible even if real inbound
    // already consumed the fresh container's first poll.
    expect(pair.map((row) => row.on_wake)).toEqual([0, 0]);
    expect(JSON.parse(pair[0].content)).toMatchObject({
      subtype: 'recall_context',
      trustedCapabilities: { agentGroupId: AG },
    });
    db.close();
  });

  it('admits a due recurrence clone through the same adjacent-pair seam', async () => {
    initSessionFolder(AG, SESS);
    const db = new Database(inboundDbPath(AG, SESS));
    const original: RecurringMessage = {
      id: 'task-recurring-original',
      kind: 'task',
      content: JSON.stringify({ prompt: 'recurring context' }),
      recurrence: '0 9 * * *',
      process_after: '2020-01-01T00:00:00.000Z',
      platform_id: 'slack:C1',
      channel_type: 'slack',
      thread_id: 'slack:C1:T1',
      series_id: 'task-recurring-original',
    };
    insertRecurrence(db, original, 'task-recurring-next', '2020-01-02T00:00:00.000Z');
    const memoryRoot = path.join('/tmp/nanoclaw-test-write-outbound', 'workgroups', 'reset', 'memory');
    fs.mkdirSync(path.join(memoryRoot, 'system'), { recursive: true });
    fs.writeFileSync(path.join(memoryRoot, 'index.md'), '# Current canon\nrecurrence memory written after cloning');
    fs.writeFileSync(path.join(memoryRoot, 'system', 'definition.md'), '# Definition\nfresh on every admission');

    expect(await admitDueTaskContexts(db, AG, SESS)).toBe(1);
    const pair = db
      .prepare(
        'SELECT id, seq, kind, trigger, series_id, recurrence, platform_id, channel_type, thread_id, content FROM messages_in WHERE id IN (?, ?) ORDER BY seq',
      )
      .all('recall-task-recurring-next', 'task-recurring-next') as Array<Record<string, unknown>>;
    expect(pair.map((row) => row.id)).toEqual(['recall-task-recurring-next', 'task-recurring-next']);
    expect((pair[1]!.seq as number) - (pair[0]!.seq as number)).toBe(2);
    expect(pair[1]).toMatchObject({
      kind: 'task',
      trigger: 1,
      series_id: 'task-recurring-original',
      recurrence: '0 9 * * *',
      platform_id: 'slack:C1',
      channel_type: 'slack',
      thread_id: 'slack:C1:T1',
    });
    const recall = JSON.parse(pair[0]!.content as string);
    expect(recall).toMatchObject({
      subtype: 'recall_context',
      trustedCapabilities: { agentGroupId: AG },
    });
    expect(recall.trustedCapabilities.services).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Exa' })]),
    );
    expect(JSON.stringify(recall.memoryEvidence)).toContain('recurrence memory written after cloning');
    db.close();
  });

  it('replaces crashed-turn recall with current memory and capabilities when backoff becomes due', async () => {
    const memoryRoot = path.join('/tmp/nanoclaw-test-write-outbound', 'workgroups', 'reset', 'memory');
    fs.mkdirSync(path.join(memoryRoot, 'system'), { recursive: true });
    fs.writeFileSync(path.join(memoryRoot, 'index.md'), '# Current canon\nmemory before crash');
    fs.writeFileSync(path.join(memoryRoot, 'system', 'definition.md'), '# Definition\nfresh retry context');
    CAPABILITY_STATE.revision = 'before-crash';

    await writeSessionMessageIfNew(AG, SESS, {
      id: 'chat-crash-retry',
      kind: 'chat-sdk',
      timestamp: '2026-07-25T00:00:00.000Z',
      platformId: 'discord:g:c',
      channelType: 'discord',
      threadId: 'discord:g:c:t',
      content: JSON.stringify({ text: 'retry with current context' }),
    });

    const db = new Database(inboundDbPath(AG, SESS));
    try {
      const firstRecall = JSON.parse(
        (
          db.prepare('SELECT content FROM messages_in WHERE id = ?').get('recall-chat-crash-retry') as {
            content: string;
          }
        ).content,
      );
      expect(JSON.stringify(firstRecall.memoryEvidence)).toContain('memory before crash');
      expect(firstRecall.trustedCapabilities.services).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'Test capability before-crash' })]),
      );

      await deferMessageForFreshContextRetry(db, 'chat-crash-retry', 60);
      const deferred = db
        .prepare('SELECT id, trigger, process_after FROM messages_in WHERE id IN (?, ?) ORDER BY id')
        .all('chat-crash-retry', 'recall-chat-crash-retry') as Array<{
        id: string;
        trigger: number;
        process_after: string | null;
      }>;
      expect(deferred).toHaveLength(2);
      expect(deferred.every((row) => row.trigger === 0)).toBe(true);
      expect(deferred[0]!.process_after).not.toBeNull();
      expect(deferred[0]!.process_after).toBe(deferred[1]!.process_after);
      expect(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS count
                 FROM messages_in
                WHERE status = 'pending' AND trigger = 1
                  AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))`,
            )
            .get() as { count: number }
        ).count,
      ).toBe(0);

      fs.writeFileSync(path.join(memoryRoot, 'index.md'), '# Current canon\nmemory after crash');
      CAPABILITY_STATE.revision = 'after-crash';
      db.prepare('UPDATE messages_in SET process_after = ? WHERE id IN (?, ?)').run(
        '2020-01-01T00:00:00.000Z',
        'chat-crash-retry',
        'recall-chat-crash-retry',
      );

      expect(await admitDueTaskContexts(db, AG, SESS)).toBe(1);
      const replacement = db
        .prepare('SELECT id, seq, kind, trigger, content FROM messages_in WHERE id IN (?, ?) ORDER BY seq')
        .all('recall-chat-crash-retry', 'chat-crash-retry') as Array<{
        id: string;
        seq: number;
        kind: string;
        trigger: number;
        content: string;
      }>;
      expect(replacement.map((row) => row.id)).toEqual(['recall-chat-crash-retry', 'chat-crash-retry']);
      expect(replacement[1]!.seq - replacement[0]!.seq).toBe(2);
      expect(replacement[0]).toMatchObject({ kind: 'system', trigger: 0 });
      expect(replacement[1]).toMatchObject({ kind: 'chat-sdk', trigger: 1 });
      const freshRecall = JSON.parse(replacement[0]!.content);
      expect(JSON.stringify(freshRecall.memoryEvidence)).toContain('memory after crash');
      expect(JSON.stringify(freshRecall.memoryEvidence)).not.toContain('memory before crash');
      expect(freshRecall.trustedCapabilities.services).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'Test capability after-crash' })]),
      );
      expect(freshRecall.trustedCapabilities.services).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'Test capability before-crash' })]),
      );

      expect(await admitDueTaskContexts(db, AG, SESS)).toBe(0);
      expect(
        (
          db
            .prepare('SELECT COUNT(*) AS count FROM messages_in WHERE id IN (?, ?)')
            .get('recall-chat-crash-retry', 'chat-crash-retry') as { count: number }
        ).count,
      ).toBe(2);
    } finally {
      CAPABILITY_STATE.revision = 'initial';
      db.close();
    }
  });

  it('never promotes ordinary accumulated chat without a retry recall marker', async () => {
    await writeSessionMessage(AG, SESS, {
      id: 'accumulated-chat-only',
      kind: 'chat',
      timestamp: '2026-07-25T00:00:00.000Z',
      content: JSON.stringify({ text: 'context only' }),
      processAfter: '2020-01-01T00:00:00.000Z',
      trigger: 0,
    });
    const db = new Database(inboundDbPath(AG, SESS));
    try {
      expect(await admitDueTaskContexts(db, AG, SESS)).toBe(0);
      expect(db.prepare('SELECT kind, trigger FROM messages_in WHERE id = ?').get('accumulated-chat-only')).toEqual({
        kind: 'chat',
        trigger: 0,
      });
      expect(db.prepare('SELECT id FROM messages_in WHERE id = ?').get('recall-accumulated-chat-only')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('leaves a malformed deferred clear-shaped pair inert instead of aborting the due sweep', async () => {
    initSessionFolder(AG, SESS);
    const db = new Database(inboundDbPath(AG, SESS));
    db.prepare(
      `INSERT INTO messages_in
         (id, seq, kind, timestamp, status, content, process_after, trigger, on_wake)
       VALUES
         ('recall-malformed-clear', 2, 'system', ?, 'pending', ?, ?, 0, 0),
         ('malformed-clear', 4, 'chat', ?, 'pending', ?, ?, 0, 0)`,
    ).run(
      '2026-07-25T00:00:00.000Z',
      JSON.stringify({ subtype: 'recall_context', provider: 'claude', contextEpoch: 0 }),
      '2020-01-01T00:00:00.000Z',
      '2026-07-25T00:00:00.000Z',
      JSON.stringify({ text: '/clear malformed retry' }),
      '2020-01-01T00:00:00.000Z',
    );

    try {
      expect(await admitDueTaskContexts(db, AG, SESS)).toBe(0);
      expect(db.prepare('SELECT trigger FROM messages_in WHERE id = ?').get('malformed-clear')).toEqual({
        trigger: 0,
      });
    } finally {
      db.close();
    }
  });

  it('test_lifecycle_turns_use_the_same_fresh_pair_contract', async () => {
    const lifecycleTurns = [
      { id: 'lifecycle-first-wake', text: 'cold start context', onWake: 1 as const },
      { id: 'lifecycle-warm', text: 'warm continuation context', onWake: 0 as const },
      { id: 'lifecycle-compaction', text: '/compact preserve context', onWake: 0 as const },
      { id: 'lifecycle-rotation', text: 'rotated provider context', onWake: 1 as const },
      { id: 'lifecycle-replacement', text: 'replacement provider context', onWake: 1 as const },
    ];

    for (const [index, turn] of lifecycleTurns.entries()) {
      await expect(
        writeSessionMessageIfNew(AG, SESS, {
          id: turn.id,
          kind: 'chat-sdk',
          timestamp: `2026-07-25T00:00:0${index}.000Z`,
          platformId: 'discord:g:c',
          channelType: 'discord',
          threadId: 'discord:g:c:t',
          content: JSON.stringify({ text: turn.text }),
          onWake: turn.onWake,
        }),
      ).resolves.toBe(true);
    }

    const db = new Database(inboundDbPath(AG, SESS), { readonly: true });
    try {
      for (const turn of lifecycleTurns) {
        const rows = db
          .prepare(
            `SELECT id, seq, kind, trigger, on_wake, content
               FROM messages_in
              WHERE id IN (?, ?)
              ORDER BY seq`,
          )
          .all(`recall-${turn.id}`, turn.id) as Array<{
          id: string;
          seq: number;
          kind: string;
          trigger: number;
          on_wake: number;
          content: string;
        }>;
        expect(rows.map((row) => row.id)).toEqual([`recall-${turn.id}`, turn.id]);
        expect(rows[1]!.seq - rows[0]!.seq).toBe(2);
        expect(rows[0]).toMatchObject({ kind: 'system', trigger: 0, on_wake: turn.onWake });
        expect(JSON.parse(rows[0]!.content)).toMatchObject({ subtype: 'recall_context' });
      }
    } finally {
      db.close();
    }
  });

  it.each([
    ['system', 1, '{"text":"system"}'],
    ['chat', 0, '{"text":"context only"}'],
    ['chat-sdk', 1, '{"text":"/clear"}'],
    ['chat-sdk', 1, '{"text":"[Thread context]\\nold\\n[Latest message]\\n<@bot> /clear now"}'],
  ])('does not pair inadmissible %s trigger=%s rows', async (kind, trigger, content) => {
    const id = `inadmissible-${kind}-${trigger}-${content.length}`;
    expect(
      isAdmissiblePreTurnTrigger({ id, kind, timestamp: new Date().toISOString(), content, trigger: trigger as 0 | 1 }),
    ).toBe(false);
    await writeSessionMessage(AG, SESS, {
      id,
      kind,
      timestamp: new Date().toISOString(),
      content,
      trigger: trigger as 0 | 1,
    });
    const db = new Database(inboundDbPath(AG, SESS), { readonly: true });
    try {
      expect(db.prepare('SELECT id FROM messages_in WHERE id = ?').get(id)).toEqual({ id });
      expect(db.prepare('SELECT id FROM messages_in WHERE id = ?').get(`recall-${id}`)).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe('threadWorktreeDir — workgroup namespace', () => {
  it('same workgroup + same thread share one scoped path; different workgroups do not', () => {
    const tid = 'slack:CTEST10001:1778800261.935259';
    const a1 = threadWorktreeDir('slack:CTEST10001', tid, 'acme');
    const a2 = threadWorktreeDir('slack:CTEST10001', tid, 'acme');
    const b = threadWorktreeDir('slack:CTEST10001', tid, 'bluesky');
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).toContain('wg-acme');
    expect(a1).not.toContain(':');
  });

  it('serves the legacy un-namespaced dir while it exists (in-flight threads)', () => {
    const tid = 'slack:CTEST10002:1778800261.935259';
    const legacy = path.join(threadsBaseDir(), 'slack_CTEST10002_1778800261.935259', 'worktrees');
    fs.mkdirSync(legacy, { recursive: true });
    try {
      const got = threadWorktreeDir('slack:CTEST10002', tid, 'acme');
      expect(got).toBe(legacy);
    } finally {
      fs.rmSync(path.dirname(legacy), { recursive: true, force: true });
    }
  });

  it('refuses to adopt a legacy dir stamped by a DIFFERENT workgroup', () => {
    const tid = 'slack:CTEST10004:1778800261.935259';
    const legacyState = path.join(threadsBaseDir(), 'slack_CTEST10004_1778800261.935259');
    fs.mkdirSync(path.join(legacyState, 'worktrees'), { recursive: true });
    fs.writeFileSync(path.join(legacyState, '.wg-owner'), 'bluesky\n');
    try {
      const got = threadWorktreeDir('slack:CTEST10004', tid, 'acme');
      expect(got).toContain('wg-acme');
      // The stamped owner keeps serving its own legacy dir.
      expect(threadWorktreeDir('slack:CTEST10004', tid, 'bluesky')).toBe(path.join(legacyState, 'worktrees'));
    } finally {
      fs.rmSync(legacyState, { recursive: true, force: true });
    }
  });

  it('without a workgroup id resolves to the legacy path (back-compat callers)', () => {
    const tid = 'slack:CTEST10003:1778800261.935259';
    expect(threadWorktreeDir('slack:CTEST10003', tid)).toBe(
      path.join(threadsBaseDir(), 'slack_CTEST10003_1778800261.935259', 'worktrees'),
    );
  });
});
