import { spawn } from 'node:child_process';

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  terminationReason?: 'aborted' | 'timeout' | 'output_limit';
}

export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
  /**
   * Written to the child's stdin, which is then closed. Payloads too large for
   * a single argv entry (Linux caps one argument at 128 KiB) must come through
   * here — passing them as arguments fails the spawn outright with E2BIG.
   */
  stdin?: string;
}

export type ProcessRun = (command: string, args: string[], options?: ProcessOptions) => Promise<ProcessResult>;

export const runManagedProcess: ProcessRun = async (command, args, options = {}) =>
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: process.platform !== 'win32',
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const maxBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let terminationReason: ProcessResult['terminationReason'];
    let terminating = false;

    const signalChild = (signal: NodeJS.Signals): void => {
      if (settled || !child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    const terminate = (): void => {
      if (terminating || settled) return;
      terminating = true;
      signalChild('SIGTERM');
      killTimer = setTimeout(() => signalChild('SIGKILL'), options.killGraceMs ?? 2_000);
      killTimer.unref();
    };
    const onAbort = (): void => {
      terminationReason = 'aborted';
      terminate();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        terminationReason = 'timeout';
        terminate();
      }, options.timeoutMs);
      timeout.unref();
    }
    const collect = (target: Buffer[], chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        terminationReason = 'output_limit';
        terminate();
        return;
      }
      target.push(chunk);
    };
    // stdout/stderr are always 'pipe' above; only stdin varies.
    child.stdout!.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr!.on('data', (chunk: Buffer) => collect(stderr, chunk));
    if (options.stdin !== undefined && child.stdin) {
      // A child that exits before draining stdin gives us EPIPE; that is the
      // child's exit to report, not a spawn failure, so swallow it here.
      child.stdin.on('error', () => {});
      child.stdin.end(options.stdin);
    }
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode: code ?? (signal === 'SIGKILL' ? 137 : signal === 'SIGTERM' ? 143 : 1),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        ...(terminationReason ? { terminationReason } : {}),
      });
    });
  });
