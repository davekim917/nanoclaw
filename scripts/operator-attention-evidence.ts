/**
 * Read-only, evidence-first operator-attention extract.
 *
 * This deliberately measures durable events, not inferred attention or reading time:
 *
 * - `messages_out`/`delivered` are separate tables with a nullable platform message
 *   id (`src/mailbox/sqlite/schema.ts:23-60`). The delivery loop marks every
 *   non-deferred row delivered with `result.platformMsgId ?? null`
 *   (`src/delivery.ts:748-758`), while spawn-child status rows return that same
 *   null result after being suppressed (`src/delivery.ts:1211-1233`). Therefore a
 *   null delivery marker is explicitly *not* counted as platform delivery here.
 * - An assistant archive row is a second, conservative final-chat signal: it is
 *   written only after the normal chat-delivery path has continued
 *   (`src/delivery.ts:1579-1609`). The canonical host archive is
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
 * It emits no message text, title, card option, selected choice, sender identity,
 * user id, payload, or PR body. Candidate samples carry only synthetic-safe
 * provenance (source, session-relative path, event id, timestamp, classifier).
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/* eslint-disable no-catch-all/no-catch-all -- malformed or unreadable evidence must become an explicit incomplete-coverage record, never a guessed count */
import { computeWeeklyReport, findFollowUp, findRevert, isoWeekKey, type PullRequestData } from './review-outcomes.js';

const DEFAULT_SAMPLE_LIMIT = 10;
const DEFAULT_FOLLOWUP_DAYS = 14;

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
  /** `kind='chat'` with platform-id or assistant-archive evidence. */
  finalChatDeliveryEvidence: number;
  finalChatPlatformMessageId: number;
  finalChatAssistantArchiveId: number;
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
    definitions: {
      delivered: 'non-null platform message id, or assistant archive id for final chat';
      deliveryProcessedUnknown: 'delivered-table row with no sufficient platform/archive evidence';
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
}

interface InboundRow {
  id: string;
  timestamp: string;
  kind: string;
  content: string;
}

interface ParsedInbound {
  text: string | null;
  questionId: string | null;
  knownBot: boolean;
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
    finalChatAssistantArchiveId: 0,
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

function openReadOnly(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function hasTable(db: Database.Database, table: string): boolean {
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
    questionId: typeof parsed.questionId === 'string' ? parsed.questionId : null,
    knownBot: parsed.isFromMe === true || authorRecord?.isBot === true || authorRecord?.isMe === true,
  };
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
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      result.push({ session: `${agentGroup.name}/${session.name}`, dir: path.join(agentGroupPath, session.name) });
    }
  }
  return result;
}

/** Mirrors the host's read-path preference at src/modules/mailbox/host-inbound.ts:237-240. */
function inboundPathForSession(sessionDir: string): string | null {
  const hostOwned = path.join(sessionDir, '.host', 'inbound.db');
  if (fs.existsSync(hostOwned)) return hostOwned;
  const legacy = path.join(sessionDir, 'inbound.db');
  return fs.existsSync(legacy) ? legacy : null;
}

function readAssistantArchiveIds(archiveDb: string, errors: CoverageError[]): Set<string> {
  if (!fs.existsSync(archiveDb)) {
    errors.push({ source: 'archive', code: 'missing_file' });
    return new Set();
  }
  let db: Database.Database | undefined;
  try {
    db = openReadOnly(archiveDb);
    if (!hasTable(db, 'messages_archive')) {
      errors.push({ source: 'archive', code: 'missing_required_table' });
      return new Set();
    }
    if (!hasColumns(db, 'messages_archive', ['id', 'role'])) {
      errors.push({ source: 'archive', code: 'missing_required_column' });
      return new Set();
    }
    return new Set(db.prepare("SELECT id FROM messages_archive WHERE role = 'assistant'").pluck().all() as string[]);
  } catch {
    errors.push({ source: 'archive', code: 'unreadable' });
    return new Set();
  } finally {
    db?.close();
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
): void {
  if (!fs.existsSync(centralDb)) {
    errors.push({ source: 'central', code: 'missing_file' });
    return;
  }
  let db: Database.Database | undefined;
  try {
    db = openReadOnly(centralDb);
    if (
      !hasTable(db, 'pending_approvals') ||
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
      !hasTable(db, 'choice_receipts') ||
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
    db?.close();
  }
}

function scanSession(input: {
  session: string;
  dir: string;
  since: string;
  until: string;
  archiveAssistantIds: ReadonlySet<string>;
  counters: AttentionCounters;
  samples: CandidateSample[];
  sampleLimit: number;
  errors: CoverageError[];
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
    inbound = openReadOnly(inboundPath);
    activeSource = 'outbound';
    outbound = openReadOnly(outboundPath);
    if (!hasTable(inbound, 'messages_in') || !hasTable(inbound, 'delivered')) {
      input.errors.push({ source: 'inbound', session: input.session, code: 'missing_required_table' });
      return false;
    }
    if (!hasTable(outbound, 'messages_out')) {
      input.errors.push({ source: 'outbound', session: input.session, code: 'missing_required_table' });
      return false;
    }
    if (
      !hasColumns(inbound, 'messages_in', ['id', 'timestamp', 'kind', 'content']) ||
      !hasColumns(inbound, 'delivered', ['message_out_id', 'status', 'platform_message_id'])
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
      if (row.kind !== 'chat' && row.kind !== 'chat-sdk') continue;
      const parsed = parseInbound(row.content);
      if (!parsed) {
        input.counters.unknownInboundMessages += 1;
        continue;
      }
      if (parsed.questionId) {
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
      }
      if (parsed.knownBot || !parsed.text) continue;
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
    const deliveredByOutboundId = new Map(
      (
        inbound.prepare('SELECT message_out_id, status, platform_message_id FROM delivered').all() as DeliveredRow[]
      ).map((row) => [row.message_out_id, row]),
    );
    for (const row of outboundRows) {
      const delivery = deliveredByOutboundId.get(row.id);
      if (!isIsoInWindow(row.timestamp, input.since, input.until) || delivery?.status !== 'delivered') continue;
      if (row.kind === 'status') {
        if (delivery.platform_message_id !== null) input.counters.statusPlatformPostEvidence += 1;
        else input.counters.deliveryProcessedUnknown += 1;
        continue;
      }
      if (isAskQuestion(row.content)) {
        if (delivery.platform_message_id !== null) input.counters.platformBackedQuestionCards += 1;
        else input.counters.deliveryProcessedUnknown += 1;
        continue;
      }
      if (row.kind !== 'chat') continue;
      if (delivery.platform_message_id !== null) {
        input.counters.finalChatDeliveryEvidence += 1;
        input.counters.finalChatPlatformMessageId += 1;
      } else if (input.archiveAssistantIds.has(row.id)) {
        input.counters.finalChatDeliveryEvidence += 1;
        input.counters.finalChatAssistantArchiveId += 1;
      } else {
        input.counters.deliveryProcessedUnknown += 1;
      }
    }
    return true;
  } catch {
    input.errors.push({ source: activeSource, session: input.session, code: 'unreadable' });
    return false;
  } finally {
    outbound?.close();
    inbound?.close();
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
  const eligiblePrs = prs.filter((pr) => isStrictIsoUtc(pr.mergedAt) && isIsoInWindow(pr.mergedAt, since, until));

  // `computeWeeklyReport` owns the established 14-day end-of-week maturity
  // definition (`scripts/review-outcomes.ts:1209-1221`); this only reuses it.
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
  const archiveAssistantIds = readAssistantArchiveIds(options.archiveDb, errors);
  readCentralEvidence(options.centralDb, options.since, options.until, counters, samples, sampleLimit, errors);

  let sessionDbsRead = 0;
  for (const session of listSessionDirectories(options.sessionsRoot)) {
    if (
      scanSession({
        ...session,
        since: options.since,
        until: options.until,
        archiveAssistantIds,
        counters,
        samples,
        sampleLimit,
        errors,
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
      definitions: {
        delivered: 'non-null platform message id, or assistant archive id for final chat',
        deliveryProcessedUnknown: 'delivered-table row with no sufficient platform/archive evidence',
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
