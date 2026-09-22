/**
 * A Codex model id the pinned CLI cannot request fails every turn at runtime
 * (HTTP 400 "not supported when using Codex with a ChatGPT account" for
 * gpt-6-sol on codex-cli 0.154.0, measured 2026-09-22) and nothing at build
 * time notices. This ties the fleet default and the family aliases to the
 * minimum codex-cli that serves them, against the pin the image installs
 * (versions.json `codex-cli`, itself tied to the Dockerfile by
 * image-version-pins.test.ts).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

import { vocabFor } from '../../src/flag-parser.js';
import { readVersionPin } from './version-pins.js';

// Minimum codex-cli per model id, measured with `codex exec -m <id>` under
// ChatGPT-account auth. Add a row when a default or alias moves to a new id.
const MIN_CODEX_CLI: Record<string, string> = {
  'gpt-6-sol': '0.155.1',
  'gpt-6-luna': '0.155.1',
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const codexTs = fs.readFileSync(path.join(root, 'container', 'agent-runner', 'src', 'providers', 'codex.ts'), 'utf-8');
const defaultModel = codexTs.match(/export const DEFAULT_CODEX_MODEL = '([^']+)'/)?.[1];

const semver = (v: string) => v.split('.').map(Number);
const atLeast = (have: string, need: string) => {
  const [a, b] = [semver(have), semver(need)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

describe('the pinned codex-cli serves every Codex model the fleet defaults to', () => {
  const pinned = readVersionPin('codex-cli');

  it('finds DEFAULT_CODEX_MODEL', () => {
    expect(defaultModel).toMatch(/^gpt-/);
  });

  it.each([
    ['DEFAULT_CODEX_MODEL', () => defaultModel!],
    ['alias sol', () => vocabFor('codex').resolveModel('sol')],
    ['alias luna', () => vocabFor('codex').resolveModel('luna')],
    ['alias terra', () => vocabFor('codex').resolveModel('terra')],
    ['alias astra', () => vocabFor('codex').resolveModel('astra')],
  ])('%s is served by the pinned codex-cli', (_label, id) => {
    const need = MIN_CODEX_CLI[id()];
    if (need) expect(atLeast(pinned, need), `${id()} needs codex-cli >= ${need}, pinned ${pinned}`).toBe(true);
  });

  it('refuses a pin below a model minimum (mutation guard)', () => {
    expect(atLeast('0.154.0', MIN_CODEX_CLI['gpt-6-sol'])).toBe(false);
    expect(atLeast('0.156.0', MIN_CODEX_CLI['gpt-6-sol'])).toBe(true);
  });
});
