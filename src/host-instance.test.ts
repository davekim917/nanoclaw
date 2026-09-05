/**
 * Acceptance cases for the host-instance lease
 * (docs/specs/upstream-restart-survival-seam/plan.md §7.A).
 *
 * `./db/coordination.js` is mocked, NOT `os`: a fake-timer test runs the real
 * function body, so the seam worth cutting is the one that would otherwise open
 * a database — `os.hostname()` is a pure read that costs nothing and mocking it
 * proves nothing (memory `feedback_fake_timer_tests_run_real_bodies`).
 *
 * The module holds process-global state (`instanceId`, `renewTimer`), so every
 * case resets it via `stopHostInstanceLease()` in afterEach — otherwise the
 * "a second start throws" case leaks a live interval into the next one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// NOT spread: log.ts installs process-wide uncaughtException/unhandledRejection
// handlers (including process.exit(1)) at module scope — importOriginal() would
// install those in this test file's worker. Complete stub instead
// (src/log-mock-tripwire.test.ts pins this shape).
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));

const mockRegister = vi.fn<(args: { instanceId: string; leaseExpiresAt: string }) => Promise<void>>(() =>
  Promise.resolve(),
);
const mockRenew = vi.fn<(instanceId: string, leaseExpiresAt: string) => Promise<boolean>>(() => Promise.resolve(true));
const mockMarkStopped = vi.fn<(instanceId: string, now: string) => Promise<void>>(() => Promise.resolve());
vi.mock('./db/coordination.js', () => ({
  registerHostInstance: (...args: unknown[]) => mockRegister(args[0] as { instanceId: string; leaseExpiresAt: string }),
  renewHostInstanceLease: (...args: unknown[]) => mockRenew(args[0] as string, args[1] as string),
  markHostInstanceStopped: (...args: unknown[]) => mockMarkStopped(args[0] as string, args[1] as string),
}));

const { log } = await import('./log.js');
const { getHostInstanceId, startHostInstanceLease, stopHostInstanceLease } = await import('./host-instance.js');

/** Lets a pending microtask chain (the interval's `void renewLease(...)`) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('host instance lease', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegister.mockResolvedValue(undefined);
    mockRenew.mockResolvedValue(true);
    mockMarkStopped.mockResolvedValue(undefined);
    vi.useFakeTimers();
  });
  afterEach(async () => {
    await stopHostInstanceLease();
    vi.useRealTimers();
  });

  it('start registers a row and returns the instance id', async () => {
    const id = await startHostInstanceLease();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(getHostInstanceId()).toBe(id);
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(mockRegister.mock.calls[0][0].instanceId).toBe(id);
  });

  it('a second start throws', async () => {
    await startHostInstanceLease();
    await expect(startHostInstanceLease()).rejects.toThrow('host instance lease already started');
    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it('the renew timer extends the lease on its interval', async () => {
    vi.setSystemTime(new Date('2026-09-05T12:00:00.000Z'));
    const id = await startHostInstanceLease({ renewIntervalMs: 10, leaseTtlMs: 60_000 });
    const registeredExpiry = mockRegister.mock.calls[0][0].leaseExpiresAt;

    vi.advanceTimersByTime(10);
    await flush();

    expect(mockRenew).toHaveBeenCalledTimes(1);
    const [renewedId, renewedExpiry] = mockRenew.mock.calls[0];
    expect(renewedId).toBe(id);
    expect(Date.parse(renewedExpiry)).toBeGreaterThan(Date.parse(registeredExpiry));
  });

  it('a rejected renewal logs a warning and does not throw', async () => {
    await startHostInstanceLease({ renewIntervalMs: 10, leaseTtlMs: 60_000 });
    mockRenew.mockRejectedValue(new Error('db down'));

    vi.advanceTimersByTime(10);
    await flush();
    expect(log.warn).toHaveBeenCalledWith('Host instance lease renewal failed', expect.anything());

    // The timer survives the rejection: a transient DB failure must not stop
    // renewal for the life of the process.
    mockRenew.mockResolvedValue(true);
    vi.advanceTimersByTime(10);
    await flush();
    expect(mockRenew).toHaveBeenCalledTimes(2);
  });

  it('a renewal that reports the row missing logs `Host instance lease row missing on renewal`', async () => {
    const id = await startHostInstanceLease({ renewIntervalMs: 10, leaseTtlMs: 60_000 });
    mockRenew.mockResolvedValue(false);

    vi.advanceTimersByTime(10);
    await flush();

    expect(log.warn).toHaveBeenCalledWith('Host instance lease row missing on renewal', { instanceId: id });
  });

  it('stop clears the timer, stamps stopped_at, and makes getHostInstanceId null', async () => {
    const id = await startHostInstanceLease({ renewIntervalMs: 10, leaseTtlMs: 60_000 });
    await stopHostInstanceLease();

    expect(getHostInstanceId()).toBeNull();
    expect(mockMarkStopped).toHaveBeenCalledTimes(1);
    expect(mockMarkStopped.mock.calls[0][0]).toBe(id);
    expect(mockMarkStopped.mock.calls[0][1]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);

    vi.advanceTimersByTime(1000);
    await flush();
    expect(mockRenew).not.toHaveBeenCalled();
  });

  it('a rejected stop stamp does not throw', async () => {
    await startHostInstanceLease({ renewIntervalMs: 10, leaseTtlMs: 60_000 });
    mockMarkStopped.mockRejectedValue(new Error('db down'));

    await expect(stopHostInstanceLease()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith('Failed to mark host instance stopped', expect.anything());
    expect(getHostInstanceId()).toBeNull();
  });

  it("the renew timer is unref'd", async () => {
    // A lease renewal must never be the reason the process refuses to exit.
    const unref = vi.fn();
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>);
    try {
      await startHostInstanceLease({ renewIntervalMs: 10, leaseTtlMs: 60_000 });
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(unref).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });
});
