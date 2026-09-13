import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { migration077 } from '../src/db/migrations/077-choice-receipts.js';
import { moduleApprovalsPendingApprovals } from '../src/db/migrations/module-approvals-pending-approvals.js';
import { ARCHIVE_UPSERT_SQL } from '../src/message-archive.js';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from '../src/mailbox/sqlite/schema.js';

import {
  collectOperatorAttentionEvidence,
  extractReviewOutcomeEvidence,
  isStrictIsoUtc,
} from './operator-attention-evidence.js';
import type { PullRequestData } from './review-outcomes.js';

const TEMP_ROOTS: string[] = [];
const SINCE = '2026-09-01T00:00:00.000Z';
const UNTIL = '2026-10-01T00:00:00.000Z';

afterEach(() => {
  for (const root of TEMP_ROOTS.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = globalThis.uniqueTmpRoot('operator-attention-evidence');
  fs.mkdirSync(root, { recursive: true });
  TEMP_ROOTS.push(root);
  return root;
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function createCentralDb(file: string): void {
  const db = new Database(file);
  // Parent tables only satisfy the real pending_approvals foreign-key schema;
  // the evidence tables themselves come from their production migrations.
  db.exec('CREATE TABLE agent_groups (id TEXT PRIMARY KEY); CREATE TABLE sessions (id TEXT PRIMARY KEY);');
  moduleApprovalsPendingApprovals.up(db);
  migration077.up(db);
  db.prepare(
    `INSERT INTO pending_approvals
       (approval_id, request_id, action, payload, created_at, platform_message_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'appr-visible',
    'request-visible',
    'request_choice',
    '{}',
    '2026-09-10T10:00:00.000Z',
    'platform-card',
    'pending',
  );
  db.prepare(
    `INSERT INTO pending_approvals
       (approval_id, request_id, action, payload, created_at, platform_message_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('appr-unconfirmed', 'request-unconfirmed', 'request_choice', '{}', '2026-09-10T10:01:00.000Z', null, 'pending');
  db.prepare(
    `INSERT INTO choice_receipts
       (approval_id, request_id, action, agent_group_id, session_id, platform_id, thread_id,
        platform_message_id, value, label, clicker_user_id, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'choice-receipt',
    'choice-request',
    'request_choice',
    'ag-fixture',
    'sess-fixture',
    'C-fixture',
    null,
    'platform-choice',
    'private-choice-value',
    'Private choice label',
    'slack:private-clicker',
    '2026-09-10T10:02:00.000Z',
  );
  db.close();
}

function createArchiveDb(
  file: string,
  rows: Array<{ id: string; channelType?: string; sentAt: string }> = [
    { id: 'out-chat-archive', channelType: 'cli', sentAt: '2026-09-10T10:00:00.000Z' },
  ],
): void {
  const db = new Database(file);
  // Query columns mirror `src/message-archive.ts:113-128`; rows go through
  // the real sole-writer statement from `src/message-archive.ts:312-319`.
  db.exec(`
    CREATE TABLE messages_archive (
      id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL, messaging_group_id TEXT,
      channel_type TEXT NOT NULL, channel_name TEXT, platform_id TEXT, thread_id TEXT,
      role TEXT NOT NULL, sender_id TEXT, sender_name TEXT, text TEXT NOT NULL,
      sent_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  const insert = db.prepare(ARCHIVE_UPSERT_SQL);
  for (const row of rows) {
    insert.run({
      id: row.id,
      agentGroupId: 'ag-fixture',
      messagingGroupId: 'mg-fixture',
      channelType: row.channelType ?? 'slack',
      channelName: 'Fixture channel',
      platformId: row.channelType === 'cli' ? 'local' : 'C-fixture',
      threadId: null,
      role: 'assistant',
      senderId: 'ag-fixture',
      senderName: 'assistant',
      text: 'synthetic private archive text',
      sentAt: row.sentAt,
    });
  }
  db.close();
}

interface ProducedQuestionResponse {
  id: string;
  kind: string;
  timestamp: string;
  content: string;
}

async function produceQuestionResponse(): Promise<ProducedQuestionResponse> {
  vi.resetModules();
  const writeSessionMessage = vi.fn(async (..._args: unknown[]) => {});
  vi.doMock('../src/db/connection.js', () => ({ getDb: () => ({}), hasTable: async () => true }));
  vi.doMock('../src/db/sessions.js', () => ({
    getPendingQuestion: async () => ({
      session_id: 'sess-fixture',
      platform_id: 'C-fixture',
      channel_type: 'slack',
      thread_id: null,
    }),
    getSession: async () => ({ id: 'sess-fixture', agent_group_id: 'ag-fixture' }),
    deletePendingQuestion: async () => {},
  }));
  vi.doMock('../src/session-manager.js', () => ({ writeSessionMessage }));
  vi.doMock('../src/log.js', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));
  vi.doMock('../src/modules/interactive/choice.js', () => ({}));
  vi.useFakeTimers();
  vi.setSystemTime('2026-09-10T09:01:00.000Z');
  try {
    // Drive the registered host producer itself. It writes kind='system' with
    // the question_response envelope at `src/modules/interactive/index.ts:38-52`.
    await import('../src/modules/interactive/index.js');
    const { getResponseHandlers } = await import('../src/response-registry.js');
    let handled = false;
    for (const handler of getResponseHandlers()) {
      if (
        await handler({
          questionId: 'q-1',
          value: 'private-selected-option',
          userId: 'slack:private-user',
          channelType: 'slack',
          platformId: 'C-fixture',
          threadId: null,
        })
      ) {
        handled = true;
        break;
      }
    }
    expect(handled).toBe(true);
    expect(writeSessionMessage).toHaveBeenCalledOnce();
    return writeSessionMessage.mock.calls[0]![2] as ProducedQuestionResponse;
  } finally {
    vi.useRealTimers();
    vi.doUnmock('../src/db/connection.js');
    vi.doUnmock('../src/db/sessions.js');
    vi.doUnmock('../src/session-manager.js');
    vi.doUnmock('../src/log.js');
    vi.doUnmock('../src/modules/interactive/choice.js');
    vi.resetModules();
  }
}

async function dispatchCliWithNoTerminal(root: string): Promise<string | undefined> {
  const cliDataDir = path.join(root, 'cli-data');
  fs.mkdirSync(cliDataDir, { recursive: true });
  vi.resetModules();
  vi.doMock('../src/config.js', () => ({ DATA_DIR: cliDataDir }));
  try {
    // Exercise the real registry dispatcher and CLI adapter. The initialized
    // server has no connected terminal, so `src/channels/cli.ts:139-145`
    // returns undefined through `channel-registry.ts:101-116`.
    const registry = await import('../src/channels/channel-registry.js');
    await import('../src/channels/cli.js');
    await registry.initChannelAdapters(() => ({
      conversations: [],
      onInbound: async () => {},
      onInboundEvent: async () => {},
      onMetadata: async () => {},
      onAction: async () => {},
    }));
    try {
      return await registry
        .createChannelDeliveryAdapter()
        .deliver('cli', 'local', null, 'chat', JSON.stringify({ text: 'private CLI response' }));
    } finally {
      await registry.teardownChannelAdapters();
    }
  } finally {
    vi.doUnmock('../src/config.js');
    vi.resetModules();
  }
}

function createSession(
  root: string,
  questionResponse: ProducedQuestionResponse,
  cliPlatformMessageId: string | null = null,
  sessionName: string = 'sess-fixture',
): {
  inbound: string;
  outbound: string;
  inDb: Database.Database;
  outDb: Database.Database;
  close(): void;
} {
  const session = path.join(root, 'ag-fixture', sessionName);
  fs.mkdirSync(session, { recursive: true });
  const inbound = path.join(session, 'inbound.db');
  const outbound = path.join(session, 'outbound.db');
  const inDb = new Database(inbound);
  inDb.pragma('journal_mode = WAL');
  inDb.exec(INBOUND_SCHEMA);
  const outDb = new Database(outbound);
  outDb.exec(OUTBOUND_SCHEMA);

  const insertInbound = inDb.prepare('INSERT INTO messages_in (id, timestamp, kind, content) VALUES (?, ?, ?, ?)');
  insertInbound.run(
    'in-status-chase',
    '2026-09-10T09:00:00.000Z',
    'chat',
    JSON.stringify({ text: 'Could I get a status update?', isFromMe: false }),
  );
  insertInbound.run(questionResponse.id, questionResponse.timestamp, questionResponse.kind, questionResponse.content);
  insertInbound.run(
    'in-malformed-question-answer',
    '2026-09-10T09:01:30.000Z',
    'system',
    JSON.stringify({ type: 'question_response', questionId: 'q-malformed', selectedOption: 'private-value' }),
  );
  insertInbound.run(
    'in-bot',
    '2026-09-10T09:02:00.000Z',
    'chat-sdk',
    JSON.stringify({ text: 'status', author: { isBot: true } }),
  );
  insertInbound.run('task-quiet', '2026-09-10T09:03:00.000Z', 'task', JSON.stringify({ quietStatus: true }));
  insertInbound.run('task-limit', '2026-09-10T09:04:00.000Z', 'task', JSON.stringify({ chatLimit: 1 }));
  insertInbound.run('task-muted', '2026-09-10T09:05:00.000Z', 'task', JSON.stringify({ muteChat: true }));

  const insertOutbound = outDb.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertDelivered = inDb.prepare(
    'INSERT INTO delivered (message_out_id, status, platform_message_id, delivered_at) VALUES (?, ?, ?, ?)',
  );
  for (const [id, kind, content, platformId, channelType] of [
    ['out-chat-platform', 'chat', JSON.stringify({ text: 'synthetic final text' }), 'platform-final', 'slack'],
    ['out-chat-archive', 'chat', JSON.stringify({ text: 'synthetic archive final' }), cliPlatformMessageId, 'cli'],
    ['out-chat-unknown', 'chat', JSON.stringify({ text: 'synthetic unknown final' }), null, 'slack'],
    ['out-status-platform', 'status', JSON.stringify({ text: 'synthetic progress' }), 'platform-status', 'slack'],
    ['out-status-suppressed', 'status', JSON.stringify({ text: 'synthetic suppressed progress' }), null, 'slack'],
    [
      'out-question-platform',
      'chat-sdk',
      // Matches the real ask_user_question producer's kind/payload shape at
      // `container/agent-runner/src/mcp-tools/interactive.ts:92-106`.
      JSON.stringify({
        type: 'ask_question',
        questionId: 'q-1',
        title: 'Fixture question',
        question: 'Private question text',
        options: [{ label: 'Private option', selectedLabel: 'Private selected label', value: 'private-value' }],
      }),
      'platform-question',
      'slack',
    ],
    [
      'out-question-unknown',
      'chat-sdk',
      JSON.stringify({
        type: 'ask_question',
        questionId: 'q-2',
        title: 'Fixture question 2',
        question: 'Private second question text',
        options: [{ label: 'Private option 2', selectedLabel: 'Private selected 2', value: 'private-value-2' }],
      }),
      null,
      'slack',
    ],
  ] as const) {
    insertOutbound.run(
      id,
      '2026-09-10T10:00:00.000Z',
      kind,
      channelType === 'cli' ? 'local' : 'C-fixture',
      channelType,
      content,
    );
    insertDelivered.run(id, 'delivered', platformId, '2026-09-10T10:00:30.000Z');
  }

  // Keep this connection open so the extractor reads a valid live WAL. The test
  // pins main/WAL logical bytes; SHM locking metadata is explicitly allowed and
  // disclosed by the report. Both schemas are the real mailbox split from
  // `src/mailbox/sqlite/schema.ts:2-82`.
  return {
    inbound,
    outbound,
    inDb,
    outDb,
    close() {
      outDb.close();
      inDb.close();
    },
  };
}

function pr(overrides: Partial<PullRequestData> & { number: number }): PullRequestData {
  return {
    title: `PR ${overrides.number}`,
    body: '',
    mergedAt: '2026-09-11T00:00:00.000Z',
    files: [],
    labels: [],
    baseRefName: 'main',
    changedLines: 0,
    changedFiles: 0,
    mergeCommitOid: null,
    headRefOid: 'head',
    ...overrides,
  };
}

describe('collectOperatorAttentionEvidence', () => {
  it('separates platform delivery from archive observation, keeps prose candidate-only, and preserves logical DB bytes', async () => {
    const root = makeRoot();
    const sessionsRoot = path.join(root, 'sessions');
    const cliDeliveryResult = await dispatchCliWithNoTerminal(root);
    expect(cliDeliveryResult).toBeUndefined();
    const source = createSession(sessionsRoot, await produceQuestionResponse(), cliDeliveryResult ?? null);
    const centralDb = path.join(root, 'central.db');
    const archiveDb = path.join(root, 'archive.db');
    createCentralDb(centralDb);
    createArchiveDb(archiveDb);
    const wal = `${source.inbound}-wal`;
    expect(fs.existsSync(wal)).toBe(true);
    const beforeDb = sha256(source.inbound);
    const beforeWal = sha256(wal);

    try {
      const report = collectOperatorAttentionEvidence({
        sessionsRoot,
        centralDb,
        archiveDb,
        since: SINCE,
        until: UNTIL,
      });

      expect(report.provenance).toMatchObject({
        sourceReadComplete: true,
        archiveScope: 'explicit_db_scope_unverified_against_sessions_root',
        sessionDbsRead: 1,
        sqliteReadContract: {
          readonly: true,
          queryOnly: true,
          sidecarMetadataMayChange: true,
        },
      });
      expect(report.counts).toMatchObject({
        platformBackedPendingApprovalCardsSnapshot: 1,
        resolvedChoiceReceipts: 1,
        platformBackedQuestionCards: 1,
        finalChatDeliveryEvidence: 1,
        finalChatPlatformMessageId: 1,
        finalChatAssistantArchiveObserved: 1,
        statusPlatformPostEvidence: 1,
        // The null status marker may be spawn-child suppression, an edit, or a drop;
        // source delivery marks it `delivered` either way (`src/delivery.ts:748-758,1216-1233`).
        deliveryProcessedUnknown: 4,
        questionResponseCandidates: 1,
        inboundReplyCandidates: 1,
        statusChaseCandidates: 1,
        unknownInboundMessages: 1,
        quietStatusTaskRowsConfigured: 1,
        chatLimitTaskRowsConfigured: 1,
        mutedChatTaskRowsConfigured: 1,
      });
      expect(JSON.stringify(report)).not.toContain('Could I get a status update?');
      expect(JSON.stringify(report)).not.toContain('synthetic private archive text');
      expect(JSON.stringify(report)).not.toContain('synthetic final text');
      expect(JSON.stringify(report)).not.toContain('private-selected-option');
      expect(JSON.stringify(report)).not.toContain('slack:private-user');
      expect(JSON.stringify(report)).not.toContain('private-choice-value');
      expect(JSON.stringify(report)).not.toContain('slack:private-clicker');
      expect(sha256(source.inbound)).toBe(beforeDb);
      expect(sha256(wal)).toBe(beforeWal);
      expect(fs.existsSync(`${source.inbound}-journal`)).toBe(false);
    } finally {
      // The fixture owns the sole WAL writer while the extractor reads it, then
      // closes both source handles before global temporary-directory cleanup.
      source.close();
    }
  });

  it('uses delivered_at and archive sent_at as independent half-open event clocks', async () => {
    const root = makeRoot();
    const sessionsRoot = path.join(root, 'sessions');
    const source = createSession(sessionsRoot, await produceQuestionResponse());
    const centralDb = path.join(root, 'central.db');
    const archiveDb = path.join(root, 'archive.db');
    createCentralDb(centralDb);
    createArchiveDb(archiveDb);

    const insertOutbound = source.outDb.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
       VALUES (?, ?, 'chat', 'C-fixture', 'slack', ?)`,
    );
    const insertDelivered = source.inDb.prepare(
      `INSERT INTO delivered (message_out_id, status, platform_message_id, delivered_at)
       VALUES (?, 'delivered', ?, ?)`,
    );

    try {
      const extract = () =>
        collectOperatorAttentionEvidence({
          sessionsRoot,
          centralDb,
          archiveDb,
          since: SINCE,
          until: UNTIL,
        });

      const baseline = extract();
      expect(baseline.counts.finalChatDeliveryEvidence).toBe(1);
      expect(baseline.counts.finalChatAssistantArchiveObserved).toBe(1);

      // Creation is outside the window, but both real event clocks are inside.
      insertOutbound.run('out-created-before-delivered-in-window', '2026-08-31T23:59:00.000Z', '{"text":"private"}');
      insertDelivered.run('out-created-before-delivered-in-window', 'platform-old-queued', '2026-09-01T00:00:00.000Z');
      insertOutbound.run('out-created-before-archived-in-window', '2026-08-31T23:58:00.000Z', '{"text":"private"}');
      insertDelivered.run('out-created-before-archived-in-window', null, '2026-09-02T00:00:00.000Z');
      const archive = new Database(archiveDb);
      archive.prepare(ARCHIVE_UPSERT_SQL).run({
        id: 'out-created-before-archived-in-window',
        agentGroupId: 'ag-fixture',
        messagingGroupId: 'mg-fixture',
        channelType: 'slack',
        channelName: 'Fixture channel',
        platformId: 'C-fixture',
        threadId: null,
        role: 'assistant',
        senderId: 'ag-fixture',
        senderName: 'assistant',
        text: 'private old queued response',
        sentAt: '2026-09-02T00:00:00.000Z',
      });
      archive.close();

      const withOldQueuedEvents = extract();
      expect(withOldQueuedEvents.counts.finalChatDeliveryEvidence).toBe(2);
      expect(withOldQueuedEvents.counts.finalChatAssistantArchiveObserved).toBe(2);

      // Creation is inside the window, but events at the exclusive cutoff are not.
      insertOutbound.run('out-created-in-window-delivered-at-cutoff', '2026-09-30T23:59:00.000Z', '{"text":"private"}');
      insertDelivered.run('out-created-in-window-delivered-at-cutoff', 'platform-future', '2026-10-01T00:00:00.000Z');
      insertOutbound.run('out-created-in-window-archived-at-cutoff', '2026-09-30T23:58:00.000Z', '{"text":"private"}');
      insertDelivered.run('out-created-in-window-archived-at-cutoff', null, '2026-10-01T00:00:00.000Z');
      const archiveAtCutoff = new Database(archiveDb);
      archiveAtCutoff.prepare(ARCHIVE_UPSERT_SQL).run({
        id: 'out-created-in-window-archived-at-cutoff',
        agentGroupId: 'ag-fixture',
        messagingGroupId: 'mg-fixture',
        channelType: 'slack',
        channelName: 'Fixture channel',
        platformId: 'C-fixture',
        threadId: null,
        role: 'assistant',
        senderId: 'ag-fixture',
        senderName: 'assistant',
        text: 'private future response',
        sentAt: '2026-10-01T00:00:00.000Z',
      });
      archiveAtCutoff.close();

      const withCutoffEvents = extract();
      expect(withCutoffEvents.counts.finalChatDeliveryEvidence).toBe(2);
      expect(withCutoffEvents.counts.finalChatPlatformMessageId).toBe(2);
      expect(withCutoffEvents.counts.finalChatAssistantArchiveObserved).toBe(2);
    } finally {
      source.close();
    }
  });

  it('discloses SQLite SHM creation while preserving copied main and committed WAL bytes', () => {
    const root = makeRoot();
    const sessionsRoot = path.join(root, 'sessions');
    const session = path.join(sessionsRoot, 'ag-fixture', 'sess-wal-without-shm');
    fs.mkdirSync(session, { recursive: true });

    const writerPath = path.join(root, 'writer.db');
    const writer = new Database(writerPath);
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    writer.exec(INBOUND_SCHEMA);
    writer.pragma('wal_checkpoint(TRUNCATE)');
    writer
      .prepare('INSERT INTO messages_in (id, timestamp, kind, content) VALUES (?, ?, ?, ?)')
      .run('wal-only-row', '2026-09-10T09:00:00.000Z', 'chat', JSON.stringify({ text: 'private WAL row' }));

    const inbound = path.join(session, 'inbound.db');
    const wal = `${inbound}-wal`;
    fs.copyFileSync(writerPath, inbound);
    fs.copyFileSync(`${writerPath}-wal`, wal);
    const outbound = new Database(path.join(session, 'outbound.db'));
    outbound.exec(OUTBOUND_SCHEMA);
    outbound.close();
    const centralDb = path.join(root, 'central.db');
    const archiveDb = path.join(root, 'archive.db');
    createCentralDb(centralDb);
    createArchiveDb(archiveDb);
    const beforeDb = sha256(inbound);
    const beforeWal = sha256(wal);
    expect(fs.existsSync(`${inbound}-shm`)).toBe(false);

    try {
      const report = collectOperatorAttentionEvidence({
        sessionsRoot,
        centralDb,
        archiveDb,
        since: SINCE,
        until: UNTIL,
      });

      expect(report.provenance.sourceReadComplete).toBe(true);
      expect(report.provenance.sqliteReadContract).toMatchObject({
        readonly: true,
        queryOnly: true,
        sidecarMetadataMayChange: true,
        walFilesWithoutShmBeforeRead: 1,
        shmFilesObservedNewDuringRead: 1,
      });
      expect(report.counts.inboundReplyCandidates).toBe(1);
      expect(sha256(inbound)).toBe(beforeDb);
      expect(sha256(wal)).toBe(beforeWal);
    } finally {
      writer.close();
    }
  });

  it('reports a malformed session DB as incomplete rather than treating it as zero evidence', () => {
    const root = makeRoot();
    const sessionsRoot = path.join(root, 'sessions');
    const session = path.join(sessionsRoot, 'ag-fixture', 'sess-bad-shape');
    fs.mkdirSync(session, { recursive: true });
    const inbound = new Database(path.join(session, 'inbound.db'));
    inbound.exec('CREATE TABLE messages_in (id TEXT PRIMARY KEY)');
    inbound.close();
    const outbound = new Database(path.join(session, 'outbound.db'));
    outbound.exec('CREATE TABLE unrelated (id TEXT PRIMARY KEY)');
    outbound.close();
    const centralDb = path.join(root, 'central.db');
    const archiveDb = path.join(root, 'archive.db');
    createCentralDb(centralDb);
    createArchiveDb(archiveDb);

    const report = collectOperatorAttentionEvidence({ sessionsRoot, centralDb, archiveDb, since: SINCE, until: UNTIL });

    expect(report.provenance.sourceReadComplete).toBe(false);
    expect(report.provenance.errors).toContainEqual({
      source: 'inbound',
      session: 'ag-fixture/sess-bad-shape',
      code: 'missing_required_table',
    });
    expect(report.provenance.sessionDbsRead).toBe(0);
  });
});

describe('extractReviewOutcomeEvidence', () => {
  it('keeps explicit reverts separate from named proxies and preserves weekly 14-day maturity', () => {
    const report = extractReviewOutcomeEvidence(
      [
        pr({ number: 7, mergedAt: '2026-09-01T00:00:00.000Z', files: ['src/old.ts'] }),
        pr({ number: 1, mergedAt: '2026-09-11T00:00:00.000Z', files: ['src/a.ts'] }),
        pr({ number: 2, title: 'fix: linked repair', body: 'Fixes-PR: #1', mergedAt: '2026-09-12T00:00:00.000Z' }),
        pr({ number: 3, title: 'revert: back out #1', mergedAt: '2026-09-13T00:00:00.000Z' }),
        pr({ number: 4, mergedAt: '2026-09-15T00:00:00.000Z', files: ['src/b.ts'] }),
        pr({ number: 5, title: 'fix: overlap', mergedAt: '2026-09-16T00:00:00.000Z', files: ['src/b.ts'] }),
        pr({ number: 6, mergedAt: '2026-09-29T00:00:00.000Z', files: ['src/c.ts'] }),
        pr({ number: 8, title: 'revert: back out #7', mergedAt: '2026-09-22T00:00:00.000Z' }),
      ],
      SINCE,
      '2026-09-28T23:59:59.999Z',
    );

    expect(report.followupDays).toBe(14);
    expect(report.rows).toContainEqual({
      kind: 'fixes_pr_proxy',
      targetPr: 1,
      evidencePr: 2,
      maturity: 'mature',
      relation: 'within_followup_window',
    });
    expect(report.rows).toContainEqual({
      kind: 'explicit_pr_revert',
      targetPr: 1,
      evidencePr: 3,
      maturity: 'mature',
      relation: 'within_followup_window',
    });
    expect(report.rows).toContainEqual({
      kind: 'same_file_overlap_proxy',
      targetPr: 4,
      evidencePr: 5,
      maturity: 'immature',
      relation: 'within_followup_window',
    });
    expect(report.rows).toContainEqual({
      kind: 'explicit_pr_revert',
      targetPr: 7,
      evidencePr: 8,
      maturity: 'mature',
      relation: 'later_unbounded',
    });
    expect(report.incidentCustomerDefectRows).toEqual([]);
    expect(report.incidentCustomerDefectStatus).toBe('unavailable_no_machine_readable_linkage');
    expect(report.baseBranch).toBe('main');
    expect(report.populationDefinition).toBe(
      'targets and relationship candidates merged into main within the half-open review window',
    );
    expect(report.rows.some((row) => row.targetPr === 6 || row.evidencePr === 6)).toBe(false);
  });

  it('uses the same main-only population for targets, relations, and weekly maturity', () => {
    const mainTarget = pr({ number: 20, mergedAt: '2026-09-01T12:00:00.000Z', files: ['src/main.ts'] });
    const mainFollowUp = pr({
      number: 21,
      title: 'fix: main follow-up',
      body: 'Fixes-PR: #20',
      mergedAt: '2026-09-02T12:00:00.000Z',
    });
    const developTarget = pr({
      number: 30,
      baseRefName: 'develop',
      mergedAt: '2026-09-01T12:00:00.000Z',
      files: ['src/develop.ts'],
    });
    const developFollowUp = pr({
      number: 31,
      baseRefName: 'develop',
      title: 'fix: develop follow-up',
      body: 'Fixes-PR: #30',
      mergedAt: '2026-09-02T12:00:00.000Z',
    });
    const developCrossBaseLink = pr({
      number: 32,
      baseRefName: 'develop',
      title: 'fix: cross-base link must not count',
      body: 'Fixes-PR: #20',
      mergedAt: '2026-09-03T12:00:00.000Z',
    });
    const initial = extractReviewOutcomeEvidence(
      [mainTarget, mainFollowUp, developTarget, developFollowUp, developCrossBaseLink],
      SINCE,
      UNTIL,
    );
    const mainRelation = initial.rows.find((row) => row.targetPr === 20 && row.kind === 'fixes_pr_proxy');
    expect(mainRelation?.maturity).toBe('mature');
    expect(initial.rows.some((row) => row.targetPr === 30 || row.evidencePr === 31)).toBe(false);
    expect(initial.rows.some((row) => row.evidencePr === 32)).toBe(false);
    expect(initial.matureTargetPrs).toBe(2);
    expect(initial.immatureTargetPrs).toBe(0);

    const withUnrelatedMain = extractReviewOutcomeEvidence(
      [
        mainTarget,
        mainFollowUp,
        developTarget,
        developFollowUp,
        developCrossBaseLink,
        pr({ number: 99, mergedAt: developTarget.mergedAt, files: ['src/unrelated.ts'] }),
      ],
      SINCE,
      UNTIL,
    );
    expect(withUnrelatedMain.rows.find((row) => row.targetPr === 20 && row.kind === 'fixes_pr_proxy')?.maturity).toBe(
      mainRelation?.maturity,
    );
    expect(withUnrelatedMain.rows.some((row) => row.targetPr === 30 || row.evidencePr === 31)).toBe(false);
  });

  it('explicitly excludes a non-main-only population instead of reporting it immature', () => {
    const report = extractReviewOutcomeEvidence(
      [
        pr({ number: 40, baseRefName: 'develop', mergedAt: '2026-09-01T12:00:00.000Z' }),
        pr({
          number: 41,
          baseRefName: 'release',
          title: 'fix: non-main relation',
          body: 'Fixes-PR: #40',
          mergedAt: '2026-09-02T12:00:00.000Z',
        }),
      ],
      SINCE,
      UNTIL,
    );

    expect(report).toMatchObject({
      baseBranch: 'main',
      populationDefinition: 'targets and relationship candidates merged into main within the half-open review window',
      matureTargetPrs: 0,
      immatureTargetPrs: 0,
      rows: [],
    });
  });
});

describe('isStrictIsoUtc', () => {
  it('accepts canonical UTC timestamps and rejects naive or offset frozen windows', () => {
    expect(isStrictIsoUtc('2026-09-01T00:00:00Z')).toBe(true);
    expect(isStrictIsoUtc('2026-09-01T00:00:00.001Z')).toBe(true);
    expect(isStrictIsoUtc('2026-09-01T00:00:00')).toBe(false);
    expect(isStrictIsoUtc('2026-09-01T00:00:00+00:00')).toBe(false);
    expect(isStrictIsoUtc('2026-02-30T00:00:00Z')).toBe(false);
  });
});
