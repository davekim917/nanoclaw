/**
 * Tests for the verb×state availability matrix (Task A5) — the single
 * table-driven structure every host handler and the drawer's verb buttons
 * consume. Mirrors design §4.0 (AUTHORITATIVE matrix).
 *
 * TDD: written before the implementation.
 */
import { describe, it, expect } from 'vitest';

import { SWEEP_INTERVAL_MS } from './scheduled-shared.js';
import {
  GUARD_GRACE_MS,
  verbVerdict,
  availableVerbs,
  type HealthState,
  type VerbCtx,
} from './scheduled-board-matrix.js';

const NOW = 1_000_000_000_000;

function ctx(over: Partial<VerbCtx>): VerbCtx {
  return {
    state: 'healthy',
    kind: 'recurring',
    claimed: false,
    processAfterMs: NOW + 10 * 60 * 60 * 1000, // far future by default
    nowMs: NOW,
    ...over,
  };
}

describe('GUARD_GRACE_MS', () => {
  it('test_guard_grace_constant', () => {
    expect(GUARD_GRACE_MS).toBe(Math.max(2 * SWEEP_INTERVAL_MS, 120_000));
  });
  it('is distinct from a stall-grace heuristic (a fixed seconds-to-minutes margin)', () => {
    // 2 * 60_000 = 120_000; max(120000, 120000) = 120000.
    expect(GUARD_GRACE_MS).toBe(120_000);
  });
});

describe('run_now', () => {
  it('test_runnow_unknown_fails_closed', () => {
    const v = verbVerdict('run_now', ctx({ state: 'unknown' }));
    expect(v.allowed).toBe(false);
    expect(v.status).toBe(503);
    expect(v.reason).toBe('claim_state_unreadable');
  });

  it('test_runnow_stalled_unclaimed_allowed', () => {
    const v = verbVerdict('run_now', ctx({ state: 'stalled', claimed: false, processAfterMs: NOW - 60_000 }));
    expect(v.allowed).toBe(true);
  });

  it('test_runnow_stalled_claimed_409', () => {
    const v = verbVerdict('run_now', ctx({ state: 'stalled', claimed: true, processAfterMs: NOW - 60_000 }));
    expect(v.allowed).toBe(false);
    expect(v.status).toBe(409);
    expect(v.reason).toBe('source_busy');
  });

  it('late unclaimed → allowed (the remedy)', () => {
    const v = verbVerdict('run_now', ctx({ state: 'late', claimed: false, processAfterMs: NOW - 1000 }));
    expect(v.allowed).toBe(true);
  });

  it('healthy within guard_grace of slot, not forced → needsForce', () => {
    const v = verbVerdict('run_now', ctx({ state: 'healthy', processAfterMs: NOW + 30_000 /* < guard_grace */ }));
    expect(v.allowed).toBe(false);
    expect(v.needsForce).toBe(true);
  });

  it('healthy within guard_grace of slot, forced → allowed', () => {
    const v = verbVerdict('run_now', ctx({ state: 'healthy', processAfterMs: NOW + 30_000, forced: true }));
    expect(v.allowed).toBe(true);
  });

  it('healthy far from slot → allowed without force', () => {
    const v = verbVerdict('run_now', ctx({ state: 'healthy', processAfterMs: NOW + 10 * 60_000 }));
    expect(v.allowed).toBe(true);
  });

  it('paused → not allowed', () => {
    expect(availableVerbs(ctx({ state: 'paused' }))).not.toContain('run_now');
  });

  it('processing → 409 source_busy', () => {
    const v = verbVerdict('run_now', ctx({ state: 'processing', claimed: true }));
    expect(v.allowed).toBe(false);
    expect(v.status).toBe(409);
    expect(v.reason).toBe('source_busy');
  });
});

describe('move', () => {
  it('test_move_paused_allowed', () => {
    expect(verbVerdict('move', ctx({ state: 'paused' })).allowed).toBe(true);
  });

  it('test_move_due_pending_409', () => {
    const v = verbVerdict('move', ctx({ state: 'late', processAfterMs: NOW - 1000 }));
    expect(v.allowed).toBe(false);
    expect(v.status).toBe(409);
  });

  it('healthy with slot > now + guard_grace → allowed', () => {
    const v = verbVerdict('move', ctx({ state: 'healthy', processAfterMs: NOW + GUARD_GRACE_MS + 60_000 }));
    expect(v.allowed).toBe(true);
  });

  it('healthy with slot within guard_grace → 409 (near-due double-fire risk)', () => {
    const v = verbVerdict('move', ctx({ state: 'healthy', processAfterMs: NOW + 30_000 }));
    expect(v.allowed).toBe(false);
    expect(v.status).toBe(409);
  });

  it('processing / unknown / strand → 409', () => {
    for (const state of ['processing', 'unknown', 'strand'] as HealthState[]) {
      const v = verbVerdict('move', ctx({ state, claimed: state === 'processing' }));
      expect(v.allowed).toBe(false);
      expect(v.status).toBe(409);
    }
  });

  it('test_move_thread_loop_blocked', () => {
    // Even in a state that would otherwise allow move (paused), the thread_loop
    // kind mask removes it.
    expect(availableVerbs(ctx({ state: 'paused', kind: 'thread_loop' }))).not.toContain('move');
  });

  it('one_off kind blocks move (mask), even when paused', () => {
    expect(availableVerbs(ctx({ state: 'paused', kind: 'one_off' }))).not.toContain('move');
  });
});

describe('one_off mask — edit/pause/cancel still available', () => {
  it('allows edit, pause, cancel for a one_off in a live state', () => {
    const verbs = availableVerbs(ctx({ state: 'healthy', kind: 'one_off' }));
    expect(verbs).toContain('edit');
    expect(verbs).toContain('pause');
    expect(verbs).toContain('cancel');
    expect(verbs).not.toContain('move');
  });
});

describe('cancel', () => {
  it('test_cancel_strand_allowed', () => {
    // Strand: cancel is the supported remedy (clears terminal recurrence).
    expect(availableVerbs(ctx({ state: 'strand' }))).toContain('cancel');
  });

  it('is available in every health state', () => {
    for (const state of ['healthy', 'late', 'stalled', 'paused', 'processing', 'unknown', 'strand'] as HealthState[]) {
      const v = verbVerdict('cancel', ctx({ state, claimed: state === 'processing' }));
      expect(v.allowed).toBe(true);
    }
  });
});

describe('edit / pause / resume per state', () => {
  it('edit: processing → 409 source_busy; strand → 409 stale_key', () => {
    expect(verbVerdict('edit', ctx({ state: 'processing', claimed: true })).reason).toBe('source_busy');
    expect(verbVerdict('edit', ctx({ state: 'strand' })).reason).toBe('stale_key');
  });

  it('edit allowed in healthy/late/stalled/paused/unknown', () => {
    for (const state of ['healthy', 'late', 'stalled', 'paused', 'unknown'] as HealthState[]) {
      expect(verbVerdict('edit', ctx({ state })).allowed).toBe(true);
    }
  });

  it('pause: paused → not available; processing → 409', () => {
    expect(availableVerbs(ctx({ state: 'paused' }))).not.toContain('pause');
    expect(verbVerdict('pause', ctx({ state: 'processing', claimed: true })).status).toBe(409);
  });

  it('resume: only available when paused', () => {
    expect(availableVerbs(ctx({ state: 'paused' }))).toContain('resume');
    for (const state of ['healthy', 'late', 'stalled', 'processing', 'unknown', 'strand'] as HealthState[]) {
      expect(availableVerbs(ctx({ state }))).not.toContain('resume');
    }
  });
});

describe('axes-precedence (kind mask AND state cell)', () => {
  it('a verb available only if BOTH the kind mask and the state cell allow it', () => {
    // move is allowed by the paused state cell, but the one_off/thread_loop
    // kind masks remove it → AND yields not-available.
    expect(availableVerbs(ctx({ state: 'paused', kind: 'recurring' }))).toContain('move');
    expect(availableVerbs(ctx({ state: 'paused', kind: 'one_off' }))).not.toContain('move');
    expect(availableVerbs(ctx({ state: 'paused', kind: 'thread_loop' }))).not.toContain('move');
  });
});
