/**
 * Fork-owned. Derived from nanocoai/nanoclaw@5c3082a1 src/host-lifecycle.test.ts —
 * see src/host-lifecycle-seam-manifest.ts's UNPORTABLE_UPSTREAM_FILES for why upstream's
 * copy cannot be carried byte-for-byte, and docs/specs/upstream-host-sweep-seam/plan.md
 * §8 "S2-PR0" (L-2) for the acceptance case this file satisfies.
 *
 * Kept verbatim from upstream: all five `host module lifecycle registry` cases
 * ("registration is inert…", "returns callback snapshots…", "starts callbacks
 * serially…", "propagates a startup error…", "stops callbacks LIFO…").
 *
 * Kept with ONE change — the read path — in `host lifecycle orchestration`: both cases
 * read src/main.ts instead of upstream's src/index.ts, because this fork's boot sequence
 * lives in main.ts (src/index.ts here is a 15-line deploy-crash-guard shim; see its own
 * header comment, "do not add imports here beyond the guard"). No other adaptation was
 * needed — the same anchor strings (`setDeliveryAdapter(createChannelDeliveryAdapter())`,
 * `await startHostModules(`, `startActiveDeliveryPoll()`, `hostAbortController.abort()`,
 * `await stopHostModules()`, `stopDeliveryPolls()`) exist in src/main.ts in the same
 * relative order.
 *
 * RE-ADDED (S2-PR14): "registers built-in approvals cleanup with the host lifecycle",
 * verbatim from upstream `5c3082a1:src/host-lifecycle.test.ts`. It was removed while this
 * fork's approvals module still shut down through response-registry.ts's own onShutdown;
 * that module now registers `approvalsHostShutdown` on the host lifecycle, which is
 * upstream's shape, so the case is portable again and nothing is deferred.
 */
import fs from 'fs';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
  // The approvals case below imports src/modules/approvals/index.ts, which
  // reaches delivery.ts → secret-scrubber.ts, and that module calls
  // `setLogScrubber` at import time. Fake surface only; no assertion uses it.
  setLogScrubber: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe('host module lifecycle registry', () => {
  it('registration is inert and exposes callbacks for registration proofs', async () => {
    const lifecycle = await import('./host-lifecycle.js');
    const start = vi.fn();
    const stop = vi.fn();

    lifecycle.onHostStart(start);
    lifecycle.onHostShutdown(stop);

    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(lifecycle.getHostStartCallbacks()).toEqual([start]);
    expect(lifecycle.getHostShutdownCallbacks()).toEqual([stop]);
  });

  it('returns callback snapshots that cannot mutate the registry', async () => {
    const lifecycle = await import('./host-lifecycle.js');
    const firstStart = vi.fn();
    const secondStart = vi.fn();
    const firstStop = vi.fn();
    const secondStop = vi.fn();

    lifecycle.onHostStart(firstStart);
    lifecycle.onHostShutdown(firstStop);
    const startSnapshot = lifecycle.getHostStartCallbacks();
    const shutdownSnapshot = lifecycle.getHostShutdownCallbacks();

    lifecycle.onHostStart(secondStart);
    lifecycle.onHostShutdown(secondStop);

    expect(startSnapshot).toEqual([firstStart]);
    expect(shutdownSnapshot).toEqual([firstStop]);
    expect(lifecycle.getHostStartCallbacks()).toEqual([firstStart, secondStart]);
    expect(lifecycle.getHostShutdownCallbacks()).toEqual([firstStop, secondStop]);
  });

  it('starts callbacks serially in registration order with the same context', async () => {
    const lifecycle = await import('./host-lifecycle.js');
    const order: string[] = [];
    const controller = new AbortController();
    const ctx = { db: {} as never, signal: controller.signal };

    lifecycle.onHostStart(async (received) => {
      expect(received).toBe(ctx);
      order.push('first-start');
      await Promise.resolve();
      order.push('first-end');
    });
    lifecycle.onHostStart((received) => {
      expect(received.signal.aborted).toBe(false);
      order.push('second');
    });

    await lifecycle.startHostModules(ctx);
    controller.abort();

    expect(order).toEqual(['first-start', 'first-end', 'second']);
    expect(ctx.signal.aborted).toBe(true);
  });

  it('propagates a startup error and does not start later callbacks', async () => {
    const lifecycle = await import('./host-lifecycle.js');
    const { log } = await import('./log.js');
    const later = vi.fn();
    const failure = new Error('start-sentinel');

    lifecycle.onHostStart(() => {
      throw failure;
    });
    lifecycle.onHostStart(later);

    await expect(lifecycle.startHostModules({ db: {} as never, signal: new AbortController().signal })).rejects.toBe(
      failure,
    );
    expect(later).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith('Host module startup callback threw', { err: failure });
  });

  it('stops callbacks LIFO, logs the error, and continues', async () => {
    const lifecycle = await import('./host-lifecycle.js');
    const { log } = await import('./log.js');
    const order: string[] = [];

    lifecycle.onHostShutdown(async () => {
      order.push('first-start');
      await Promise.resolve();
      order.push('first-end');
    });
    lifecycle.onHostShutdown(() => {
      order.push('failed');
      throw new Error('shutdown-sentinel');
    });
    lifecycle.onHostShutdown(() => {
      order.push('last');
    });

    await lifecycle.stopHostModules();

    expect(order).toEqual(['last', 'failed', 'first-start', 'first-end']);
    expect(log.error).toHaveBeenCalledWith('Shutdown callback threw', {
      err: expect.objectContaining({ message: 'shutdown-sentinel' }),
    });
  });

  it('registers built-in approvals cleanup with the host lifecycle', async () => {
    const lifecycle = await import('./host-lifecycle.js');

    expect(lifecycle.getHostShutdownCallbacks()).toHaveLength(0);
    await import('./modules/approvals/index.js');
    // Upstream asserts a length of exactly 1 here. On this fork the approvals
    // module's own import graph reaches src/db/archive-projection-worker.ts
    // (via delivery.ts → container-runner.ts, #324), which registers a second,
    // unrelated callback — a difference in the fork's module graph, not in what
    // approvals registers. The assertion is therefore stated on the approvals
    // registrant by NAME, which pins the same property and one more besides:
    // approvals registers exactly one shutdown callback, and it is its own.
    const names = lifecycle.getHostShutdownCallbacks().map((cb) => cb.name);
    expect(names.filter((name) => name === 'approvalsHostShutdown')).toEqual(['approvalsHostShutdown']);
  });
});

describe('host lifecycle orchestration', () => {
  it('starts after delivery is ready and before delivery polling', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'main.ts'), 'utf8');
    const deliveryReady = source.indexOf('setDeliveryAdapter(createChannelDeliveryAdapter())');
    const modulesStart = source.indexOf('await startHostModules(');
    const pollingStart = source.indexOf('startActiveDeliveryPoll()');

    expect(deliveryReady).toBeGreaterThan(-1);
    expect(modulesStart).toBeGreaterThan(deliveryReady);
    expect(pollingStart).toBeGreaterThan(modulesStart);
  });

  it('aborts modules and awaits their LIFO shutdown before host cleanup', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'main.ts'), 'utf8');
    const abort = source.indexOf('hostAbortController.abort()');
    const modulesStop = source.indexOf('await stopHostModules()');
    const pollsStop = source.indexOf('stopDeliveryPolls()');

    expect(abort).toBeGreaterThan(-1);
    expect(modulesStop).toBeGreaterThan(abort);
    expect(pollsStop).toBeGreaterThan(modulesStop);
  });
});
