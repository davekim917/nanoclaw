import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-attention-evidence-'));
  TEMP_ROOTS.push(root);
  return root;
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function createCentralDb(file: string): void {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE pending_approvals (approval_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, platform_message_id TEXT, status TEXT NOT NULL);
    CREATE TABLE choice_receipts (approval_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, resolved_at TEXT NOT NULL);
  `);
  db.prepare('INSERT INTO pending_approvals VALUES (?, ?, ?, ?)').run(
    'appr-visible',
    '2026-09-10T10:00:00.000Z',
    'platform-card',
    'pending',
  );
  db.prepare('INSERT INTO pending_approvals VALUES (?, ?, ?, ?)').run(
    'appr-unconfirmed',
    '2026-09-10T10:01:00.000Z',
    null,
    'pending',
  );
  db.prepare('INSERT INTO choice_receipts VALUES (?, ?, ?)').run(
    'choice-receipt',
    'sess-fixture',
    '2026-09-10T10:02:00.000Z',
  );
  db.close();
}

function createArchiveDb(file: string): void {
  const db = new Database(file);
  db.exec('CREATE TABLE messages_archive (id TEXT PRIMARY KEY, role TEXT NOT NULL, text TEXT NOT NULL)');
  db.prepare('INSERT INTO messages_archive VALUES (?, ?, ?)').run(
    'out-chat-archive',
    'assistant',
    'synthetic private archive text',
  );
  db.close();
}

function createSession(
  root: string,
  sessionName: string = 'sess-fixture',
): {
  inbound: string;
  outbound: string;
  close(): void;
} {
  const session = path.join(root, 'ag-fixture', sessionName);
  fs.mkdirSync(session, { recursive: true });
  const inbound = path.join(session, 'inbound.db');
  const outbound = path.join(session, 'outbound.db');
  const inDb = new Database(inbound);
  inDb.pragma('journal_mode = WAL');
  inDb.exec(`
    CREATE TABLE messages_in (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL);
    CREATE TABLE delivered (message_out_id TEXT PRIMARY KEY, status TEXT NOT NULL, platform_message_id TEXT);
  `);
  const outDb = new Database(outbound);
  outDb.exec(`
    CREATE TABLE messages_out (
      id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, kind TEXT NOT NULL,
      platform_id TEXT, channel_type TEXT, content TEXT NOT NULL
    );
  `);

  const insertInbound = inDb.prepare('INSERT INTO messages_in VALUES (?, ?, ?, ?)');
  insertInbound.run(
    'in-status-chase',
    '2026-09-10T09:00:00.000Z',
    'chat',
    JSON.stringify({ text: 'Could I get a status update?', isFromMe: false }),
  );
  insertInbound.run(
    'in-question-answer',
    '2026-09-10T09:01:00.000Z',
    'chat',
    JSON.stringify({ text: 'yes', questionId: 'q-1', isFromMe: false }),
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

  const insertOutbound = outDb.prepare('INSERT INTO messages_out VALUES (?, ?, ?, ?, ?, ?)');
  const insertDelivered = inDb.prepare('INSERT INTO delivered VALUES (?, ?, ?)');
  for (const [id, kind, content, platformId] of [
    ['out-chat-platform', 'chat', JSON.stringify({ text: 'synthetic final text' }), 'platform-final'],
    ['out-chat-archive', 'chat', JSON.stringify({ text: 'synthetic archive final' }), null],
    ['out-chat-unknown', 'chat', JSON.stringify({ text: 'synthetic unknown final' }), null],
    ['out-status-platform', 'status', JSON.stringify({ text: 'synthetic progress' }), 'platform-status'],
    ['out-status-suppressed', 'status', JSON.stringify({ text: 'synthetic suppressed progress' }), null],
    [
      'out-question-platform',
      'chat-sdk',
      // Matches the real ask_user_question producer's kind/payload shape at
      // `container/agent-runner/src/mcp-tools/interactive.ts:92-106`.
      JSON.stringify({ type: 'ask_question', questionId: 'q-1' }),
      'platform-question',
    ],
    ['out-question-unknown', 'chat-sdk', JSON.stringify({ type: 'ask_question', questionId: 'q-2' }), null],
  ] as const) {
    insertOutbound.run(id, '2026-09-10T10:00:00.000Z', kind, 'C-fixture', 'slack', content);
    insertDelivered.run(id, 'delivered', platformId);
  }

  // Keep this connection open: its valid WAL makes the read-only extractor prove
  // it neither checkpoints nor creates sidecars. The source schema is the real
  // mailbox split (`src/mailbox/sqlite/schema.ts:3-60`), reduced to only queried columns.
  return {
    inbound,
    outbound,
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
  it('counts only platform/archive evidence, keeps prose candidate-only, and never writes source DBs', () => {
    const root = makeRoot();
    const sessionsRoot = path.join(root, 'sessions');
    const source = createSession(sessionsRoot);
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
      });
      expect(report.counts).toMatchObject({
        platformBackedPendingApprovalCardsSnapshot: 1,
        resolvedChoiceReceipts: 1,
        platformBackedQuestionCards: 1,
        finalChatDeliveryEvidence: 2,
        finalChatPlatformMessageId: 1,
        finalChatAssistantArchiveId: 1,
        statusPlatformPostEvidence: 1,
        // The null status marker may be spawn-child suppression, an edit, or a drop;
        // source delivery marks it `delivered` either way (`src/delivery.ts:748-758,1216-1233`).
        deliveryProcessedUnknown: 3,
        questionResponseCandidates: 1,
        inboundReplyCandidates: 2,
        statusChaseCandidates: 1,
        quietStatusTaskRowsConfigured: 1,
        chatLimitTaskRowsConfigured: 1,
        mutedChatTaskRowsConfigured: 1,
      });
      expect(JSON.stringify(report)).not.toContain('Could I get a status update?');
      expect(JSON.stringify(report)).not.toContain('synthetic private archive text');
      expect(JSON.stringify(report)).not.toContain('synthetic final text');
      expect(sha256(source.inbound)).toBe(beforeDb);
      expect(sha256(wal)).toBe(beforeWal);
      expect(fs.existsSync(`${source.inbound}-journal`)).toBe(false);
    } finally {
      // The fixture owns the sole WAL writer while the extractor reads it, then
      // closes both source handles before global temporary-directory cleanup.
      source.close();
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
    expect(report.rows.some((row) => row.targetPr === 6 || row.evidencePr === 6)).toBe(false);
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
