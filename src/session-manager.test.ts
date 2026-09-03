import path from 'path';
import fs from 'fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { CAPABILITY_STATE, TEST_DATA_DIR } = vi.hoisted(() => ({
  CAPABILITY_STATE: { revision: 'initial' },
  // This file's fixtures rmSync their own subtrees of DATA_DIR, so a constant
  // path made any two concurrent runs — from any two worktrees on the host —
  // delete each other's session directories mid-test. Measured: 20-33 of ~50
  // tests failing non-deterministically with SQLITE_READONLY_DBMOVED and
  // friends, in both directions, which is untrustworthy green as well as red.
  // uniqueTmpRoot is installed on globalThis by src/test-setup.ts, so it is
  // callable here: a hoisted factory runs before this file's imports are
  // initialized and cannot reference one.
  TEST_DATA_DIR: uniqueTmpRoot('test-write-outbound'),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DATA_DIR };
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
  threadWorktreeDir,
  threadsBaseDir,
  initSessionFolder,
  sessionClaudeProjectsDir,
  sessionContextPath,
  sessionContextPathFor,
  sessionDir,
  sessionMessageExists,
  withExistingMailboxSession,
  withMailboxSession,
  writeSessionMessage,
  writeSessionMessageIfNew,
  SessionWriteRefusedError,
  isAdmissiblePreTurnTrigger,
  reconcilePendingUpgradeContexts,
} from './session-manager.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup, getDb } from './db/index.js';
import { createSession } from './db/sessions.js';
import { insertDeferredMessageWithContextIfNew } from './modules/mailbox/ops/ingress.js';
import { insertRecurrence, insertTaskRow, type RecurringMessage } from './modules/scheduling/db.js';
import { getSessionClaudeMounts } from './session-claude-mounts.js';
import type { AgentGroup, Session } from './types.js';

const AG = 'ag-test';
const SESS = 'sess-test';

// The three admission entry points take a mailbox SESSION now (mailbox seam
// PR 7), not a raw handle. These wrappers open one for the named session so
// each test still calls the production function directly — the fixtures hold
// their own handle on the same file for assertions, which stays valid because
// session DBs are journal_mode=DELETE.
async function admitDueTaskContexts(agentGroupId: string, sessionId: string): Promise<number> {
  const module = await import('./session-manager.js');
  return (
    (await module.withExistingMailboxSession(agentGroupId, sessionId, (mailbox) =>
      module.admitDueTaskContexts(mailbox, agentGroupId, sessionId),
    )) ?? 0
  );
}

async function admitPendingUpgradeContexts(agentGroupId: string, sessionId: string): Promise<number> {
  const module = await import('./session-manager.js');
  return (
    (await module.withExistingMailboxSession(agentGroupId, sessionId, (mailbox) =>
      module.admitPendingUpgradeContexts(mailbox, agentGroupId, sessionId),
    )) ?? 0
  );
}

async function deferMessageForFreshContextRetry(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
  backoffSec: number,
): Promise<void> {
  const module = await import('./session-manager.js');
  await module.withExistingMailboxSession(agentGroupId, sessionId, (mailbox) =>
    module.deferMessageForFreshContextRetry(mailbox, messageId, backoffSec),
  );
}

describe('threadWorktreeDir', () => {
  it('uses thread_id directly as the key when present', async () => {
    const got = threadWorktreeDir('slack:CTEST00004', 'slack:CTEST00004:1778800261.935259');
    expect(got).toBe(path.join(threadsBaseDir(), 'slack_CTEST00004_1778800261.935259', 'worktrees'));
  });

  it('produces NO colons in the path (Docker -v safety)', async () => {
    // Docker's -v flag treats `:` as source:target:options separator.
    // A colon anywhere in the host path causes Docker to reject with exit 125.
    const got = threadWorktreeDir('slack:CTEST00004', 'slack:CTEST00004:1778800261.935259');
    expect(got).not.toContain(':');
  });

  it('two siblings on different channelTypes but same platform_id resolve to same path', async () => {
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

  it('falls back to dm-<platform_id> when threadId is null', async () => {
    const got = threadWorktreeDir('slack:DTEST00009', null);
    expect(got).toBe(path.join(threadsBaseDir(), 'dm-slack_DTEST00009', 'worktrees'));
  });

  it('two siblings in the same DM (different mgs, same platform_id) share path', async () => {
    const a = threadWorktreeDir('slack:DTEST00009', null);
    const b = threadWorktreeDir('slack:DTEST00009', null);
    expect(a).toBe(b);
  });

  it('strips dangerous characters via fsSlug', async () => {
    const got = threadWorktreeDir('slack:weird*chan?', 'slack:weird*chan?:thread\\bad');
    expect(got).not.toContain('*');
    expect(got).not.toContain('?');
    expect(got).not.toContain(':');
    expect(got).not.toContain('\\');
  });
});

/**
 * Tests for the direct outbound write path.
 *
 * Drives the real `writeOutboundDirect` op through the mailbox seam against a
 * real session folder on disk. A previous implementation opened the outbound
 * DB readonly, so every INSERT threw SQLITE_READONLY and the command-gate
 * denial path silently never delivered. Goes red if the open reverts to the
 * readonly form.
 */
describe('writeOutboundDirect', () => {
  const TEST_DIR = TEST_DATA_DIR;
  const AG = 'ag-test';
  const SESS = 'sess-test';

  /** The seam's op, for a session the fixture has already provisioned. */
  async function writeOutboundDirectRow(message: {
    id: string;
    kind: string;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    content: string;
  }): Promise<void> {
    await withExistingMailboxSession(AG, SESS, (mailbox) => mailbox.writeOutboundDirect(message));
  }

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

  it('inserts into messages_out with an even host-side seq (requires a writable outbound.db)', async () => {
    // With a readonly open this very call throws SQLITE_READONLY.
    await writeOutboundDirectRow({
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

  it('keeps host seq numbers even across multiple writes and ignores duplicate ids', async () => {
    await writeOutboundDirectRow({
      id: 'denial-1',
      kind: 'chat',
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{"text":"first"}',
    });
    await writeOutboundDirectRow({
      id: 'denial-2',
      kind: 'chat',
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{"text":"second"}',
    });
    // INSERT OR IGNORE — a delivery retry with the same id must not throw or duplicate.
    await writeOutboundDirectRow({
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

  it('treats a missing inbound DB as unseen without creating it', async () => {
    fs.rmSync(sessionDir(AG, SESS), { recursive: true, force: true });

    expect(await sessionMessageExists(AG, SESS, 'next-platform-message')).toBe(false);
    expect(fs.existsSync(sessionDir(AG, SESS))).toBe(false);
  });

  /**
   * Routine ingress must never write the container-owned outbound.db.
   *
   * The provisioning funnel's `prepare()` calls `ensureSchema(..., 'outbound')`,
   * which opens that file read-write and runs DDL. A message arriving while the
   * container is live would make the host a second writer on a cross-mount
   * SQLite file, on every message — which is not what the pre-seam path did
   * (it opened inbound.db and nothing else).
   *
   * Deleting outbound.db is the crisp probe: `ensureSchema` would recreate it,
   * so its continued absence proves no writable outbound open happened. The
   * message must still land, because the whole point is that the inbound write
   * is unaffected.
   */
  it('does not open or recreate outbound.db when writing to a session that already exists', async () => {
    initSessionFolder(AG, SESS);
    expect(fs.existsSync(outboundDbPath(AG, SESS))).toBe(true);
    fs.rmSync(outboundDbPath(AG, SESS));

    await writeSessionMessage(AG, SESS, {
      id: 'no-outbound-write-1',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: 'slack:C1',
      channelType: 'slack',
      threadId: null,
      content: JSON.stringify({ text: 'routine ingress' }),
    });

    expect(fs.existsSync(outboundDbPath(AG, SESS))).toBe(false);
    const db = new Database(inboundDbPath(AG, SESS), { readonly: true });
    try {
      const row = db.prepare('SELECT id FROM messages_in WHERE id = ?').get('no-outbound-write-1') as
        | { id: string }
        | undefined;
      expect(row?.id).toBe('no-outbound-write-1');
    } finally {
      db.close();
    }
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
    const memoryRoot = path.join(TEST_DATA_DIR, 'workgroups', 'reset', 'memory');
    fs.mkdirSync(path.join(memoryRoot, 'preferences'), { recursive: true });
    fs.writeFileSync(path.join(memoryRoot, 'index.md'), '# Canon\nJordan owns deployment.');
    fs.writeFileSync(path.join(memoryRoot, 'preferences', 'operator.md'), '# Operator\nJordan owns deployment.');
    const message = (id: string) => ({
      id,
      kind: 'chat-sdk',
      timestamp: '2026-07-25T00:00:00.000Z',
      content: JSON.stringify({ text: 'Who owns deployment?', sender: 'Operator' }),
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
      expect(first.memoryEvidence.excerpts.map((row: { path: string }) => row.path)).toContain(
        'preferences/operator.md',
      );
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
      expect(reset.memoryEvidence.excerpts.map((row: { path: string }) => row.path)).toContain(
        'preferences/operator.md',
      );
    } finally {
      outbound.close();
      inbound.close();
    }
  });

  it('treats input queued behind a pending clear as a fresh provider context', async () => {
    const memoryRoot = path.join(TEST_DATA_DIR, 'workgroups', 'reset', 'memory');
    fs.mkdirSync(path.join(memoryRoot, 'preferences'), { recursive: true });
    fs.writeFileSync(path.join(memoryRoot, 'index.md'), '# Canon\nJordan owns deployment.');
    fs.writeFileSync(path.join(memoryRoot, 'preferences', 'operator.md'), '# Operator\nJordan owns deployment.');
    const message = (id: string, text: string) => ({
      id,
      kind: 'chat-sdk',
      timestamp: '2026-07-25T00:00:00.000Z',
      content: JSON.stringify({ text, sender: 'Operator' }),
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
      expect(followup.memoryEvidence.excerpts.map((row: { path: string }) => row.path)).toContain(
        'preferences/operator.md',
      );
    } finally {
      outbound.close();
      inbound.close();
    }
  });

  it('does not repeat the bootstrap after more than 256 recall rows in one provider epoch', async () => {
    const memoryRoot = path.join(TEST_DATA_DIR, 'workgroups', 'reset', 'memory');
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
    const memoryRoot = path.join(TEST_DATA_DIR, 'workgroups', 'reset', 'memory');
    fs.mkdirSync(path.join(memoryRoot, 'system'), { recursive: true });
    fs.writeFileSync(path.join(memoryRoot, 'index.md'), '# Current canon\nupgrade-cutover context');
    fs.writeFileSync(path.join(memoryRoot, 'system', 'definition.md'), '# Definition\nfresh upgrade context');

    expect(await admitPendingUpgradeContexts(AG, SESS)).toBe(2);
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

    expect(await admitPendingUpgradeContexts(AG, SESS)).toBe(0);
    expect(
      (
        db
          .prepare('SELECT COUNT(*) AS count FROM messages_in WHERE id LIKE ? OR id IN (?,?)')
          .get('recall-%-before-upgrade', 'pending-before-upgrade', 'processing-before-upgrade') as { count: number }
      ).count,
    ).toBe(4);
    db.close();
  });

  it('upgrades a legacy inbound schema before startup reconciliation admits fresh context', async () => {
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

    const memoryRoot = path.join(TEST_DATA_DIR, 'workgroups', 'reset', 'memory');
    fs.mkdirSync(path.join(memoryRoot, 'system'), { recursive: true });
    fs.writeFileSync(path.join(memoryRoot, 'index.md'), '# Current canon\nlegacy upgrade context');
    fs.writeFileSync(path.join(memoryRoot, 'system', 'definition.md'), '# Definition\nfresh legacy context');

    expect(await reconcilePendingUpgradeContexts(getDb(), ['reset'])).toEqual({
      sessions: 1,
      admitted: 1,
      mtimesRestored: 0,
      skipped: 0,
      stubsRemoved: 0,
    });

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

    const { activateRepoIngressFence, releaseRepoIngressFence } = await import('./modules/mailbox/ops/fence.js');
    const fence = activateRepoIngressFence(fencedDb, 'repository-activation:test');

    expect(await admitDueTaskContexts(AG, SESS)).toBe(0);
    expect(
      (fencedDb.prepare('SELECT trigger FROM messages_in WHERE id = ?').get('task-fenced') as { trigger: number })
        .trigger,
    ).toBe(0);

    releaseRepoIngressFence(fencedDb, 'repository-activation:test', fence.generation);
    expect(await admitDueTaskContexts(AG, SESS)).toBe(1);
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

    const memoryRoot = path.join(TEST_DATA_DIR, 'workgroups', 'reset', 'memory');
    fs.mkdirSync(path.join(memoryRoot, 'system'), { recursive: true });
    fs.writeFileSync(path.join(memoryRoot, 'index.md'), '# Current canon\nfirst-fire context written after scheduling');
    fs.writeFileSync(path.join(memoryRoot, 'system', 'definition.md'), '# Definition\nfresh on every admission');

    expect(await admitDueTaskContexts(AG, SESS)).toBe(1);
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

    expect(await admitDueTaskContexts(AG, SESS)).toBe(0);
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

    expect(await admitDueTaskContexts(AG, SESS)).toBe(1);
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
    const memoryRoot = path.join(TEST_DATA_DIR, 'workgroups', 'reset', 'memory');
    fs.mkdirSync(path.join(memoryRoot, 'system'), { recursive: true });
    fs.writeFileSync(path.join(memoryRoot, 'index.md'), '# Current canon\nrecurrence memory written after cloning');
    fs.writeFileSync(path.join(memoryRoot, 'system', 'definition.md'), '# Definition\nfresh on every admission');

    expect(await admitDueTaskContexts(AG, SESS)).toBe(1);
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

  it("a retry backoff moves process_after but NEVER the occurrence's scheduled slot", async () => {
    initSessionFolder(AG, SESS);
    const db = new Database(inboundDbPath(AG, SESS));
    try {
      insertTaskRow(db, {
        id: 'task-crash-retry',
        seriesId: 'task-crash-retry',
        processAfter: '2026-01-05T09:00:00.000Z',
        recurrence: '0 9 * * *',
        content: JSON.stringify({ prompt: "prepare today's brief" }),
      });

      await deferMessageForFreshContextRetry(db, 'task-crash-retry', 600);

      const row = db
        .prepare('SELECT process_after, scheduled_for, tries FROM messages_in WHERE id = ?')
        .get('task-crash-retry') as { process_after: string; scheduled_for: string; tries: number };

      // The backoff deadline is a "don't touch me until", not a new slot.
      expect(row.tries).toBe(1);
      expect(row.process_after).not.toBe('2026-01-05T09:00:00.000Z');
      expect(Date.parse(row.process_after)).toBeGreaterThan(Date.now());
      // The occurrence is still the 9am one. This is the whole point: an agent
      // asked for "today's" numbers, and anything date-windowed or idempotent
      // keyed off the slot, must survive the retry with the same identity.
      expect(row.scheduled_for).toBe('2026-01-05T09:00:00.000Z');
    } finally {
      db.close();
    }
  });

  it('replaces crashed-turn recall with current memory and capabilities when backoff becomes due', async () => {
    const memoryRoot = path.join(TEST_DATA_DIR, 'workgroups', 'reset', 'memory');
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

      await deferMessageForFreshContextRetry(AG, SESS, 'chat-crash-retry', 60);
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

      expect(await admitDueTaskContexts(AG, SESS)).toBe(1);
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

      expect(await admitDueTaskContexts(AG, SESS)).toBe(0);
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
      expect(await admitDueTaskContexts(AG, SESS)).toBe(0);
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
      expect(await admitDueTaskContexts(AG, SESS)).toBe(0);
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

// T1 (SR1) — a schema migration is bookkeeping, not session activity. The idle
// clock the reaper reads must survive it, including across a crash mid-pass.
describe('session migration pass preserves the idle clock', () => {
  const MIGRATION_AG = 'ag-mtime';
  const DATA_DIR = TEST_DATA_DIR;
  const OLD_SECONDS = Date.parse('2026-04-01T00:00:00.000Z') / 1000;

  beforeEach(() => {
    fs.rmSync(path.join(DATA_DIR, 'v2-sessions', MIGRATION_AG), { recursive: true, force: true });
    fs.rmSync(path.join(DATA_DIR, 'pending-upgrade-mtimes.json'), { force: true });
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: MIGRATION_AG,
      name: 'Mtime',
      folder: 'mtime',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    getDb()
      .prepare(`INSERT INTO workgroups (id, display_name, created_at) VALUES ('mtime','Mtime',?)`)
      .run(new Date().toISOString());
    getDb().prepare(`UPDATE agent_groups SET workgroup_id = 'mtime' WHERE id = ?`).run(MIGRATION_AG);
  });

  afterEach(() => {
    closeDb();
  });

  function seedSession(sessionId: string): void {
    createSession({
      id: sessionId,
      agent_group_id: MIGRATION_AG,
      messaging_group_id: null,
      thread_id: `thr-${sessionId}`,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-04-01T00:00:00.000Z',
    });
  }

  function ageInbound(sessionId: string): number {
    const target = inboundDbPath(MIGRATION_AG, sessionId);
    fs.utimesSync(target, OLD_SECONDS, OLD_SECONDS);
    return fs.statSync(target).mtimeMs;
  }

  it('leaves a schema-current inbound.db untouched', async () => {
    const sessionId = 'sess-current-schema';
    seedSession(sessionId);
    initSessionFolder(MIGRATION_AG, sessionId);
    const before = ageInbound(sessionId);

    expect(await reconcilePendingUpgradeContexts(getDb(), ['mtime'])).toMatchObject({ sessions: 1, mtimesRestored: 0 });
    expect(fs.statSync(inboundDbPath(MIGRATION_AG, sessionId)).mtimeMs).toBe(before);
  });

  it('restores the pre-pass mtime after real DDL runs', async () => {
    const sessionId = 'sess-legacy-schema';
    seedSession(sessionId);
    const legacyPath = inboundDbPath(MIGRATION_AG, sessionId);
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
    legacy.close();
    const before = ageInbound(sessionId);

    expect(await reconcilePendingUpgradeContexts(getDb(), ['mtime'])).toMatchObject({
      sessions: 1,
      admitted: 0,
      mtimesRestored: 1,
    });
    expect(fs.statSync(legacyPath).mtimeMs).toBe(before);

    const verified = new Database(legacyPath, { readonly: true });
    const columns = new Set(
      (verified.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    verified.close();
    expect(columns.has('series_id')).toBe(true);
    expect(columns.has('repo_fence_epoch')).toBe(true);
  });

  it('deletes the intent manifest when the pass completes', async () => {
    const sessionId = 'sess-manifest-clean';
    seedSession(sessionId);
    initSessionFolder(MIGRATION_AG, sessionId);

    await reconcilePendingUpgradeContexts(getDb(), ['mtime']);

    expect(fs.existsSync(path.join(DATA_DIR, 'pending-upgrade-mtimes.json'))).toBe(false);
  });

  it('replays an interrupted pass from the fsynced manifest at startup', async () => {
    const sessionId = 'sess-crashed-pass';
    seedSession(sessionId);
    initSessionFolder(MIGRATION_AG, sessionId);
    const target = inboundDbPath(MIGRATION_AG, sessionId);
    const stat = fs.statSync(target);
    // The pass wrote its manifest, ran DDL, and died before restoring.
    const writtenAtMs = Date.now();
    fs.writeFileSync(
      path.join(DATA_DIR, 'pending-upgrade-mtimes.json'),
      JSON.stringify({
        writtenAtMs,
        entries: [{ path: target, atimeMs: OLD_SECONDS * 1000, mtimeMs: OLD_SECONDS * 1000 }],
      }),
    );
    const bumped = (writtenAtMs + 1000) / 1000;
    fs.utimesSync(target, bumped, bumped);

    const { replayUpgradeMtimeManifest } = await import('./session-manager.js');
    expect(replayUpgradeMtimeManifest(DATA_DIR, getDb())).toBe(1);
    expect(fs.statSync(target).mtimeMs).toBe(OLD_SECONDS * 1000);
    expect(fs.existsSync(path.join(DATA_DIR, 'pending-upgrade-mtimes.json'))).toBe(false);
    expect(stat.mtimeMs).toBeGreaterThan(0);
  });

  it('does not read sub-millisecond mtime precision as activity after the manifest', async () => {
    // Regression for the phantom-activity flake (#195). `writtenAtMs` is a
    // Date.now() reading — integer ms — while statSync reports mtimeMs as a
    // float. An activity file touched microseconds BEFORE the manifest was
    // written compares as after it, so the pass sees its own quiescent session
    // as live traffic and skips the restore.
    //
    // This pins the artifact deterministically rather than racing for it: the
    // real sequence (write outbound.db, then read Date.now()) reproduced the
    // phantom in 36.6% of 20,000 trials on this host, which is why the two
    // sibling tests flaked roughly one CI run in three. Without the floor in
    // sawRealActivityAfter this fails every time; with it, never.
    const sessionId = 'sess-subms-phantom';
    seedSession(sessionId);
    initSessionFolder(MIGRATION_AG, sessionId);
    const target = inboundDbPath(MIGRATION_AG, sessionId);
    const writtenAtMs = Date.now();
    fs.writeFileSync(
      path.join(DATA_DIR, 'pending-upgrade-mtimes.json'),
      JSON.stringify({
        writtenAtMs,
        entries: [{ path: target, sessionId, atimeMs: OLD_SECONDS * 1000, mtimeMs: OLD_SECONDS * 1000 }],
      }),
    );
    // The DDL bump: inside the replay window, so the entry is a candidate.
    const bumped = (writtenAtMs + 1000) / 1000;
    fs.utimesSync(target, bumped, bumped);
    // The artifact: outbound.db in the SAME millisecond as writtenAtMs, but
    // with a sub-millisecond fraction above it. This is the shape a real write
    // lands in; it is not activity.
    const phantom = (writtenAtMs + 0.5) / 1000;
    const outbound = path.join(path.dirname(target), 'outbound.db');
    fs.utimesSync(outbound, phantom, phantom);
    // Assert the fixture actually landed sub-millisecond-above, so a
    // coarse-granularity filesystem fails as a broken fixture rather than
    // silently passing without exercising the bug.
    const outboundMtime = fs.statSync(outbound).mtimeMs;
    expect(outboundMtime).toBeGreaterThan(writtenAtMs);
    expect(Math.floor(outboundMtime)).toBe(writtenAtMs);

    const { replayUpgradeMtimeManifest } = await import('./session-manager.js');
    expect(replayUpgradeMtimeManifest(DATA_DIR, getDb())).toBe(1);
    expect(fs.statSync(target).mtimeMs).toBe(OLD_SECONDS * 1000);
  });

  it('leaves a session that saw real traffic after the crashed pass alone', async () => {
    const sessionId = 'sess-real-traffic';
    seedSession(sessionId);
    initSessionFolder(MIGRATION_AG, sessionId);
    const target = inboundDbPath(MIGRATION_AG, sessionId);
    const writtenAtMs = Date.now() - 60 * 60 * 1000;
    fs.writeFileSync(
      path.join(DATA_DIR, 'pending-upgrade-mtimes.json'),
      JSON.stringify({
        writtenAtMs,
        entries: [{ path: target, atimeMs: OLD_SECONDS * 1000, mtimeMs: OLD_SECONDS * 1000 }],
      }),
    );
    const recent = Date.now() / 1000;
    fs.utimesSync(target, recent, recent);

    const { replayUpgradeMtimeManifest } = await import('./session-manager.js');
    expect(replayUpgradeMtimeManifest(DATA_DIR, getDb())).toBe(0);
    expect(fs.statSync(target).mtimeMs).toBeGreaterThan(OLD_SECONDS * 1000);
  });

  it('a schemaless inbound.db in one session does not abort the startup pass', async () => {
    // The startup crash loop of 2026-09-01, from the other end. Three sessions:
    // one healthy, one holding the 0-byte stub a failed open left behind, one
    // holding a real but schemaless DB. The pass used to throw on the first bad
    // file and main.ts exited on it, taking the whole fleet down; every healthy
    // session must now still be processed.
    const healthy = 'sess-isolation-healthy';
    const stub = 'sess-isolation-stub';
    const schemaless = 'sess-isolation-schemaless';
    for (const sessionId of [healthy, stub, schemaless]) seedSession(sessionId);

    initSessionFolder(MIGRATION_AG, healthy);

    // Exactly the residue the old inbound funnel left: a resurrected session
    // directory containing a 0-byte inbound.db and nothing else.
    const stubPath = inboundDbPath(MIGRATION_AG, stub);
    fs.mkdirSync(path.dirname(stubPath), { recursive: true });
    fs.writeFileSync(stubPath, '');

    const schemalessPath = inboundDbPath(MIGRATION_AG, schemaless);
    fs.mkdirSync(path.dirname(schemalessPath), { recursive: true });
    const broken = new Database(schemalessPath);
    broken.exec('CREATE TABLE x (a)');
    broken.close();

    const result = await reconcilePendingUpgradeContexts(getDb(), ['mtime']);
    expect(result).toMatchObject({ sessions: 1, admitted: 0, skipped: 1, stubsRemoved: 1 });

    // The healthy session was migrated, not merely counted.
    const verified = new Database(inboundDbPath(MIGRATION_AG, healthy), { readonly: true });
    const columns = new Set(
      (verified.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    verified.close();
    expect(columns.has('repo_fence_epoch')).toBe(true);

    // The stub is gone — which is what restores the two-signal reclaimed state
    // (session reclaimed AND no inbound.db) the stub was defeating.
    expect(fs.existsSync(stubPath)).toBe(false);

    // A schemaless DB is NOT a stub: it holds bytes nobody has proven are
    // disposable, so it is skipped and left exactly where it is.
    expect(fs.existsSync(schemalessPath)).toBe(true);
    const stillBroken = new Database(schemalessPath, { readonly: true });
    const tables = (
      stillBroken.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((t) => t.name);
    stillBroken.close();
    expect(tables).toEqual(['x']);

    expect(fs.existsSync(path.join(DATA_DIR, 'pending-upgrade-mtimes.json'))).toBe(false);
  });

  it('a session whose admission fails is skipped and keeps its clock, never rewound', async () => {
    // Fault injected where it actually hurts: DDL has run for this session and
    // its mtime is bumped, but admission then fails. The pass used to throw out
    // of here, which exits the host — one bad session DB crash-looped the whole
    // fleet on 2026-09-01. It is now this session's problem alone: skipped and
    // counted.
    //
    // Its clock is deliberately NOT restored. `admitPendingUpgradeContexts`
    // commits one transaction per message, so a throw on a later row leaves
    // earlier admissions durable while `admittedHere` is still 0 — restoring
    // would rewind the clock over committed work and report an active session
    // as idle to the reclaim. A clock left bumped only delays this session's
    // reclaim; a clock rewound over real rows can get it archived.
    const sessionId = 'sess-throws-after-ddl';
    seedSession(sessionId);
    const legacyPath = inboundDbPath(MIGRATION_AG, sessionId);
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    const legacy = new Database(legacyPath);
    legacy.exec(`CREATE TABLE messages_in (
      id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, kind TEXT NOT NULL,
      timestamp TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      platform_id TEXT, channel_type TEXT, thread_id TEXT, content TEXT NOT NULL,
      process_after TEXT, recurrence TEXT
    )`);
    legacy
      .prepare(
        `INSERT INTO messages_in (id,seq,kind,timestamp,status,platform_id,channel_type,thread_id,content)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'legacy-pending',
        2,
        'chat-sdk',
        '2026-04-01T00:00:00.000Z',
        'pending',
        'slack:C1',
        'slack',
        'slack:C1:T1',
        JSON.stringify({ text: 'admit me after the schema upgrade' }),
      );
    // Admission inserts the recall row; this makes that insert — and only that
    // insert — fail, so migrateMessagesInTable's DDL has already landed.
    legacy.exec("CREATE TRIGGER boom BEFORE INSERT ON messages_in BEGIN SELECT RAISE(ABORT, 'injected'); END");
    legacy.close();
    const memoryRoot = path.join(DATA_DIR, 'workgroups', 'mtime', 'memory');
    fs.mkdirSync(path.join(memoryRoot, 'system'), { recursive: true });
    fs.writeFileSync(path.join(memoryRoot, 'index.md'), '# Current canon\nadmitted context');
    fs.writeFileSync(path.join(memoryRoot, 'system', 'definition.md'), '# Definition\nfresh context');
    const before = ageInbound(sessionId);

    expect(await reconcilePendingUpgradeContexts(getDb(), ['mtime'])).toEqual({
      sessions: 1,
      admitted: 0,
      mtimesRestored: 0,
      skipped: 1,
      stubsRemoved: 0,
    });

    // The DDL landed and bumped the clock, and the pass leaves it bumped.
    expect(fs.statSync(legacyPath).mtimeMs).toBeGreaterThan(before);
    // The manifest is still removed: a per-session failure is handled inline,
    // so there is nothing here for a replay to recover. A crash OUTSIDE the
    // per-session loop is what the manifest still exists for, and
    // `replayUpgradeMtimeManifest` covers that.
    expect(fs.existsSync(path.join(DATA_DIR, 'pending-upgrade-mtimes.json'))).toBe(false);
  });

  it('does not rewind the clock of a session that admitted one message before failing on the next', async () => {
    // The case the rule above exists for, exercised rather than argued.
    // `admitPendingUpgradeContexts` commits per message, so the first row's
    // recall is DURABLE when the second row throws — and the return value that
    // would have reported it never arrives, leaving `admittedHere` at 0. A
    // restore keyed on that zero would rewind the clock of a session holding
    // freshly admitted work, which is what feeds the reclaim's idle decision.
    const sessionId = 'sess-partial-admit';
    seedSession(sessionId);
    const legacyPath = inboundDbPath(MIGRATION_AG, sessionId);
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    const legacy = new Database(legacyPath);
    legacy.exec(`CREATE TABLE messages_in (
      id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, kind TEXT NOT NULL,
      timestamp TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      platform_id TEXT, channel_type TEXT, thread_id TEXT, content TEXT NOT NULL,
      process_after TEXT, recurrence TEXT
    )`);
    const insert = legacy.prepare(
      `INSERT INTO messages_in (id,seq,kind,timestamp,status,platform_id,channel_type,thread_id,content)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    for (const [id, seq] of [
      ['first-pending', 2],
      ['second-pending', 4],
    ] as Array<[string, number]>) {
      insert.run(
        id,
        seq,
        'chat-sdk',
        '2026-04-01T00:00:00.000Z',
        'pending',
        'slack:C1',
        'slack',
        'slack:C1:T1',
        JSON.stringify({ text: `admit ${id}` }),
      );
    }
    // Fails the SECOND recall insert only, so the first one commits first.
    legacy.exec(
      `CREATE TRIGGER boom BEFORE INSERT ON messages_in
       WHEN NEW.id = 'recall-second-pending'
       BEGIN SELECT RAISE(ABORT, 'injected'); END`,
    );
    legacy.close();
    const memoryRoot = path.join(DATA_DIR, 'workgroups', 'mtime', 'memory');
    fs.mkdirSync(path.join(memoryRoot, 'system'), { recursive: true });
    fs.writeFileSync(path.join(memoryRoot, 'index.md'), '# Current canon\nadmitted context');
    fs.writeFileSync(path.join(memoryRoot, 'system', 'definition.md'), '# Definition\nfresh context');
    const before = ageInbound(sessionId);

    expect(await reconcilePendingUpgradeContexts(getDb(), ['mtime'])).toEqual({
      sessions: 1,
      // The committed admission is invisible to the counter — which is exactly
      // why the counter must not be what authorizes a clock rewind.
      admitted: 0,
      mtimesRestored: 0,
      skipped: 1,
      stubsRemoved: 0,
    });

    // The first message's recall really did commit…
    const verify = new Database(legacyPath, { readonly: true });
    const committed = verify.prepare("SELECT 1 FROM messages_in WHERE id = 'recall-first-pending'").get();
    verify.close();
    expect(committed).toBeDefined();

    // …so the clock over that work is left where the write put it.
    expect(fs.statSync(legacyPath).mtimeMs).toBeGreaterThan(before);
  });

  it('leaves a session alone when untouched evidence shows work inside the replay window', async () => {
    const sessionId = 'sess-traffic-in-window';
    seedSession(sessionId);
    initSessionFolder(MIGRATION_AG, sessionId);
    const target = inboundDbPath(MIGRATION_AG, sessionId);
    const writtenAtMs = Date.now();
    fs.writeFileSync(
      path.join(DATA_DIR, 'pending-upgrade-mtimes.json'),
      JSON.stringify({
        writtenAtMs,
        entries: [{ path: target, sessionId, atimeMs: OLD_SECONDS * 1000, mtimeMs: OLD_SECONDS * 1000 }],
      }),
    );
    // Bumped INSIDE the window — indistinguishable from the pass by mtime alone.
    const bumped = (writtenAtMs + 120_000) / 1000;
    fs.utimesSync(target, bumped, bumped);
    // But outbound.db moved too, and the migration pass never writes that.
    const outbound = outboundDbPath(MIGRATION_AG, sessionId);
    fs.utimesSync(outbound, bumped, bumped);

    const { replayUpgradeMtimeManifest } = await import('./session-manager.js');
    expect(replayUpgradeMtimeManifest(DATA_DIR, getDb())).toBe(0);
    // Not rewound. Compared against the pre-pass clock rather than the exact
    // bumped value: utimes takes float seconds and ms -> s -> ns -> ms does not
    // always round-trip.
    expect(fs.statSync(target).mtimeMs).toBeGreaterThan(OLD_SECONDS * 1000);
  });

  it('tolerates filesystem rounding on the low edge of the replay window', async () => {
    const sessionId = 'sess-rounding-edge';
    seedSession(sessionId);
    initSessionFolder(MIGRATION_AG, sessionId);
    const target = inboundDbPath(MIGRATION_AG, sessionId);
    const writtenAtMs = Date.now();
    fs.writeFileSync(
      path.join(DATA_DIR, 'pending-upgrade-mtimes.json'),
      JSON.stringify({
        writtenAtMs,
        entries: [{ path: target, sessionId, atimeMs: OLD_SECONDS * 1000, mtimeMs: OLD_SECONDS * 1000 }],
      }),
    );
    // Stamped BEFORE the manifest's clock — a rounding artifact, not a
    // different event. Outside the tolerance this session stayed broken.
    //
    // The offset must survive utimesSync's own rounding: it takes seconds, and
    // a filesystem storing whole seconds can floor this by nearly 1s more. At
    // the original 1500ms that left ~500ms of headroom under the 2000ms
    // tolerance, so a coarse-granularity filesystem pushed the real mtime past
    // the edge and the replay skipped — the test flaked on CI while passing on
    // a machine with finer timestamps. 1000ms keeps a full second of slack.
    const bumped = (writtenAtMs - 1000) / 1000;
    fs.utimesSync(target, bumped, bumped);
    // Assert the fixture landed where the test believes it did, so a future
    // granularity surprise fails as a broken fixture and not as a broken replay.
    expect(writtenAtMs - fs.statSync(target).mtimeMs).toBeLessThan(2000);

    const { replayUpgradeMtimeManifest } = await import('./session-manager.js');
    expect(replayUpgradeMtimeManifest(DATA_DIR, getDb())).toBe(1);
    expect(fs.statSync(target).mtimeMs).toBe(OLD_SECONDS * 1000);
  });

  it('keeps the new mtime for a session whose pass admitted real work', async () => {
    const sessionId = 'sess-admits-work';
    seedSession(sessionId);
    const legacyPath = inboundDbPath(MIGRATION_AG, sessionId);
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
        `INSERT INTO messages_in (id,seq,kind,timestamp,status,platform_id,channel_type,thread_id,content)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'legacy-pending',
        2,
        'chat-sdk',
        '2026-04-01T00:00:00.000Z',
        'pending',
        'slack:C1',
        'slack',
        'slack:C1:T1',
        JSON.stringify({ text: 'admit me after the schema upgrade' }),
      );
    legacy.close();
    const memoryRoot = path.join(DATA_DIR, 'workgroups', 'mtime', 'memory');
    fs.mkdirSync(path.join(memoryRoot, 'system'), { recursive: true });
    fs.writeFileSync(path.join(memoryRoot, 'index.md'), '# Current canon\nadmitted context');
    fs.writeFileSync(path.join(memoryRoot, 'system', 'definition.md'), '# Definition\nfresh context');
    const before = ageInbound(sessionId);

    expect(await reconcilePendingUpgradeContexts(getDb(), ['mtime'])).toEqual({
      sessions: 1,
      admitted: 1,
      mtimesRestored: 0,
      skipped: 0,
      stubsRemoved: 0,
    });
    expect(fs.statSync(legacyPath).mtimeMs).toBeGreaterThan(before);
  });
});

describe('threadWorktreeDir — workgroup namespace', () => {
  it('same workgroup + same thread share one scoped path; different workgroups do not', async () => {
    const tid = 'slack:CTEST10001:1778800261.935259';
    const a1 = threadWorktreeDir('slack:CTEST10001', tid, 'acme');
    const a2 = threadWorktreeDir('slack:CTEST10001', tid, 'acme');
    const b = threadWorktreeDir('slack:CTEST10001', tid, 'bluesky');
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).toContain('wg-acme');
    expect(a1).not.toContain(':');
  });

  it('serves the legacy un-namespaced dir while it exists (in-flight threads)', async () => {
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

  it('refuses to adopt a legacy dir stamped by a DIFFERENT workgroup', async () => {
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

  it('without a workgroup id resolves to the legacy path (back-compat callers)', async () => {
    const tid = 'slack:CTEST10003:1778800261.935259';
    expect(threadWorktreeDir('slack:CTEST10003', tid)).toBe(
      path.join(threadsBaseDir(), 'slack_CTEST10003_1778800261.935259', 'worktrees'),
    );
  });
});

describe('the shared-transcript migration is gone', () => {
  const TEST_DIR = TEST_DATA_DIR;
  const LAZY_AG = 'ag-lazy';
  const LAZY_SESS = 'sess-lazy';
  const sharedProjects = path.join(TEST_DIR, 'v2-sessions', LAZY_AG, '.claude-shared', 'projects', '-workspace-agent');

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(sharedProjects, { recursive: true });
    fs.writeFileSync(path.join(sharedProjects, 'old-a.jsonl'), '{"a":1}\n');
    fs.writeFileSync(path.join(sharedProjects, 'old-b.jsonl'), '{"b":1}\n');
    fs.writeFileSync(path.join(sharedProjects, 'sessions-index.json'), '{}');
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  function projectsDir(): string {
    return sessionClaudeProjectsDir(LAZY_AG, LAZY_SESS);
  }

  function spawn(): void {
    getSessionClaudeMounts({ id: LAZY_AG } as AgentGroup, { id: LAZY_SESS } as Session);
  }

  it('session creation writes the DBs and nothing else — no transcripts, no .claude-projects', async () => {
    initSessionFolder(LAZY_AG, LAZY_SESS);

    expect(fs.existsSync(projectsDir())).toBe(false);
    expect(fs.readdirSync(sessionDir(LAZY_AG, LAZY_SESS)).sort()).toEqual(['inbound.db', 'outbound.db', 'outbox']);
  });

  it('the spawn path creates the projects dir and copies nothing into it', async () => {
    initSessionFolder(LAZY_AG, LAZY_SESS);
    spawn();

    expect(fs.existsSync(projectsDir())).toBe(true);
    expect(fs.readdirSync(projectsDir())).toEqual([]);
  });

  it('leaves the group-shared dir untouched', async () => {
    initSessionFolder(LAZY_AG, LAZY_SESS);
    spawn();
    spawn();

    // `memory` is the group-shared memory dir prepareSessionClaudeDir creates;
    // nothing else in the shared pile moved or vanished.
    expect(fs.readdirSync(sharedProjects).sort()).toEqual([
      'memory',
      'old-a.jsonl',
      'old-b.jsonl',
      'sessions-index.json',
    ]);
  });

  it('does not clobber transcripts the agent wrote in a previous turn', async () => {
    initSessionFolder(LAZY_AG, LAZY_SESS);
    spawn();
    fs.writeFileSync(path.join(projectsDir(), 'live.jsonl'), '{"a":"agent-turn"}\n');

    spawn();

    expect(fs.readdirSync(projectsDir())).toEqual(['live.jsonl']);
    expect(fs.readFileSync(path.join(projectsDir(), 'live.jsonl'), 'utf-8')).toBe('{"a":"agent-turn"}\n');
  });
});

/**
 * The write-after-check race that the reaper being unstalled makes reachable.
 *
 * A writer passes the `status === 'archiving'` check and opens inbound.db, then
 * pauses BEFORE writing. It has produced no observable signal at that point —
 * no unconsumed row, no mtime change — so the reclaim's open-work and
 * mtime-equality guards both read a quiet session, archive it, and rmSync the
 * directory out from under the open fd. The insert lands in an unlinked inode:
 * accepted, acknowledged, and absent from the rescue archive.
 *
 * These assert the two halves of the lease contract that closes it. Both fail
 * against the pre-fix writer, which took no lease and re-checked nothing.
 */
/**
 * The writer's own guard.
 *
 * Callers used to prove their preconditions and then call `writeSessionMessage`,
 * which awaits — a storage-activity lease, a reclaim-journal import, the mailbox
 * funnel — before the row lands. Every one of those is a window where the proof
 * goes stale, and nothing a caller does can close a window inside the callee.
 * So the proof is handed to the writer, which evaluates it inside the mailbox
 * action with nothing awaited between the answer and the insert.
 */
describe('writeSessionMessage evaluates its caller guard at the insert', () => {
  const GUARD_SESS = 'sess-guard';

  beforeEach(() => {
    fs.rmSync(sessionDir(AG, GUARD_SESS), { recursive: true, force: true });
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: AG,
      name: 'Guard',
      folder: 'guard',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    createSession({
      id: GUARD_SESS,
      agent_group_id: AG,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    });
    initSessionFolder(AG, GUARD_SESS);
  });

  afterEach(() => {
    fs.rmSync(sessionDir(AG, GUARD_SESS), { recursive: true, force: true });
    closeDb();
  });

  function rowIds(): string[] {
    const db = new Database(inboundDbPath(AG, GUARD_SESS), { readonly: true });
    try {
      return (db.prepare('SELECT id FROM messages_in').all() as Array<{ id: string }>).map((r) => r.id);
    } finally {
      db.close();
    }
  }

  const message = (id: string) => ({
    id,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: 'slack:C1',
    channelType: 'slack',
    threadId: null,
    content: JSON.stringify({ text: 'hello' }),
  });

  /** Every file under the session's inbox tree, relative to it. */
  function inboxFiles(): string[] {
    const root = path.join(sessionDir(AG, GUARD_SESS), 'inbox');
    if (!fs.existsSync(root)) return [];
    const out: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else out.push(rel);
      }
    };
    walk(root, '');
    return out.sort();
  }

  const withAttachment = (id: string) => ({
    ...message(id),
    content: JSON.stringify({
      text: 'see attached',
      attachments: [{ name: 'payload.txt', data: Buffer.from('secret-bytes').toString('base64') }],
    }),
  });

  /**
   * A guard already false must not let the BYTES land either.
   *
   * `extractAttachmentFiles` decodes inline base64 into the target session's
   * mounted `inbox`, which its container reads — so extraction is a delivery in
   * its own right, and it happens before the mailbox action where the guard
   * first ran. A precondition already false on entry should write nothing at
   * all.
   */
  it('writes no attachment bytes when the guard is already false on entry', async () => {
    await expect(
      writeSessionMessage(AG, GUARD_SESS, withAttachment('att-pre'), {
        guard: () => ({ ok: false, reason: 'destination revoked' }),
      }),
    ).rejects.toThrow(SessionWriteRefusedError);

    expect(inboxFiles()).toEqual([]);
    expect(rowIds()).not.toContain('att-pre');
  });

  /**
   * And bytes already written are taken back when the guard refuses at the insert.
   *
   * This is the window the entry check cannot cover: the grant holds on entry,
   * the extraction runs, and the revocation lands during the writer's own
   * awaits. The caller's cleanup cannot reach these files — it knows only what
   * IT forwarded, not what the writer decoded from inline `data`.
   */
  it('removes the attachment bytes it wrote when the guard refuses at the insert', async () => {
    let authorized = true;
    const write = writeSessionMessage(AG, GUARD_SESS, withAttachment('att-mid'), {
      guard: () => (authorized ? true : { ok: false, reason: 'destination revoked' }),
    });
    // Revoked after the entry check and the extraction, before the insert.
    authorized = false;

    await expect(write).rejects.toThrow(SessionWriteRefusedError);

    expect(inboxFiles()).toEqual([]);
    expect(rowIds()).not.toContain('att-mid');
  });

  it('keeps the attachment bytes when the write is allowed', async () => {
    await writeSessionMessage(AG, GUARD_SESS, withAttachment('att-ok'), { guard: () => true });
    expect(inboxFiles()).toEqual(['att-ok/payload.txt']);
    expect(rowIds()).toContain('att-ok');
  });

  it('writes when the guard still holds', async () => {
    await writeSessionMessage(AG, GUARD_SESS, message('guard-ok'), { guard: () => true });
    expect(rowIds()).toContain('guard-ok');
  });

  /**
   * The interleave the caller could not see: the precondition holds when
   * `writeSessionMessage` is CALLED and fails by the time the row would land.
   * The guard is only ever asked once, inside the action, so flipping it after
   * the call proves the writer asks it late rather than early.
   */
  it('writes nothing when the guard fails during its own awaits', async () => {
    const state = { authorized: true };
    const write = writeSessionMessage(AG, GUARD_SESS, message('guard-revoked'), {
      guard: () => (state.authorized ? true : { ok: false, reason: 'destination revoked' }),
    });
    // Revoked while the writer is between its entry and its insert. Everything
    // it awaits happens after this line and before the guard runs.
    state.authorized = false;

    await expect(write).rejects.toThrow(SessionWriteRefusedError);
    expect(rowIds()).not.toContain('guard-revoked');
  });

  it('treats a bare false as a refusal, and writes nothing', async () => {
    await expect(writeSessionMessage(AG, GUARD_SESS, message('guard-false'), { guard: () => false })).rejects.toThrow(
      SessionWriteRefusedError,
    );
    expect(rowIds()).not.toContain('guard-false');
  });

  it('refuses the idempotent variant the same way', async () => {
    await expect(
      writeSessionMessageIfNew(AG, GUARD_SESS, message('guard-ifnew'), {
        guard: () => ({ ok: false, reason: 'no longer wired' }),
      }),
    ).rejects.toThrow(/no longer wired/);
    expect(rowIds()).not.toContain('guard-ifnew');
  });
});

describe('writeSessionMessage does not race an in-flight session archival', () => {
  // `CLEANUP_CLAIM` in storage-activity.ts. Written directly because the
  // reaper's own helper holds it only for a synchronous callback, and this
  // needs it held across the writer's awaits.
  const claimPath = () => path.join(sessionDir(AG, SESS), '.nanoclaw-storage-cleanup');
  const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

  // The reclaim journal is what the writer now reads to decide "was this
  // session taken?". `appendReclaimJournal` is private to storage-manager, so
  // these fixtures write the same line it writes — a reclaim that removed a
  // directory without journalling it first is not a state the reclaim can
  // produce (`storage-manager.ts:1207` precedes the `rmSync` at `:1230`).
  const DATA_DIR = TEST_DATA_DIR;
  const journalPath = () => path.join(DATA_DIR, 'session-rescues', 'reclaim-journal.jsonl');
  const journalReclaim = (sessionId: string, priorStatus: 'active' | 'closed' | 'orphan' = 'active') => {
    fs.mkdirSync(path.dirname(journalPath()), { recursive: true });
    fs.appendFileSync(
      journalPath(),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        session_id: sessionId,
        agent_group_id: AG,
        prior_status: priorStatus,
        rescue_path: path.join(DATA_DIR, 'session-rescues', `${AG}__${sessionId}-stamp.tar.zst`),
      })}\n`,
    );
  };
  /** What the reclaim does to the filesystem, after the line is durable. */
  const reclaimDirectory = () => fs.rmSync(sessionDir(AG, SESS), { recursive: true, force: true });

  /** Chat rows only — insertMessageWithContext also writes a `recall-` companion. */
  function inboundIds(): string[] {
    if (!fs.existsSync(inboundDbPath(AG, SESS))) return [];
    const db = new Database(inboundDbPath(AG, SESS), { readonly: true });
    try {
      return (db.prepare("SELECT id FROM messages_in WHERE id NOT LIKE 'recall-%'").all() as { id: string }[]).map(
        (r) => r.id,
      );
    } catch {
      return [];
    } finally {
      db.close();
    }
  }

  beforeEach(() => {
    fs.rmSync(sessionDir(AG, SESS), { recursive: true, force: true });
    fs.rmSync(journalPath(), { force: true });
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: AG,
      name: 'Race',
      folder: 'race',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    getDb()
      .prepare(`INSERT INTO workgroups (id, display_name, created_at) VALUES ('race','Race',?)`)
      .run(new Date().toISOString());
    getDb().prepare(`UPDATE agent_groups SET workgroup_id = 'race' WHERE id = ?`).run(AG);
    createSession({
      id: SESS,
      agent_group_id: AG,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    });
    initSessionFolder(AG, SESS);
  });

  afterEach(() => {
    fs.rmSync(claimPath(), { force: true });
    fs.rmSync(journalPath(), { force: true });
    closeDb();
  });

  const message = (id: string) => ({
    id,
    kind: 'chat' as const,
    timestamp: new Date().toISOString(),
    platformId: 'slack:C1',
    channelType: 'slack' as const,
    threadId: null,
    content: JSON.stringify({ text: 'do not lose me' }),
  });

  it('waits for a reclaim holding the cleanup claim instead of writing under it', async () => {
    // A reclaim is mid-archive: it owns the claim and is about to rmSync.
    fs.writeFileSync(claimPath(), JSON.stringify({ pid: 1, createdAt: new Date().toISOString() }));

    const write = writeSessionMessage(AG, SESS, message('during-archive'));
    await settle();

    // Pre-fix this row is already committed — into a directory the reclaim is
    // about to delete.
    expect(inboundIds()).toEqual([]);

    fs.rmSync(claimPath(), { force: true });
    await expect(write).resolves.toBeUndefined();
    expect(inboundIds()).toEqual(['during-archive']);
  });

  // CASE: reclaimed while this writer queued. Passes against cb1d9f51 too —
  // that guard sampled inbound.db present and saw it absent afterwards. Kept
  // as a GUARD that the journal token did not lose the case the flip caught.
  it('refuses when the reclaim takes the session while the writer queues', async () => {
    fs.writeFileSync(claimPath(), JSON.stringify({ pid: 1, createdAt: new Date().toISOString() }));

    const write = writeSessionMessage(AG, SESS, message('after-archive'));
    await settle();

    // The reclaim finishes: line journalled, row closed, directory gone.
    // Releasing the claim lets the queued writer through.
    journalReclaim(SESS, 'active');
    getDb().prepare("UPDATE sessions SET status = 'closed' WHERE id = ?").run(SESS);
    reclaimDirectory();
    fs.mkdirSync(sessionDir(AG, SESS), { recursive: true });
    fs.rmSync(claimPath(), { force: true });

    await expect(write).rejects.toThrow(/has been reclaimed/);
    expect(inboundIds()).toEqual([]);
  });

  // CASE: session already closed AND deleted before this writer arrived.
  // FAILS against cb1d9f51: nothing changes across the wait, so
  // statusBefore === statusAfter === 'closed' and inbound.db is absent at both
  // ends. That guard passes, recreates inbound.db and inserts into a session
  // whose row stays closed. Production entry point is the raw-session-id path
  // at src/modules/approvals/response-handler.ts:115.
  it('refuses a write to a session the reclaim finished with before it arrived', async () => {
    journalReclaim(SESS, 'active');
    getDb().prepare("UPDATE sessions SET status = 'closed' WHERE id = ?").run(SESS);
    reclaimDirectory();
    expect(fs.existsSync(inboundDbPath(AG, SESS)), 'nothing to observe changing').toBe(false);

    await expect(writeSessionMessage(AG, SESS, message('late-approval'))).rejects.toThrow(/has been reclaimed/);
    expect(inboundIds()).toEqual([]);
  });

  // CASE: an ORPHAN reclaim — no central row at all, journalled, directory
  // gone. FAILS against cb1d9f51 (`inboundExisted` is false at both ends, so
  // the guard passes and re-provisions). It is also the case no status-based
  // predicate can reach: there is no row to read a status from.
  it('refuses a write to an orphan session the reclaim already took', async () => {
    journalReclaim(SESS, 'orphan');
    getDb().prepare('DELETE FROM sessions WHERE id = ?').run(SESS);
    reclaimDirectory();

    await expect(writeSessionMessage(AG, SESS, message('orphan-late'))).rejects.toThrow(/has been reclaimed/);
    expect(inboundIds()).toEqual([]);
  });

  // The journal line records the reclaim's INTENT, written at
  // storage-manager.ts:1207 BEFORE the archiving->closed CAS at :1215. When
  // that CAS loses, :1221 logs and deliberately keeps the directory; a crash
  // before the rmSync at :1230 leaves the same shape. The line alone would
  // brick a session that is still live and still polled, permanently. GUARD:
  // passes against cb1d9f51 too — it is here to pin that the journal token did
  // not trade a racy refusal for a permanent one.
  it('still writes when the reclaim journalled but kept the directory', async () => {
    journalReclaim(SESS, 'active');
    expect(fs.existsSync(inboundDbPath(AG, SESS)), 'the archival kept the directory').toBe(true);

    await expect(writeSessionMessage(AG, SESS, message('cas-lost-dir-kept'))).resolves.toBeUndefined();
    expect(inboundIds()).toEqual(['cas-lost-dir-kept']);
  });

  // CASE: brand-new session — row created, folder never provisioned, first
  // write. GUARD: passes against cb1d9f51, which is too weak here rather than
  // too strict. It is the case the status+directory predicate got wrong in the
  // other direction, and the one the journal token must never re-break.
  //
  // Deliberately NOT the no-row-at-all variant: `writeSessionMessage` cannot
  // serve one. `buildRecallRow` -> `buildPreTurnContext` throws "Unable to
  // resolve trusted session scope" (pre-turn-context.ts:1890) long after this
  // guard, so a session with no central row is not a shape this writer has.
  it('provisions a brand-new session on its first write', async () => {
    fs.rmSync(sessionDir(AG, SESS), { recursive: true, force: true });
    expect(fs.existsSync(sessionDir(AG, SESS)), 'never provisioned').toBe(false);

    await expect(writeSessionMessage(AG, SESS, message('brand-new'))).resolves.toBeUndefined();
    expect(inboundIds()).toEqual(['brand-new']);
  });

  // GUARD, and the regression that actually shipped once: a rotation-
  // superseded session is deliberately `closed` and may have no directory at
  // all, which the status+directory predicate misread as "reclaimed" and
  // refused. workgroup-memory.integration.test.ts writes to exactly such a
  // session and broke. `closed` is therefore NOT a reclaim signal.
  it('provisions a closed session that never had a directory', async () => {
    getDb().prepare("UPDATE sessions SET status = 'closed' WHERE id = ?").run(SESS);
    fs.rmSync(sessionDir(AG, SESS), { recursive: true, force: true });

    await expect(writeSessionMessage(AG, SESS, message('superseded-lineage'))).resolves.toBeUndefined();
    expect(inboundIds()).toEqual(['superseded-lineage']);
  });

  // CASE: documented operator `rm -rf` of a live session's folder. GUARD:
  // passes against cb1d9f51. Same on-disk shape as a reclaim and the opposite
  // required outcome, separated only by the absence of a journal line.
  it('still re-provisions a session whose directory an operator removed', async () => {
    fs.rmSync(sessionDir(AG, SESS), { recursive: true, force: true });
    expect(fs.existsSync(journalPath()), 'no reclaim ever touched this session').toBe(false);

    await expect(writeSessionMessage(AG, SESS, message('after-rm-rf'))).resolves.toBeUndefined();
    expect(inboundIds()).toEqual(['after-rm-rf']);
  });

  // A reclaim of a DIFFERENT session must not make this one unwritable — the
  // journal is one shared append-only file for the whole data root.
  it('is not fooled by a journal line for another session', async () => {
    journalReclaim('sess-someone-else', 'active');
    fs.rmSync(sessionDir(AG, SESS), { recursive: true, force: true });

    await expect(writeSessionMessage(AG, SESS, message('not-mine'))).resolves.toBeUndefined();
    expect(inboundIds()).toEqual(['not-mine']);
  });

  it('still writes normally when no reclaim is in progress', async () => {
    await expect(writeSessionMessage(AG, SESS, message('ordinary'))).resolves.toBeUndefined();
    expect(inboundIds()).toEqual(['ordinary']);
    // The lease leaves nothing behind for the next reclaim to trip over.
    expect(fs.existsSync(path.join(sessionDir(AG, SESS), '.nanoclaw-storage-active'))).toBe(false);
  });
});

describe('runner session context path', () => {
  it('the DATA_DIR form and the session-directory form name the same file', () => {
    // The storage reclaim walks an injected sessions root and can only use the
    // directory-derived form. If these two ever disagree, the reclaim silently
    // stops removing context files and each reclaimed session leaks one.
    expect(sessionContextPathFor(sessionDir('ag-ctx', 'sess-ctx'))).toBe(sessionContextPath('ag-ctx', 'sess-ctx'));
    expect(sessionContextPath('ag-ctx', 'sess-ctx').endsWith('/ag-ctx/.context/sess-ctx.json')).toBe(true);
  });
});

/**
 * PR 4 (mailbox seam, ingress family): `writeSessionMessage` writes through
 * `withMailboxSession`, so the mailbox's `prepare()` is now the provisioning
 * path AND the same-key nesting guard is live on the host's busiest write.
 */
describe('mailbox seam: ingress writes', () => {
  const AG_ING = 'ag-ingress';
  const SESS_ING = 'sess-ingress';

  const ingressMessage = (id: string) => ({
    id,
    kind: 'chat' as const,
    timestamp: new Date().toISOString(),
    platformId: 'slack:C1',
    channelType: 'slack' as const,
    threadId: null,
    content: JSON.stringify({ text: 'through the seam' }),
  });

  beforeEach(() => {
    fs.rmSync(sessionDir(AG_ING, SESS_ING), { recursive: true, force: true });
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: AG_ING,
      name: 'Ingress',
      folder: 'ingress',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    for (const id of [SESS_ING, 'sess-ingress-other']) {
      createSession({
        id,
        agent_group_id: AG_ING,
        messaging_group_id: null,
        thread_id: id === SESS_ING ? null : 'slack:C1:other',
        agent_provider: null,
        status: 'active',
        container_status: 'stopped',
        last_active: null,
        created_at: new Date().toISOString(),
      });
    }
  });

  afterEach(() => {
    fs.rmSync(sessionDir(AG_ING, SESS_ING), { recursive: true, force: true });
    fs.rmSync(sessionDir(AG_ING, 'sess-ingress-other'), { recursive: true, force: true });
    closeDb();
  });

  it('writeSessionMessage provisions through prepare() and never nests a same-key session', async () => {
    // (1) Provisioning. Nothing on disk for this session yet — the write itself
    // has to create the mailbox, which is `prepare()`'s job now that the raw
    // `initSessionFolder` open is gone from the write path.
    expect(fs.existsSync(inboundDbPath(AG_ING, SESS_ING))).toBe(false);
    await writeSessionMessage(AG_ING, SESS_ING, ingressMessage('provisioned'));
    expect(fs.existsSync(inboundDbPath(AG_ING, SESS_ING))).toBe(true);
    expect(fs.existsSync(outboundDbPath(AG_ING, SESS_ING))).toBe(true);
    const written = new Database(inboundDbPath(AG_ING, SESS_ING), { readonly: true });
    try {
      expect(
        (written.prepare("SELECT id FROM messages_in WHERE id NOT LIKE 'recall-%'").all() as { id: string }[]).map(
          (r) => r.id,
        ),
      ).toEqual(['provisioned']);
    } finally {
      written.close();
    }

    // (2) The nesting guard. Calling the writer from inside an open session on
    // the SAME key must reject — a serialized implementation would deadlock
    // there (invariant I-3). This is the case that would only have shown up in
    // production before the guard existed.
    await expect(
      withMailboxSession(AG_ING, SESS_ING, async () => {
        await writeSessionMessage(AG_ING, SESS_ING, ingressMessage('nested'));
      }),
    ).rejects.toThrow(/Nested mailbox session/);

    // (3) A different key from inside an open session is fine, and the refused
    // nested write left nothing behind.
    await withMailboxSession(AG_ING, SESS_ING, async () => {
      await writeSessionMessage(AG_ING, 'sess-ingress-other', ingressMessage('sibling'));
    });
    const after = new Database(inboundDbPath(AG_ING, SESS_ING), { readonly: true });
    try {
      expect(after.prepare('SELECT 1 FROM messages_in WHERE id = ?').get('nested')).toBeUndefined();
    } finally {
      after.close();
    }
    fs.rmSync(sessionDir(AG_ING, 'sess-ingress-other'), { recursive: true, force: true });
  });
});
