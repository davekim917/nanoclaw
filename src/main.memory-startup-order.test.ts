import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';

import {
  adoptionSeedFor,
  isDirectExecution,
  resolveChannelMetadataUpdates,
  runBootMountQuiescence,
  runWorkgroupMemoryStartupGate,
} from './main.js';

// PR #251, rounds 5-7 all landed on this seam. The settled rule is a single
// invariant, and it is about PROVENANCE, not about what any name looks like:
//
//   a persisted channel name is only overwritten by a refresh from the same
//   platform whose name source is at least as well informed as the source that
//   produced the stored value — or when the name slot is empty.
//
// Two sources exist. `adapter` is the raw per-channel fetch
// (reportChannelMetadata, chat-sdk-bridge.ts), which reports whatever string
// the platform hangs on the conversation. `classified` is the classification
// seam (resolveConversation / resolveChannelName), which can enrich that — a
// Slack MPDM's platform name is an internal `mpdm-a--b--c-1` slug, and the
// classifier replaces it with the participant roster. `onMetadata` is always
// an `adapter` refresh, so it can never take a classified name back. No slug
// pattern, no per-platform exception, and no wiring test: provenance settles
// the writer race in the same direction whichever round trip returns first.
const ADAPTER = { platform: 'slack', source: 'adapter' } as const;
const CLASSIFIED = { platform: 'slack', source: 'classified' } as const;

describe('resolveChannelMetadataUpdates', () => {
  it('accepts any source into an empty name slot', () => {
    expect(
      resolveChannelMetadataUpdates(
        { name: null, name_source: null, channel_type: 'slack', is_group: 0 },
        'General',
        undefined,
        ADAPTER,
      ),
    ).toEqual({ name: 'General', name_source: 'slack:adapter' });
  });

  it('ignores an adapter refresh over a classified name', () => {
    expect(
      resolveChannelMetadataUpdates(
        { name: 'Group DM: Alice and Bob', name_source: 'slack:classified', channel_type: 'slack', is_group: 1 },
        'mpdm-alice--bob-1',
        undefined,
        ADAPTER,
      ),
    ).toEqual({});
  });

  it('lets a classified refresh replace an adapter name', () => {
    expect(
      resolveChannelMetadataUpdates(
        { name: 'mpdm-alice--bob-1', name_source: 'slack:adapter', channel_type: 'slack', is_group: 1 },
        'Group DM: Alice and Bob',
        undefined,
        CLASSIFIED,
      ),
    ).toEqual({ name: 'Group DM: Alice and Bob', name_source: 'slack:classified' });
  });

  it('refreshes an adapter name from the same adapter source — renames still propagate', () => {
    expect(
      resolveChannelMetadataUpdates(
        { name: 'old-channel-name', name_source: 'slack:adapter', channel_type: 'slack', is_group: 0 },
        'renamed-channel',
        undefined,
        ADAPTER,
      ),
    ).toEqual({ name: 'renamed-channel', name_source: 'slack:adapter' });
  });

  it('refreshes a name whose stored slug matches the pattern the old exception used to catch', () => {
    // The deleted SLACK_MPIM_SLUG_RE keyed off the name's SHAPE, so any
    // platform whose names happen to look like `mpdm-…-1` lost its refresh.
    // Provenance never looks at the string.
    expect(
      resolveChannelMetadataUpdates(
        { name: 'mpdm-legacy-1', name_source: 'discord:adapter', channel_type: 'discord', is_group: 1 },
        'mpdm-legacy-2',
        undefined,
        { platform: 'discord', source: 'adapter' },
      ),
    ).toEqual({ name: 'mpdm-legacy-2', name_source: 'discord:adapter' });
  });

  it('refuses a refresh whose platform differs from the stored name provenance', () => {
    expect(
      resolveChannelMetadataUpdates(
        { name: '#general', name_source: 'slack:adapter', channel_type: 'slack', is_group: 0 },
        'general',
        undefined,
        { platform: 'discord', source: 'classified' },
      ),
    ).toEqual({});
  });

  it('reads a pre-migration-069 row (no provenance) as an adapter name', () => {
    // Behavior-preserving for rows written before the column existed: the raw
    // fetch overwrote them then, and still does.
    expect(
      resolveChannelMetadataUpdates(
        { name: 'legacy', name_source: null, channel_type: 'slack', is_group: 0 },
        'legacy-renamed',
        undefined,
        ADAPTER,
      ),
    ).toEqual({ name: 'legacy-renamed', name_source: 'slack:adapter' });
    // …and a classified write still outranks it.
    expect(
      resolveChannelMetadataUpdates(
        { name: 'legacy', channel_type: 'slack', is_group: 0 },
        'Group DM: Alice and Bob',
        undefined,
        CLASSIFIED,
      ),
    ).toEqual({ name: 'Group DM: Alice and Bob', name_source: 'slack:classified' });
  });

  it('leaves a matching name alone whatever the provenance', () => {
    expect(
      resolveChannelMetadataUpdates(
        { name: 'Existing', name_source: 'slack:adapter', channel_type: 'slack', is_group: 0 },
        'Existing',
        undefined,
        ADAPTER,
      ),
    ).toEqual({});
  });

  it('still updates is_group independently of the name decision', () => {
    expect(
      resolveChannelMetadataUpdates(
        { name: 'Group DM: Alice and Bob', name_source: 'slack:classified', channel_type: 'slack', is_group: 0 },
        'mpdm-alice--bob-1',
        true,
        ADAPTER,
      ),
    ).toEqual({ is_group: 1 });
  });

  it('returns an empty object when nothing changed', () => {
    expect(
      resolveChannelMetadataUpdates(
        { name: 'Existing', name_source: 'slack:adapter', channel_type: 'slack', is_group: 1 },
        'Existing',
        true,
        ADAPTER,
      ),
    ).toEqual({});
    expect(
      resolveChannelMetadataUpdates(
        { name: 'Existing', name_source: 'slack:adapter', channel_type: 'slack', is_group: 1 },
        undefined,
        undefined,
        ADAPTER,
      ),
    ).toEqual({});
  });
});

it('uses exact main-module identity instead of NODE_ENV to decide startup', () => {
  const entry = path.resolve(`${uniqueTmpRoot('index-entry')}.ts`);
  const moduleUrl = pathToFileURL(entry).href;

  expect(isDirectExecution(moduleUrl, entry)).toBe(true);
  expect(isDirectExecution(moduleUrl, `${entry}.test`)).toBe(false);
  expect(isDirectExecution(moduleUrl, undefined)).toBe(false);
});

it('test_startup_runs_strict_quiescence_before_any_memory_cutover', async () => {
  // The strict proof moved out of the memory gate and into the boot door
  // (docs/specs/upstream-restart-survival-seam/plan.md §7.D): one quiescence,
  // ahead of BOTH reconciles, still fail-closed. The assertion is unchanged —
  // a proof that cannot be completed stops startup before any cutover.
  const db = new Database(':memory:');
  const calls: string[] = [];

  await expect(
    runBootMountQuiescence(db, {
      workgroupIds: () => ['wg-1'],
      memoryWouldChange: () => true,
      sharedWouldChange: () => false,
      sharedFsEnabled: true,
      quiesce: () => {
        calls.push('quiescence');
        return Promise.reject(new Error('listing unavailable'));
      },
      activeSessionIds: async () => [],
      ensureRuntime: () => undefined,
      warnStartup: async () => {
        calls.push('warn');
      },
      reconcileShared: () => {
        calls.push('reconcile-shared');
      },
      memoryGate: () => {
        calls.push('reconcile-memory');
        return [];
      },
      prune: () => {
        calls.push('prune');
      },
    }),
  ).rejects.toThrow('listing unavailable');

  // The accountability note is written by the door itself, between its
  // pre-stop partition and its first stop (seam 4 D2); a door that cannot even
  // list writes none — and nothing below the door ran.
  expect(calls).toEqual(['quiescence']);
  db.close();
});

it('runs reconciliation only after runtime and strict absence proof succeed', async () => {
  const db = new Database(':memory:');
  const calls: string[] = [];

  await runBootMountQuiescence(db, {
    workgroupIds: () => ['wg-1'],
    memoryWouldChange: () => true,
    sharedWouldChange: () => false,
    sharedFsEnabled: true,
    quiesce: async (changed, options) => {
      calls.push('quiescence');
      expect(options.knownWorkgroupIds).toEqual(['wg-1']);
      expect(options.knownSessionIds).toEqual([]);
      await options.beforeStop({ pass: 1, survivableSessionIds: [], mustStopSessionIds: [] });
      return Promise.resolve({
        workgroups: 0,
        // No flip: the door's post-stop re-evaluation agrees with its input.
        changedWorkgroupIds: changed,
        containers: 0,
        stopped: 0,
        survivable: 0,
        unlabeled: 0,
        survivableSessionIds: [],
        mustStopSessionIds: [],
      });
    },
    activeSessionIds: async () => [],
    ensureRuntime: () => undefined,
    warnStartup: async () => {
      calls.push('warn');
    },
    reconcileShared: () => {
      calls.push('reconcile-shared');
    },
    memoryGate: (_db, opts) => {
      calls.push('reconcile-memory');
      expect(opts.mutateWorkgroupIds).toEqual(['wg-1']);
      return [];
    },
    prune: () => {
      calls.push('prune');
    },
  });

  expect(calls).toEqual(['quiescence', 'warn', 'reconcile-shared', 'reconcile-memory', 'prune']);
  db.close();
});

it('with survivors the adoption seed is the post-stop survivable set', () => {
  // The fail-closed seed adoption holds when its own inventory cannot be read
  // is only what the door LEFT running: the survivable partition when the
  // door stopped fewer containers than it found, nothing when it stopped all.
  expect(adoptionSeedFor({ containers: 3, stopped: 1, survivableSessionIds: ['s1', 's2'] })).toEqual(['s1', 's2']);
  expect(adoptionSeedFor({ containers: 2, stopped: 2, survivableSessionIds: ['s1'] })).toEqual([]);
  expect(adoptionSeedFor({ containers: 0, stopped: 0, survivableSessionIds: [] })).toEqual([]);
});

it('keeps the memory gate a runtime check plus the cutover, with nothing stopped inside it', () => {
  const db = new Database(':memory:');
  const calls: string[] = [];

  const reports = runWorkgroupMemoryStartupGate(db, {
    mutateWorkgroupIds: ['wg-1'],
    ensureRuntime: () => {
      calls.push('runtime');
    },
    reconcile: (_db, dirs) => {
      calls.push('reconcile');
      // The WRITES are scoped; the report set is not (see WorkgroupMemoryDirs).
      expect(dirs.mutateWorkgroupIds).toEqual(['wg-1']);
      return [];
    },
  });

  expect(calls).toEqual(['runtime', 'reconcile']);
  expect(reports).toEqual([]);
  db.close();
});

it('admits pending upgrade contexts after memory cutover and before any runtime can wake', () => {
  const source = fs.readFileSync(path.resolve('src/main.ts'), 'utf8');
  // Destructuring-agnostic: series E reads `scope` off the same return.
  const memoryCutover = source.indexOf('= await runBootMountQuiescence(db);');
  const pendingUpgrade = source.indexOf('const pendingUpgrade = await reconcilePendingUpgradeContexts(');
  const dashboard = source.indexOf('startDashboard();');
  const channels = source.indexOf('await initChannelAdapters(');

  expect(memoryCutover).toBeGreaterThanOrEqual(0);
  expect(pendingUpgrade).toBeGreaterThan(memoryCutover);
  expect(dashboard).toBeGreaterThan(pendingUpgrade);
  expect(channels).toBeGreaterThan(pendingUpgrade);
});
