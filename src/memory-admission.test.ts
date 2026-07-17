import { describe, expect, it } from 'vitest';

import { MemoryAdmissionController } from './memory-admission.js';

describe('MemoryAdmissionController', () => {
  it('test_memory_admission_reserves_without_overcommit', () => {
    const admission = new MemoryAdmissionController<string>(8192);

    expect(admission.request('a', 5120, 'session-a').status).toBe('admitted');
    expect(admission.request('b', 4096, 'session-b').status).toBe('queued');
    expect(admission.reservedMb).toBe(5120);
    expect(admission.queuedCount).toBe(1);
  });

  it('test_memory_admission_deduplicates_concurrent_wakes', () => {
    const admission = new MemoryAdmissionController<string>(8192);

    expect(admission.request('a', 5120, 'first').status).toBe('admitted');
    expect(admission.request('a', 5120, 'duplicate').status).toBe('admitted');
    expect(admission.reservedMb).toBe(5120);
    expect(admission.queuedCount).toBe(0);
  });

  it('test_memory_admission_drains_strict_fifo', () => {
    const admission = new MemoryAdmissionController<string>(8192);
    admission.request('active', 5120, 'active');
    admission.request('large', 5120, 'large');
    admission.request('small', 3072, 'small');

    expect(admission.release('active')).toEqual(['large', 'small']);
    expect(admission.reservedMb).toBe(8192);
    expect(admission.queuedCount).toBe(0);
  });

  it('test_memory_admission_does_not_skip_fifo_head', () => {
    const admission = new MemoryAdmissionController<string>(8192);
    admission.request('active', 6144, 'active');
    admission.request('large', 4096, 'large');
    admission.request('small', 2048, 'small');

    expect(admission.release('missing')).toEqual([]);
    expect(admission.queuedCount).toBe(2);
  });

  it('admits interactive work ahead of a scheduled head when the interactive request fits', () => {
    const admission = new MemoryAdmissionController<string>(8192);
    admission.request('active', 7168, 'active');

    expect(admission.request('scheduled', 2048, 'scheduled', 'scheduled').status).toBe('queued');
    expect(admission.request('interactive', 1024, 'interactive', 'interactive').status).toBe('admitted');

    expect(admission.reservedMb).toBe(8192);
    expect(admission.isQueued('scheduled')).toBe(true);
    expect(admission.isQueued('interactive')).toBe(false);
  });

  it('preserves FIFO within each priority class', () => {
    const admission = new MemoryAdmissionController<string>(8192);
    admission.request('active', 8192, 'active');
    admission.request('scheduled-1', 2048, 'scheduled-1', 'scheduled');
    admission.request('interactive-1', 2048, 'interactive-1', 'interactive');
    admission.request('scheduled-2', 2048, 'scheduled-2', 'scheduled');
    admission.request('interactive-2', 2048, 'interactive-2', 'interactive');

    expect(admission.release('active')).toEqual(['interactive-1', 'interactive-2', 'scheduled-1', 'scheduled-2']);
  });

  it('does not let a newer smaller scheduled request bypass a non-fitting scheduled head', () => {
    const admission = new MemoryAdmissionController<string>(8192);
    admission.request('active', 6144, 'active');

    expect(admission.request('scheduled-large', 4096, 'scheduled-large', 'scheduled').status).toBe('queued');
    expect(admission.request('scheduled-small', 2048, 'scheduled-small', 'scheduled').status).toBe('queued');

    expect(admission.reservedMb).toBe(6144);
    expect(admission.release('active')).toEqual(['scheduled-large', 'scheduled-small']);
  });

  it('promotes an already queued scheduled session when interactive work arrives', () => {
    const admission = new MemoryAdmissionController<string>(8192);
    admission.request('active', 6144, 'active');
    admission.request('scheduled-large', 4096, 'scheduled-large', 'scheduled');
    admission.request('scheduled-session', 2048, 'scheduled-session', 'scheduled');

    expect(admission.request('scheduled-session', 2048, 'scheduled-session', 'interactive').status).toBe('admitted');
    expect(admission.hasReservation('scheduled-session')).toBe(true);
    expect(admission.isQueued('scheduled-large')).toBe(true);
  });

  it('keeps genuine interactive work ahead of older scheduled work', () => {
    const admission = new MemoryAdmissionController<string>(4096);
    admission.request('active', 4096, 'active');
    admission.request('scheduled', 4096, 'scheduled', 'scheduled');
    admission.request('interactive', 4096, 'interactive', 'interactive');

    expect(admission.release('active')).toEqual(['interactive']);
    expect(admission.isQueued('scheduled')).toBe(true);
  });

  it('does not demote an interactive session when a scheduled retry arrives', () => {
    const admission = new MemoryAdmissionController<string>(4096);
    admission.request('active', 4096, 'active');
    admission.request('same-session', 4096, 'same-session', 'interactive');
    admission.request('same-session', 4096, 'same-session', 'scheduled');
    admission.request('scheduled', 4096, 'scheduled', 'scheduled');

    expect(admission.release('active')).toEqual(['same-session']);
    expect(admission.isQueued('scheduled')).toBe(true);
  });

  it('test_memory_admission_rejects_request_above_budget', () => {
    const admission = new MemoryAdmissionController<string>(4096);

    expect(admission.request('oversized', 5120, 'oversized')).toEqual({
      status: 'rejected',
      reason: 'request_exceeds_budget',
      budgetMb: 4096,
      requestMb: 5120,
    });
    expect(admission.queuedCount).toBe(0);
  });

  it('test_memory_admission_shutdown_discards_reservations_and_queue', () => {
    const admission = new MemoryAdmissionController<string>(8192);
    admission.request('active', 6144, 'active');
    admission.request('queued', 4096, 'queued');

    admission.shutdown();

    expect(admission.reservedMb).toBe(0);
    expect(admission.queuedCount).toBe(0);
    expect(admission.isQueued('queued')).toBe(false);
    expect(admission.hasReservation('active')).toBe(false);
  });
});
