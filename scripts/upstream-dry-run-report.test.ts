import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { main, resolveLatestOwnerDm, submitOwnerReport } from './upstream-dry-run-report.js';

const roots: string[] = [];

function fixtureRoot(): string {
  const root = globalThis.uniqueTmpRoot('upstream-dry-run-report');
  roots.push(root);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function createOwnerDb(dbPath: string, includeDm = true): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE user_roles (user_id TEXT NOT NULL, role TEXT NOT NULL);
    CREATE TABLE user_dms (user_id TEXT NOT NULL, messaging_group_id TEXT NOT NULL, channel_type TEXT NOT NULL, resolved_at TEXT NOT NULL);
    CREATE TABLE messaging_groups (
      id TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      platform_id TEXT NOT NULL,
      instance TEXT NOT NULL DEFAULT 'test-channel'
    );
  `);
  db.exec(`INSERT INTO user_roles VALUES ('test-channel:owner-user', 'owner');`);
  if (includeDm) {
    db.exec(`
      INSERT INTO messaging_groups (id, channel_type, platform_id) VALUES ('older-dm', 'test-channel', 'destination-older');
      INSERT INTO messaging_groups (id, channel_type, platform_id) VALUES ('newer-dm', 'test-channel', 'destination-newer');
      INSERT INTO user_dms VALUES ('test-channel:owner-user', 'older-dm', 'test-channel', '2026-01-01T00:00:00.000Z');
      INSERT INTO user_dms VALUES ('test-channel:owner-user', 'newer-dm', 'test-channel', '2026-02-01T00:00:00.000Z');
    `);
  }
  db.close();
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

function testDm() {
  return { messagingGroupId: 'newer-dm' };
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
  it('resolves the latest owner DM through roles, DM cache, and messaging groups', () => {
    const dbPath = path.join(fixtureRoot(), 'v2.db');
    createOwnerDb(dbPath);

    expect(resolveLatestOwnerDm(dbPath)).toEqual({ messagingGroupId: 'newer-dm' });
  });

  it('skips a newer CLI cache row because it has no durable delivery target', () => {
    const dbPath = path.join(fixtureRoot(), 'v2.db');
    createOwnerDb(dbPath);
    const db = new Database(dbPath);
    db.exec(`
      INSERT INTO messaging_groups (id, channel_type, platform_id) VALUES ('cli-dm', 'cli', 'local');
      INSERT INTO user_dms VALUES ('test-channel:owner-user', 'cli-dm', 'cli', '2026-03-01T00:00:00.000Z');
    `);
    db.close();

    expect(resolveLatestOwnerDm(dbPath)).toEqual({ messagingGroupId: 'newer-dm' });
  });

  it('returns no target when no owner has a DM cache row', () => {
    const dbPath = path.join(fixtureRoot(), 'v2.db');
    createOwnerDb(dbPath, false);

    expect(resolveLatestOwnerDm(dbPath)).toBeUndefined();
  });

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
      await expect(submitOwnerReport({ socketPath, dm: testDm(), report: 'Weekly report body' })).resolves.toEqual(
        delivery(),
      );
      expect(request).toMatchObject({
        id: expect.any(String),
        command: 'messaging-groups-notify',
        args: { id: 'newer-dm', text: 'Weekly report body' },
      });
      expect(request).not.toHaveProperty('senderId');
      expect(request).not.toHaveProperty('isMention');
    } finally {
      await close(server);
    }
  });

  it('accepts a named-instance owner DM because the host resolves the messaging group', async () => {
    const dbPath = path.join(fixtureRoot(), 'v2.db');
    createOwnerDb(dbPath);
    const db = new Database(dbPath);
    db.prepare('UPDATE messaging_groups SET instance = ? WHERE id = ?').run('test-channel-secondary', 'newer-dm');
    db.close();
    const dm = resolveLatestOwnerDm(dbPath)!;
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
      { socketPath: 'test.sock', dm, report: 'report' },
      () => socket as unknown as net.Socket,
    );
    socket.emit('connect');

    await expect(submission).resolves.toEqual(delivery());
  });

  it('surfaces socket connection errors', async () => {
    const socketPath = path.join(fixtureRoot(), 'missing.sock');

    await expect(submitOwnerReport({ socketPath, dm: testDm(), report: 'report' })).rejects.toThrow(
      /submission failed/,
    );
  });

  it('times out while a socket connection never completes', async () => {
    const socket = new EventEmitter() as EventEmitter & { destroy: () => void; write: () => void };
    socket.destroy = vi.fn();
    socket.write = vi.fn();

    vi.useFakeTimers();
    try {
      const submission = submitOwnerReport(
        { socketPath: 'pending.sock', dm: testDm(), report: 'report', connectionTimeoutMs: 5_000 },
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
        { socketPath: 'delayed.sock', dm: testDm(), report: 'report', connectionTimeoutMs: 5_000 },
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
      { socketPath: 'failed.sock', dm: testDm(), report: 'report' },
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
      { socketPath: 'malformed.sock', dm: testDm(), report: 'report' },
      () => socket as unknown as net.Socket,
    );
    socket.emit('connect');

    await expect(submission).rejects.toThrow(/malformed response/);
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
      { socketPath: 'wrong-id.sock', dm: testDm(), report: 'report' },
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
      { socketPath: 'rejected.sock', dm: testDm(), report: 'report' },
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
      { socketPath: 'closed.sock', dm: testDm(), report: 'report' },
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
      { socketPath: 'errored.sock', dm: testDm(), report: 'report' },
      () => socket as unknown as net.Socket,
    );
    socket.emit('connect');

    await expect(submission).rejects.toThrow(/errored after submitting.*outcome is unknown.*connection lost/);
  });

  it('keeps the default invocation stdout-only without opening the DB or socket', async () => {
    const root = fixtureRoot();
    const generateReport = vi.fn(() => 'Manual report');
    const resolveOwnerDm = vi.fn();
    const submitReport = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await main([], root, { generateReport, resolveOwnerDm, submitReport });

    expect(generateReport).toHaveBeenCalledWith({ repoRoot: root });
    expect(resolveOwnerDm).not.toHaveBeenCalled();
    expect(submitReport).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('Manual report');
  });

  it('resolves a temporary owner DB and delivers the generated report when requested', async () => {
    const root = fixtureRoot();
    createOwnerDb(path.join(root, 'data', 'v2.db'));
    const generateReport = vi.fn(() => 'Generated report');
    const submitReport = vi.fn().mockResolvedValue(delivery());
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await main(['--notify-owner'], root, { generateReport, submitReport });

    expect(submitReport).toHaveBeenCalledOnce();
    expect(submitReport).toHaveBeenCalledWith({
      socketPath: path.join(root, 'data', 'ncl.sock'),
      dm: { messagingGroupId: 'newer-dm' },
      report: 'Generated report',
    });
    expect(log).toHaveBeenNthCalledWith(1, 'Generated report');
    expect(log).toHaveBeenNthCalledWith(
      2,
      'upstream-dry-run-report: report delivered to the owner DM through the host CLI.',
    );
  });

  it('prints the report before rejecting an owner notification with no cached DM', async () => {
    const root = fixtureRoot();
    createOwnerDb(path.join(root, 'data', 'v2.db'), false);
    const generateReport = vi.fn(() => 'Generated report');
    const submitReport = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(main(['--notify-owner'], root, { generateReport, submitReport })).rejects.toThrow(/no owner DM found/);

    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('Generated report');
    expect(submitReport).not.toHaveBeenCalled();
  });
});
