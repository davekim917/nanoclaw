/**
 * Read-only, evidence-first operator-attention extract.
 *
 * This deliberately measures durable events, not inferred attention or reading time:
 *
 * - `messages_out`/`delivered` are separate tables; delivery evidence is a non-null
 *   platform message id at the host-stamped `delivered_at` event time
 *   (`src/mailbox/sqlite/schema.ts:23-28`, `src/mailbox/sqlite/session-db.ts:258-262`).
 *   The delivery loop also acknowledges valid adapter no-ops with a null id, so a
 *   null marker is explicitly *not* counted as platform delivery here
 *   (`src/delivery.ts:748-758`, `src/channels/cli.ts:139-145`).
 * - An assistant archive row is reported only as archive observation, at its own
 *   `sent_at` event time. It is not platform-delivery evidence: the archive write
 *   follows any normally returned adapter result, including the CLI no-terminal
 *   no-op above (`src/delivery.ts:1488-1496,1579-1600`). The canonical host archive is
 *   `path.join(DATA_DIR, 'archive.db')` (`src/message-archive.ts:30`), but this
 *   script accepts an explicit archive DB and never claims it covers every
 *   session beneath an independently supplied sessions root. Archive contents
 *   are never selected or emitted.
 * - `quietStatus` stops status rows before they are written
 *   (`container/agent-runner/src/poll-loop.ts:2558-2562`) and `chatLimit` can
 *   drop chat rows before their insert (`container/agent-runner/src/modules/mailbox/index.ts:116-131`).
 *   Configuration is reported separately; missing rows are never invented as
 *   suppressed delivery events.
 *
 * SQLite connections are opened `readonly` and set `PRAGMA query_only=ON`, so this
 * script issues no logical data/schema writes. Ordinary SQLite WAL locking may
 * still create or change `-shm` filesystem metadata; the report says so and counts
 * WAL-without-SHM inputs and SHM files observed newly present after the read. It
 * never uses `immutable=1`, because that would silently ignore committed WAL data.
 *
 * It emits no message text, title, card option, selected choice, sender identity,
 * user id, payload, or PR body. Candidate samples carry only synthetic-safe
 * provenance (source, session-relative path, event id, timestamp, classifier).
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/* eslint-disable no-catch-all/no-catch-all -- malformed or unreadable evidence must become an explicit incomplete-coverage record, never a guessed count */
import { resolveInboundDbPath } from '../src/modules/mailbox/host-inbound.js';
import { computeWeeklyReport, findFollowUp, findRevert, isoWeekKey, type PullRequestData } from './review-outcomes.js';

const DEFAULT_SAMPLE_LIMIT = 10;
const DEFAULT_FOLLOWUP_DAYS = 14;
const REVIEW_OUTCOME_BASE_BRANCH = 'main' as const;

/**
 * Known agent-group metadata directories, not session directories.
 *
 * Keep this explicit: session ids are normally minted as `sess-*`
 * (`src/session-manager.ts:328-330`), but an unfamiliar directory must still
 * fail closed as a possible session rather than disappear from coverage.
 * `.claude-shared` is created per group (`src/group-init.ts:283-288`) and
 * `.context` is the sibling store written by `sessionContextPathFor`
 * (`src/session-manager.ts:73-103`). `.claude-memory` is retained for stale
 * installs: `groupClaudeMemoryDir` created it at
 * `ac8582847:src/session-manager.ts:90-92` before `3198aef43` moved that state
 * beneath `.claude-shared`.
 */
const AGENT_GROUP_METADATA_DIR_NAMES = new Set(['.claude-shared', '.claude-memory', '.context']);

export interface CandidateSample {
  source: 'inbound' | 'choice_receipts';
  session: string;
  eventId: string;
  timestamp: string;
  classifier:
    | 'inbound_reply_candidate'
    | 'status_chase_candidate'
    | 'question_response_candidate'
    | 'resolved_choice_receipt';
}

export interface CoverageError {
  source: 'archive' | 'central' | 'inbound' | 'outbound';
  session?: string;
  code: 'missing_file' | 'missing_required_table' | 'missing_required_column' | 'unreadable';
}

export type ArchiveScope = 'explicit_db_scope_unverified_against_sessions_root';

export interface AttentionCounters {
  /** Current pending central-DB cards, never a historical card total. */
  platformBackedPendingApprovalCardsSnapshot: number;
  /** Durable host-written receipts; no clicker id, label, or value is emitted. */
  resolvedChoiceReceipts: number;
  /** Exact `ask_question` payload plus a non-null platform message id. */
  platformBackedQuestionCards: number;
  /** `kind='chat'` with a non-null platform id at `delivered_at`. */
  finalChatDeliveryEvidence: number;
  finalChatPlatformMessageId: number;
  /** Matching assistant archive rows at `sent_at`; never delivery confirmation. */
  finalChatAssistantArchiveObserved: number;
  /** Statuses with a platform message id; null-marker statuses remain unknown. */
  statusPlatformPostEvidence: number;
  deliveryProcessedUnknown: number;
  questionResponseCandidates: number;
  inboundReplyCandidates: number;
  statusChaseCandidates: number;
  unknownInboundMessages: number;
  quietStatusTaskRowsConfigured: number;
  chatLimitTaskRowsConfigured: number;
  mutedChatTaskRowsConfigured: number;
}

export interface ReviewOutcomeRow {
  kind: 'explicit_pr_revert' | 'fixes_pr_proxy' | 'same_file_overlap_proxy';
  targetPr: number;
  evidencePr: number;
  /** Existing review-metrics week maturity, not a newly invented threshold. */
  maturity: 'mature' | 'immature';
  /** The existing cumulative revert view is intentionally unbounded. */
  relation: 'within_followup_window' | 'later_unbounded';
}

export interface ReviewOutcomeEvidence {
  followupDays: number;
  until: string;
  baseBranch: typeof REVIEW_OUTCOME_BASE_BRANCH;
  populationDefinition: 'targets and relationship candidates merged into main within the half-open review window';
  matureTargetPrs: number;
  immatureTargetPrs: number;
  rows: ReviewOutcomeRow[];
  /** No current PullRequestData field links a PR to an incident/customer defect. */
  incidentCustomerDefectRows: [];
  incidentCustomerDefectStatus: 'unavailable_no_machine_readable_linkage';
}

export interface OperatorAttentionEvidence {
  schemaVersion: 'operator-attention-evidence/v1';
  window: { since: string; until: string };
  provenance: {
    sessionDbsRead: number;
    /** Source readability/schema only; never a claim that archive and session roots have equal scope. */
    sourceReadComplete: boolean;
    archiveScope: ArchiveScope;
    errors: CoverageError[];
    sqliteReadContract: {
      readonly: true;
      queryOnly: true;
      /** SQLite may create/change WAL shared-memory lock metadata even on a logical read. */
      sidecarMetadataMayChange: true;
      walFilesWithoutShmBeforeRead: number;
      shmFilesObservedNewDuringRead: number;
    };
    definitions: {
      delivered: 'non-null platform message id at delivered_at';
      archiveObserved: 'matching assistant archive id at sent_at; not platform-delivery confirmation';
      deliveryProcessedUnknown: 'delivered-table row with a null platform message id';
      prose: 'candidate only; no reading-time inference';
      approvalCards: 'current pending, platform-backed pending_approvals snapshot, not historical total';
    };
  };
  counts: AttentionCounters;
  samples: CandidateSample[];
  reviewOutcomes?: ReviewOutcomeEvidence;
}

export interface ExtractOptions {
  sessionsRoot: string;
  centralDb: string;
  archiveDb: string;
  since: string;
  until: string;
  sampleLimit?: number;
  reviewPrs?: PullRequestData[];
  reviewSince?: string;
  reviewUntil?: string;
  followupDays?: number;
}

interface OutboundRow {
  id: string;
  timestamp: string;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  content: string;
}

interface DeliveredRow {
  message_out_id: string;
  status: string;
  platform_message_id: string | null;
  delivered_at: string;
}

interface InboundRow {
  id: string;
  timestamp: string;
  kind: string;
  content: string;
}

interface ParsedInbound {
  text: string | null;
  knownBot: boolean;
}

interface ArchiveObservation {
  sentAt: string;
}

interface SqliteReadObservations {
  walWithoutShmBeforeRead: Set<string>;
  shmObservedNewDuringRead: Set<string>;
}

interface ParsedTaskControls {
  quietStatus: boolean;
  chatLimit: boolean;
  muteChat: boolean;
}

function emptyCounters(): AttentionCounters {
  return {
    platformBackedPendingApprovalCardsSnapshot: 0,
    resolvedChoiceReceipts: 0,
    platformBackedQuestionCards: 0,
    finalChatDeliveryEvidence: 0,
    finalChatPlatformMessageId: 0,
    finalChatAssistantArchiveObserved: 0,
    statusPlatformPostEvidence: 0,
    deliveryProcessedUnknown: 0,
    questionResponseCandidates: 0,
    inboundReplyCandidates: 0,
    statusChaseCandidates: 0,
    unknownInboundMessages: 0,
    quietStatusTaskRowsConfigured: 0,
    chatLimitTaskRowsConfigured: 0,
    mutedChatTaskRowsConfigured: 0,
  };
}

const STRICT_ISO_UTC_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/;

/**
 * `new Date()` also accepts local/naive forms. Frozen measurement windows must
 * name an exact UTC instant, matching the repository's storage convention.
 */
export function isStrictIsoUtc(value: string): boolean {
  const match = STRICT_ISO_UTC_RE.exec(value);
  if (!match) return false;
  const milliseconds = (match[2] ?? '').padEnd(3, '0') || '000';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === `${match[1]}.${milliseconds}Z`;
}

function isIsoInWindow(value: string, since: string, until: string): boolean {
  const valueMs = new Date(value).getTime();
  const sinceMs = new Date(since).getTime();
  const untilMs = new Date(until).getTime();
  return Number.isFinite(valueMs) && valueMs >= sinceMs && valueMs < untilMs;
}

function assertIso(value: string, name: string): void {
  if (!isStrictIsoUtc(value)) throw new Error(`${name} must be a strict ISO-8601 UTC timestamp ending in Z`);
}

function openReadOnly(dbPath: string, observations: SqliteReadObservations): Database.Database {
  if (fs.existsSync(`${dbPath}-wal`) && !fs.existsSync(`${dbPath}-shm`)) {
    observations.walWithoutShmBeforeRead.add(dbPath);
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  if (!db.readonly || db.pragma('query_only', { simple: true }) !== 1) {
    db.close();
    throw new Error('failed to enforce SQLite readonly/query_only');
  }
  return db;
}

function closeReadOnly(db: Database.Database | undefined, dbPath: string, observations: SqliteReadObservations): void {
  if (!db) return;
  if (observations.walWithoutShmBeforeRead.has(dbPath) && fs.existsSync(`${dbPath}-shm`)) {
    observations.shmObservedNewDuringRead.add(dbPath);
  }
  db.close();
  if (observations.walWithoutShmBeforeRead.has(dbPath) && fs.existsSync(`${dbPath}-shm`)) {
    observations.shmObservedNewDuringRead.add(dbPath);
  }
}

function readDbHasTable(db: Database.Database, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function hasColumns(db: Database.Database, table: string, columns: readonly string[]): boolean {
  const present = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  );
  return columns.every((column) => present.has(column));
}

function safeJson(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseInbound(content: string): ParsedInbound | null {
  const parsed = safeJson(content);
  if (!parsed) return null;
  const author = parsed.author;
  const authorRecord =
    author !== null && typeof author === 'object' && !Array.isArray(author)
      ? (author as Record<string, unknown>)
      : null;
  return {
    text: typeof parsed.text === 'string' ? parsed.text : null,
    knownBot: parsed.isFromMe === true || authorRecord?.isBot === true || authorRecord?.isMe === true,
  };
}

function isQuestionResponseEnvelope(parsed: Record<string, unknown>): boolean {
  return (
    parsed.type === 'question_response' &&
    typeof parsed.questionId === 'string' &&
    typeof parsed.selectedOption === 'string' &&
    typeof parsed.userId === 'string'
  );
}

function parseTaskControls(content: string): ParsedTaskControls | null {
  const parsed = safeJson(content);
  if (!parsed) return null;
  return {
    quietStatus: parsed.quietStatus === true,
    chatLimit: typeof parsed.chatLimit === 'number' && Number.isFinite(parsed.chatLimit) && parsed.chatLimit >= 0,
    muteChat: parsed.muteChat === true,
  };
}

/** A deliberately small prose-only candidate detector; never an outcome fact. */
export function isStatusChaseCandidate(text: string): boolean {
  return /\b(?:status|update|progress|eta|any news|where (?:are|is)|still (?:working|running)|how(?:'s| is) it going)\b/i.test(
    text,
  );
}

function isAskQuestion(content: string): boolean {
  const parsed = safeJson(content);
  return parsed?.type === 'ask_question' && typeof parsed.questionId === 'string';
}

function appendSample(samples: CandidateSample[], sample: CandidateSample, sampleLimit: number): void {
  if (samples.filter((existing) => existing.classifier === sample.classifier).length < sampleLimit)
    samples.push(sample);
}

function listSessionDirectories(root: string): Array<{ session: string; dir: string }> {
  const result: Array<{ session: string; dir: string }> = [];
  for (const agentGroup of fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const agentGroupPath = path.join(root, agentGroup.name);
    for (const session of fs
      .readdirSync(agentGroupPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !AGENT_GROUP_METADATA_DIR_NAMES.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      result.push({ session: `${agentGroup.name}/${session.name}`, dir: path.join(agentGroupPath, session.name) });
    }
  }
  return result;
}

/** Uses the canonical host-owned-first, legacy-fallback resolver at src/modules/mailbox/host-inbound.ts:237-240. */
function inboundPathForSession(sessionDir: string): string | null {
  const resolved = resolveInboundDbPath(sessionDir);
  return fs.existsSync(resolved) ? resolved : null;
}

function readAssistantArchiveObservations(
  archiveDb: string,
  errors: CoverageError[],
  sqliteObservations: SqliteReadObservations,
): Map<string, ArchiveObservation> {
  if (!fs.existsSync(archiveDb)) {
    errors.push({ source: 'archive', code: 'missing_file' });
    return new Map();
  }
  let db: Database.Database | undefined;
  try {
    db = openReadOnly(archiveDb, sqliteObservations);
    if (!readDbHasTable(db, 'messages_archive')) {
      errors.push({ source: 'archive', code: 'missing_required_table' });
      return new Map();
    }
    if (!hasColumns(db, 'messages_archive', ['id', 'role', 'sent_at'])) {
      errors.push({ source: 'archive', code: 'missing_required_column' });
      return new Map();
    }
    return new Map(
      (
        db.prepare("SELECT id, sent_at FROM messages_archive WHERE role = 'assistant'").all() as Array<{
          id: string;
          sent_at: string;
        }>
      ).map((row) => [row.id, { sentAt: row.sent_at }]),
    );
  } catch {
    errors.push({ source: 'archive', code: 'unreadable' });
    return new Map();
  } finally {
    closeReadOnly(db, archiveDb, sqliteObservations);
  }
}

function readCentralEvidence(
  centralDb: string,
  since: string,
  until: string,
  counters: AttentionCounters,
  samples: CandidateSample[],
  sampleLimit: number,
  errors: CoverageError[],
  sqliteObservations: SqliteReadObservations,
): void {
  if (!fs.existsSync(centralDb)) {
    errors.push({ source: 'central', code: 'missing_file' });
    return;
  }
  let db: Database.Database | undefined;
  try {
    db = openReadOnly(centralDb, sqliteObservations);
    if (
      !readDbHasTable(db, 'pending_approvals') ||
      !hasColumns(db, 'pending_approvals', ['approval_id', 'platform_message_id', 'status'])
    ) {
      errors.push({ source: 'central', code: 'missing_required_table' });
    } else {
      const rows = db
        .prepare(
          `SELECT approval_id
             FROM pending_approvals
            WHERE status = 'pending' AND platform_message_id IS NOT NULL
            ORDER BY approval_id`,
        )
        .all() as Array<{ approval_id: string }>;
      counters.platformBackedPendingApprovalCardsSnapshot += rows.length;
    }

    if (
      !readDbHasTable(db, 'choice_receipts') ||
      !hasColumns(db, 'choice_receipts', ['approval_id', 'session_id', 'resolved_at'])
    ) {
      errors.push({ source: 'central', code: 'missing_required_table' });
      return;
    }
    const rows = db
      .prepare('SELECT approval_id, session_id, resolved_at FROM choice_receipts ORDER BY resolved_at, approval_id')
      .all() as Array<{ approval_id: string; session_id: string; resolved_at: string }>;
    for (const row of rows) {
      if (!isIsoInWindow(row.resolved_at, since, until)) continue;
      counters.resolvedChoiceReceipts += 1;
      appendSample(
        samples,
        {
          source: 'choice_receipts',
          session: row.session_id,
          eventId: row.approval_id,
          timestamp: row.resolved_at,
          classifier: 'resolved_choice_receipt',
        },
        sampleLimit,
      );
    }
  } catch {
    errors.push({ source: 'central', code: 'unreadable' });
  } finally {
    closeReadOnly(db, centralDb, sqliteObservations);
  }
}

function scanSession(input: {
  session: string;
  dir: string;
  since: string;
  until: string;
  archiveAssistantObservations: ReadonlyMap<string, ArchiveObservation>;
  counters: AttentionCounters;
  samples: CandidateSample[];
  sampleLimit: number;
  errors: CoverageError[];
  sqliteObservations: SqliteReadObservations;
}): boolean {
  const inboundPath = inboundPathForSession(input.dir);
  const outboundPath = path.join(input.dir, 'outbound.db');
  if (!inboundPath) {
    input.errors.push({ source: 'inbound', session: input.session, code: 'missing_file' });
    return false;
  }
  if (!fs.existsSync(outboundPath)) {
    input.errors.push({ source: 'outbound', session: input.session, code: 'missing_file' });
    return false;
  }

  let inbound: Database.Database | undefined;
  let outbound: Database.Database | undefined;
  let activeSource: CoverageError['source'] = 'inbound';
  try {
    inbound = openReadOnly(inboundPath, input.sqliteObservations);
    activeSource = 'outbound';
    outbound = openReadOnly(outboundPath, input.sqliteObservations);
    if (!readDbHasTable(inbound, 'messages_in') || !readDbHasTable(inbound, 'delivered')) {
      input.errors.push({ source: 'inbound', session: input.session, code: 'missing_required_table' });
      return false;
    }
    if (!readDbHasTable(outbound, 'messages_out')) {
      input.errors.push({ source: 'outbound', session: input.session, code: 'missing_required_table' });
      return false;
    }
    if (
      !hasColumns(inbound, 'messages_in', ['id', 'timestamp', 'kind', 'content']) ||
      !hasColumns(inbound, 'delivered', ['message_out_id', 'status', 'platform_message_id', 'delivered_at'])
    ) {
      input.errors.push({ source: 'inbound', session: input.session, code: 'missing_required_column' });
      return false;
    }
    if (!hasColumns(outbound, 'messages_out', ['id', 'timestamp', 'kind', 'platform_id', 'channel_type', 'content'])) {
      input.errors.push({ source: 'outbound', session: input.session, code: 'missing_required_column' });
      return false;
    }

    activeSource = 'inbound';
    const inboundRows = inbound
      .prepare('SELECT id, timestamp, kind, content FROM messages_in ORDER BY timestamp, id')
      .all() as InboundRow[];
    for (const row of inboundRows) {
      if (!isIsoInWindow(row.timestamp, input.since, input.until)) continue;
      if (row.kind === 'task') {
        const controls = parseTaskControls(row.content);
        if (controls?.quietStatus) input.counters.quietStatusTaskRowsConfigured += 1;
        if (controls?.chatLimit) input.counters.chatLimitTaskRowsConfigured += 1;
        if (controls?.muteChat) input.counters.mutedChatTaskRowsConfigured += 1;
        continue;
      }
      if (row.kind === 'system') {
        const parsed = safeJson(row.content);
        if (parsed && isQuestionResponseEnvelope(parsed)) {
          input.counters.questionResponseCandidates += 1;
          appendSample(
            input.samples,
            {
              source: 'inbound',
              session: input.session,
              eventId: row.id,
              timestamp: row.timestamp,
              classifier: 'question_response_candidate',
            },
            input.sampleLimit,
          );
        } else {
          // A system row outside the one recognized question-response shape is
          // still durable inbound evidence. Do not silently omit a new system
          // subtype from an extract that claims source completeness.
          input.counters.unknownInboundMessages += 1;
        }
        continue;
      }
      if (row.kind !== 'chat' && row.kind !== 'chat-sdk') continue;
      const parsed = parseInbound(row.content);
      if (!parsed) {
        input.counters.unknownInboundMessages += 1;
        continue;
      }
      if (parsed.knownBot) continue;
      if (!parsed.text) {
        // A human file/attachment-only reply is not a prose candidate, but it
        // must remain visible as unclassified evidence rather than becoming a
        // zero-traffic window.
        input.counters.unknownInboundMessages += 1;
        continue;
      }
      input.counters.inboundReplyCandidates += 1;
      appendSample(
        input.samples,
        {
          source: 'inbound',
          session: input.session,
          eventId: row.id,
          timestamp: row.timestamp,
          classifier: 'inbound_reply_candidate',
        },
        input.sampleLimit,
      );
      if (isStatusChaseCandidate(parsed.text)) {
        input.counters.statusChaseCandidates += 1;
        appendSample(
          input.samples,
          {
            source: 'inbound',
            session: input.session,
            eventId: row.id,
            timestamp: row.timestamp,
            classifier: 'status_chase_candidate',
          },
          input.sampleLimit,
        );
      }
    }

    activeSource = 'outbound';
    const outboundRows = outbound
      .prepare(
        `SELECT id, timestamp, kind, platform_id, channel_type, content
           FROM messages_out
          ORDER BY timestamp, id`,
      )
      .all() as OutboundRow[];
    // Delivery acknowledgements belong to the *inbound* database by design;
    // `messages_out` is container-owned and never has this table
    // (`src/mailbox/sqlite/schema.ts:23-60`). Do not ATTACH: each source DB
    // remains independently read-only, including when its WAL is live.
    const deliveredRows = inbound
      .prepare('SELECT message_out_id, status, platform_message_id, delivered_at FROM delivered')
      .all() as DeliveredRow[];
    // Count this metric from its authoritative table rather than from the
    // outbound join. Acknowledgements can outlive a pruned outbound row, and
    // a concurrent read can observe an acknowledgement before its row; either
    // is still durable null-id delivery evidence in this time window.
    for (const delivery of deliveredRows) {
      if (
        delivery.platform_message_id === null &&
        isIsoInWindow(delivery.delivered_at, input.since, input.until)
      ) {
        input.counters.deliveryProcessedUnknown += 1;
      }
    }
    const deliveredByOutboundId = new Map(deliveredRows.map((row) => [row.message_out_id, row]));
    for (const row of outboundRows) {
      const delivery = deliveredByOutboundId.get(row.id);
      const archiveObservation = input.archiveAssistantObservations.get(row.id);
      if (
        row.kind === 'chat' &&
        archiveObservation &&
        isIsoInWindow(archiveObservation.sentAt, input.since, input.until)
      ) {
        input.counters.finalChatAssistantArchiveObserved += 1;
      }
      if (!delivery || !isIsoInWindow(delivery.delivered_at, input.since, input.until)) {
        continue;
      }
      // Null-id rows were counted directly from `delivered` above. Do not let
      // them enter successful-delivery classification merely because a matching
      // container-owned outbound row happens to be present.
      if (delivery.platform_message_id === null) {
        continue;
      }
      if (delivery.status !== 'delivered') continue;
      if (row.kind === 'status') {
        input.counters.statusPlatformPostEvidence += 1;
        continue;
      }
      if (isAskQuestion(row.content)) {
        input.counters.platformBackedQuestionCards += 1;
        continue;
      }
      if (row.kind !== 'chat') continue;
      input.counters.finalChatDeliveryEvidence += 1;
      input.counters.finalChatPlatformMessageId += 1;
    }
    return true;
  } catch {
    input.errors.push({ source: activeSource, session: input.session, code: 'unreadable' });
    return false;
  } finally {
    closeReadOnly(outbound, outboundPath, input.sqliteObservations);
    closeReadOnly(inbound, inboundPath, input.sqliteObservations);
  }
}

/**
 * Extracts only the outcome relationships already modelled by review-outcomes.
 * An explicit PR-to-PR revert is a source/deployment outcome, not a customer-defect
 * claim. `Fixes-PR:` and same-file overlap remain explicitly named proxies.
 */
export function extractReviewOutcomeEvidence(
  prs: readonly PullRequestData[],
  since: string,
  until: string,
  followupDays: number = DEFAULT_FOLLOWUP_DAYS,
): ReviewOutcomeEvidence {
  assertIso(since, 'review since');
  assertIso(until, 'review until');
  if (new Date(since).getTime() >= new Date(until).getTime())
    throw new Error('review since must be before review until');
  if (!Number.isFinite(followupDays) || followupDays <= 0) throw new Error('followupDays must be positive');

  // The half-open window is applied before both target and follow-up selection.
  // In particular, a PR fetched past `until` cannot mature or supply evidence
  // for an earlier target in this frozen report.
  // Match `computeWeeklyReport`'s population exactly: it begins by retaining
  // only PRs whose base is `main` (`scripts/review-outcomes.ts:1310-1317`).
  // Apply that scope before selecting targets OR relationship candidates so a
  // PR on another base cannot borrow a main PR's week maturity or link into a
  // main target's evidence.
  const eligiblePrs = prs.filter(
    (pr) =>
      pr.baseRefName === REVIEW_OUTCOME_BASE_BRANCH &&
      isStrictIsoUtc(pr.mergedAt) &&
      isIsoInWindow(pr.mergedAt, since, until),
  );

  // `computeWeeklyReport` owns the established 14-day end-of-week maturity
  // definition (`scripts/review-outcomes.ts:1266-1295`); this only reuses it.
  const maturityByWeek = new Map(
    computeWeeklyReport([...eligiblePrs], [], followupDays, until).rows.map((row) => [row.isoWeek, row.immature]),
  );
  const sorted = [...eligiblePrs].sort((a, b) => new Date(a.mergedAt).getTime() - new Date(b.mergedAt).getTime());
  const rows: ReviewOutcomeRow[] = [];
  let matureTargetPrs = 0;
  let immatureTargetPrs = 0;

  for (const target of sorted) {
    const maturity = maturityByWeek.get(isoWeekKey(target.mergedAt)) === false ? 'mature' : 'immature';
    if (maturity === 'mature') matureTargetPrs += 1;
    else immatureTargetPrs += 1;
    const targetMs = new Date(target.mergedAt).getTime();
    const later = sorted.filter((candidate) => new Date(candidate.mergedAt).getTime() > targetMs);
    const laterWithinWindow = later.filter(
      (candidate) => new Date(candidate.mergedAt).getTime() <= targetMs + followupDays * 24 * 60 * 60 * 1000,
    );
    const followUp = findFollowUp(target, laterWithinWindow);
    if (followUp.kind === 'link' && followUp.prNumber !== null) {
      rows.push({
        kind: 'fixes_pr_proxy',
        targetPr: target.number,
        evidencePr: followUp.prNumber,
        maturity,
        relation: 'within_followup_window',
      });
    } else if (followUp.kind === 'overlap' && followUp.prNumber !== null) {
      rows.push({
        kind: 'same_file_overlap_proxy',
        targetPr: target.number,
        evidencePr: followUp.prNumber,
        maturity,
        relation: 'within_followup_window',
      });
    }

    const withinWindowRevert = findRevert(target, laterWithinWindow);
    if (withinWindowRevert !== null) {
      rows.push({
        kind: 'explicit_pr_revert',
        targetPr: target.number,
        evidencePr: withinWindowRevert,
        maturity,
        relation: 'within_followup_window',
      });
      continue;
    }
    const laterRevert = findRevert(target, later);
    if (laterRevert !== null) {
      rows.push({
        kind: 'explicit_pr_revert',
        targetPr: target.number,
        evidencePr: laterRevert,
        maturity,
        relation: 'later_unbounded',
      });
    }
  }
  return {
    followupDays,
    until,
    baseBranch: REVIEW_OUTCOME_BASE_BRANCH,
    populationDefinition: 'targets and relationship candidates merged into main within the half-open review window',
    matureTargetPrs,
    immatureTargetPrs,
    rows,
    incidentCustomerDefectRows: [],
    incidentCustomerDefectStatus: 'unavailable_no_machine_readable_linkage',
  };
}

export function collectOperatorAttentionEvidence(options: ExtractOptions): OperatorAttentionEvidence {
  assertIso(options.since, 'since');
  assertIso(options.until, 'until');
  if (new Date(options.since).getTime() >= new Date(options.until).getTime())
    throw new Error('since must be before until');
  if (!fs.existsSync(options.sessionsRoot) || !fs.statSync(options.sessionsRoot).isDirectory()) {
    throw new Error('sessionsRoot must be an existing directory');
  }
  const sampleLimit = options.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  if (!Number.isInteger(sampleLimit) || sampleLimit < 0) throw new Error('sampleLimit must be a non-negative integer');

  const errors: CoverageError[] = [];
  const counters = emptyCounters();
  const samples: CandidateSample[] = [];
  const sqliteObservations: SqliteReadObservations = {
    walWithoutShmBeforeRead: new Set(),
    shmObservedNewDuringRead: new Set(),
  };
  const archiveAssistantObservations = readAssistantArchiveObservations(options.archiveDb, errors, sqliteObservations);
  readCentralEvidence(
    options.centralDb,
    options.since,
    options.until,
    counters,
    samples,
    sampleLimit,
    errors,
    sqliteObservations,
  );

  let sessionDbsRead = 0;
  for (const session of listSessionDirectories(options.sessionsRoot)) {
    if (
      scanSession({
        ...session,
        since: options.since,
        until: options.until,
        archiveAssistantObservations,
        counters,
        samples,
        sampleLimit,
        errors,
        sqliteObservations,
      })
    ) {
      sessionDbsRead += 1;
    }
  }

  return {
    schemaVersion: 'operator-attention-evidence/v1',
    window: { since: options.since, until: options.until },
    provenance: {
      sessionDbsRead,
      sourceReadComplete: errors.length === 0,
      archiveScope: 'explicit_db_scope_unverified_against_sessions_root',
      errors,
      sqliteReadContract: {
        readonly: true,
        queryOnly: true,
        sidecarMetadataMayChange: true,
        walFilesWithoutShmBeforeRead: sqliteObservations.walWithoutShmBeforeRead.size,
        shmFilesObservedNewDuringRead: sqliteObservations.shmObservedNewDuringRead.size,
      },
      definitions: {
        delivered: 'non-null platform message id at delivered_at',
        archiveObserved: 'matching assistant archive id at sent_at; not platform-delivery confirmation',
        deliveryProcessedUnknown: 'delivered-table row with a null platform message id',
        prose: 'candidate only; no reading-time inference',
        approvalCards: 'current pending, platform-backed pending_approvals snapshot, not historical total',
      },
    },
    counts: counters,
    samples,
    ...(options.reviewPrs
      ? {
          reviewOutcomes: extractReviewOutcomeEvidence(
            options.reviewPrs,
            options.reviewSince ?? options.since,
            options.reviewUntil ?? options.until,
            options.followupDays,
          ),
        }
      : {}),
  };
}

interface CliOptions extends ExtractOptions {
  repo?: string;
  reviewSince?: string;
}

function usage(): never {
  throw new Error(
    'Usage: tsx scripts/operator-attention-evidence.ts --sessions-root <dir> --central-db <db> --archive-db <db> --since <ISO> --until <ISO> [--sample-limit <n>] [--repo <owner/repo> --review-since <ISO> --review-until <ISO> --followup-days <n>]',
  );
}

function parseCliArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  const allowed = new Set([
    'sessions-root',
    'central-db',
    'archive-db',
    'since',
    'until',
    'sample-limit',
    'repo',
    'review-since',
    'review-until',
    'followup-days',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) usage();
    const name = argument.slice(2);
    const value = argv[index + 1];
    if (!allowed.has(name) || values.has(name) || !value || value.startsWith('--')) usage();
    values.set(name, value);
    index += 1;
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) usage();
    return value;
  };
  const repo = values.get('repo');
  const reviewSince = values.get('review-since');
  const reviewUntil = values.get('review-until');
  if ((reviewSince || reviewUntil || values.has('followup-days')) && !repo) usage();
  return {
    sessionsRoot: required('sessions-root'),
    centralDb: required('central-db'),
    archiveDb: required('archive-db'),
    since: required('since'),
    until: required('until'),
    sampleLimit: values.has('sample-limit') ? Number(values.get('sample-limit')) : undefined,
    repo,
    reviewUntil,
    followupDays: values.has('followup-days') ? Number(values.get('followup-days')) : undefined,
    reviewSince,
  };
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  let reviewPrs: PullRequestData[] | undefined;
  if (options.repo) {
    const { fetchMergedPRs } = await import('./review-outcomes.js');
    const reviewSince = options.reviewSince ?? options.since;
    const reviewUntil = options.reviewUntil ?? options.until;
    assertIso(reviewSince, 'review since');
    assertIso(reviewUntil, 'review until');
    if (new Date(reviewSince).getTime() >= new Date(reviewUntil).getTime())
      throw new Error('review since must be before review until');
    reviewPrs = fetchMergedPRs(options.repo, reviewSince, reviewUntil);
  }
  const report = collectOperatorAttentionEvidence({
    ...options,
    reviewPrs,
    reviewSince: options.reviewSince ?? options.since,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.provenance.sourceReadComplete) process.exitCode = 1;
}

if (process.argv[1] && new URL(process.argv[1], 'file:').href === import.meta.url) {
  main().catch((error: unknown) => {
    // Do not stringify a SQLite error: some implementations include SQL text.
    process.stderr.write(`operator-attention-evidence: ${error instanceof Error ? error.message : 'invalid input'}\n`);
    process.exitCode = 1;
  });
}
