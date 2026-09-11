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

import { quiesceWorkgroupsForBootMountChange } from './container-restart.js';
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
      quiesce: async (changed, options) => {
        calls.push(`quiesce(${changed.join(',')}, of ${options.knownWorkgroupIds.length})`);
        // The real door writes the accountability note after its pre-stop
        // partition and before its first stop.
        await options.beforeStop({ pass: 1, survivableSessionIds: [], mustStopSessionIds: ['s1'] });
        // Suspend inside the door: anything that runs before it resolves is a
        // mutation racing a live container.
        await new Promise<void>((resolve) => {
          resolveQuiesce = resolve;
        });
        calls.push('quiesce:resolved');
        return {
          workgroups: 1,
          changedWorkgroupIds: changed,
          containers: 1,
          stopped: 1,
          survivable: 0,
          unlabeled: 0,
          survivableSessionIds: [],
          mustStopSessionIds: ['s1'],
        };
      },
      activeSessionIds: async () => ['s1', 's2'],
      ensureRuntime: () => undefined,
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
    expect(calls).toEqual(['quiesce(wgx, of 1)', 'warn']);

    resolveQuiesce!();
    await pending;

    expect(calls).toEqual([
      'quiesce(wgx, of 1)',
      'warn',
      'quiesce:resolved',
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
        return {
          workgroups: 0,
          changedWorkgroupIds: [],
          containers: 0,
          stopped: 0,
          survivable: 0,
          unlabeled: 0,
          survivableSessionIds: [],
          mustStopSessionIds: [],
        };
      },
      activeSessionIds: async () => ['s1', 's2'],
      ensureRuntime: () => undefined,
      warnStartup: async () => undefined,
      reconcileShared: () => {
        calls.push('reconcileWorkgroupSharedDirs');
      },
      memoryGate: () => [],
      prune: () => undefined,
    });

    expect(calls).toEqual(['quiesce', 'reconcileWorkgroupSharedDirs']);

    const source = fs.readFileSync(path.resolve('src/main.ts'), 'utf8');
    const proof = source.indexOf('quiesceWorkgroupsForBootMountChange)(changedBeforeQuiescence, {');
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
      // Same workgroup: `wgx` is the only id the fixture DB holds, and a label
      // naming a workgroup the DB does not have is must-stop by construction
      // (see the deleted-workgroup case in the primitive's suite).
      { name: 'nanoclaw-v2-b-1', workgroupId: 'wgx', sessionId: 's2', groupId: 'g2' },
    ]);
    let quiesceArg: string[] | null = null;

    const { changedWorkgroupIds, scope } = await runBootMountQuiescence(db, {
      workgroupIds: () => ['wgx'],
      memoryWouldChange: (database, id) => workgroupMemoryReconcileWouldChange(database, id, { groupsDir, dataDir }),
      sharedWouldChange: (database, id) => sharedDirsReconcileWouldChange(database, id, { groupsDir, dataDir }),
      sharedFsEnabled: true,
      quiesce: (changed, options) => {
        quiesceArg = changed;
        return quiesceWorkgroupsForBootMountChange(changed, { ...runtime, ...options });
      },
      activeSessionIds: async () => ['s1', 's2'],
      ensureRuntime: () => undefined,
      warnStartup: async () => undefined,
      reconcileShared: () => undefined,
      memoryGate: () => [],
      prune: () => undefined,
    });

    expect(changedWorkgroupIds).toEqual([]);
    expect(quiesceArg).toEqual([]);
    // D2: the scope is empty and BOTH containers are left running — milestone
    // 1's first line of evidence (plan §6): `stopped: 0`, `survivable: 2`.
    expect(scope).toEqual({
      workgroups: 1,
      changedWorkgroupIds: [],
      containers: 2,
      stopped: 0,
      survivable: 2,
      unlabeled: 0,
      // Both are identified and outside the changed set — the survivors, named
      // session by session for seam-4 E (adoption) and G (the warn's skip set).
      survivableSessionIds: ['s1', 's2'],
      mustStopSessionIds: [],
    });
    expect(scope.stopped).toBe(0);
    expect(runtime.stops).toEqual([]);
    db.close();
  });

  it('a workgroup that flips during the stops is stopped in the second pass', async () => {
    // The group directories the predicates read are bind-mounted WRITABLE into
    // live containers. A still-running agent can write one between the
    // pre-stop snapshot and the first pass completing; the pre-stop set would
    // then exclude it and leave its container running across a mount cutover.
    // The fix is the second evaluation after the first pass, and a second
    // stop pass over whatever it classifies must-stop.
    //
    // The door's first listing stands in for that agent's last write: it
    // removes the exact compatibility symlink, which flips the memory
    // predicate to true, after the pre-stop snapshot was taken and before the
    // door re-evaluates. The pre-stop pass stops nothing (the tree was
    // settled), so the survivor was still writing.
    const { groupsDir, dataDir } = buildSettledTree();
    const db = makeDb();
    const scopes: Array<string[]> = [];
    const stops: string[] = [];
    const warns: Array<{ skip: string[]; beforeStops: number }> = [];
    let listings = 0;
    let stopped = false;

    const { changedWorkgroupIds, scope } = await runBootMountQuiescence(db, {
      workgroupIds: () => ['wgx'],
      memoryWouldChange: (database, id) => workgroupMemoryReconcileWouldChange(database, id, { groupsDir, dataDir }),
      sharedWouldChange: (database, id) => sharedDirsReconcileWouldChange(database, id, { groupsDir, dataDir }),
      sharedFsEnabled: true,
      quiesce: (changed, options) => {
        scopes.push([...changed]);
        return quiesceWorkgroupsForBootMountChange(changed, {
          ...options,
          list: () => {
            listings += 1;
            if (listings === 1) fs.unlinkSync(path.join(groupsDir, 'wgx', 'memory'));
            return stopped ? [] : [{ name: 'nanoclaw-v2-a-1', workgroupId: 'wgx', sessionId: 's1', groupId: 'g1' }];
          },
          stop: (name) => {
            stops.push(name);
            stopped = true;
          },
        });
      },
      activeSessionIds: async () => ['s1', 's2'],
      ensureRuntime: () => undefined,
      warnStartup: async (_reason, skipSessionIds) => {
        warns.push({ skip: [...skipSessionIds].sort(), beforeStops: stops.length });
      },
      reconcileShared: () => undefined,
      memoryGate: (_db, opts) => {
        scopes.push([...(opts.mutateWorkgroupIds ?? [])]);
        return [];
      },
      prune: () => undefined,
    });

    // Pre-stop the tree was settled, so the door's input was empty…
    expect(scopes[0]).toEqual([]);
    // …and the post-stop evaluation caught the flip, so the reconcile is scoped
    // to it rather than skipping it.
    expect(changedWorkgroupIds).toEqual(['wgx']);
    expect(scopes[1]).toEqual(['wgx']);
    // The flipped workgroup's container was stopped in the second pass, and
    // the scope handed to seam-4 E is built from the SAME set: `wgx` is
    // changed, so its session is not offered as survivable.
    expect(stops).toEqual(['nanoclaw-v2-a-1']);
    expect(scope.changedWorkgroupIds).toEqual(['wgx']);
    expect(scope.survivableSessionIds).toEqual([]);
    expect(scope.survivable).toBe(0);
    expect(scope.stopped).toBe(1);
    // The first note skipped s1 as survivable; the reclassification warned it
    // — and only it — before the second-pass stop (#479 round 1).
    expect(warns).toEqual([
      { skip: ['s1'], beforeStops: 0 },
      { skip: ['s2'], beforeStops: 0 },
    ]);
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
      quiesce: (changed, options) => quiesceWorkgroupsForBootMountChange(changed, { ...runtime, ...options }),
      activeSessionIds: async () => ['s1', 's2'],
      ensureRuntime: () => undefined,
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

  it('the bounded runtime probe runs before the door, and the warn runs inside it', async () => {
    // Regression guard. On main the only 10 s-bounded docker probe
    // (`ensureContainerRuntimeRunning`) ran immediately ahead of
    // `cleanupOrphansStrict()`. The door's inventory is an UNBOUNDED
    // `docker ps`, so with the probe left to the memory gate a stalled daemon
    // would hang the boot instead of failing it. Under D2 the warn moves
    // INSIDE the door (its pre-stop partition is the note's skip set), so it
    // follows the probe and precedes the first stop.
    const db = makeDb();
    const calls: string[] = [];

    await runBootMountQuiescence(db, {
      workgroupIds: () => ['wgx'],
      memoryWouldChange: () => false,
      sharedWouldChange: () => false,
      sharedFsEnabled: true,
      activeSessionIds: async () => [],
      ensureRuntime: () => {
        calls.push('ensureRuntime');
      },
      warnStartup: async () => {
        calls.push('warn');
      },
      quiesce: async (_changed, options) => {
        calls.push('quiesce');
        await options.beforeStop({ pass: 1, survivableSessionIds: [], mustStopSessionIds: [] });
        return {
          workgroups: 1,
          changedWorkgroupIds: [],
          containers: 0,
          stopped: 0,
          survivable: 0,
          unlabeled: 0,
          survivors: [],
          survivableSessionIds: [],
          mustStopSessionIds: [],
        };
      },
      reconcileShared: () => undefined,
      memoryGate: () => [],
      prune: () => undefined,
    });

    expect(calls).toEqual(['ensureRuntime', 'quiesce', 'warn']);
    db.close();
  });

  it('a runtime probe that throws aborts before the door lists anything', async () => {
    const db = makeDb();
    const calls: string[] = [];

    await expect(
      runBootMountQuiescence(db, {
        workgroupIds: () => ['wgx'],
        memoryWouldChange: () => false,
        sharedWouldChange: () => false,
        sharedFsEnabled: true,
        activeSessionIds: async () => [],
        ensureRuntime: () => {
          calls.push('ensureRuntime');
          throw new Error('Container runtime is required but failed to start');
        },
        warnStartup: async () => {
          calls.push('warn');
        },
        quiesce: async () => {
          calls.push('quiesce');
          throw new Error('the door must not be reached');
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
    ).rejects.toThrow(/Container runtime is required/);

    // The door never listed, so no note was written either (the warn lives
    // inside the door under D2, and a boot that cannot reach the runtime fails
    // here; the next boot warns), and nothing reconciled.
    expect(calls).toEqual(['ensureRuntime']);
    db.close();
  });

  it('the startup warn runs before the first stop', async () => {
    // main() has always captured this evidence ahead of the stop pass. §7.D's
    // listed order puts the warn after the door, which would leave the
    // sessions a half-failed door already killed with no note at all. Under D2
    // the door itself calls the warn between its pre-stop partition and its
    // first stop. The primitive is real here, so `stops` is the actual stop
    // sequence.
    const db = makeDb();
    const calls: string[] = [];
    const runtime = fakeRuntime([{ name: 'nanoclaw-v2-a-1', workgroupId: 'wgx', sessionId: 's1', groupId: 'g1' }]);

    await runBootMountQuiescence(db, {
      workgroupIds: () => ['wgx'],
      memoryWouldChange: () => true,
      sharedWouldChange: () => false,
      sharedFsEnabled: true,
      quiesce: (changed, options) => {
        calls.push('quiesce');
        return quiesceWorkgroupsForBootMountChange(changed, {
          ...options,
          list: runtime.list,
          stop: (name: string) => {
            calls.push(`stop:${name}`);
            runtime.stop(name);
          },
        });
      },
      activeSessionIds: async () => ['s1', 's2'],
      ensureRuntime: () => undefined,
      warnStartup: async () => {
        calls.push('warn');
      },
      reconcileShared: () => undefined,
      memoryGate: () => [],
      prune: () => undefined,
    });

    expect(calls).toEqual(['quiesce', 'warn', 'stop:nanoclaw-v2-a-1']);
    expect(calls.indexOf('warn')).toBeLessThan(calls.findIndex((c) => c.startsWith('stop:')));
    db.close();
  });

  it('survivors get no accountability note; must-stop sessions get theirs before the stop', async () => {
    // Two workgroups, one changed. The note claims the session's container was
    // stopped by this restart, so the survivor must not get one — and the
    // must-stop session's note has to land before its container is stopped.
    const db = makeDb(['wgy']);
    const calls: string[] = [];
    let skipped: ReadonlySet<string> | null = null;
    const runtime = fakeRuntime([
      { name: 'nanoclaw-v2-a-1', workgroupId: 'wgx', sessionId: 's1', groupId: 'g1' },
      { name: 'nanoclaw-v2-b-1', workgroupId: 'wgy', sessionId: 's2', groupId: 'g2' },
    ]);

    const { scope } = await runBootMountQuiescence(db, {
      workgroupIds: () => ['wgx', 'wgy'],
      memoryWouldChange: (_database, id) => id === 'wgx',
      sharedWouldChange: () => false,
      sharedFsEnabled: true,
      quiesce: (changed, options) =>
        quiesceWorkgroupsForBootMountChange(changed, {
          ...options,
          list: runtime.list,
          stop: (name: string) => {
            calls.push(`stop:${name}`);
            runtime.stop(name);
          },
        }),
      activeSessionIds: async () => ['s1', 's2'],
      ensureRuntime: () => undefined,
      warnStartup: async (_reason, skipSessionIds) => {
        calls.push('warn');
        skipped = skipSessionIds;
      },
      reconcileShared: () => undefined,
      memoryGate: () => [],
      prune: () => undefined,
    });

    expect(calls).toEqual(['warn', 'stop:nanoclaw-v2-a-1']);
    // The skip set is the PRE-stop survivable partition: the survivor only.
    expect([...skipped!]).toEqual(['s2']);
    expect(scope.survivableSessionIds).toEqual(['s2']);
    expect(scope.mustStopSessionIds).toEqual(['s1']);
    db.close();
  });

  it('a door that fails part way leaves the warn already written and no reconcile run', async () => {
    // The note covers every session an unclean previous host left marked
    // running, and it is written before the door touches anything — so a stop
    // that throws mid-pass needs no recovery path of its own.
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
        activeSessionIds: async () => ['s1', 's2'],
        ensureRuntime: () => undefined,
        workgroupIds: () => ['wgx'],
        memoryWouldChange: () => true,
        sharedWouldChange: () => false,
        sharedFsEnabled: true,
        quiesce: (changed, options) => quiesceWorkgroupsForBootMountChange(changed, { ...runtime, ...options }),
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
    ).rejects.toThrow(/prove install-scoped container absence: failed to stop nanoclaw-v2-b-1/);

    expect(runtime.stops).toEqual(['nanoclaw-v2-a-1']);
    expect(calls).toEqual(['warn']);
    db.close();
  });

  it('a failing door still stops startup before any reconcile', async () => {
    const db = makeDb();
    const calls: string[] = [];

    await expect(
      runBootMountQuiescence(db, {
        activeSessionIds: async () => ['s1', 's2'],
        ensureRuntime: () => undefined,
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

    // The warn already ran; nothing below the door did.
    // A door whose LISTING fails never reaches its pre-stop partition, so no
    // note is written (the boot fails; the next boot warns) — and nothing
    // below the door ran.
    expect(calls).toEqual([]);
    db.close();
  });
});

describe('initializeManagedGitHooks runs after the boot door and before anything that can spawn', () => {
  // #666 review: at an earlier head this ran inside startHostModules, AFTER
  // startDashboard/honorPendingStopIntents/initChannelAdapters had already
  // opened paths that can spawn a container — a spawn racing ahead of the
  // refresh would have found the previous boot's hook copies (or none at
  // all). startNanoClaw() itself is not practical to drive end-to-end in a
  // unit test (real DB, HTTP dashboard, channel adapters, an OneCLI network
  // preflight — no existing test in this repo attempts it), so this
  // verifies the property the way this file already tests the mount door's
  // "nothing mutates before the door returns" invariant: as a fact about
  // src/main.ts's own source order, read once as text.
  it('initializeManagedGitHooks() is called after runBootMountQuiescence(db) and before startDashboard()/honorPendingStopIntents(/initChannelAdapters(', () => {
    const source = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
    const indexOf = (needle: string): number => {
      const idx = source.indexOf(needle);
      expect(idx, `expected to find ${JSON.stringify(needle)} in src/main.ts`).toBeGreaterThan(-1);
      return idx;
    };

    const doorCall = indexOf('await runBootMountQuiescence(db)');
    const initCall = indexOf('initializeManagedGitHooks();');
    const dashboardCall = indexOf('startDashboard();');
    const stopIntentsCall = indexOf('await honorPendingStopIntents(');
    const channelAdaptersCall = indexOf('await initChannelAdapters(');

    expect(initCall).toBeGreaterThan(doorCall);
    expect(initCall).toBeLessThan(dashboardCall);
    expect(initCall).toBeLessThan(stopIntentsCall);
    expect(initCall).toBeLessThan(channelAdaptersCall);
  });

  it('is a direct awaited-style call in startNanoClaw, not an onHostStart registrant', () => {
    // Guards against a regression back to onHostStart, which main.test.ts's
    // T-5 pins to exactly the six recurring timer modules — see
    // src/managed-git-hooks.ts's own doc comment on initializeManagedGitHooks
    // for why a one-shot pass with a harder deadline than "once delivery is
    // ready" does not belong there.
    const source = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
    expect(source).not.toMatch(/onHostStart\(\s*function managedGitHooksHostStart/);
    expect(source).toMatch(/import \{ initializeManagedGitHooks \} from '\.\/managed-git-hooks\.js';/);
  });
});
