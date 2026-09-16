/**
 * #840 — `groups/<folder>/container.json` has ONE owning mutation primitive,
 * and it is exclusive across processes.
 *
 * The defect: four writers, three of them read-modify-write over the tolerant
 * `readContainerConfig`, with no lock, version or compare-and-swap anywhere.
 * Process A reads; process B writes; A writes its stale object back and B's
 * change is gone, with no error and no reader downstream able to tell. The
 * field that made that more than a config annoyance is `excludePlugins`:
 * losing it silently re-enables a plugin an operator withheld from a group.
 *
 * The tests below are written as the LOST UPDATE, not as "the lock exists":
 * two mutations touching two different fields must BOTH survive. That property
 * fails against the pre-fix code and cannot be satisfied by any amount of
 * narrowing the window.
 */
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dirs = vi.hoisted(() => {
  const testRoot = uniqueTmpRoot('container-config-lock-test');
  return { TEST_ROOT: testRoot, GROUPS_DIR: `${testRoot}/groups`, DATA_DIR: `${testRoot}/data` };
});

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  GROUPS_DIR: dirs.GROUPS_DIR,
  DATA_DIR: dirs.DATA_DIR,
}));

import {
  containerConfigLockPath,
  readContainerConfig,
  updateContainerConfig,
  writeContainerConfig,
} from './container-config.js';

const FOLDER = 'probe';
const configFile = (): string => path.join(dirs.GROUPS_DIR, FOLDER, 'container.json');

beforeEach(() => {
  fs.mkdirSync(path.join(dirs.GROUPS_DIR, FOLDER), { recursive: true });
  writeContainerConfig(FOLDER, {
    groupName: 'probe',
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all',
    excludePlugins: ['withheld-plugin'],
  });
});

afterEach(() => {
  fs.rmSync(dirs.TEST_ROOT, { recursive: true, force: true });
});

describe('mutations of container.json are serialized', () => {
  it('THE LOST UPDATE: a separate process’s excludePlugins write survives a concurrent identity write', async () => {
    // The issue's exact scenario, and the only shape that reproduces it. Two
    // in-process calls with synchronous mutators cannot interleave at all —
    // JavaScript runs each read-mutate-write to completion — so an in-process
    // test would pass against the pre-fix code and prove nothing. One of the
    // four writers is a hand-run script (`scripts/enable-agent-plugin.ts`),
    // which is why the primitive has to be exclusive ACROSS PROCESSES.
    //
    // The holder below takes the group's lock, waits, then appends an
    // exclusion — standing in for `applyOptOut`. Meanwhile this process runs
    // the spawn path's identity write. Pre-fix, this process reads before the
    // holder writes and commits after it, and `second-withheld` is gone with
    // no error anywhere: a plugin the operator withheld is silently
    // re-enabled. Post-fix the identity write waits, reads the holder's
    // committed file, and both land.
    const lock = containerConfigLockPath(FOLDER);
    // The lock lives under DATA_DIR, not beside the config: `groups/<folder>/`
    // is bind-mounted into the container, and a lock the agent can delete would
    // turn `withFileLock`'s inode check into a refused spawn.
    expect(lock.startsWith(dirs.DATA_DIR)).toBe(true);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, '');
    const ready = path.join(dirs.TEST_ROOT, 'holder-ready');
    const inner = path.join(dirs.TEST_ROOT, 'holder.sh');
    // Under the lock: announce, dawdle, then append an exclusion. The dawdle
    // is what puts this process's read-mutate-write inside the holder's
    // critical section rather than merely after it.
    fs.writeFileSync(
      inner,
      [
        '#!/bin/sh',
        `touch ${JSON.stringify(ready)}`,
        'sleep 0.4',
        `node -e 'const fs=require("fs");const p=process.argv[1];const d=JSON.parse(fs.readFileSync(p,"utf8"));` +
          `d.excludePlugins=[...(d.excludePlugins||[]),"second-withheld"];fs.writeFileSync(p,JSON.stringify(d,null,2));' ` +
          JSON.stringify(configFile()),
      ].join('\n') + '\n',
      { mode: 0o755 },
    );
    const holder = execFileSync(
      'sh',
      ['-c', `flock -x ${JSON.stringify(lock)} ${JSON.stringify(inner)} >/dev/null 2>&1 & echo $!`],
      { encoding: 'utf8' },
    ).trim();
    try {
      // Only start once the holder demonstrably OWNS the lock; otherwise this
      // process can win the race and the test asserts nothing.
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(ready)) {
        if (Date.now() > deadline) throw new Error('lock holder never started');
        await new Promise((r) => setTimeout(r, 10));
      }
      await updateContainerConfig(FOLDER, (config) => {
        config.agentGroupId = 'ag-spawn';
      });
      const final = readContainerConfig(FOLDER);
      expect(final.agentGroupId).toBe('ag-spawn');
      expect(final.excludePlugins).toEqual(['withheld-plugin', 'second-withheld']);
    } finally {
      try {
        process.kill(Number(holder));
      } catch {
        /* already exited */
      }
    }
  });

  it('serializes read-mutate-write: no mutator body runs between another’s read and its write', async () => {
    // An in-process ordering assertion, which is weaker than the cross-process
    // case above (it would also hold without a lock, because these mutators
    // are synchronous). It is here to pin the primitive's CONTRACT — the lock
    // spans the whole read-mutate-write, not just the write — so a later
    // change that moved the write outside the lock is caught by a second,
    // cheaper signal than a process-spawning test.
    const order: string[] = [];
    const first = updateContainerConfig(FOLDER, (config) => {
      order.push('first:read');
      config.groupName = 'first';
      order.push('first:write');
    });
    const second = updateContainerConfig(FOLDER, (config) => {
      order.push('second:read');
      config.agentGroupId = 'ag-second';
      order.push('second:write');
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['first:read', 'first:write', 'second:read', 'second:write']);
    const final = readContainerConfig(FOLDER);
    expect(final.groupName).toBe('first');
    expect(final.agentGroupId).toBe('ag-second');
    expect(final.excludePlugins).toEqual(['withheld-plugin']);
  });
});

describe('the write leaves nothing beside the config', () => {
  it('writes IN PLACE — no sibling temp file, because that file would not be mount-protected', () => {
    // A write-to-temp-and-rename is the textbook atomic write and is wrong
    // here: `groups/<folder>/` is bind-mounted read-write into the agent
    // container (`src/container-runner.ts:4677`), the container runs as the
    // host uid (`:7134`), and the only protection on this file is a nested
    // read-only mount of `container.json` ITSELF (`:4809-4813`). A sibling temp
    // file inherits none of that, so an agent could overwrite it between the
    // host's close and its rename and have its own bytes installed as the
    // authoritative config. The torn-write case the rename would have covered
    // is already REFUSED by `assertOverwritableContainerConfig`, not repaired.
    writeContainerConfig(FOLDER, {
      groupName: 'probe',
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      excludePlugins: ['withheld-plugin'],
    });
    expect(JSON.parse(fs.readFileSync(configFile(), 'utf8')).excludePlugins).toEqual(['withheld-plugin']);
    const siblings = fs.readdirSync(path.dirname(configFile())).filter((f) => f !== 'container.json');
    expect(siblings).toEqual([]);
  });
});

describe('every host writer routes through the primitive', () => {
  it('nothing outside container-config.ts writes container.json in production code', () => {
    // Structural, because the defect class is a NEW writer added later that
    // reads, mutates and writes on its own — the thing the lock cannot see.
    // Tests seed configs from whole cloth and are exempt; there is nothing to
    // lose in a fixture directory.
    //
    // Roots resolve from THIS FILE, not the working directory: a relative root
    // behind an existsSync guard is exactly how a structural test walks nothing
    // and passes. The coverage assertions below exist for the same reason.
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const roots = ['src', 'scripts', 'setup'].map((r) => path.join(repoRoot, r));
    const owner = path.join(repoRoot, 'src', 'container-config.ts');
    const offenders: string[] = [];
    let scanned = 0;
    let ownerSeen = false;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
        scanned++;
        const source = fs.readFileSync(full, 'utf8');
        // The LOAD-BEARING check is the first one: a call to the unlocked
        // `writeContainerConfig` from anywhere but its own module.
        //
        // The second is a cheap extra, and its reach is smaller than it looks:
        // it fires only when a raw write names the file as a literal on the
        // SAME LINE. A writer that builds the path into a variable first (as
        // `setup/migrate-v2/groups.ts:92` does) slips past it, and that is
        // accepted rather than papered over — the file-wide version of this
        // probe ("mentions container.json anywhere AND calls writeFileSync
        // anywhere") flagged six modules that do neither together, and a
        // structural test with false positives earns an allowlist and then
        // gets ignored. Neither form of this test can be a complete barrier
        // against a determined new writer; it catches the careless one.
        const rawWrite = source
          .split('\n')
          .some(
            (line) => /\b(writeFileSync|renameSync|createWriteStream)\s*\(/.test(line) && /container\.json/.test(line),
          );
        const writes = /\bwriteContainerConfig\s*\(/.test(source) || rawWrite;
        if (full === owner) {
          ownerSeen = true;
          // Positive control: the owner MUST match. If it does not, the
          // detector is broken and every other file's clean result is noise.
          expect(writes).toBe(true);
          continue;
        }
        if (writes) offenders.push(path.relative(repoRoot, full));
      }
    };
    for (const root of roots) walk(root);
    expect(ownerSeen).toBe(true);
    expect(scanned).toBeGreaterThan(200);
    expect(offenders).toEqual([]);
  });
});
