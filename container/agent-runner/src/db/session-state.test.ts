import { beforeEach, describe, expect, test } from 'bun:test';

import { getOutboundDb, initTestSessionDb } from './connection.js';
import {
  WORK_CONTINUATION_RESUME_MAX_ATTEMPTS,
  advanceMemoryContextEpoch,
  clearContinuation,
  getContinuation,
  getMemoryContextEpoch,
  getWorkContinuation,
  isWorkContinuationRunnable,
  markWorkContinuationRunning,
  getStickyFast,
  migrateLegacyContinuation,
  queueWorkContinuation,
  requeueWorkContinuationIfMatches,
  resetWorkContinuationForRealInbound,
  clearWorkContinuationIfMatches,
  cancelWorkContinuation,
  setContinuation,
  setStickyFast,
} from './session-state.js';

beforeEach(() => {
  initTestSessionDb();
});

function seedLegacy(value: string): void {
  getOutboundDb()
    .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('sdk_session_id', value, new Date().toISOString());
}

describe('session-state — per-provider continuations', () => {
  test('set/get round-trip, case-insensitive provider key', () => {
    setContinuation('claude', 'claude-conv-1');
    expect(getContinuation('claude')).toBe('claude-conv-1');
    expect(getContinuation('Claude')).toBe('claude-conv-1');
    expect(getContinuation('CLAUDE')).toBe('claude-conv-1');
  });

  test('providers are isolated — switching reads the right slot', () => {
    setContinuation('claude', 'claude-conv-1');
    setContinuation('codex', 'codex-thread-xyz');

    expect(getContinuation('claude')).toBe('claude-conv-1');
    expect(getContinuation('codex')).toBe('codex-thread-xyz');
  });

  test('clearContinuation only affects the specified provider', () => {
    setContinuation('claude', 'keep-me');
    setContinuation('codex', 'drop-me');

    clearContinuation('codex');

    expect(getContinuation('claude')).toBe('keep-me');
    expect(getContinuation('codex')).toBeUndefined();
  });

  test('unknown provider returns undefined', () => {
    expect(getContinuation('never-used')).toBeUndefined();
  });
});

describe('session-state — provider memory context epochs', () => {
  test('defaults to zero and advances monotonically per provider', () => {
    expect(getMemoryContextEpoch('claude')).toBe(0);
    expect(advanceMemoryContextEpoch('claude')).toBe(1);
    expect(advanceMemoryContextEpoch('Claude')).toBe(2);
    expect(getMemoryContextEpoch('claude')).toBe(2);
  });

  test('provider epochs remain isolated', () => {
    advanceMemoryContextEpoch('claude');
    advanceMemoryContextEpoch('codex');
    advanceMemoryContextEpoch('codex');

    expect(getMemoryContextEpoch('claude')).toBe(1);
    expect(getMemoryContextEpoch('codex')).toBe(2);
    expect(getMemoryContextEpoch('opencode')).toBe(0);
  });
});

describe('session-state — legacy migration', () => {
  test('adopts legacy value into current provider when current is empty', () => {
    seedLegacy('old-session-id');

    const adopted = migrateLegacyContinuation('claude');

    expect(adopted).toBe('old-session-id');
    expect(getContinuation('claude')).toBe('old-session-id');
  });

  test('always deletes legacy row regardless of migration outcome', () => {
    seedLegacy('old-session-id');
    setContinuation('claude', 'existing');

    migrateLegacyContinuation('claude');

    // After migration the legacy key must be gone, whether or not it was adopted.
    // A subsequent migration for a different provider must not see it.
    const resultAfterSecondCall = migrateLegacyContinuation('codex');
    expect(resultAfterSecondCall).toBeUndefined();
  });

  test('prefers existing current-provider slot over legacy', () => {
    seedLegacy('legacy-value');
    setContinuation('claude', 'claude-value');

    const result = migrateLegacyContinuation('claude');

    expect(result).toBe('claude-value');
    expect(getContinuation('claude')).toBe('claude-value');
  });

  test('no legacy row — returns current provider value (possibly undefined)', () => {
    expect(migrateLegacyContinuation('claude')).toBeUndefined();

    setContinuation('codex', 'codex-value');
    expect(migrateLegacyContinuation('codex')).toBe('codex-value');
  });

  test('migration is idempotent on a second call (legacy already gone)', () => {
    seedLegacy('once');

    const first = migrateLegacyContinuation('claude');
    expect(first).toBe('once');

    const second = migrateLegacyContinuation('claude');
    expect(second).toBe('once');
  });
});

describe('session-state — sticky fast mode', () => {
  test('round-trips both on and off states', () => {
    expect(getStickyFast()).toBeUndefined();
    setStickyFast(true);
    expect(getStickyFast()).toBe(true);
    setStickyFast(false);
    expect(getStickyFast()).toBe(false);
  });
});

describe('session-state — durable work continuation', () => {
  test('queues, marks running, and compare-clears only the matching id', () => {
    const first = queueWorkContinuation('write the migration tests', 'origin-message');
    expect(first.accepted).toBe(true);
    if (!first.accepted) throw new Error('expected accepted continuation');

    const running = markWorkContinuationRunning(first.continuation.id, 'runner-a');
    expect(running?.phase).toBe('running');
    expect(running?.runner_id).toBe('runner-a');
    expect(running?.source_message_id).toBe('origin-message');
    expect(clearWorkContinuationIfMatches('stale-id')).toBe(false);
    expect(getWorkContinuation()?.id).toBe(first.continuation.id);
    expect(clearWorkContinuationIfMatches(first.continuation.id)).toBe(true);
    expect(getWorkContinuation()).toBeUndefined();
  });

  test('replacement survives stale completion and increments the chain', () => {
    const first = queueWorkContinuation('step one');
    if (!first.accepted) throw new Error('expected accepted continuation');
    markWorkContinuationRunning(first.continuation.id, 'runner-a');
    const replacement = queueWorkContinuation('step two');
    if (!replacement.accepted) throw new Error('expected replacement');

    expect(replacement.continuation.chain).toBe(2);
    expect(clearWorkContinuationIfMatches(first.continuation.id)).toBe(false);
    expect(getWorkContinuation()?.task).toBe('step two');
  });

  test('real inbound resets counters without deleting work', () => {
    const queued = queueWorkContinuation('keep going');
    if (!queued.accepted) throw new Error('expected continuation');
    const db = getOutboundDb();
    const row = getWorkContinuation();
    if (!row) throw new Error('expected stored row');
    db.prepare("UPDATE session_state SET value = ? WHERE key = 'work_continuation'").run(
      JSON.stringify({ ...row, chain: 17, resume_attempts: 2 }),
    );

    resetWorkContinuationForRealInbound();
    expect(getWorkContinuation()).toMatchObject({
      task: 'keep going',
      chain: 0,
      resume_attempts: 0,
      recovery_episode: 1,
    });

    resetWorkContinuationForRealInbound();
    expect(getWorkContinuation()?.recovery_episode).toBe(2);
  });

  test('same runner cannot re-inject running work; a fresh runner can', () => {
    const queued = queueWorkContinuation('resume safely');
    if (!queued.accepted) throw new Error('expected continuation');
    const running = markWorkContinuationRunning(queued.continuation.id, 'runner-a');
    expect(running).toBeDefined();
    expect(isWorkContinuationRunnable(running!, 'runner-a')).toBe(false);
    expect(isWorkContinuationRunnable(running!, 'runner-b')).toBe(true);
    expect(requeueWorkContinuationIfMatches(queued.continuation.id, 'runner-b')).toBe(false);
    expect(requeueWorkContinuationIfMatches(queued.continuation.id, 'runner-a')).toBe(true);
    expect(getWorkContinuation()).toMatchObject({ phase: 'queued' });
  });

  test('a capped attempt stays parked across unrelated runner wakes until real inbound', () => {
    const queued = queueWorkContinuation('resume only after user input');
    if (!queued.accepted) throw new Error('expected continuation');
    const db = getOutboundDb();
    db.prepare("UPDATE session_state SET value = ? WHERE key = 'work_continuation'").run(
      JSON.stringify({
        ...queued.continuation,
        resume_attempts: WORK_CONTINUATION_RESUME_MAX_ATTEMPTS,
      }),
    );

    // No runner_id means the host-authorized final attempt has not started.
    const finalAttempt = markWorkContinuationRunning(queued.continuation.id, 'runner-a');
    expect(finalAttempt).toBeDefined();
    expect(isWorkContinuationRunnable(finalAttempt!, 'runner-b')).toBe(false);

    expect(requeueWorkContinuationIfMatches(queued.continuation.id, 'runner-a')).toBe(true);
    const parked = getWorkContinuation();
    expect(parked).toMatchObject({ phase: 'queued', runner_id: 'runner-a' });
    expect(isWorkContinuationRunnable(parked!, 'runner-b')).toBe(false);
    expect(markWorkContinuationRunning(queued.continuation.id, 'runner-b')).toBeUndefined();

    const reset = resetWorkContinuationForRealInbound();
    expect(reset).toMatchObject({ resume_attempts: 0, phase: 'queued', runner_id: 'runner-a' });
    expect(isWorkContinuationRunnable(reset!, 'runner-b')).toBe(true);
  });

  test('migrates valid pending_next once and deletes malformed legacy state', () => {
    const db = getOutboundDb();
    db.prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      'pending_next',
      JSON.stringify({ task: 'legacy task', chain: 4 }),
      new Date().toISOString(),
    );
    expect(getWorkContinuation()).toMatchObject({ task: 'legacy task', phase: 'queued', chain: 4 });
    expect(db.prepare("SELECT 1 FROM session_state WHERE key = 'pending_next'").get()).toBeNull();

    cancelWorkContinuation();
    db.prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      'pending_next',
      'not-json',
      new Date().toISOString(),
    );
    expect(getWorkContinuation()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM session_state WHERE key = 'pending_next'").get()).toBeNull();
  });

  test('cancel is idempotent', () => {
    queueWorkContinuation('cancel me');
    expect(cancelWorkContinuation()).toBe(true);
    expect(cancelWorkContinuation()).toBe(false);
  });
});
