/**
 * Persistent key/value state for the container. Lives in outbound.db
 * (container-owned, already scoped per channel/thread).
 *
 * Primary use: remember each provider's opaque continuation id so the
 * agent's conversation resumes across container restarts. Keyed per
 * provider because continuations are provider-private — a Claude
 * conversation id means nothing to Codex and vice versa. Switching
 * providers is therefore lossless: each provider's last thread stays
 * on file and resumes cleanly if the user flips back.
 */
import { getOutboundDb } from './connection.js';
import { randomUUID } from 'node:crypto';

const LEGACY_KEY = 'sdk_session_id';
const STICKY_MODEL_KEY = 'sticky_model';
const STICKY_EFFORT_KEY = 'sticky_effort';
const STICKY_ULTRACODE_KEY = 'sticky_ultracode';
const STICKY_FAST_KEY = 'sticky_fast';
const REPOSITORY_MOUNT_BARRIER_ACK_KEY = 'repository_mount_barrier_ack';

function continuationKey(providerName: string): string {
  return `continuation:${providerName.toLowerCase()}`;
}

function memoryContextEpochKey(providerName: string): string {
  return `memory_context_epoch:${providerName.toLowerCase()}`;
}

function getValue(key: string): string | undefined {
  const row = getOutboundDb().prepare('SELECT value FROM session_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function setValue(key: string, value: string): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, value, new Date().toISOString());
}

function deleteValue(key: string): void {
  getOutboundDb().prepare('DELETE FROM session_state WHERE key = ?').run(key);
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

/**
 * One-time migration of the pre-per-provider continuation row.
 *
 * Before this was keyed per provider, continuations lived under the
 * single key `sdk_session_id`. On container start, if that legacy row
 * exists and the current provider has no continuation of its own, adopt
 * the legacy value into the current provider's slot (best-guess — the
 * legacy row was written by whatever provider ran last). The legacy row
 * is always deleted so future provider flips never re-read a stale id
 * through the wrong lens.
 *
 * Returns the continuation the caller should use at startup (either the
 * current provider's existing value, the adopted legacy value, or
 * undefined).
 */
export function migrateLegacyContinuation(providerName: string): string | undefined {
  const legacy = getValue(LEGACY_KEY);
  const currentKey = continuationKey(providerName);
  const current = getValue(currentKey);

  if (legacy === undefined) return current;

  // Always drop the legacy row so no future provider reads it.
  deleteValue(LEGACY_KEY);

  // Prefer the current provider's own slot if one already exists.
  if (current !== undefined) return current;

  setValue(currentKey, legacy);
  return legacy;
}

export function getContinuation(providerName: string): string | undefined {
  return getValue(continuationKey(providerName));
}

export function setContinuation(providerName: string, id: string): void {
  setValue(continuationKey(providerName), id);
}

export function clearContinuation(providerName: string): void {
  deleteValue(continuationKey(providerName));
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

/**
 * The a2a reply stamp: the id of the first inbound message in the batch the
 * agent is currently processing. The poll loop publishes it at batch start;
 * MCP tools (`send_message`, `send_file`) read it and stamp it onto outbound
 * rows so the host's a2a return-path routing can correlate replies back to
 * the originating session.
 *
 * This lives in outbound.db rather than module state because the MCP server
 * runs as a separate stdio subprocess from the poll loop — module state set
 * by the poll loop is invisible to it. Both processes open outbound.db
 * (journal_mode=DELETE + busy_timeout make intra-container access safe).
 */
const IN_REPLY_TO_KEY = 'current_in_reply_to';

/**
 * Ignore a stamp older than this. The poll loop clears the stamp in a
 * finally, but a container killed mid-batch (SIGKILL) can leave one behind;
 * the guard stops a later out-of-batch read from picking up a dead stamp.
 * Generous so a long-running batch's late sends still stamp correctly.
 */
const IN_REPLY_TO_MAX_AGE_MS = 30 * 60 * 1000;

export function setCurrentInReplyTo(id: string | null): void {
  if (id === null) {
    clearCurrentInReplyTo();
    return;
  }
  setValue(IN_REPLY_TO_KEY, id);
}

export function clearCurrentInReplyTo(): void {
  deleteValue(IN_REPLY_TO_KEY);
}

export function getCurrentInReplyTo(): string | null {
  const row = getOutboundDb()
    .prepare('SELECT value, updated_at FROM session_state WHERE key = ?')
    .get(IN_REPLY_TO_KEY) as { value: string; updated_at: string } | undefined;
  if (!row) return null;
  const age = Date.now() - new Date(row.updated_at).getTime();
  if (!Number.isFinite(age) || age > IN_REPLY_TO_MAX_AGE_MS) return null;
  return row.value;
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
  const row = getOutboundDb()
    .prepare('SELECT value, updated_at FROM session_state WHERE key = ?')
    .get(INFRA_WARNING_KEY) as { value: string; updated_at: string } | undefined;
  if (row && row.value === text) {
    const age = Date.now() - new Date(row.updated_at).getTime();
    if (Number.isFinite(age) && age < INFRA_WARNING_COOLDOWN_MS) return false;
  }
  setValue(INFRA_WARNING_KEY, text);
  return true;
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
