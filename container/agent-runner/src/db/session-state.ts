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

const LEGACY_KEY = 'sdk_session_id';
const STICKY_MODEL_KEY = 'sticky_model';
const STICKY_EFFORT_KEY = 'sticky_effort';
const STICKY_ULTRACODE_KEY = 'sticky_ultracode';
const STICKY_FAST_KEY = 'sticky_fast';

function continuationKey(providerName: string): string {
  return `continuation:${providerName.toLowerCase()}`;
}

function memoryContextEpochKey(providerName: string): string {
  return `memory_context_epoch:${providerName.toLowerCase()}`;
}

function getValue(key: string): string | undefined {
  const row = getOutboundDb()
    .prepare('SELECT value FROM session_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
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
