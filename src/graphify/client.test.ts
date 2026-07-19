import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { sendGraphifyRequest } from './client.js';

const roots: string[] = [];

async function socketServer(
  respond: (socket: net.Socket, request: Record<string, unknown>) => void,
): Promise<{ path: string; close: () => Promise<void> }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-graphify-client-'));
  roots.push(root);
  const socketPath = path.join(root, 'graphify.sock');
  const server = net.createServer((socket) => {
    let input = '';
    socket.on('data', (chunk) => {
      input += chunk.toString('utf8');
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      respond(socket, JSON.parse(input.slice(0, newline)) as Record<string, unknown>);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return {
    path: socketPath,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Graphify daemon socket client', () => {
  it('sends trusted overlay context and resolves a correlated response once', async () => {
    let observed: Record<string, unknown> | undefined;
    const server = await socketServer((socket, request) => {
      observed = request;
      socket.end(`${JSON.stringify({ id: request.id, ok: true, data: { ready: true } })}\n`);
    });
    try {
      await expect(
        sendGraphifyRequest(
          {
            workgroupId: 'wg-a',
            agentGroupId: 'ag-a',
            sessionId: 'sess-a',
            command: 'status',
            args: {},
          },
          { socketPath: server.path },
        ),
      ).resolves.toEqual({ ready: true });
      expect(observed).toMatchObject({
        workgroupId: 'wg-a',
        agentGroupId: 'ag-a',
        sessionId: 'sess-a',
        command: 'status',
        args: {},
      });
      expect(observed?.id).toEqual(expect.any(String));
    } finally {
      await server.close();
    }
  });

  it('test_graphify_client_rejects_oversized_response', async () => {
    const server = await socketServer((socket) => socket.end(`${'x'.repeat(33)}\n`));
    try {
      await expect(
        sendGraphifyRequest(
          { workgroupId: 'wg-a', command: 'status', args: {} },
          { socketPath: server.path, maxResponseBytes: 32 },
        ),
      ).rejects.toThrow(/exceeds 32 bytes/i);
    } finally {
      await server.close();
    }
  });

  it('test_graphify_client_rejects_malformed_response', async () => {
    const server = await socketServer((socket) => socket.end('{not-json}\n'));
    try {
      await expect(
        sendGraphifyRequest({ workgroupId: 'wg-a', command: 'status', args: {} }, { socketPath: server.path }),
      ).rejects.toThrow(/malformed response from Graphify daemon/i);
    } finally {
      await server.close();
    }
  });

  it('rejects an early close with an actionable error', async () => {
    const server = await socketServer((socket) => socket.end());
    try {
      await expect(
        sendGraphifyRequest({ workgroupId: 'wg-a', command: 'status', args: {} }, { socketPath: server.path }),
      ).rejects.toThrow(/closed the connection before sending a response/i);
    } finally {
      await server.close();
    }
  });

  it('uses the explicit unavailable marker only for a missing daemon socket', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-graphify-client-'));
    roots.push(root);
    await expect(
      sendGraphifyRequest(
        { workgroupId: 'wg-a', command: 'status', args: {} },
        { socketPath: path.join(root, 'missing.sock') },
      ),
    ).rejects.toThrow(/Graphify daemon unavailable/);
  });

  it('rejects a response with the wrong correlation id', async () => {
    const server = await socketServer((socket) =>
      socket.end(`${JSON.stringify({ id: 'another-request', ok: true, data: {} })}\n`),
    );
    try {
      await expect(
        sendGraphifyRequest({ workgroupId: 'wg-a', command: 'status', args: {} }, { socketPath: server.path }),
      ).rejects.toThrow(/correlation id does not match/i);
    } finally {
      await server.close();
    }
  });
});
