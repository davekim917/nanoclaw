/** Client half of the constrained Claude review launcher. */
import net from 'node:net';

import {
  CLAUDE_REVIEW_SOCKET_ENV,
  isClaudeReviewResponse,
  MAX_CLAUDE_REVIEW_PROMPT_BYTES,
  MAX_CLAUDE_REVIEW_REQUEST_BYTES,
  MAX_CLAUDE_REVIEW_RESPONSE_BYTES,
  parseClaudeReviewArgs,
  toClaudeReviewWireRequest,
  type ClaudeReviewRequest,
  type ClaudeReviewResponse,
} from './claude-review-contract.js';

async function readBoundedStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_CLAUDE_REVIEW_PROMPT_BYTES) {
      throw new Error(`stdin exceeds ${MAX_CLAUDE_REVIEW_PROMPT_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

export async function requestClaudeReview(
  socketPath: string,
  request: ClaudeReviewRequest,
): Promise<ClaudeReviewResponse> {
  const payload = Buffer.from(JSON.stringify(toClaudeReviewWireRequest(request)), 'utf8');
  if (payload.byteLength > MAX_CLAUDE_REVIEW_REQUEST_BYTES) {
    throw new Error(`request exceeds ${MAX_CLAUDE_REVIEW_REQUEST_BYTES} bytes`);
  }
  return await new Promise<ClaudeReviewResponse>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks: Buffer[] = [];
    let size = 0;
    socket.setNoDelay(true);
    socket.on('connect', () => socket.write(Buffer.concat([payload, Buffer.from('\n')])));
    socket.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_CLAUDE_REVIEW_RESPONSE_BYTES) {
        socket.destroy();
        reject(new Error('response exceeds launcher limit'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    socket.once('error', (err) => reject(err));
    socket.once('close', () => reject(new Error('runner review service disconnected')));
    socket.once('end', () => {
      try {
        const response: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)),
        );
        if (!isClaudeReviewResponse(response)) throw new Error('invalid response');
        resolve(response);
      } catch {
        reject(new Error('invalid launcher response'));
      }
    });
  });
}

async function main(): Promise<void> {
  const [mode, ...argv] = process.argv.slice(2);
  if (mode === '--nanoclaw-review-eligible') {
    process.exitCode = parseClaudeReviewArgs(argv) ? 0 : 64;
    return;
  }
  if (mode !== '--nanoclaw-review') {
    process.stderr.write('claude review launcher: internal invocation error\n');
    process.exitCode = 2;
    return;
  }
  const args = parseClaudeReviewArgs(argv);
  if (!args) {
    process.stderr.write('claude review launcher: unsafe review invocation\n');
    process.exitCode = 2;
    return;
  }
  const socketPath = process.env[CLAUDE_REVIEW_SOCKET_ENV];
  if (!socketPath) {
    process.stderr.write('claude review launcher: runner review service is unavailable\n');
    process.exitCode = 2;
    return;
  }
  try {
    const stdin = await readBoundedStdin();
    const response = await requestClaudeReview(socketPath, { ...args, stdin, cwd: process.cwd() });
    if (response.stdout) process.stdout.write(response.stdout);
    if (response.stderr) process.stderr.write(response.stderr);
    process.exitCode = response.exitCode;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'request failed';
    process.stderr.write(`claude review launcher: ${message}\n`);
    process.exitCode = 2;
  }
}

if (import.meta.main) void main();
