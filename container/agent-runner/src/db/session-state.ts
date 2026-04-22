/**
 * Persistent key/value state for the container. Lives in outbound.db
 * (container-owned, already scoped per channel/thread).
 *
 * Primary use: remember the SDK session ID so the agent's conversation
 * resumes across container restarts. Cleared by /clear.
 */
import { getOutboundDb } from './connection.js';

const SDK_SESSION_KEY = 'sdk_session_id';
const STICKY_MODEL_KEY = 'sticky_model';
const STICKY_EFFORT_KEY = 'sticky_effort';

function getValue(key: string): string | undefined {
  const row = getOutboundDb()
    .prepare('SELECT value FROM session_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

function setValue(key: string, value: string): void {
  getOutboundDb()
    .prepare(
      'INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)',
    )
    .run(key, value, new Date().toISOString());
}

function deleteValue(key: string): void {
  getOutboundDb().prepare('DELETE FROM session_state WHERE key = ?').run(key);
}

export function getStoredSessionId(): string | undefined {
  return getValue(SDK_SESSION_KEY);
}

export function setStoredSessionId(sessionId: string): void {
  setValue(SDK_SESSION_KEY, sessionId);
}

export function clearStoredSessionId(): void {
  deleteValue(SDK_SESSION_KEY);
}

/**
 * Session-sticky model/effort overrides. Set by `-m1 <model>` and
 * `-e1 <level>` flags on an inbound message; cleared by explicit
 * `-m1 ''` / `-e1 ''` (or /clear which wipes the row on session reset).
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
