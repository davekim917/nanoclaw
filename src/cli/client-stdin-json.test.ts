import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../test-hermeticity.js';
import { main } from './client.js';
import { MAX_STDIN_JSON_BYTES, type StdinJsonStream } from './stdin-json.js';

allowSubprocess([path.basename(process.execPath)]);
enforceHermeticity();

function ttyStream(): StdinJsonStream & { isTTY: true } {
  return Object.assign((async function* () {})(), { isTTY: true as const });
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [
    'ALL_PROXY',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'NODE_USE_ENV_PROXY',
    'all_proxy',
    'https_proxy',
    'http_proxy',
    'no_proxy',
  ]) {
    delete env[name];
  }
  return env;
}

function runClient(input: string | Uint8Array) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli/client.ts', 'groups', 'list', '--stdin-json'],
    { cwd: process.cwd(), encoding: 'utf8', env: childEnv(), input },
  );
}

afterEach(() => vi.restoreAllMocks());

describe('host CLI --stdin-json entry point', () => {
  it('exits 2 for a TTY instead of reading until Ctrl-D', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(main(['groups', 'list', '--stdin-json'], ttyStream())).rejects.toThrow('exit:2');

    expect(stderr).toHaveBeenCalledWith('ncl: --stdin-json requires piped stdin (e.g. `echo {...} | ncl ...`)\n');
    expect(exit).toHaveBeenCalledWith(2);
  });

  it.each([
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

  it('exits 2 for invalid UTF-8 instead of replacing malformed bytes', () => {
    const result = runClient(Buffer.concat([Buffer.from('{"value":"'), Buffer.from([0xc3]), Buffer.from('"}')]));

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('ncl: --stdin-json input is not valid UTF-8\n');
  });
  it.each(['--proto--', '__proto--', '--proto__', '_-proto-_'])(
    'rejects prototype key alias %s before dispatch',
    (key) => {
      const result = runClient(JSON.stringify({ [key]: { cli_scope: 'global' } }));

      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(`ncl: --stdin-json key "${key}" is not allowed\n`);
    },
  );

});
