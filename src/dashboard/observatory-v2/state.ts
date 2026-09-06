import { createHash } from 'node:crypto';
import { getDb } from '../../db/connection.js';
import type { SignalDecision, SignalPerson, SignalReviewRequest } from './types.js';

export class SignalError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function decisionId(workgroup: string, kind: string, source: string): string {
  return Buffer.from(JSON.stringify([workgroup, kind, source])).toString('base64url');
}
export function parseDecisionId(id: string): [string, string, string] {
  try {
    const p: unknown = JSON.parse(Buffer.from(id, 'base64url').toString('utf8'));
    if (
      !Array.isArray(p) ||
      p.length !== 3 ||
      p.some((v) => typeof v !== 'string' || !v) ||
      decisionId(p[0], p[1], p[2]) !== id
    )
      throw new Error();
    return p as [string, string, string];
  } catch {
    throw new SignalError(404, 'not_found');
  }
}
export interface ReviewRecord {
  snapshot?: SignalDecision;
  owner: SignalPerson | null;
  answer: string | null;
  answered_by: SignalPerson | null;
  answered_at: string | null;
  history: SignalDecision['history'];
  requests: { key: string; hash: string; version: number }[];
  dispatch: {
    key: string;
    agent_group_id: string;
    user_id: string;
    text: string;
    state: 'pending' | 'sent' | 'failed';
    error: string | null;
    session_id: string;
    thread_id: string;
  } | null;
}
export interface ReviewRow {
  id: string;
  workgroup_id: string;
  source_kind: string;
  source_id: string;
  evidence_hash: string;
  version: number;
  record: string;
  updated_at: string;
}
export function emptyRecord(): ReviewRecord {
  return { owner: null, answer: null, answered_by: null, answered_at: null, history: [], requests: [], dispatch: null };
}
export function readRecord(row: ReviewRow | undefined): ReviewRecord {
  return row ? (JSON.parse(row.record) as ReviewRecord) : emptyRecord();
}
export async function readReview(id: string): Promise<ReviewRow | undefined> {
  return getDb().get<ReviewRow>('SELECT * FROM observatory_reviews WHERE id = ?', id);
}
export function decorateReview(source: SignalDecision, row: ReviewRow | undefined): SignalDecision {
  const record = readRecord(row);
  const changed = !!row && row.evidence_hash !== source.evidence_hash;
  const ownedByOther = record.owner !== null;
  return {
    ...source,
    version: row?.version ?? 0,
    owner: record.owner,
    answer: record.answer,
    answered_by: record.answered_by,
    answered_at: record.answered_at,
    history: record.history,
    state: changed ? 'changed' : record.answer !== null ? 'answered' : 'open',
    dispatch_state: record.dispatch?.state ?? 'not_requested',
    dispatch_target_thread_id: record.dispatch?.thread_id ?? null,
    dispatch_agent_group_id: record.dispatch?.agent_group_id ?? null,
    dispatch_evidence_hash: record.dispatch ? (row?.evidence_hash ?? null) : null,
    dispatch_error: record.dispatch?.error ?? null,
    capabilities: {
      ...source.capabilities,
      claim: source.capabilities.claim && !ownedByOther,
      dispatch:
        source.capabilities.dispatch && (!changed || record.dispatch?.state === 'pending') && record.answer !== null,
    },
  };
}
/** Whole human record and history share one compare-and-set. No async transaction. */
export async function saveReview(
  source: SignalDecision,
  expectedVersion: number,
  record: ReviewRecord,
): Promise<number> {
  const nextVersion = expectedVersion + 1;
  record.snapshot = { ...source, history: [], answer: null, answered_by: null, answered_at: null, owner: null };
  const now = new Date().toISOString();
  const result = await getDb().run(
    `INSERT INTO observatory_reviews(id, workgroup_id, source_kind, source_id, evidence_hash, version, record, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ? = 0
     ON CONFLICT(id) DO NOTHING`,
    source.id,
    source.workgroup_id,
    source.source_kind,
    source.source_id,
    source.evidence_hash,
    nextVersion,
    JSON.stringify(record),
    now,
    expectedVersion,
  );
  if (result.changes) return nextVersion;
  if (expectedVersion === 0) throw new SignalError(409, 'revision_conflict');
  const update = await getDb().run(
    `UPDATE observatory_reviews SET evidence_hash = ?, version = ?, record = ?, updated_at = ?
     WHERE id = ? AND version = ?`,
    source.evidence_hash,
    nextVersion,
    JSON.stringify(record),
    now,
    source.id,
    expectedVersion,
  );
  if (!update.changes) throw new SignalError(409, 'revision_conflict');
  return nextVersion;
}
export async function applyReview(
  source: SignalDecision,
  request: SignalReviewRequest,
  actor: SignalPerson,
  globalAdmin: boolean,
): Promise<SignalDecision> {
  const row = await readReview(source.id);
  const record = readRecord(row);
  const requestHash = digest({ actor: actor.id, ...request });
  const prior = record.requests.find((r) => r.key === request.idempotency_key);
  if (prior) {
    if (prior.hash !== requestHash) throw new SignalError(409, 'idempotency_conflict');
    return decorateReview(source, row);
  }
  if (source.source_kind === 'approval') throw new SignalError(409, 'use_original_approval');
  if (request.evidence_hash !== source.evidence_hash) throw new SignalError(409, 'evidence_changed');
  if (request.expected_version !== (row?.version ?? 0)) throw new SignalError(409, 'revision_conflict');
  if (record.dispatch?.state === 'pending') throw new SignalError(409, 'delivery_pending');
  const otherOwner = record.owner && record.owner.id !== actor.id;
  if (request.action === 'release') {
    if (otherOwner && !globalAdmin) throw new SignalError(409, 'owned_by_another_reviewer');
    record.owner = null;
  } else {
    if (otherOwner) throw new SignalError(409, 'owned_by_another_reviewer');
    if (request.action === 'claim' && record.owner) throw new SignalError(409, 'already_claimed');
    record.owner = actor;
  }
  if (row && row.evidence_hash !== source.evidence_hash) {
    // History retains previous decisions; the current answer must not silently
    // become valid again when someone merely claims the changed evidence.
    record.answer = null;
    record.answered_by = null;
    record.answered_at = null;
    record.dispatch = null;
  }
  if (request.action === 'answer') {
    const text = request.text?.trim();
    if (!text || text.length > 3000) throw new SignalError(400, 'answer_must_be_1_to_3000_characters');
    record.answer = text;
    record.answered_by = actor;
    record.answered_at = new Date().toISOString();
    record.dispatch = null;
  }
  record.history.push({
    at: new Date().toISOString(),
    actor,
    action: request.action,
    note: request.action === 'answer' ? record.answer : null,
    evidence_hash: source.evidence_hash,
  });
  record.requests.push({ key: request.idempotency_key, hash: requestHash, version: request.expected_version + 1 });
  // Do not truncate history or forget idempotency keys. Bound the record and
  // return an explicit limit rather than silently allowing an old replay.
  if (JSON.stringify(record).length > 1_000_000) throw new SignalError(409, 'review_history_limit');
  await saveReview(source, request.expected_version, record);
  return decorateReview(source, await readReview(source.id));
}
