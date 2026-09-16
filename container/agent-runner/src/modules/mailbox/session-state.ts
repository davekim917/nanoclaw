/**
 * Fork-only persistent state in outbound.db's `session_state`.
 *
 * Moved verbatim from db/session-state.ts, which is now upstream's thin compat
 * shim (continuation + in-reply-to only). Every operation here is expressed
 * over upstream's state ops so exactly one implementation of the underlying
 * SQL exists. The handful that need a transaction across keys take the
 * outbound handle from upstream's connection module — read-modify-write of a
 * single JSON row has to be atomic, and MailboxOperations exposes no
 * transaction seam.
 */
import { randomUUID } from 'node:crypto';

import { getOutboundDb } from '../../mailbox/sqlite/connection.js';
import { sqliteDeleteState, sqliteGetState, sqliteSetState } from '../../mailbox/sqlite/operations.js';

const STICKY_MODEL_KEY = 'sticky_model';
const STICKY_EFFORT_KEY = 'sticky_effort';
const STICKY_ULTRACODE_KEY = 'sticky_ultracode';
const STICKY_FAST_KEY = 'sticky_fast';
const REPOSITORY_MOUNT_BARRIER_ACK_KEY = 'repository_mount_barrier_ack';

function memoryContextEpochKey(providerName: string): string {
  return `memory_context_epoch:${providerName.toLowerCase()}`;
}

// `:numbered` retires every slot the usage-based pick (#811/#821) persisted
// under the bare key, so each session restarts at slot 1 once instead of
// resuming a usage-chosen slot (#849, operator 2026-09-16). Orphaned rows are
// never read.
function credentialSlotKey(providerName: string): string {
  return `credential_slot:${providerName.toLowerCase()}:numbered`;
}

/**
 * The active OAuth ring slot, persisted so it survives a container respawn.
 * Rotation position otherwise lives only in provider instance state
 * (`oauthRingPos`) and resets to the primary on every fresh container — a
 * fleet that respawns constantly then burns a rejected turn and a replay on
 * every spawn before landing back on the credential that's actually healthy.
 *
 * Claude's circular `CLAUDE_CODE_OAUTH_TOKEN` ring is the ONLY writer: it
 * stores the env var NAME (e.g. `CLAUDE_CODE_OAUTH_TOKEN_2`), never the
 * credential VALUE — a pointer into config the provider already holds, not a
 * secret. Forward-only pools deliberately do not use this key: Claude's
 * `ANTHROPIC_API_KEY_N` fallbacks (providers/claude.ts:2199, the comment in
 * `restorePersistedCredentialSlot`) and Codex's `fallbackHomes` cursor
 * (providers/codex.ts:1107-1123, `nextFallback` is process-local) both rely
 * on a respawn as their reset, and a persisted cursor that never wraps would
 * turn a recoverable dead end into a permanent one.
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

/**
 * Acknowledge that the poll loop reached an admission boundary while the
 * host-owned repository ingress fence was active. The host waits for this
 * exact epoch before stopping the container, so a stale acknowledgement from
 * an earlier publication can never authorize a later mount transition.
 */
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

/**
 * Session-sticky model/effort overrides. Set by `-m <model>` and
 * `-e <level>` flags on an inbound message; cleared by explicit
 * `-m ''` / `-e ''`. Survives `/clear`, which resets only the provider
 * continuation and intentionally keeps user-selected runtime settings.
 * Survives container restart via session_state.
 */
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

/**
 * Session-sticky ultracode flag (`-e ultracode`). Stored as '1'/'0' so an
 * explicit `-e <normal-level>` can persist the off-state. Returns undefined
 * when never set (caller falls back to no ultracode). Claude-only.
 */
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
  // Taking on more work retracts any standing close proposal — see
  // clearDoneProposal. Promising a next step and proposing done are
  // contradictory statements about the same session, and the operator acts on
  // the proposal, so the newer statement must win.
  clearDoneProposal();
  return { accepted: true, continuation };
}

export function isWorkContinuationRunnable(continuation: WorkContinuation, _runnerId: string): boolean {
  // A queued record with no owner is either fresh work from this runner or an
  // attempt explicitly authorized by the stopped-container host path. Once a
  // runner claims it, keep that claim across every pause/crash. A fresh runner
  // may proceed only after the host counts a recovery attempt (or real inbound
  // explicitly re-arms the work), so unrelated scheduled wakes cannot make the
  // continuation hitchhike around the recovery throttle/cap.
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
    // Retain runner_id even below the cap. The host owns stopped-container
    // recovery authorization and clears this claim only after counting an
    // attempt; real inbound clears it when intentionally re-arming the work.
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

/** Cooldown window for `shouldPostInfraWarning` — see that function's doc. */
export const INFRA_WARNING_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Dedupe identical infra/provider warning text (empty-response fallback,
 * retry-exhausted notices) so a flapping provider doesn't spam the channel
 * with the same notice every turn. Callers must still log unconditionally —
 * this only decides whether the text is worth posting to chat again.
 *
 * ponytail: tracks only the single most recently posted warning text + time,
 * not a per-text history. Two distinct warning types alternating within the
 * cooldown both post every time (the second overwrites the tracked slot) —
 * fine for the observed failure mode (one flapping condition repeating
 * itself verbatim); upgrade to a per-text map if overlapping warning types
 * ever need independent cooldown windows.
 */
export function shouldPostInfraWarning(text: string): boolean {
  const row = sqliteGetState(INFRA_WARNING_KEY);
  if (row && row.value === text) {
    const age = Date.now() - new Date(row.updatedAt).getTime();
    if (Number.isFinite(age) && age < INFRA_WARNING_COOLDOWN_MS) return false;
  }
  setValue(INFRA_WARNING_KEY, text);
  return true;
}

/* ─── Done proposal ────────────────────────────────────────────────────────── */

const DONE_PROPOSAL_KEY = 'done_proposal';

export const DONE_PROPOSAL_REASON_MAX_CHARS = 500;

/**
 * The agent's own "I believe this thread is finished" record.
 *
 * Stored exactly the way {@link WorkContinuation} is — one JSON row in
 * `session_state` on the container-owned outbound.db — because it is the same
 * kind of thing: a durable statement about work that has to outlive the
 * container that made it. No second store, no new table, and no outbound
 * message: proposing is not saying anything to the room.
 *
 * **Proposing is not closing.** Nothing in the runner reads this to change what
 * the agent does. The poll loop, the continuation paths and the ceiling paths
 * are all untouched by it. The host surfaces it; an operator decides.
 *
 * The timestamp is carried IN the record rather than read off
 * `session_state.updated_at`, because the host compares it against the moment
 * it asked for a wrap-up, and that comparison IS the confirmation signal — it
 * must not ride on a column any later write to this key would move.
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

/** Record (or replace) this session's close proposal. */
export function proposeDone(reason: string): DoneProposal {
  const proposal: DoneProposal = { reason: reason.trim(), proposed_at: new Date().toISOString() };
  setValue(DONE_PROPOSAL_KEY, JSON.stringify(proposal));
  return proposal;
}

/**
 * Drop the proposal. Called when the agent takes on more work
 * ({@link queueWorkContinuation}) and when real user input arrives (poll-loop's
 * `hasRealInbound` seam) — both mean "not finished after all", and a stale
 * proposal would offer the operator a one-confirmation close over work that has
 * since restarted.
 */
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
