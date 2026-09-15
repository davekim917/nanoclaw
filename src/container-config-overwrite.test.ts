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

import {
  initContainerConfig,
  readContainerConfig,
  updateContainerConfig,
  writeContainerConfig,
} from './container-config.js';
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

  it('REFUSES bytes that do not parse at all — a truncated write is the realistic corruption', () => {
    // This case was carved OUT in the first version of this guard, on the
    // ground that a corrupt file would otherwise have no repair path. The
    // third substitute pass argued it back in and was right: a truncated write
    // leaves the entries visibly in the file, the tolerant reader answers
    // "none", and nothing distinguishes that from any other parse failure.
    // Automatic replacement was never a repair path — every writer is
    // read-modify-write over that reader (`updateContainerConfig`,
    // `ensureRuntimeFields`, `applyOptOut`), so each would persist the
    // reader's guess. Repair is a person editing the file.
    const truncated = '{"excludePlugins": ["bootstrap/plugins/orchestrate"],';
    fs.writeFileSync(configFile(), truncated);
    expect(() => writeContainerConfig(FOLDER, baseConfig())).toThrow(/not valid JSON/);
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(truncated);
  });

  it('distinguishes ABSENCE from a failed read — the one state that may be overwritten', () => {
    // A directory at the config path cannot be read as a file, and might have
    // been anything; absence is the only state that provably holds no field.
    fs.rmSync(configFile(), { force: true });
    fs.mkdirSync(configFile());
    expect(() => writeContainerConfig(FOLDER, baseConfig())).toThrow(/could not be read/);
    fs.rmdirSync(configFile());
    writeContainerConfig(FOLDER, baseConfig());
    expect(readContainerConfig(FOLDER).groupName).toBe('probe');
  });

  it('leaves first-time initialization alone — initContainerConfig never writes over a file', () => {
    // The only caller that legitimately CREATES a config returns before
    // writing when one exists, so a refused overwrite cannot wedge setup.
    fs.rmSync(configFile(), { force: true });
    expect(initContainerConfig(FOLDER)).toBe(true);
    fs.writeFileSync(configFile(), '{ truncated');
    expect(initContainerConfig(FOLDER)).toBe(false);
    expect(fs.readFileSync(configFile(), 'utf8')).toBe('{ truncated');
  });
});
