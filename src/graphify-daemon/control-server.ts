import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import net, { type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';

import type { ControlCommand, ControlRequest, GraphifyDaemonApi, TrustedOverlayContext } from './types.js';

const COMMANDS = new Set<ControlCommand>([
  'query',
  'path',
  'explain',
  'affected',
  'status',
  'ensure-fresh',
  'reindex',
  'pause',
  'resume',
]);
const ALLOWED_KEYS = new Set(['id', 'workgroupId', 'command', 'args', 'agentGroupId', 'sessionId']);

export interface GraphifyControlServerOptions {
  socketPath: string;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  requestTimeoutMs?: number;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`${label} must be a non-empty bounded string`);
  return value;
}
function integer(value: unknown, label: string, fallback?: number, max = 10_000): number | undefined {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max)
    throw new Error(`${label} must be a positive bounded integer`);
  return value as number;
}
function noExtraArgs(args: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`unsupported arguments: ${unknown.join(', ')}`);
}

function parseRequest(raw: string): ControlRequest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error('request must be valid JSON', { cause: error });
  }
  const request = object(value, 'request');
  const unknown = Object.keys(request).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknown.length) throw new Error(`unsupported request fields: ${unknown.join(', ')}`);
  const id = string(request.id, 'id', 256);
  const workgroupId = string(request.workgroupId, 'workgroupId', 256);
  const command = string(request.command, 'command', 64) as ControlCommand;
  if (!COMMANDS.has(command)) throw new Error(`unsupported Graphify command: ${command}`);
  const args = object(request.args, 'args');
  const agentGroupId =
    request.agentGroupId === undefined ? undefined : string(request.agentGroupId, 'agentGroupId', 256);
  const sessionId = request.sessionId === undefined ? undefined : string(request.sessionId, 'sessionId', 256);
  if (Boolean(agentGroupId) !== Boolean(sessionId))
    throw new Error('agentGroupId and sessionId must be supplied together');
  return { id, workgroupId, command, args, ...(agentGroupId ? { agentGroupId, sessionId } : {}) };
}

async function socketActive(path: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 250);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export class GraphifyControlServer {
  private server?: Server;
  private owned?: { dev: bigint; ino: bigint };
  private readonly maxRequest: number;
  private readonly maxResponse: number;

  constructor(
    private readonly daemon: GraphifyDaemonApi,
    private readonly options: GraphifyControlServerOptions,
  ) {
    this.maxRequest = integer(options.maxRequestBytes ?? 1024 * 1024, 'maxRequestBytes', undefined, 16 * 1024 * 1024)!;
    this.maxResponse = integer(
      options.maxResponseBytes ?? 4 * 1024 * 1024,
      'maxResponseBytes',
      undefined,
      16 * 1024 * 1024,
    )!;
  }

  async start(): Promise<void> {
    if (this.server) throw new Error('Graphify control server is already started');
    const parent = dirname(this.options.socketPath);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);
    try {
      const entry = await lstat(this.options.socketPath, { bigint: true });
      if (!entry.isSocket()) throw new Error(`refusing to replace non-socket path: ${this.options.socketPath}`);
      if (await socketActive(this.options.socketPath))
        throw new Error(`Graphify control socket is already active: ${this.options.socketPath}`);
      if (typeof process.getuid === 'function' && entry.uid !== BigInt(process.getuid()))
        throw new Error('refusing to remove a socket owned by another user');
      await rm(this.options.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const server = net.createServer((socket) => this.handle(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    await chmod(this.options.socketPath, 0o600);
    const entry = await lstat(this.options.socketPath, { bigint: true });
    this.owned = { dev: entry.dev, ino: entry.ino };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      const entry = await lstat(this.options.socketPath, { bigint: true });
      if (this.owned && entry.isSocket() && entry.dev === this.owned.dev && entry.ino === this.owned.ino)
        await rm(this.options.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.owned = undefined;
  }

  private handle(socket: Socket): void {
    let buffer = Buffer.alloc(0);
    let finished = false;
    const reply = (id: string | null, ok: boolean, value: unknown): void => {
      if (finished) return;
      finished = true;
      let encoded = Buffer.from(
        `${JSON.stringify(ok ? { id, ok: true, data: value } : { id, ok: false, error: String(value) })}\n`,
      );
      if (encoded.byteLength > this.maxResponse)
        encoded = Buffer.from(
          `${JSON.stringify({ id, ok: false, error: `response exceeds ${this.maxResponse} bytes` })}\n`,
        );
      socket.end(encoded);
    };
    socket.setTimeout(this.options.requestTimeoutMs ?? 30_000, () => reply(null, false, 'request timed out'));
    socket.on('data', (chunk: Buffer) => {
      if (finished) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > this.maxRequest) {
        reply(null, false, `request exceeds ${this.maxRequest} bytes`);
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      if (buffer.subarray(newline + 1).some((byte) => ![0x0a, 0x0d, 0x20, 0x09].includes(byte))) {
        reply(null, false, 'only one request is allowed per connection');
        return;
      }
      let parsed: ControlRequest;
      try {
        parsed = parseRequest(buffer.subarray(0, newline).toString('utf8'));
      } catch (error) {
        reply(null, false, error instanceof Error ? error.message : error);
        return;
      }
      void this.execute(parsed).then(
        (data) => reply(parsed.id, true, data),
        (error) => reply(parsed.id, false, error instanceof Error ? error.message : error),
      );
    });
    socket.once('error', () => {
      finished = true;
    });
  }

  private async execute(request: ControlRequest): Promise<unknown> {
    if (!this.daemon.hasWorkgroup(request.workgroupId)) throw new Error(`unknown workgroup: ${request.workgroupId}`);
    const context: TrustedOverlayContext | undefined =
      request.agentGroupId && request.sessionId
        ? { agentGroupId: request.agentGroupId, sessionId: request.sessionId }
        : undefined;
    if (context) await this.daemon.validateOverlayContext(request.workgroupId, context);
    const args = request.args;
    switch (request.command) {
      case 'query':
        noExtraArgs(args, ['query', 'limit']);
        return this.daemon.query(
          request.workgroupId,
          string(args.query, 'query'),
          integer(args.limit, 'limit'),
          context,
        );
      case 'explain':
        noExtraArgs(args, ['node', 'depth']);
        if (
          args.depth !== undefined &&
          (!Number.isSafeInteger(args.depth) || (args.depth as number) < 0 || (args.depth as number) > 5)
        )
          throw new Error('depth must be an integer from 0 to 5');
        return this.daemon.explain(
          request.workgroupId,
          string(args.node, 'node'),
          args.depth === undefined ? 2 : (args.depth as number),
          context,
        );
      case 'path':
        noExtraArgs(args, ['from', 'to', 'maxDepth']);
        return this.daemon.path(
          request.workgroupId,
          string(args.from, 'from'),
          string(args.to, 'to'),
          integer(args.maxDepth, 'maxDepth'),
          context,
        );
      case 'affected': {
        noExtraArgs(args, ['node', 'depth', 'limit']);
        const limit = integer(args.limit, 'limit', 100, 200)!;
        const value = (await this.daemon.affected(
          request.workgroupId,
          string(args.node, 'node'),
          integer(args.depth, 'depth', 6, 12),
          context,
        )) as unknown;
        if (value && typeof value === 'object' && Array.isArray((value as { nodes?: unknown }).nodes)) {
          const result = value as {
            source?: string;
            nodes: Array<{ id?: unknown }>;
            edges?: Array<{ from?: unknown; to?: unknown }>;
          };
          const nodes = result.nodes.slice(0, limit);
          const selected = new Set(nodes.map((node) => node.id).filter((id): id is string => typeof id === 'string'));
          if (result.source) selected.add(result.source);
          return {
            ...result,
            nodes,
            ...(result.edges
              ? {
                  edges: result.edges.filter(
                    (edge) =>
                      typeof edge.from === 'string' &&
                      typeof edge.to === 'string' &&
                      selected.has(edge.from) &&
                      selected.has(edge.to),
                  ),
                }
              : {}),
          };
        }
        return value;
      }
      case 'status':
        noExtraArgs(args, []);
        return this.daemon.statusAsync?.(request.workgroupId) ?? this.daemon.status(request.workgroupId);
      case 'ensure-fresh':
        noExtraArgs(args, []);
        return this.daemon.ensureFresh(request.workgroupId, undefined, context);
      case 'reindex':
        noExtraArgs(args, ['full']);
        if (args.full !== undefined && typeof args.full !== 'boolean') throw new Error('full must be boolean');
        await this.daemon.reindex(request.workgroupId, args.full === true);
        return this.daemon.statusAsync?.(request.workgroupId) ?? this.daemon.status(request.workgroupId);
      case 'pause':
        noExtraArgs(args, []);
        this.daemon.pause(request.workgroupId);
        return this.daemon.statusAsync?.(request.workgroupId) ?? this.daemon.status(request.workgroupId);
      case 'resume':
        noExtraArgs(args, []);
        this.daemon.resume(request.workgroupId);
        return this.daemon.statusAsync?.(request.workgroupId) ?? this.daemon.status(request.workgroupId);
    }
  }
}
