import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_CLAUDE_REVIEW_OUTPUT_BYTES,
  MAX_CLAUDE_REVIEW_REQUEST_BYTES,
  reviewCliArgs,
  type ClaudeReviewRequest,
  type ClaudeReviewResponse,
  validateClaudeReviewRequest,
} from './claude-review-contract.js';
import { isPreInferenceCredentialFailure } from '../providers/claude-review-classification.js';
import { ANTHROPIC_KEY_RE, OAUTH_KEY_RE } from '../providers/secret-env.js';

interface CredentialSlot {
  name: string;
  value: string;
  envName: 'ANTHROPIC_API_KEY' | 'CLAUDE_CODE_OAUTH_TOKEN';
}

interface RunningReview {
  cancel: (reason: string) => void;
  done: Promise<void>;
}

export interface ClaudeReviewService {
  readonly socketPath: string;
  stop(): Promise<void>;
}

export interface ClaudeReviewServiceOptions {
  executable?: string;
  /** Evaluated per request: native provider rotation updates process.env. */
  getEnv?: () => NodeJS.ProcessEnv;
  socketParent?: string;
  onDiagnostic?: (message: string) => void;
}

function credentialRing(env: NodeJS.ProcessEnv): CredentialSlot[] {
  const family: CredentialSlot['envName'] | null = env.ANTHROPIC_API_KEY
    ? 'ANTHROPIC_API_KEY'
    : env.CLAUDE_CODE_OAUTH_TOKEN
      ? 'CLAUDE_CODE_OAUTH_TOKEN'
      : null;
  if (!family) return [];

  const fallback = family === 'ANTHROPIC_API_KEY' ? /^ANTHROPIC_API_KEY_(\d+)$/ : /^CLAUDE_CODE_OAUTH_TOKEN_(\d+)$/;
  const slots = [
    { name: family, value: env[family] ?? '', envName: family },
    ...Object.entries(env)
      .filter(([name, value]) => fallback.test(name) && typeof value === 'string' && value.length > 0)
      .sort(([left], [right]) => Number(left.match(fallback)![1]) - Number(right.match(fallback)![1]))
      .map(([name, value]) => ({ name, value: value!, envName: family })),
  ];
  const seen = new Set<string>();
  return slots.filter((slot) => {
    // OneCLI uses placeholder as an intentional non-credential sentinel.
    if (!slot.value || slot.value === 'placeholder' || seen.has(slot.value)) return false;
    seen.add(slot.value);
    return true;
  });
}

function childEnv(snapshot: NodeJS.ProcessEnv, slot: CredentialSlot | undefined): NodeJS.ProcessEnv {
  const env = { ...snapshot };
  if (!slot) return env;
  for (const name of Object.keys(env)) {
    if (ANTHROPIC_KEY_RE.test(name) || OAUTH_KEY_RE.test(name)) delete env[name];
  }
  env[slot.envName] = slot.value;
  return env;
}

function redact(value: string, slots: readonly CredentialSlot[]): string {
  let redacted = value;
  for (const slot of slots) {
    if (slot.value) redacted = redacted.split(slot.value).join('[redacted]');
  }
  return redacted;
}

function cliReportedError(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stdout) as { is_error?: unknown };
    return parsed?.is_error === true;
  } catch {
    return false;
  }
}

function writeResponse(socket: net.Socket, response: ClaudeReviewResponse): void {
  if (socket.destroyed) return;
  socket.end(JSON.stringify(response));
}

function protocolFailure(socket: net.Socket, message: string): void {
  writeResponse(socket, { exitCode: 2, stdout: '', stderr: `claude review launcher: ${message}\n` });
}

async function terminateChildTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  // The pnpm shim normally execs node, but kill the process group as well so a
  // future shim cannot leave a review subprocess behind after disconnect.
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  await new Promise<void>((resolve) =>
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      resolve();
    }, 1000),
  );
}

async function runAttempt(
  executable: string,
  request: ClaudeReviewRequest,
  env: NodeJS.ProcessEnv,
  slots: readonly CredentialSlot[],
  onRunning: (running: RunningReview) => void,
): Promise<{ response: ClaudeReviewResponse; cancelled: boolean; limitExceeded: boolean }> {
  let child: ChildProcess;
  try {
    child = spawn(executable, reviewCliArgs(request), {
      cwd: request.cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return {
      response: { exitCode: 127, stdout: '', stderr: 'claude review launcher: unable to start original CLI\n' },
      cancelled: false,
      limitExceeded: false,
    };
  }

  let cancelled = false;
  let termination: Promise<void> | undefined;
  let limitExceeded = false;
  let outputBytes = 0;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let settleDone!: () => void;
  const done = new Promise<void>((resolve) => {
    settleDone = resolve;
  });
  onRunning({
    cancel(reason) {
      if (cancelled) return;
      cancelled = true;
      termination = terminateChildTree(child);
      void reason;
    },
    done,
  });

  const collect = (target: Buffer[]) => (chunk: Buffer) => {
    if (cancelled) return;
    outputBytes += chunk.byteLength;
    if (outputBytes > MAX_CLAUDE_REVIEW_OUTPUT_BYTES) {
      limitExceeded = true;
      cancelled = true;
      termination = terminateChildTree(child);
      return;
    }
    target.push(Buffer.from(chunk));
  };
  child.stdout?.on('data', collect(stdout));
  child.stderr?.on('data', collect(stderr));

  let spawnFailed = false;
  const result = await new Promise<{ exitCode: number }>((resolve) => {
    child.once('error', () => {
      spawnFailed = true;
      resolve({ exitCode: 127 });
    });
    child.once('close', (code, signal) =>
      resolve({
        exitCode:
          typeof code === 'number'
            ? code
            : 128 + (os.constants.signals[signal as keyof typeof os.constants.signals] ?? 1),
      }),
    );
    child.stdin?.on('error', () => undefined); // Early quota/CLI exit may close stdin.
    child.stdin?.end(request.stdin);
  });
  await termination;
  settleDone();
  if (limitExceeded) {
    return {
      response: { exitCode: 1, stdout: '', stderr: 'claude review launcher: CLI output exceeded 16777216 bytes\n' },
      cancelled: false,
      limitExceeded: true,
    };
  }
  if (cancelled) {
    return { response: { exitCode: 1, stdout: '', stderr: '' }, cancelled: true, limitExceeded: false };
  }
  const output = redact(Buffer.concat(stdout).toString('utf8'), slots);
  const errors = spawnFailed
    ? 'claude review launcher: unable to start original CLI\n'
    : redact(Buffer.concat(stderr).toString('utf8'), slots);
  return {
    response: {
      // A JSON error must never look successful to the review gate even if a
      // future CLI release accidentally exits zero for its error envelope.
      exitCode: cliReportedError(output) && result.exitCode === 0 ? 1 : result.exitCode,
      stdout: output,
      stderr: errors,
    },
    cancelled: false,
    limitExceeded: false,
  };
}

export async function startClaudeReviewService(options: ClaudeReviewServiceOptions = {}): Promise<ClaudeReviewService> {
  const privateDir = fs.mkdtempSync(path.join(options.socketParent ?? os.tmpdir(), 'nanoclaw-claude-review-'));
  fs.chmodSync(privateDir, 0o700);
  const socketPath = path.join(privateDir, 'review.sock');
  const executable = options.executable ?? '/pnpm/claude-real';
  const getEnv = options.getEnv ?? (() => process.env);
  const sockets = new Set<net.Socket>();
  const running = new Set<RunningReview>();
  let stopping = false;

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    let inputBytes = 0;
    const chunks: Buffer[] = [];
    let active: RunningReview | undefined;

    let submitted = false;
    let disconnected = false;
    const execute = async (payload: Buffer) => {
      let request: ClaudeReviewRequest;
      try {
        request = validateClaudeReviewRequest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)));
      } catch {
        protocolFailure(socket, 'invalid request');
        return;
      }

      const snapshot = { ...getEnv() };
      const slots = credentialRing(snapshot);
      const diagnostics: string[] = [];
      for (let index = 0; index < Math.max(slots.length, 1); index++) {
        if (disconnected || stopping || socket.destroyed) return;
        const slot = slots[index];
        const attempt = await runAttempt(executable, request, childEnv(snapshot, slot), slots, (item) => {
          active = item;
          running.add(item);
        });
        if (active) running.delete(active);
        active = undefined;
        if (attempt.limitExceeded) {
          writeResponse(socket, attempt.response);
          return;
        }
        if (attempt.cancelled || disconnected || stopping || socket.destroyed) return;
        if (index < slots.length - 1 && isPreInferenceCredentialFailure(attempt.response.stdout)) {
          const message = `Claude review credential ${slot.name} hit a pre-inference limit; retrying ${slots[index + 1].name}`;
          diagnostics.push(message);
          options.onDiagnostic?.(message);
          continue;
        }
        attempt.response.stderr =
          diagnostics.map((line) => `[claude-review] ${line}\n`).join('') + attempt.response.stderr;
        writeResponse(socket, attempt.response);
        return;
      }
    };
    // Newline frames one JSON request. EOF remains a cancellation after upload.
    socket.on('data', (chunk: Buffer) => {
      if (submitted) {
        active?.cancel('extra request data');
        socket.destroy();
        return;
      }
      inputBytes += chunk.byteLength;
      if (inputBytes > MAX_CLAUDE_REVIEW_REQUEST_BYTES + 1) {
        submitted = true;
        chunks.length = 0;
        protocolFailure(socket, 'request exceeds launcher limit');
        return;
      }
      const newline = chunk.indexOf(10);
      chunks.push(Buffer.from(chunk));
      if (newline === -1) return;
      submitted = true;
      if (newline !== chunk.length - 1) {
        protocolFailure(socket, 'invalid request framing');
        return;
      }
      const payload = Buffer.concat(chunks, inputBytes).subarray(0, -1);
      chunks.length = 0;
      void execute(payload).catch(() => protocolFailure(socket, 'review execution failed'));
    });
    socket.on('end', () => {
      disconnected = true;
      active?.cancel('client disconnected');
    });
    socket.on('close', () => {
      disconnected = true;
      sockets.delete(socket);
      if (active) active.cancel('client disconnected');
    });
    socket.on('error', () => undefined);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    fs.chmodSync(socketPath, 0o600);
  } catch (error) {
    server.close();
    fs.rmSync(privateDir, { recursive: true, force: true });
    throw error;
  }

  return {
    socketPath,
    async stop() {
      if (stopping) return;
      stopping = true;
      for (const item of running) item.cancel('runner stopping');
      for (const socket of sockets) socket.destroy();
      await Promise.all([...running].map((item) => item.done));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(privateDir, { recursive: true, force: true });
    },
  };
}
