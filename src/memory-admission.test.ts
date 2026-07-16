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
