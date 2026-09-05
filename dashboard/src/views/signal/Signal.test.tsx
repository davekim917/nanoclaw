import { describe, expect, it, vi, afterEach } from 'vitest';
import { signalRoute, threadHref } from './routes.js';
import { getSignalOverview, reviewSignalDecision, SignalApiError } from '../../lib/signal-api.js';
afterEach(() => vi.unstubAllGlobals());
describe('Signal routing and authenticated client', () => {
  it('defaults to overview and preserves opaque exact thread IDs', () => {
    expect(signalRoute('')).toEqual({ page: 'overview', id: null });
    const id = 'slack:channel/thread/123';
    expect(signalRoute(threadHref(id))).toEqual({ page: 'threads', id });
    for (const page of ['projects', 'decisions', 'agents', 'threads', 'schedule'])
      expect(signalRoute(`#/${page}`).page).toBe(page);
    expect(signalRoute('#/scheduled').page).toBe('schedule');
  });
  it('does not turn failed source reads into empty all-clear data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: 'source unavailable' }) }),
    );
    await expect(getSignalOverview('all')).rejects.toThrow('source unavailable');
  });
  it('preserves conflicts and version-bound ownership request', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'review changed' }) });
    vi.stubGlobal('fetch', fetcher);
    const body = { action: 'claim' as const, expected_version: 4, evidence_hash: 'evidence', idempotency_key: 'one' };
    await expect(reviewSignalDecision('opaque/id', body)).rejects.toBeInstanceOf(SignalApiError);
    expect(fetcher).toHaveBeenCalledWith(
      '/dashboard/api/observatory/v2/decisions/opaque%2Fid/review',
      expect.objectContaining({ credentials: 'include', body: JSON.stringify(body) }),
    );
  });
});
