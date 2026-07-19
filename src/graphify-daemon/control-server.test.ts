import net from 'node:net';
import { lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GraphifyControlServer } from './control-server.js';
import type { GraphifyDaemonApi } from './types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeDaemon(): GraphifyDaemonApi {
  return {
    hasWorkgroup: (id) => id === 'wg',
    validateOverlayContext: vi.fn(),
    query: vi.fn(async () => ({ ok: 'query' }) as never),
    explain: vi.fn(async () => null),
    path: vi.fn(async () => null),
    affected: vi.fn(async () => ({ ok: 'affected' }) as never),
    status: vi.fn(() => ({ ok: 'status' }) as never),
    ensureFresh: vi.fn(async () => ({ ok: 'fresh' }) as never),
    markDirty: vi.fn(),
    reindex: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  };
}

async function request(path: string, payload: string): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    let text = '';
    socket.once('connect', () => socket.write(payload));
    socket.on('data', (chunk) => {
      text += chunk.toString();
      if (text.includes('\n')) socket.end();
    });
    socket.once('error', reject);
    socket.once('close', () => {
      try {
        resolve(JSON.parse(text.split('\n')[0]));
      } catch (error) {
        reject(error);
      }
    });
  });
}

describe('GraphifyControlServer', () => {
  it('test_control_socket_is_0600_and_rejects_oversized_request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'graphify-control-'));
    roots.push(root);
    const socketPath = join(root, 'private', 'graphify.sock');
    const server = new GraphifyControlServer(fakeDaemon(), { socketPath, maxRequestBytes: 128 });
    await server.start();
    expect(lstatSync(socketPath).mode & 0o777).toBe(0o600);
    const response = await request(
      socketPath,
      `${JSON.stringify({ id: 'too-big', workgroupId: 'wg', command: 'query', args: { query: 'x'.repeat(300) } })}\n`,
    );
    expect(response.ok).toBe(false);
    expect(String(response.error)).toMatch(/exceeds/);
    await server.close();
  });

  it('test_control_socket_rejects_cross_workgroup_agent_context', async () => {
    const root = mkdtempSync(join(tmpdir(), 'graphify-control-'));
    roots.push(root);
    const socketPath = join(root, 'graphify.sock');
    const daemon = fakeDaemon();
    vi.mocked(daemon.validateOverlayContext).mockRejectedValue(new Error('does not belong'));
    const server = new GraphifyControlServer(daemon, { socketPath });
    await server.start();
    const response = await request(
      socketPath,
      `${JSON.stringify({
        id: 'r-1',
        workgroupId: 'wg',
        command: 'query',
        args: { query: 'margin' },
        agentGroupId: 'foreign',
        sessionId: 's',
      })}\n`,
    );
    expect(response).toEqual({ id: 'r-1', ok: false, error: 'does not belong' });
    expect(daemon.query).not.toHaveBeenCalled();
    await server.close();
  });

  it('dispatches every CLI wire verb with its argument semantics', async () => {
    const root = mkdtempSync(join(tmpdir(), 'graphify-control-'));
    roots.push(root);
    const socketPath = join(root, 'graphify.sock');
    const daemon = fakeDaemon();
    vi.mocked(daemon.affected).mockResolvedValue({
      source: 'source',
      nodes: [{ id: 'n1' }, { id: 'n2' }],
      edges: [
        { from: 'source', to: 'n1' },
        { from: 'n1', to: 'n2' },
      ],
    } as never);
    const server = new GraphifyControlServer(daemon, { socketPath });
    await server.start();
    const calls: Array<[string, Record<string, unknown>]> = [
      ['query', { query: 'margin', limit: 7 }],
      ['path', { from: 'a', to: 'b', maxDepth: 4 }],
      ['explain', { node: 'label', depth: 3 }],
      ['affected', { node: 'label', depth: 4, limit: 1 }],
      ['status', {}],
      ['ensure-fresh', {}],
      ['reindex', { full: true }],
      ['pause', {}],
      ['resume', {}],
    ];
    const responses = [];
    for (const [command, args] of calls)
      responses.push(
        await request(socketPath, `${JSON.stringify({ id: `id-${command}`, workgroupId: 'wg', command, args })}\n`),
      );
    expect(responses.every((response) => response.ok === true)).toBe(true);
    expect(daemon.query).toHaveBeenCalledWith('wg', 'margin', 7, undefined);
    expect(daemon.path).toHaveBeenCalledWith('wg', 'a', 'b', 4, undefined);
    expect(daemon.explain).toHaveBeenCalledWith('wg', 'label', 3, undefined);
    expect(daemon.affected).toHaveBeenCalledWith('wg', 'label', 4, undefined);
    expect((responses[3].data as { edges: unknown[] }).edges).toHaveLength(1);
    expect(daemon.reindex).toHaveBeenCalledWith('wg', true);
    expect(daemon.pause).toHaveBeenCalledWith('wg');
    expect(daemon.resume).toHaveBeenCalledWith('wg');
    await server.close();
  });
});
