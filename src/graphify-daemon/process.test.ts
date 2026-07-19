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
