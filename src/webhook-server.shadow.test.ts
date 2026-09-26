import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shadowState = vi.hoisted(() => ({ on: false }));
vi.mock('./shadow-host.js', () => ({ isShadowHost: () => shadowState.on }));
// Complete stub, not a spread: log.ts installs process-wide exit handlers.
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  isSurvivableIoError: vi.fn(() => false),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as AddressInfo;
      srv.close(() => resolve(addr.port));
    });
  });
}

async function boundHost(): Promise<unknown> {
  process.env.WEBHOOK_PORT = String(await getFreePort());
  const listen = vi.spyOn(http.Server.prototype, 'listen');
  const { ensureServerStarted, stopWebhookServer } = await import('./webhook-server.js');
  ensureServerStarted();
  const host = listen.mock.calls[0]?.[1];
  await stopWebhookServer();
  return host;
}

describe('webhook-server bind address', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    shadowState.on = false;
    vi.restoreAllMocks();
    delete process.env.WEBHOOK_PORT;
  });

  it('binds every interface when shadow mode is off', async () => {
    expect(await boundHost()).toBe('0.0.0.0');
  });

  it('binds loopback only on a shadow host', async () => {
    shadowState.on = true;
    expect(await boundHost()).toBe('127.0.0.1');
  });
});
