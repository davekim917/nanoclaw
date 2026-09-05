/**
 * Ordering and safety properties of the boot mount-change block (convergence
 * seam 4, PR D1 — docs/specs/upstream-restart-survival-seam/plan.md §7.D,
 * properties 1 and 4).
 *
 * Property 1 is the one that matters: NOTHING MUTATES BEFORE THE QUIESCENCE
 * RETURNS. Today's boot proves install-scoped absence inside the memory gate
 * and runs the shared-FS consolidation two calls EARLIER (plan §3.5,
 * divergence 4) — true "before any spawn" only for spawns this process makes,
 * while the previous host's containers are still live. D1 moves both reconciles
 * behind one door and makes the ordering an asserted property.
 *
 * Hermeticity (brief-common.md HARD RULE): every reconcile, the warn and the
 * prune are injected recorders, the runtime listing is a fake, the fixture tree
 * is a per-process `uniqueTmpRoot`, and the `child_process` tripwire records
 * and throws on any real spawn. Every case asserts it stayed empty.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawns = vi.hoisted(() => [] as string[]);

/** A tripwire, not a functional mock: it records the call and then throws. */
function childProcessTripwire(record: string[]): Record<string, (...args: unknown[]) => never> {
  const spawnAttempted =
    (name: string) =>
    (...args: unknown[]): never => {
      record.push(name);
      throw new Error(`boot-quiescence-order.test: real process spawn attempted (${name}(${JSON.stringify(args[0])}))`);
    };
  return {
    exec: spawnAttempted('exec'),
    execFile: spawnAttempted('execFile'),
    spawn: spawnAttempted('spawn'),
    execSync: spawnAttempted('execSync'),
    execFileSync: spawnAttempted('execFileSync'),
    spawnSync: spawnAttempted('spawnSync'),
    fork: spawnAttempted('fork'),
  };
}

vi.mock('child_process', () => childProcessTripwire(spawns));
vi.mock('node:child_process', () => childProcessTripwire(spawns));

import { BootQuiescencePartialStopError, quiesceWorkgroupsForBootMountChange } from './container-restart.js';
import type { InstallContainerScope } from './container-runtime.js';
import { runBootMountQuiescence, runWorkgroupMemoryStartupGate } from './main.js';
import {
  reconcileWorkgroupMemory,
  sharedDirsReconcileWouldChange,
  workgroupMemoryReconcileWouldChange,
  WORKGROUP_MEMORY_CONTAINER_PATH,
  workgroupMemoryDir,
} from './modules/workgroup/shared-dirs.js';

let root: string;

beforeEach(() => {
  spawns.length = 0;
  root = uniqueTmpRoot('boot-quiescence-order');
  fs.mkdirSync(root, { recursive: true });
});

afterEach(() => {
  expect(spawns).toEqual([]);
  fs.rmSync(root, { recursive: true, force: true });
});

function makeDb(extraWorkgroups: string[] = []): Database.Database {
  const db = new Database(':memory:');
  db.exec(
    `CREATE TABLE workgroups (id TEXT PRIMARY KEY);
     CREATE TABLE agent_groups (id TEXT PRIMARY KEY, folder TEXT, workgroup_id TEXT);`,
  );
  db.prepare(`INSERT INTO workgroups (id) VALUES (?)`).run('wgx');
  db.prepare(`INSERT INTO agent_groups (id, folder, workgroup_id) VALUES (?,?,?)`).run('ag-seed', 'wgx', 'wgx');
  for (const id of extraWorkgroups) {
    db.prepare(`INSERT INTO workgroups (id) VALUES (?)`).run(id);
    db.prepare(`INSERT INTO agent_groups (id, folder, workgroup_id) VALUES (?,?,?)`).run(`ag-${id}`, id, id);
  }
  return db;
}

/** Workgroups whose boot reconciles are all settled: nothing would change. */
function buildSettledTree(workgroupIds: string[] = ['wgx']): { groupsDir: string; dataDir: string } {
  const groupsDir = path.join(root, 'groups');
  const dataDir = path.join(root, 'data');
  for (const id of workgroupIds) {
    fs.mkdirSync(path.join(workgroupMemoryDir(id, dataDir), 'preferences'), { recursive: true });
    fs.mkdirSync(path.join(groupsDir, id), { recursive: true });
    fs.symlinkSync(WORKGROUP_MEMORY_CONTAINER_PATH, path.join(groupsDir, id, 'memory'));
  }
  return { groupsDir, dataDir };
}

/** Content hash of a fixture tree: file bytes, symlink targets, directory shape. */
function hashTree(rootDir: string): string {
  const lines: string[] = [];
  const visit = (absolute: string, relative: string): void => {
    const st = fs.lstatSync(absolute);
    if (st.isSymbolicLink()) {
      lines.push(`symlink\0${relative}\0${fs.readlinkSync(absolute)}`);
      return;
    }
    if (st.isFile()) {
      lines.push(`file\0${relative}\0${fs.readFileSync(absolute).toString('base64')}`);
      return;
    }
    if (!st.isDirectory()) {
      lines.push(`other\0${relative}\0${st.mode}`);
      return;
    }
    lines.push(`dir\0${relative}`);
    for (const child of fs.readdirSync(absolute).sort()) {
      visit(path.join(absolute, child), relative ? path.join(relative, child) : child);
    }
  };
  visit(rootDir, '');
  return lines.join('\n');
}

function fakeRuntime(initial: InstallContainerScope[], failStopOf?: string, failListCall?: number) {
  let running = [...initial];
  const stops: string[] = [];
  let calls = 0;
  return {
    stops,
    list: (): InstallContainerScope[] => {
      calls += 1;
      if (failListCall === calls) {
        throw new Error('Cannot prove install-scoped container absence: runtime listing failed');
      }
      return [...running];
    },
    stop: (name: string): void => {
      if (failStopOf === name) throw new Error(`docker stop ${name}: no such container`);
      stops.push(name);
      running = running.filter((entry) => entry.name !== name);
    },
  };
}

describe('boot mount-change ordering', () => {
  it('the boot reconciles run only after the quiescence primitive resolves', async () => {
    const db = makeDb();
    const calls: string[] = [];
    let resolveQuiesce: (() => void) | null = null;

    const pending = runBootMountQuiescence(db, {
      workgroupIds: () => ['wgx'],
      memoryWouldChange: () => true,
      sharedWouldChange: () => true,
      sharedFsEnabled: true,
      quiesce: async (changed) => {
        calls.push(`quiesce(${changed.join(',')})`);
        // Suspend inside the door: anything that runs before it resolves is a
        // mutation racing a live container.
        await new Promise<void>((resolve) => {
          resolveQuiesce = resolve;
        });
        calls.push('quiesce:resolved');
        return { containers: 1, stopped: 1, survivable: 0, unlabeled: 0 };
      },
      warnStartup: async () => {
        calls.push('warn');
      },
      reconcileShared: () => {
        calls.push('reconcileWorkgroupSharedDirs');
      },
      memoryGate: () => {
        calls.push('reconcileWorkgroupMemory');
        return [];
      },
      prune: () => {
        calls.push('pruneAgentRunnerSnapshots');
      },
    });

    // Let every already-scheduled microtask drain while the door is suspended.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(['quiesce(wgx)']);

    resolveQuiesce!();
    await pending;

    expect(calls).toEqual([
      'quiesce(wgx)',
      'quiesce:resolved',
      'warn',
      'reconcileWorkgroupSharedDirs',
      'reconcileWorkgroupMemory',
      'pruneAgentRunnerSnapshots',
    ]);
    db.close();
  });

  it('shared-FS consolidation no longer runs before the quiescence proof', async () => {
    // Divergence 4, both halves: the runtime order, and the source itself —
    // the call used to sit ~20 lines ABOVE the proof in main().
    const db = makeDb();
    const calls: string[] = [];

    await runBootMountQuiescence(db, {
      workgroupIds: () => ['wgx'],
      memoryWouldChange: () => false,
      sharedWouldChange: () => true,
      sharedFsEnabled: true,
      quiesce: async () => {
        calls.push('quiesce');
        return { containers: 0, stopped: 0, survivable: 0, unlabeled: 0 };
      },
      warnStartup: async () => undefined,
      reconcileShared: () => {
        calls.push('reconcileWorkgroupSharedDirs');
      },
      memoryGate: () => [],
      prune: () => undefined,
    });

    expect(calls).toEqual(['quiesce', 'reconcileWorkgroupSharedDirs']);

    const source = fs.readFileSync(path.resolve('src/main.ts'), 'utf8');
    const proof = source.indexOf('quiesceWorkgroupsForBootMountChange)(changedWorkgroupIds)');
    const shared = source.indexOf('reconcileWorkgroupSharedDirs)(db, { workgroupIds: changedWorkgroupIds })');
    expect(proof).toBeGreaterThanOrEqual(0);
    expect(shared).toBeGreaterThan(proof);
    db.close();
  });

  it('a boot where nothing would change stops nothing', async () => {
    // The predicates and the primitive are REAL here; only the reconcilers,
    // the warn and the prune are recorders. A settled tree must produce an
    // empty changed set.
    const { groupsDir, dataDir } = buildSettledTree();
    const db = makeDb();
    const runtime = fakeRuntime([
      { name: 'nanoclaw-v2-a-1', workgroupId: 'wgx', sessionId: 's1', groupId: 'g1' },
      { name: 'nanoclaw-v2-b-1', workgroupId: 'wg-other', sessionId: 's2', groupId: 'g2' },
    ]);
    let quiesceArg: string[] | null = null;

    const { changedWorkgroupIds, scope } = await runBootMountQuiescence(db, {
      workgroupIds: () => ['wgx'],
      memoryWouldChange: (database, id) => workgroupMemoryReconcileWouldChange(database, id, { groupsDir, dataDir }),
      sharedWouldChange: (database, id) => sharedDirsReconcileWouldChange(database, id, { groupsDir, dataDir }),
      sharedFsEnabled: true,
      quiesce: (changed) => {
        quiesceArg = changed;
        return quiesceWorkgroupsForBootMountChange(changed, runtime);
      },
      warnStartup: async () => undefined,
      reconcileShared: () => undefined,
      memoryGate: () => [],
      prune: () => undefined,
    });

    expect(changedWorkgroupIds).toEqual([]);
    expect(quiesceArg).toEqual([]);
    // D1: the scope is empty and BOTH containers are still stopped. The D2 PR
    // changes this to `stopped: 0` and `runtime.stops` empty — that flip is
    // the whole of milestone 1's first line of evidence (plan §6).
    expect(scope).toEqual({ containers: 2, stopped: 2, survivable: 2, unlabeled: 0 });
    expect(scope.stopped).toBe(scope.containers);
    expect(runtime.stops).toEqual(['nanoclaw-v2-a-1', 'nanoclaw-v2-b-1']);
    db.close();
  });

  it('an empty-changed boot still reports every workgroup for the pending-upgrade pass', async () => {
    // `main()` derives the pending-pre-turn-context targets AND the
    // migration-required operator warnings from these reports. An ordinary boot
    // changes nothing, so scoping the REPORT set to the changed workgroups —
    // rather than only the writes — would skip the session-DB admission pass on
    // almost every start. The predicates, the primitive, the memory gate and
    // the memory reconcile are all real here.
    const { groupsDir, dataDir } = buildSettledTree(['wgx', 'wgy']);
    const db = makeDb(['wgy']);
    const runtime = fakeRuntime([{ name: 'nanoclaw-v2-a-1', workgroupId: 'wgx', sessionId: 's1', groupId: 'g1' }]);
    const before = hashTree(root);

    const { changedWorkgroupIds, memoryReports } = await runBootMountQuiescence(db, {
      workgroupIds: () => ['wgx', 'wgy'],
      memoryWouldChange: (database, id) => workgroupMemoryReconcileWouldChange(database, id, { groupsDir, dataDir }),
      sharedWouldChange: (database, id) => sharedDirsReconcileWouldChange(database, id, { groupsDir, dataDir }),
      sharedFsEnabled: true,
      quiesce: (changed) => quiesceWorkgroupsForBootMountChange(changed, runtime),
      warnStartup: async () => undefined,
      reconcileShared: () => undefined,
      memoryGate: (database, opts) =>
        runWorkgroupMemoryStartupGate(database, {
          ...opts,
          ensureRuntime: () => undefined,
          reconcile: (inner, dirs) => reconcileWorkgroupMemory(inner, { ...dirs, groupsDir, dataDir }),
        }),
      prune: () => undefined,
    });

    expect(changedWorkgroupIds).toEqual([]);
    // One report per workgroup, none of them claiming a change…
    expect(memoryReports.map((report) => report.workgroupId).sort()).toEqual(['wgx', 'wgy']);
    expect(memoryReports.every((report) => report.changed === false)).toBe(true);
    // …and nothing on disk moved, because the WRITES were scoped to the empty set.
    expect(hashTree(root)).toBe(before);
    db.close();
  });

  it('a door that dies part way still writes the host-restart note before rethrowing', async () => {
    // The containers it did stop took real sessions down with them. Those
    // sessions get the same accountability note they would have got on a clean
    // pass; the failure still propagates and no reconcile runs.
    const db = makeDb();
    const calls: string[] = [];
    const runtime = fakeRuntime(
      [
        { name: 'nanoclaw-v2-a-1', workgroupId: 'wgx', sessionId: 's1', groupId: 'g1' },
        { name: 'nanoclaw-v2-b-1', workgroupId: 'wg-other', sessionId: 's2', groupId: 'g2' },
      ],
      'nanoclaw-v2-b-1',
    );

    await expect(
      runBootMountQuiescence(db, {
        workgroupIds: () => ['wgx'],
        memoryWouldChange: () => true,
        sharedWouldChange: () => false,
        sharedFsEnabled: true,
        quiesce: (changed) => quiesceWorkgroupsForBootMountChange(changed, runtime),
        warnStartup: async () => {
          calls.push('warn');
        },
        reconcileShared: () => {
          calls.push('reconcileWorkgroupSharedDirs');
        },
        memoryGate: () => {
          calls.push('reconcileWorkgroupMemory');
          return [];
        },
        prune: () => {
          calls.push('pruneAgentRunnerSnapshots');
        },
      }),
    ).rejects.toBeInstanceOf(BootQuiescencePartialStopError);

    expect(runtime.stops).toEqual(['nanoclaw-v2-a-1']);
    expect(calls).toEqual(['warn']);
    db.close();
  });

  it('a post-stop listing failure still writes the host-restart note before rethrowing', async () => {
    // The stops all took; docker went away before the proof. The containers
    // are gone either way, so the sessions get their note and the failure
    // still stops startup ahead of every reconcile.
    const db = makeDb();
    const calls: string[] = [];
    const runtime = fakeRuntime(
      [
        { name: 'nanoclaw-v2-a-1', workgroupId: 'wgx', sessionId: 's1', groupId: 'g1' },
        { name: 'nanoclaw-v2-b-1', workgroupId: 'wg-other', sessionId: 's2', groupId: 'g2' },
      ],
      undefined,
      2,
    );

    await expect(
      runBootMountQuiescence(db, {
        workgroupIds: () => ['wgx'],
        memoryWouldChange: () => true,
        sharedWouldChange: () => false,
        sharedFsEnabled: true,
        quiesce: (changed) => quiesceWorkgroupsForBootMountChange(changed, runtime),
        warnStartup: async () => {
          calls.push('warn');
        },
        reconcileShared: () => {
          calls.push('reconcileWorkgroupSharedDirs');
        },
        memoryGate: () => {
          calls.push('reconcileWorkgroupMemory');
          return [];
        },
        prune: () => {
          calls.push('pruneAgentRunnerSnapshots');
        },
      }),
    ).rejects.toBeInstanceOf(BootQuiescencePartialStopError);

    expect(runtime.stops).toEqual(['nanoclaw-v2-a-1', 'nanoclaw-v2-b-1']);
    expect(calls).toEqual(['warn']);
    db.close();
  });

  it('a door that stopped nothing writes no host-restart note', async () => {
    const db = makeDb();
    const calls: string[] = [];

    await expect(
      runBootMountQuiescence(db, {
        workgroupIds: () => ['wgx'],
        memoryWouldChange: () => true,
        sharedWouldChange: () => false,
        sharedFsEnabled: true,
        quiesce: () =>
          quiesceWorkgroupsForBootMountChange([], {
            list: () => {
              throw new Error('Cannot prove install-scoped container absence: runtime listing failed');
            },
            stop: () => undefined,
          }),
        warnStartup: async () => {
          calls.push('warn');
        },
        reconcileShared: () => {
          calls.push('reconcileWorkgroupSharedDirs');
        },
        memoryGate: () => {
          calls.push('reconcileWorkgroupMemory');
          return [];
        },
        prune: () => {
          calls.push('pruneAgentRunnerSnapshots');
        },
      }),
    ).rejects.toThrow(/prove install-scoped container absence/);

    // Nothing was interrupted, so nothing is announced as interrupted.
    expect(calls).toEqual([]);
    db.close();
  });
});
