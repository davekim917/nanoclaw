import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, spyOn, test } from 'bun:test';

import { allowSubprocess } from '../test-hermeticity.js';
import { main } from './ncl.js';
import { MAX_STDIN_JSON_BYTES, type StdinJsonStream } from './stdin-json.js';

allowSubprocess([path.basename(process.execPath)]);

function ttyStream(): StdinJsonStream & { isTTY: true } {
  return Object.assign((async function* () {})(), { isTTY: true as const });
}

function runClient(input: string) {
  return spawnSync(process.execPath, ['src/cli/ncl.ts', 'groups', 'list', '--stdin-json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    input,
  });
}

describe('container CLI --stdin-json entry point', () => {
  test('exits 2 for a TTY instead of reading until Ctrl-D', async () => {
    const priorExitCode = process.exitCode;
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      process.exitCode = 0;
      await main(['groups', 'list', '--stdin-json'], ttyStream());

      expect(stderr).toHaveBeenCalledWith('ncl: --stdin-json requires piped stdin (e.g. `echo {...} | ncl ...`)\n');
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = priorExitCode ?? 0;
      stderr.mockRestore();
    }
  });

  test.each([
    ['malformed input', '{"broken":', '--stdin-json input is not valid JSON'],
    [
      'oversized input',
      `{"payload":"${'a'.repeat(MAX_STDIN_JSON_BYTES)}"}`,
      `--stdin-json input exceeds ${MAX_STDIN_JSON_BYTES} bytes`,
    ],
  ])('exits 2 for %s', (_name, input, expectedError) => {
    const result = runClient(input);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`ncl: ${expectedError}\n`);
  });
});
