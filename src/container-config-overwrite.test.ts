/**
 * `writeContainerConfig` refusing to normalize away a document nobody agreed to
 * discard.
 *
 * `readContainerConfig` is tolerant on purpose: it reads every field and
 * defaults what it cannot understand, so a group whose model is unreadable
 * still boots. Every writer here is read-modify-write, and the spawn path runs
 * one on every spawn (`ensureRuntimeFields`, `src/container-runner.ts`), so
 * composed they turn a root the reader could not understand into a materialized
 * default written back over the operator's file — BEFORE any container reads
 * the mount. The fail-closed reader in the container
 * (`container/agent-runner/src/excluded-plugins.ts`) never sees that root and
 * never gets to refuse it.
 *
 * The property under test is therefore about the host write, not the container
 * read: a file whose root carries fields the reader drops must not be
 * overwritten with the reader's idea of it.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dirs = vi.hoisted(() => {
  const testRoot = uniqueTmpRoot('container-config-overwrite-test');
  return { TEST_ROOT: testRoot, GROUPS_DIR: `${testRoot}/groups`, DATA_DIR: `${testRoot}/data` };
});

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  GROUPS_DIR: dirs.GROUPS_DIR,
  DATA_DIR: dirs.DATA_DIR,
}));

import { readContainerConfig, updateContainerConfig, writeContainerConfig } from './container-config.js';
import type { ContainerConfig } from './container-config.js';

/** The smallest complete config — every required field, nothing else. */
const baseConfig = (): ContainerConfig => ({
  groupName: 'probe',
  mcpServers: {},
  packages: { apt: [], npm: [] },
  additionalMounts: [],
  skills: 'all',
});

const FOLDER = 'probe';
const configFile = (): string => path.join(dirs.GROUPS_DIR, FOLDER, 'container.json');

beforeEach(() => {
  fs.mkdirSync(path.join(dirs.GROUPS_DIR, FOLDER), { recursive: true });
});

afterEach(() => {
  fs.rmSync(dirs.TEST_ROOT, { recursive: true, force: true });
});

describe('writeContainerConfig refuses to overwrite a non-object root', () => {
  it('REFUSES the array-wrapping-a-real-config shape, leaving the operator bytes intact', () => {
    // The reachable case: the exclusions are right there in the file, and the
    // tolerant reader answers "no exclusions" for them.
    const original = JSON.stringify([{ excludePlugins: ['bootstrap/plugins/orchestrate'] }]);
    fs.writeFileSync(configFile(), original);

    expect(() => updateContainerConfig(FOLDER, (c) => void (c.groupName = 'probe'))).toThrow(
      /refusing to overwrite .*root is a JSON array/,
    );
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(original);
  });

  it('REFUSES every other non-object root that parses', () => {
    for (const [raw, shape] of [
      ['42', 'number'],
      ['"oops"', 'string'],
      ['true', 'boolean'],
      ['null', 'null'],
    ] as const) {
      fs.writeFileSync(configFile(), raw);
      expect(() => writeContainerConfig(FOLDER, baseConfig())).toThrow(new RegExp(`root is a JSON ${shape}`));
      expect(fs.readFileSync(configFile(), 'utf8')).toBe(raw);
    }
  });

  it('writes normally over an object root, and over no file at all', () => {
    fs.writeFileSync(configFile(), JSON.stringify({ excludePlugins: ['bootstrap'] }));
    writeContainerConfig(FOLDER, { ...baseConfig(), excludePlugins: ['bootstrap'] });
    expect(readContainerConfig(FOLDER).excludePlugins).toEqual(['bootstrap']);

    fs.rmSync(configFile());
    writeContainerConfig(FOLDER, baseConfig());
    expect(readContainerConfig(FOLDER).groupName).toBe('probe');
  });

  it('still writes over bytes that do not parse at all — no structure to have lost a field from', () => {
    // Deliberately NOT refused: a file that is not JSON has no fields the
    // reader dropped, and refusing here would leave a group with a corrupt
    // config no repair path could rewrite.
    fs.writeFileSync(configFile(), '{ this is not json');
    writeContainerConfig(FOLDER, baseConfig());
    expect(readContainerConfig(FOLDER).groupName).toBe('probe');
  });
});
