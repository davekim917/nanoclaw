import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  authMe,
  postSteer,
  listScheduled,
  getScheduledDetail,
  editScheduled,
  pauseScheduled,
  resumeScheduled,
  runNowScheduled,
  cancelScheduled,
  moveScheduledPreview,
  moveScheduled,
} from './api.js';

function okJson(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

describe('api', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('test_api_authMe_includes_credentials', () => {
    it('authMe includes credentials: include', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ user_id: 'u1', scopes: { role: 'owner', allowed_group_ids: [], no_filter: true } }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await authMe();

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(init.credentials).toBe('include');
    });
  });

  describe('test_api_postSteer_body_shape', () => {
    it('postSteer sends correct body', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ task_id: 'spawn-abc', message_id: 'msg-1', echo_status: 'pending' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await postSteer('spawn-abc', { idempotency_key: 'uuid-1', text: 'hi' });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/dashboard/api/tasks/spawn-abc/message');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ idempotency_key: 'uuid-1', text: 'hi' });
    });
  });

  describe('test_api_throws_typed_error_on_non_2xx', () => {
    it('throws typed error on 422', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: () => Promise.resolve({ error: 'mismatched_idempotency_payload' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(
        postSteer('spawn-abc', { idempotency_key: 'x', text: 'hi' })
      ).rejects.toMatchObject({ status: 422, error: 'mismatched_idempotency_payload' });
    });
  });

  describe('test_api_throws_retry_after_on_429', () => {
    it('throws typed error with retry_after on 429', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: () => Promise.resolve({ error: 'rate_limit_exceeded', retry_after: 5 }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(
        postSteer('spawn-abc', { idempotency_key: 'x', text: 'hi' })
      ).rejects.toMatchObject({ status: 429, error: 'rate_limit_exceeded', retry_after: 5 });
    });
  });

  // ─── Scheduled board client (Group E / E5) ───

  describe('test_list_scheduled_calls_endpoint', () => {
    it('listScheduled() GETs /dashboard/api/scheduled', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        okJson({ rows: [], counts: {}, degraded: false, assembled_at: 't' }),
      );
      vi.stubGlobal('fetch', mockFetch);

      await listScheduled();

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/dashboard/api/scheduled');
      // never the /tasks namespace
      expect(url).not.toMatch(/\/tasks/);
      expect(init.credentials).toBe('include');
    });

    it('listScheduled({group_id}) appends the query param', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        okJson({ rows: [], counts: {}, degraded: false, assembled_at: 't' }),
      );
      vi.stubGlobal('fetch', mockFetch);

      await listScheduled({ group_id: 'ag-7' });

      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/dashboard/api/scheduled?group_id=ag-7');
    });
  });

  describe('test_scheduled_detail_calls_endpoint', () => {
    it('getScheduledDetail(key) GETs the encoded :key path', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        okJson({ row: {}, prompt: 'p', script: null, history: [] }),
      );
      vi.stubGlobal('fetch', mockFetch);

      await getScheduledDetail('a/b/c');

      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`/dashboard/api/scheduled/${encodeURIComponent('a/b/c')}`);
    });
  });

  describe('test_scheduled_mutators_paths_and_method', () => {
    it('editScheduled PUTs the :key path with the body', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson({ updated: true }));
      vi.stubGlobal('fetch', mockFetch);

      await editScheduled('K1', { prompt: 'new', cron: '0 6 * * *' });

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/dashboard/api/scheduled/K1');
      expect(init.method).toBe('PUT');
      expect(init.credentials).toBe('include');
      expect(JSON.parse(init.body as string)).toEqual({ prompt: 'new', cron: '0 6 * * *' });
    });

    it('pause/resume/cancel POST the verb paths (never /tasks)', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson({ ok: true }));
      vi.stubGlobal('fetch', mockFetch);

      await pauseScheduled('K2');
      await resumeScheduled('K2');
      await cancelScheduled('K2');

      const urls = mockFetch.mock.calls.map((c) => (c as [string, RequestInit])[0]);
      expect(urls).toEqual([
        '/dashboard/api/scheduled/K2/pause',
        '/dashboard/api/scheduled/K2/resume',
        '/dashboard/api/scheduled/K2/cancel',
      ]);
      for (const u of urls) expect(u).not.toMatch(/\/tasks/);
      for (const c of mockFetch.mock.calls) {
        expect((c as [string, RequestInit])[1].method).toBe('POST');
      }
    });

    it('runNowScheduled sends {force} only when forcing', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson({ fired: true }));
      vi.stubGlobal('fetch', mockFetch);

      await runNowScheduled('K3', { force: true });

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/dashboard/api/scheduled/K3/run-now');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ force: true });
    });
  });

  describe('test_move_sends_delta_hash', () => {
    it('moveScheduledPreview POSTs the target ids to /move/preview', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        okJson({
          wiringOk: true,
          gains: ['Datafold'],
          losses: [],
          crossWorkgroup: false,
          scriptPresent: true,
          environmentDeltaChecked: false,
          deltaHash: 'h1',
        }),
      );
      vi.stubGlobal('fetch', mockFetch);

      const res = await moveScheduledPreview('K4', {
        targetAgentGroupId: 'ag-2',
        targetMessagingGroupId: 'mg-9',
      });

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/dashboard/api/scheduled/K4/move/preview');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({
        targetAgentGroupId: 'ag-2',
        targetMessagingGroupId: 'mg-9',
      });
      expect(res.deltaHash).toBe('h1');
    });

    it('moveScheduled echoes confirmedDeltaHash in the body', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson({ moved: true }));
      vi.stubGlobal('fetch', mockFetch);

      await moveScheduled('K5', {
        targetAgentGroupId: 'ag-2',
        targetMessagingGroupId: 'mg-9',
        confirmedDeltaHash: 'h1',
      });

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/dashboard/api/scheduled/K5/move');
      expect(JSON.parse(init.body as string)).toMatchObject({ confirmedDeltaHash: 'h1' });
    });
  });

  describe('test_409_surfaces_reason', () => {
    it('a 409 {error:source_busy} surfaces a typed error carrying the reason', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ error: 'source_busy' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(pauseScheduled('K6')).rejects.toMatchObject({
        status: 409,
        error: 'source_busy',
      });
    });

    it('a 503 {error:claim_state_unreadable} surfaces the reason', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: () => Promise.resolve({ error: 'claim_state_unreadable' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(runNowScheduled('K7')).rejects.toMatchObject({
        status: 503,
        error: 'claim_state_unreadable',
      });
    });
  });
});
