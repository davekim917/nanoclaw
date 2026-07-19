/**
 * Bounded, one-shot client for the host Graphify daemon.
 *
 * The daemon owns the socket and its permissions. Each connection carries one
 * newline-delimited JSON request and exactly one newline-delimited response.
 */
import { randomUUID } from 'crypto';
import net from 'net';
import path from 'path';

import { DATA_DIR } from '../config.js';

export const DEFAULT_GRAPHIFY_SOCKET_PATH = path.join(DATA_DIR, 'graphify', 'graphify.sock');
export const DEFAULT_GRAPHIFY_TIMEOUT_MS = 30_000;
export const MAX_GRAPHIFY_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_GRAPHIFY_REQUEST_BYTES = 1024 * 1024;

export type GraphifyCommand =
  | 'query'
  | 'path'
  | 'explain'
  | 'affected'
  | 'status'
  | 'ensure-fresh'
  | 'reindex'
  | 'pause'
  | 'resume';

export interface GraphifyClientRequest {
  workgroupId: string;
  command: GraphifyCommand;
  args: Record<string, unknown>;
  /** Trusted overlay context, supplied by the transport-owned caller context. */
  agentGroupId?: string;
  /** Trusted overlay context, supplied by the transport-owned caller context. */
  sessionId?: string;
}

export interface GraphifyWireRequest extends GraphifyClientRequest {
  id: string;
}

type GraphifyWireResponse =
  | { id: string; ok: true; data?: unknown }
  | { id: string; ok: false; error?: string | { message?: string } };

export interface GraphifyClientOptions {
  socketPath?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function daemonErrorMessage(response: Extract<GraphifyWireResponse, { ok: false }>): string {
  if (typeof response.error === 'string' && response.error.trim()) return response.error;
  if (
    response.error &&
    typeof response.error === 'object' &&
    typeof response.error.message === 'string' &&
    response.error.message.trim()
  ) {
    return response.error.message;
  }
  return 'request failed without an error message';
}

function parseResponse(line: Buffer, request: GraphifyWireRequest): unknown {
  let value: unknown;
  try {
    value = JSON.parse(line.toString('utf8'));
  } catch (error) {
    throw new Error(
      `malformed response from Graphify daemon: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!value || typeof value !== 'object') {
    throw new Error('malformed response from Graphify daemon: expected an object');
  }
  const response = value as Partial<GraphifyWireResponse>;
  if (response.id !== request.id) {
    throw new Error('malformed response from Graphify daemon: correlation id does not match request');
  }
  if (response.ok === true) return response.data;
  if (response.ok === false) {
    const failed = response as Extract<GraphifyWireResponse, { ok: false }>;
    throw new Error(`Graphify daemon rejected ${request.command}: ${daemonErrorMessage(failed)}`);
  }
  throw new Error('malformed response from Graphify daemon: missing boolean ok field');
}

function actionableTransportError(socketPath: string, error: Error & { code?: string }): Error {
  if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
    return new Error(`Graphify daemon unavailable at ${socketPath}: ${error.message}`, { cause: error });
  }
  return new Error(`Graphify daemon transport failed at ${socketPath}: ${error.message}`, { cause: error });
}

export async function sendGraphifyRequest(
  input: GraphifyClientRequest,
  options: GraphifyClientOptions = {},
): Promise<unknown> {
  const socketPath = options.socketPath ?? DEFAULT_GRAPHIFY_SOCKET_PATH;
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_GRAPHIFY_TIMEOUT_MS, 'Graphify timeout');
  const maxResponseBytes = positiveInteger(
    options.maxResponseBytes ?? MAX_GRAPHIFY_RESPONSE_BYTES,
    'Graphify maximum response size',
  );
  const request: GraphifyWireRequest = { id: randomUUID(), ...input };
  const encoded = Buffer.from(`${JSON.stringify(request)}\n`, 'utf8');
  if (encoded.byteLength > MAX_GRAPHIFY_REQUEST_BYTES) {
    throw new Error(`Graphify request exceeds ${MAX_GRAPHIFY_REQUEST_BYTES} bytes`);
  }

  return new Promise<unknown>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks: Buffer[] = [];
    let responseBytes = 0;
    let settled = false;

    const settle = (error?: Error, data?: unknown): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(data);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => socket.write(encoded));
    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      const newline = chunk.indexOf(0x0a);
      const payload = newline >= 0 ? chunk.subarray(0, newline) : chunk;
      responseBytes += payload.byteLength;
      if (responseBytes > maxResponseBytes) {
        settle(new Error(`Graphify daemon response exceeds ${maxResponseBytes} bytes`));
        return;
      }
      chunks.push(payload);
      if (newline < 0) return;
      try {
        settle(undefined, parseResponse(Buffer.concat(chunks, responseBytes), request));
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        settle(error);
      }
    });
    socket.once('timeout', () => {
      settle(new Error(`Graphify daemon request timed out after ${timeoutMs}ms`));
    });
    socket.once('error', (error) => settle(actionableTransportError(socketPath, error)));
    socket.once('close', () => {
      if (!settled) settle(new Error('Graphify daemon closed the connection before sending a response'));
    });
  });
}
