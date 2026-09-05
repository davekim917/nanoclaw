import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it, vi } from 'vitest';

import { isDirectExecution, resolveChannelMetadataUpdates, runWorkgroupMemoryStartupGate } from './main.js';

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

// Seam 4 D1 moved the install-scoped stop OUT of this gate and into the one
// boot door, `quiesceWorkgroupsForBootMountChange` — so the gate no longer
// takes a `cleanupStrict` dep, and the quiescence-before-cutover ordering is
// asserted over `main()` itself in src/boot-quiescence-order.test.ts. What is
// left here is the gate's own two-step contract.
it('test_startup_refuses_memory_cutover_when_the_container_runtime_is_unreachable', () => {
  const db = new Database(':memory:');
  const calls: string[] = [];
  const ensureRuntime = vi.fn(() => {
    calls.push('runtime');
    throw new Error('container runtime unreachable');
  });
  const reconcile = vi.fn(() => {
    calls.push('reconcile');
    return [];
  });

  expect(() => runWorkgroupMemoryStartupGate(db, {}, { ensureRuntime, reconcile })).toThrow(
    'container runtime unreachable',
  );
  expect(calls).toEqual(['runtime']);
  expect(reconcile).not.toHaveBeenCalled();
  db.close();
});

it('runs reconciliation only after the container runtime check succeeds, over the proved scope', () => {
  const db = new Database(':memory:');
  const calls: string[] = [];
  const seen: Array<string[] | undefined> = [];

  runWorkgroupMemoryStartupGate(
    db,
    { workgroupIds: ['wg-changed'] },
    {
      ensureRuntime: () => {
        calls.push('runtime');
      },
      reconcile: (_db, dirs) => {
        calls.push('reconcile');
        seen.push(dirs.workgroupIds);
        return [];
      },
    },
  );

  expect(calls).toEqual(['runtime', 'reconcile']);
  expect(seen).toEqual([['wg-changed']]);
  db.close();
});

it('admits pending upgrade contexts after memory cutover and before any runtime can wake', () => {
  const source = fs.readFileSync(path.resolve('src/main.ts'), 'utf8');
  const memoryCutover = source.indexOf(
    'const memoryReports = runWorkgroupMemoryStartupGate(db, { workgroupIds: changedWorkgroupIds });',
  );
  const pendingUpgrade = source.indexOf('const pendingUpgrade = await reconcilePendingUpgradeContexts(');
  const dashboard = source.indexOf('startDashboard();');
  const channels = source.indexOf('await initChannelAdapters(');

  expect(memoryCutover).toBeGreaterThanOrEqual(0);
  expect(pendingUpgrade).toBeGreaterThan(memoryCutover);
  expect(dashboard).toBeGreaterThan(pendingUpgrade);
  expect(channels).toBeGreaterThan(pendingUpgrade);
});
