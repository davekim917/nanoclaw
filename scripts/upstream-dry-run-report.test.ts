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
    CREATE TABLE messaging_groups (id TEXT PRIMARY KEY, platform_id TEXT NOT NULL);
  `);
  db.exec(`INSERT INTO user_roles VALUES ('owner-user', 'owner');`);
  if (includeDm) {
    db.exec(`
      INSERT INTO messaging_groups VALUES ('older-dm', 'destination-older');
      INSERT INTO messaging_groups VALUES ('newer-dm', 'destination-newer');
      INSERT INTO user_dms VALUES ('owner-user', 'older-dm', 'test-channel', '2026-01-01T00:00:00.000Z');
      INSERT INTO user_dms VALUES ('owner-user', 'newer-dm', 'test-channel', '2026-02-01T00:00:00.000Z');
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

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('upstream dry-run owner notification', () => {
  it('resolves the latest owner DM through roles, DM cache, and messaging groups', () => {
    const dbPath = path.join(fixtureRoot(), 'v2.db');
    createOwnerDb(dbPath);

    expect(resolveLatestOwnerDm(dbPath)).toEqual({ channelType: 'test-channel', platformId: 'destination-newer' });
  });

  it('returns no target when no owner has a DM cache row', () => {
    const dbPath = path.join(fixtureRoot(), 'v2.db');
    createOwnerDb(dbPath, false);

    expect(resolveLatestOwnerDm(dbPath)).toBeUndefined();
  });

  it('submits a mention-addressed relay request without waiting for an acknowledgement', async () => {
    const root = fixtureRoot();
    const socketPath = path.join(root, 'cli.sock');
    let received = '';
    let receivePayload!: (payload: string) => void;
    const receivedPayload = new Promise<string>((resolve) => {
      receivePayload = resolve;
    });
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        received += chunk.toString('utf8');
      });
      socket.on('end', () => receivePayload(received));
    });
    await listen(server, socketPath);

    try {
      await submitOwnerReport({
        socketPath,
        dm: { channelType: 'test-channel', platformId: 'destination-current' },
        report: 'Weekly report body',
      });

      const payload = JSON.parse((await receivedPayload).trim()) as Record<string, unknown>;
      expect(payload).toMatchObject({
        senderId: 'system:upstream-dry-run',
        sender: 'Upstream Dry Run',
        isMention: true,
        to: { channelType: 'test-channel', platformId: 'destination-current', threadId: 'destination-current' },
      });
      expect(payload.text).toContain('Please relay');
      expect(payload.text).toContain('Weekly report body');
    } finally {
      await close(server);
    }
  });

  it('surfaces socket connection errors', async () => {
    const socketPath = path.join(fixtureRoot(), 'missing.sock');

    await expect(
      submitOwnerReport({
        socketPath,
        dm: { channelType: 'test-channel', platformId: 'destination-current' },
        report: 'report',
      }),
    ).rejects.toThrow(/submission failed/);
  });

  it('surfaces a socket timeout when a connection never completes', async () => {
    const socket = new EventEmitter() as EventEmitter & { destroy: () => void; end: () => void };
    socket.destroy = vi.fn();
    socket.end = vi.fn();

    await expect(
      submitOwnerReport(
        {
          socketPath: 'pending.sock',
          dm: { channelType: 'test-channel', platformId: 'destination-current' },
          report: 'report',
          timeoutMs: 1,
        },
        () => socket as unknown as net.Socket,
      ),
    ).rejects.toThrow(/timed out/);
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  it('surfaces a socket error reported by the end callback', async () => {
    const socket = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      end: (payload: string, callback: (err?: Error | null) => void) => void;
    };
    socket.destroy = vi.fn();
    socket.end = (_payload, callback) => callback(new Error('write failed'));

    const submission = submitOwnerReport(
      {
        socketPath: 'failed.sock',
        dm: { channelType: 'test-channel', platformId: 'destination-current' },
        report: 'report',
      },
      () => socket as unknown as net.Socket,
    );
    socket.emit('connect');

    await expect(submission).rejects.toThrow(/write failed/);
    expect(socket.destroy).toHaveBeenCalledOnce();
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

  it('resolves a temporary owner DB and submits the generated report when requested', async () => {
    const root = fixtureRoot();
    createOwnerDb(path.join(root, 'data', 'v2.db'));
    const generateReport = vi.fn(() => 'Generated report');
    const submitReport = vi.fn().mockResolvedValue(undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await main(['--notify-owner'], root, { generateReport, submitReport });

    expect(submitReport).toHaveBeenCalledOnce();
    expect(submitReport).toHaveBeenCalledWith({
      socketPath: path.join(root, 'data', 'cli.sock'),
      dm: { channelType: 'test-channel', platformId: 'destination-newer' },
      report: 'Generated report',
    });
    expect(log).toHaveBeenNthCalledWith(1, 'Generated report');
    expect(log).toHaveBeenNthCalledWith(
      2,
      'upstream-dry-run-report: report submitted to the owner DM agent via the CLI socket; delivery is unconfirmed.',
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
