import { describe, expect, it } from 'vitest';

import { runManagedProcess } from './process.js';

describe('runManagedProcess', () => {
  it('escalates to SIGKILL when a process group ignores SIGTERM', async () => {
    if (process.platform === 'win32') return;
    const result = await runManagedProcess(
      process.execPath,
      [
        '-e',
        [
          "process.on('SIGTERM', () => {});",
          "process.stdout.write(String(process.pid) + '\\n');",
          'setInterval(() => {}, 1000);',
        ].join(''),
      ],
      // Leave enough startup headroom for the child to install its signal
      // handler even when Vitest is running the complete suite in parallel.
      { timeoutMs: 1_000, killGraceMs: 50 },
    );
    expect(result).toMatchObject({ exitCode: 137, terminationReason: 'timeout' });
    const childPid = Number(result.stdout.trim());
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it('delivers a payload too large for argv over stdin', async () => {
    // 200 KiB: over the 128 KiB Linux per-argument limit, under the backend's
    // 256 KiB batch ceiling. Passing this as an argument fails the spawn with
    // E2BIG before the child ever starts.
    const payload = 'x'.repeat(200 * 1024);
    const echoStdin = [
      'const chunks = [];',
      "process.stdin.on('data', (chunk) => chunks.push(chunk));",
      "process.stdin.on('end', () => process.stdout.write(String(Buffer.concat(chunks).length)));",
    ].join('');

    await expect(runManagedProcess(process.execPath, ['-e', echoStdin, payload])).rejects.toMatchObject({
      code: 'E2BIG',
    });

    const result = await runManagedProcess(process.execPath, ['-e', echoStdin], { stdin: payload });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(String(Buffer.byteLength(payload)));
  });

  it('handles an already-aborted signal without leaving a child running', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runManagedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      signal: controller.signal,
      killGraceMs: 25,
    });
    expect(result.terminationReason).toBe('aborted');
  });
});
