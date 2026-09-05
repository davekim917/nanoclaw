import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main, submitOwnerReport } from './upstream-dry-run-report.js';

const roots: string[] = [];

function fixtureRoot(): string {
  const root = globalThis.uniqueTmpRoot('upstream-dry-run-report');
  roots.push(root);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function listen(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

function delivery(messageId = 'platform-message'): Record<string, string | null> {
  return {
    messaging_group_id: 'newer-dm',
    channel_type: 'test-channel',
    platform_id: 'destination-current',
    instance: 'test-channel-secondary',
    platform_message_id: messageId,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('upstream dry-run owner notification', () => {
  it('submits the report to the host CLI and awaits its direct delivery result', async () => {
    const root = fixtureRoot();
    const socketPath = path.join(root, 'ncl.sock');
    let request: Record<string, unknown> | undefined;
    const server = net.createServer((socket) => {
      socket.once('data', (chunk) => {
        request = JSON.parse(chunk.toString('utf8')) as Record<string, unknown>;
        socket.end(JSON.stringify({ id: request.id, ok: true, data: { delivered: delivery() } }) + '\n');
      });
    });
    await listen(server, socketPath);

    try {
      await expect(submitOwnerReport({ socketPath, report: 'Weekly report body' })).resolves.toEqual(delivery());
      expect(request).toMatchObject({
        id: expect.any(String),
        command: 'messaging-groups-notify-owner',
        args: { text: 'Weekly report body' },
      });
      expect(request).not.toHaveProperty('senderId');
      expect(request).not.toHaveProperty('isMention');
    } finally {
      await close(server);
    }
  });

  it('leaves the named-instance owner DM selection to the host', async () => {
    const socket = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      write: (payload: string, callback: (err?: Error | null) => void) => void;
    };
    socket.destroy = vi.fn();
    socket.write = (payload, callback) => {
      callback();
      const request = JSON.parse(payload) as { id: string };
      socket.emit(
        'data',
        Buffer.from(JSON.stringify({ id: request.id, ok: true, data: { delivered: delivery() } }) + '\n'),
      );
    };

    const submission = submitOwnerReport(
      { socketPath: 'test.sock', report: 'report' },
      () => socket as unknown as net.Socket,
    );
    socket.emit('connect');

    await expect(submission).resolves.toEqual(delivery());
  });

  it('surfaces socket connection errors', async () => {
    const socketPath = path.join(fixtureRoot(), 'missing.sock');

    await expect(submitOwnerReport({ socketPath, report: 'report' })).rejects.toThrow(/submission failed/);
  });

  it('times out while a socket connection never completes', async () => {
    const socket = new EventEmitter() as EventEmitter & { destroy: () => void; write: () => void };
    socket.destroy = vi.fn();
    socket.write = vi.fn();

    vi.useFakeTimers();
    try {
      const submission = submitOwnerReport(
        { socketPath: 'pending.sock', report: 'report', connectionTimeoutMs: 5_000 },
        () => socket as unknown as net.Socket,
      );
      const rejected = expect(submission).rejects.toThrow(/timed out.*before submitting/);
      await vi.advanceTimersByTimeAsync(5_000);

      await rejected;
      expect(socket.destroy).toHaveBeenCalledOnce();
      socket.emit('connect');
      expect(socket.write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits beyond the connection timeout for a delivery acknowledgement', async () => {
    const socket = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      write: (payload: string, callback: (err?: Error | null) => void) => void;
    };
    let requestId = '';
    socket.destroy = vi.fn();
    socket.write = (payload, callback) => {
      requestId = (JSON.parse(payload) as { id: string }).id;
      callback();
    };

    vi.useFakeTimers();
    try {
      const submission = submitOwnerReport(
        { socketPath: 'delayed.sock', report: 'report', connectionTimeoutMs: 5_000 },
        () => socket as unknown as net.Socket,
      );
      socket.emit('connect');
      await vi.advanceTimersByTimeAsync(5_001);
      expect(socket.destroy).not.toHaveBeenCalled();

      socket.emit(
        'data',
        Buffer.from(JSON.stringify({ id: requestId, ok: true, data: { delivered: delivery() } }) + '\n'),
      );
      await expect(submission).resolves.toEqual(delivery());
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a socket error reported by the write callback', async () => {
    const socket = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      write: (payload: string, callback: (err?: Error | null) => void) => void;
    };
    socket.destroy = vi.fn();
    socket.write = (_payload, callback) => callback(new Error('write failed'));

    const submission = submitOwnerReport(
      { socketPath: 'failed.sock', report: 'report' },
      () => socket as unknown as net.Socket,
    );
    socket.emit('connect');

    await expect(submission).rejects.toThrow(/write failed/);
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  it('rejects a malformed host CLI response', async () => {
    const socket = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      write: (payload: string, callback: (err?: Error | null) => void) => void;
    };
    socket.destroy = vi.fn();
    socket.write = (_payload, callback) => {
      callback();
      socket.emit('data', Buffer.from('not-json\n'));
    };

    const submission = submitOwnerReport(
      { socketPath: 'malformed.sock', report: 'report' },
      () => socket as unknown as net.Socket,
    );
    socket.emit('connect');

    await expect(submission).rejects.toThrow(/malformed response/);
  });

  it('rejects an empty owner-DM id in a successful host response', async () => {
    const socket = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      write: (payload: string, callback: (err?: Error | null) => void) => void;
    };
    socket.destroy = vi.fn();
    socket.write = (payload, callback) => {
      callback();
      const request = JSON.parse(payload) as { id: string };
      socket.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            id: request.id,
            ok: true,
            data: { delivered: { ...delivery(), messaging_group_id: '' } },
          }) + '\n',
        ),
      );
    };

    const submission = submitOwnerReport(
      { socketPath: 'empty-owner-dm.sock', report: 'report' },
      () => socket as unknown as net.Socket,
    );
    socket.emit('connect');

    await expect(submission).rejects.toThrow(/invalid delivery result/);
  });

  it('rejects a host CLI response for another request', async () => {
    const socket = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      write: (payload: string, callback: (err?: Error | null) => void) => void;
    };
    socket.destroy = vi.fn();
    socket.write = (_payload, callback) => {
      callback();
      socket.emit(
        'data',
        Buffer.from(JSON.stringify({ id: 'other-request', ok: true, data: { delivered: delivery() } }) + '\n'),
      );
    };

    const submission = submitOwnerReport(
      { socketPath: 'wrong-id.sock', report: 'report' },
      () => socket as unknown as net.Socket,
    );
    socket.emit('connect');

    await expect(submission).rejects.toThrow(/malformed response/);
  });

  it('surfaces a host CLI negative acknowledgement', async () => {
    const socket = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      write: (payload: string, callback: (err?: Error | null) => void) => void;
    };
    socket.destroy = vi.fn();
    socket.write = (payload, callback) => {
      callback();
      const request = JSON.parse(payload) as { id: string };
      socket.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            id: request.id,
            ok: false,
            error: { code: 'handler-error', message: 'delivery rejected' },
          }) + '\n',
        ),
      );
    };

    const submission = submitOwnerReport(
      { socketPath: 'rejected.sock', report: 'report' },
      () => socket as unknown as net.Socket,
    );
    socket.emit('connect');

    await expect(submission).rejects.toThrow(/delivery rejected/);
  });

  it('reports an unknown delivery outcome when the connection closes after submission', async () => {
    const socket = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      write: (payload: string, callback: (err?: Error | null) => void) => void;
    };
    socket.destroy = vi.fn();
    socket.write = (_payload, callback) => {
      callback();
      socket.emit('close');
    };

    const submission = submitOwnerReport(
      { socketPath: 'closed.sock', report: 'report' },
      () => socket as unknown as net.Socket,
    );
    socket.emit('connect');

    await expect(submission).rejects.toThrow(/closed after submitting.*outcome is unknown/);
  });

  it('reports an unknown delivery outcome when the socket errors after submission', async () => {
    const socket = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      write: (payload: string, callback: (err?: Error | null) => void) => void;
    };
    socket.destroy = vi.fn();
    socket.write = (_payload, callback) => {
      callback();
      socket.emit('error', new Error('connection lost'));
    };

    const submission = submitOwnerReport(
      { socketPath: 'errored.sock', report: 'report' },
      () => socket as unknown as net.Socket,
    );
    socket.emit('connect');

    await expect(submission).rejects.toThrow(/errored after submitting.*outcome is unknown.*connection lost/);
  });

  it('keeps the default invocation stdout-only without opening the DB or socket', async () => {
    const root = fixtureRoot();
    const generateReport = vi.fn(() => 'Manual report');
    const submitReport = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await main([], root, { generateReport, submitReport });

    expect(generateReport).toHaveBeenCalledWith({ repoRoot: root });
    expect(submitReport).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('Manual report');
  });

  it('submits the generated report to the host owner resolver when requested', async () => {
    const root = fixtureRoot();
    const generateReport = vi.fn(() => 'Generated report');
    const submitReport = vi.fn().mockResolvedValue(delivery());
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await main(['--notify-owner'], root, { generateReport, submitReport });

    expect(submitReport).toHaveBeenCalledOnce();
    expect(submitReport).toHaveBeenCalledWith({
      socketPath: path.join(root, 'data', 'ncl.sock'),
      report: 'Generated report',
    });
    expect(log).toHaveBeenNthCalledWith(1, 'Generated report');
    expect(log).toHaveBeenNthCalledWith(
      2,
      'upstream-dry-run-report: report delivered to the owner DM through the host CLI.',
    );
  });

  it('prints the report before surfacing a host owner-resolution failure', async () => {
    const root = fixtureRoot();
    const generateReport = vi.fn(() => 'Generated report');
    const submitReport = vi.fn().mockRejectedValue(new Error('no owner DM found through the host owner predicate'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(main(['--notify-owner'], root, { generateReport, submitReport })).rejects.toThrow(/no owner DM found/);

    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('Generated report');
    expect(submitReport).toHaveBeenCalledWith({
      socketPath: path.join(root, 'data', 'ncl.sock'),
      report: 'Generated report',
    });
  });
});
