/** Fork-only session_state ops over upstream's state ops. Multi-key read-modify-write takes the outbound handle for a transaction (MailboxOperations has no transaction seam). */
import { randomUUID } from 'node:crypto';

import { getOutboundDb } from '../../mailbox/sqlite/connection.js';
import { sqliteDeleteState, sqliteGetState, sqliteSetState } from '../../mailbox/sqlite/operations.js';
import { isAdmissibleOutcomeRequestSource } from '../../outcome-reporting-schema.js';

const STICKY_MODEL_KEY = 'sticky_model';
const STICKY_EFFORT_KEY = 'sticky_effort';
const STICKY_ULTRACODE_KEY = 'sticky_ultracode';
const STICKY_FAST_KEY = 'sticky_fast';
const REPOSITORY_MOUNT_BARRIER_ACK_KEY = 'repository_mount_barrier_ack';

function memoryContextEpochKey(providerName: string): string {
  return `memory_context_epoch:${providerName.toLowerCase()}`;
}

// `:numbered` retires every slot an earlier usage-based pick persisted under
// the bare key, so each session restarts at slot 1 once instead of resuming a
// usage-chosen slot. Orphaned rows are never read.
function credentialSlotKey(providerName: string): string {
  return `credential_slot:${providerName.toLowerCase()}:numbered`;
}

/**
 * The active OAuth ring slot, persisted so a respawn doesn't restart at the primary and burn a rejected turn.
 * Stores the env var NAME, never the credential. Only Claude's circular OAuth ring writes it: the forward-only
 * API-key pool relies on a respawn as its reset, and Codex keeps its slot in CODEX_HOME.
 */
export function getCredentialSlot(providerName: string): string | undefined {
  return getValue(credentialSlotKey(providerName));
}

export function setCredentialSlot(providerName: string, slot: string): void {
  setValue(credentialSlotKey(providerName), slot);
}

function getValue(key: string): string | undefined {
  return sqliteGetState(key)?.value;
}

function setValue(key: string, value: string): void {
  sqliteSetState(key, value);
}

function deleteValue(key: string): void {
  sqliteDeleteState(key);
}

/** The host waits for this exact epoch, so a stale ack from an earlier publication never authorizes a later mount transition. */
export function acknowledgeRepositoryMountBarrier(epoch: string): void {
  if (!epoch) throw new Error('repository mount barrier epoch must not be empty');
  setValue(REPOSITORY_MOUNT_BARRIER_ACK_KEY, epoch);
}

/** The token this session last acknowledged — lets the gate skip a duplicate write. */
export function getRepositoryMountBarrierAck(): string | null {
  return getValue(REPOSITORY_MOUNT_BARRIER_ACK_KEY) ?? null;
}

/**
 * Monotonic provider-context identity used by host-side recall deduplication.
 * This reuses session_state rather than introducing a second lifecycle store.
 */
export function getMemoryContextEpoch(providerName: string): number {
  const parsed = Number.parseInt(getValue(memoryContextEpochKey(providerName)) ?? '0', 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function advanceMemoryContextEpoch(providerName: string): number {
  // Transaction: read-then-write of the same key must not interleave with a
  // sibling MCP subprocess doing the same.
  return getOutboundDb().transaction(() => {
    const current = getMemoryContextEpoch(providerName);
    const next = current >= Number.MAX_SAFE_INTEGER ? 0 : current + 1;
    setValue(memoryContextEpochKey(providerName), String(next));
    return next;
  })();
}

/** Session-sticky `-m`/`-e` overrides (cleared by `-m ''`/`-e ''`); survive `/clear` and container restart. */
export function getStickyModel(): string | undefined {
  return getValue(STICKY_MODEL_KEY);
}

export function setStickyModel(model: string): void {
  setValue(STICKY_MODEL_KEY, model);
}

export function clearStickyModel(): void {
  deleteValue(STICKY_MODEL_KEY);
}

export function getStickyEffort(): string | undefined {
  return getValue(STICKY_EFFORT_KEY);
}

export function setStickyEffort(effort: string): void {
  setValue(STICKY_EFFORT_KEY, effort);
}

export function clearStickyEffort(): void {
  deleteValue(STICKY_EFFORT_KEY);
}

/** Stored '1'/'0' so an explicit normal `-e` persists the off-state; undefined when never set. Claude-only. */
export function getStickyUltracode(): boolean | undefined {
  const v = getValue(STICKY_ULTRACODE_KEY);
  if (v === undefined) return undefined;
  return v === '1';
}

export function setStickyUltracode(on: boolean): void {
  setValue(STICKY_ULTRACODE_KEY, on ? '1' : '0');
}

export function clearStickyUltracode(): void {
  deleteValue(STICKY_ULTRACODE_KEY);
}

/** Codex fast service-tier override (`-f on|off`). */
export function getStickyFast(): boolean | undefined {
  const v = getValue(STICKY_FAST_KEY);
  if (v === undefined) return undefined;
  return v === '1';
}

export function setStickyFast(on: boolean): void {
  setValue(STICKY_FAST_KEY, on ? '1' : '0');
}

const WORK_CONTINUATION_KEY = 'work_continuation';
const LEGACY_PENDING_NEXT_KEY = 'pending_next';

export const WORK_CONTINUATION_CHAIN_MAX = 50;
export const WORK_CONTINUATION_TASK_MAX_CHARS = 500;
export const WORK_CONTINUATION_RESUME_MAX_ATTEMPTS = 2;

export interface WorkContinuation {
  id: string;
  task: string;
  /** Inbound row that supplied the exact reply route for restart recovery. */
  source_message_id?: string;
  phase: 'queued' | 'running';
  chain: number;
  runner_id?: string;
  resume_attempts: number;
  recovery_episode: number;
}

export type QueueWorkContinuationResult =
  | { accepted: true; continuation: WorkContinuation }
  | { accepted: false; reason: 'chain-cap'; chain: number };

function parseWorkContinuation(raw: string): WorkContinuation | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<WorkContinuation>;
    if (typeof parsed.id !== 'string' || parsed.id.trim() === '') return undefined;
    if (
      typeof parsed.task !== 'string' ||
      parsed.task.trim() === '' ||
      parsed.task.length > WORK_CONTINUATION_TASK_MAX_CHARS
    ) {
      return undefined;
    }
    if (parsed.phase !== 'queued' && parsed.phase !== 'running') return undefined;
    if (!Number.isSafeInteger(parsed.chain) || (parsed.chain ?? -1) < 0) return undefined;
    if (!Number.isSafeInteger(parsed.resume_attempts) || (parsed.resume_attempts ?? -1) < 0) return undefined;
    if (
      parsed.recovery_episode !== undefined &&
      (!Number.isSafeInteger(parsed.recovery_episode) || parsed.recovery_episode < 0)
    ) {
      return undefined;
    }
    if (parsed.runner_id !== undefined && (typeof parsed.runner_id !== 'string' || parsed.runner_id === '')) {
      return undefined;
    }
    const sourceMessageId =
      typeof parsed.source_message_id === 'string' &&
      parsed.source_message_id.length > 0 &&
      parsed.source_message_id.length <= 1024
        ? parsed.source_message_id
        : undefined;
    return {
      id: parsed.id,
      task: parsed.task.trim(),
      ...(sourceMessageId ? { source_message_id: sourceMessageId } : {}),
      phase: parsed.phase,
      chain: parsed.chain as number,
      ...(parsed.runner_id ? { runner_id: parsed.runner_id } : {}),
      resume_attempts: parsed.resume_attempts as number,
      recovery_episode: parsed.recovery_episode ?? 0,
    };
  } catch {
    return undefined;
  }
}

function migrateLegacyPendingNext(): WorkContinuation | undefined {
  const raw = getValue(LEGACY_PENDING_NEXT_KEY);
  if (raw === undefined) return undefined;
  deleteValue(LEGACY_PENDING_NEXT_KEY);
  try {
    const parsed = JSON.parse(raw) as { task?: unknown; chain?: unknown };
    const task = typeof parsed.task === 'string' ? parsed.task.trim() : '';
    if (!task || task.length > WORK_CONTINUATION_TASK_MAX_CHARS) return undefined;
    const chain = Number.isSafeInteger(parsed.chain) && (parsed.chain as number) >= 0 ? (parsed.chain as number) : 0;
    const migrated: WorkContinuation = {
      id: `legacy-${randomUUID()}`,
      task,
      phase: 'queued',
      chain,
      resume_attempts: 0,
      recovery_episode: 0,
    };
    setValue(WORK_CONTINUATION_KEY, JSON.stringify(migrated));
    return migrated;
  } catch {
    return undefined;
  }
}

export function getWorkContinuation(): WorkContinuation | undefined {
  const raw = getValue(WORK_CONTINUATION_KEY);
  if (raw !== undefined) {
    const parsed = parseWorkContinuation(raw);
    if (parsed) return parsed;
    deleteValue(WORK_CONTINUATION_KEY);
  }
  return migrateLegacyPendingNext();
}

export function queueWorkContinuation(task: string, sourceMessageId?: string | null): QueueWorkContinuationResult {
  const normalized = task.trim();
  const normalizedSourceMessageId =
    typeof sourceMessageId === 'string' && sourceMessageId.length > 0 && sourceMessageId.length <= 1024
      ? sourceMessageId
      : undefined;
  const current = getWorkContinuation();
  const chain = (current?.chain ?? 0) + 1;
  if (chain > WORK_CONTINUATION_CHAIN_MAX) return { accepted: false, reason: 'chain-cap', chain };
  const continuation: WorkContinuation = {
    id: randomUUID(),
    task: normalized,
    ...(normalizedSourceMessageId ? { source_message_id: normalizedSourceMessageId } : {}),
    phase: 'queued',
    chain,
    resume_attempts: 0,
    recovery_episode: 0,
  };
  setValue(WORK_CONTINUATION_KEY, JSON.stringify(continuation));
  // Taking on more work retracts any standing done proposal: the newer statement must win.
  clearDoneProposal();
  return { accepted: true, continuation };
}

export function isWorkContinuationRunnable(continuation: WorkContinuation, _runnerId: string): boolean {
  // A runner's claim persists across pauses/crashes; a fresh runner may proceed only after the host counts a
  // recovery attempt (or real inbound re-arms the work), so scheduled wakes can't bypass the recovery cap.
  return continuation.phase === 'queued' && continuation.runner_id === undefined;
}

export function markWorkContinuationRunning(id: string, runnerId: string): WorkContinuation | undefined {
  return getOutboundDb().transaction(() => {
    const current = getWorkContinuation();
    if (!current || current.id !== id || !isWorkContinuationRunnable(current, runnerId)) return undefined;
    const running: WorkContinuation = { ...current, phase: 'running', runner_id: runnerId };
    setValue(WORK_CONTINUATION_KEY, JSON.stringify(running));
    return running;
  })();
}

export function requeueWorkContinuationIfMatches(id: string, runnerId: string): boolean {
  return getOutboundDb().transaction(() => {
    const current = getWorkContinuation();
    if (!current || current.id !== id || current.phase !== 'running' || current.runner_id !== runnerId) return false;
    const queued: WorkContinuation = { ...current, phase: 'queued' };
    // Keep runner_id even below the cap: only the host (after counting an attempt) or real inbound clears it.
    setValue(WORK_CONTINUATION_KEY, JSON.stringify(queued));
    return true;
  })();
}

export function clearWorkContinuationIfMatches(id: string): boolean {
  return getOutboundDb().transaction(() => {
    const current = getWorkContinuation();
    if (!current || current.id !== id) return false;
    deleteValue(WORK_CONTINUATION_KEY);
    return true;
  })();
}

export function cancelWorkContinuation(): boolean {
  const existed = getValue(WORK_CONTINUATION_KEY) !== undefined || getValue(LEGACY_PENDING_NEXT_KEY) !== undefined;
  deleteValue(WORK_CONTINUATION_KEY);
  deleteValue(LEGACY_PENDING_NEXT_KEY);
  return existed;
}

const INFRA_WARNING_KEY = 'last_infra_warning';

export const INFRA_WARNING_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h

/** Dedupe identical infra warning text within the cooldown; tracks only the last posted text. Callers must still log unconditionally. */
export function shouldPostInfraWarning(text: string): boolean {
  const row = sqliteGetState(INFRA_WARNING_KEY);
  if (row && row.value === text) {
    const age = Date.now() - new Date(row.updatedAt).getTime();
    if (Number.isFinite(age) && age < INFRA_WARNING_COOLDOWN_MS) return false;
  }
  setValue(INFRA_WARNING_KEY, text);
  return true;
}

const PRIMARY_RETRY_REQUEST_KEY = 'primary_retry_requested_at';

/**
 * A LOOP BRAKE: each request respawns the session; if the primary is still spent it lands back on the fallback
 * with the same pending message, which asks again, and the request resets the backoff streak. 30 min is sized
 * against that ~1-2 min cycle.
 */
const PRIMARY_RETRY_REQUEST_COOLDOWN_MS = 30 * 60 * 1000;

/** At most once per cooldown. Stored in session_state because the respawn the request causes would reset an in-memory guard. */
export function claimPrimaryRetryRequest(nowMs = Date.now()): boolean {
  const previous = sqliteGetState(PRIMARY_RETRY_REQUEST_KEY);
  if (previous) {
    const age = nowMs - Date.parse(previous.value);
    // An unparseable stamp is treated as expired, not as a live claim: failing
    // toward one extra request is safer than a session that can never ask.
    if (Number.isFinite(age) && age >= 0 && age < PRIMARY_RETRY_REQUEST_COOLDOWN_MS) return false;
  }
  setValue(PRIMARY_RETRY_REQUEST_KEY, new Date(nowMs).toISOString());
  return true;
}

/** Called when a turn completes on the primary, so a later park can ask again. */
export function clearPrimaryRetryRequest(): void {
  // Read first: this runs every turn, and a session that never asked must not DELETE per turn.
  if (sqliteGetState(PRIMARY_RETRY_REQUEST_KEY) === undefined) return;
  deleteValue(PRIMARY_RETRY_REQUEST_KEY);
}

const DONE_PROPOSAL_KEY = 'done_proposal';

export const DONE_PROPOSAL_REASON_MAX_CHARS = 500;

/**
 * The agent's "this thread is finished" record. Proposing is NOT closing: nothing in the runner reads it; the
 * host surfaces it and an operator decides. The timestamp lives in the record because the host compares it
 * to its wrap-up request; it must not ride on `session_state.updated_at`.
 */
export interface DoneProposal {
  reason: string;
  /** ISO-8601 UTC, always — CLAUDE.md's timestamp rule. */
  proposed_at: string;
}

export function getDoneProposal(): DoneProposal | undefined {
  const raw = getValue(DONE_PROPOSAL_KEY);
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<DoneProposal>;
    if (typeof parsed.reason !== 'string' || parsed.reason.trim() === '') return undefined;
    if (parsed.reason.length > DONE_PROPOSAL_REASON_MAX_CHARS) return undefined;
    if (typeof parsed.proposed_at !== 'string' || Number.isNaN(Date.parse(parsed.proposed_at))) return undefined;
    return { reason: parsed.reason.trim(), proposed_at: parsed.proposed_at };
  } catch {
    return undefined;
  }
}

export function proposeDone(reason: string): DoneProposal {
  const proposal: DoneProposal = { reason: reason.trim(), proposed_at: new Date().toISOString() };
  setValue(DONE_PROPOSAL_KEY, JSON.stringify(proposal));
  return proposal;
}

/** Dropped when the agent takes on more work or real user input arrives: a stale proposal would offer a close over restarted work. */
export function clearDoneProposal(): boolean {
  const existed = getValue(DONE_PROPOSAL_KEY) !== undefined;
  deleteValue(DONE_PROPOSAL_KEY);
  return existed;
}

export function resetWorkContinuationForRealInbound(): WorkContinuation | undefined {
  return getOutboundDb().transaction(() => {
    const current = getWorkContinuation();
    if (!current) return undefined;
    const reset: WorkContinuation = {
      ...current,
      phase: 'queued',
      chain: 0,
      resume_attempts: 0,
      recovery_episode: current.recovery_episode === Number.MAX_SAFE_INTEGER ? 0 : current.recovery_episode + 1,
    };
    delete reset.runner_id;
    setValue(WORK_CONTINUATION_KEY, JSON.stringify(reset));
    return reset;
  })();
}

export interface RequestCandidate {
  sequence: number;
  messageId: string;
}

const REQUEST_CANDIDATES_KEY = 'request_candidates';
const MAX_REQUEST_CANDIDATES = 32;

/** Retain trusted original inbound identities across retries and clarification turns. */
export function rememberRequestCandidates(
  messages: Array<{
    id: string;
    seq: number | null;
    kind: string;
    trigger: number;
    channel_type: string | null;
    content: string;
  }>,
): void {
  const previous = getRequestCandidates();
  const bySequence = new Map(previous.map((candidate) => [candidate.sequence, candidate]));
  for (const message of messages) {
    let eligible = message.kind === 'task';
    if ((message.kind === 'chat' || message.kind === 'chat-sdk') && message.channel_type !== 'agent') {
      try {
        eligible = isAdmissibleOutcomeRequestSource(message.kind, JSON.parse(message.content));
      } catch {
        eligible = false;
      }
    }
    if (message.trigger === 1 && Number.isSafeInteger(message.seq) && (message.seq as number) > 0 && eligible) {
      bySequence.set(message.seq as number, { sequence: message.seq as number, messageId: message.id });
    }
  }
  const candidates = [...bySequence.values()].sort((a, b) => a.sequence - b.sequence).slice(-MAX_REQUEST_CANDIDATES);
  if (candidates.length > 0) setValue(REQUEST_CANDIDATES_KEY, JSON.stringify(candidates));
}

export function getRequestCandidates(): RequestCandidate[] {
  const raw = getValue(REQUEST_CANDIDATES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (value): value is RequestCandidate =>
        !!value &&
        typeof value === 'object' &&
        Number.isSafeInteger((value as RequestCandidate).sequence) &&
        (value as RequestCandidate).sequence > 0 &&
        typeof (value as RequestCandidate).messageId === 'string' &&
        (value as RequestCandidate).messageId.length > 0,
    );
  } catch {
    return [];
  }
}

export function resolveRequestCandidate(sequence: unknown): RequestCandidate {
  const candidates = getRequestCandidates();
  if (sequence === undefined && candidates.length === 1) return candidates[0];
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1)
    throw new Error(
      candidates.length > 1
        ? 'requestId is required when several original requests are available'
        : 'No admissible original request is available',
    );
  const candidate = candidates.find((value) => value.sequence === sequence);
  if (!candidate) throw new Error('requestId is not an admissible original request for this session');
  return candidate;
}

const LIFECYCLE_STATUS_KEY = 'current_lifecycle_status';

export function setCurrentLifecycleStatus(id: string): void {
  setValue(LIFECYCLE_STATUS_KEY, id);
}

export function getCurrentLifecycleStatus(): string | null {
  return getValue(LIFECYCLE_STATUS_KEY) ?? null;
}

export function clearCurrentLifecycleStatus(): void {
  deleteValue(LIFECYCLE_STATUS_KEY);
}
