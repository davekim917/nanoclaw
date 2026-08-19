/**
 * Tests for the observatory scene-graph endpoint:
 *   GET /dashboard/api/observatory?workgroup=<id>
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import { execFileSync } from 'child_process';

// Config is mocked to a test-only root because claims-board.ts reads
// DATA_DIR/workgroups/*/claims/*.json directly via claimsBaseDir().
vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-observatory-api-test',
}));

// The registry's live adapter map has no injection seam (adapters self-register
// on import and are instantiated by initChannelAdapters), so permalink
// resolution is exercised through a mocked lookup. Default: nothing registered,
// which is exactly what every pre-existing test in this file already saw.
vi.mock('../../channels/channel-registry.js', () => ({
  getChannelAdapter: vi.fn(() => undefined),
}));

const TEST_DIR = '/tmp/nanoclaw-observatory-api-test';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import {
  buildObservatoryScene,
  observatoryHandler,
  ownerMatchesAgent,
  isNotARoom,
  readReleaseState,
  readOfficeThemes,
  readWorkgroupSignals,
  threadPermalink,
  type ObservatoryDeps,
} from './observatory.js';
import type { AuthedRequestContext } from '../router.js';

function now(): string {
  return new Date().toISOString();
}

/** Stub deps — persona resolution defaults to passing the canonical name
 *  through unchanged, so tests that don't care about the persona/canonical
 *  split behave exactly as before it existed. */
function makeDeps(overrides: Partial<ObservatoryDeps> = {}): ObservatoryDeps {
  return {
    getActiveContainerSessionIds: () => [],
    resolveAssistantName: async (agentGroup) => agentGroup.name,
    // Isolate from whatever the live repo checkout's own .nanoclaw/*.json
    // happens to contain — install config must never leak into a unit test's
    // result. `signals: undefined` is a real injection: the scene checks for
    // the KEY, so this pins "no signals configured" rather than reading disk.
    themedSlots: {},
    signals: undefined,
    ...overrides,
  };
}

function makeCtx(opts: { no_filter?: boolean; allowed_group_ids?: string[] } = {}): AuthedRequestContext {
  return {
    user: { id: 'u1', kind: 'dashboard', display_name: 'u1', created_at: now() },
    scopes: {
      role: opts.no_filter ? 'owner' : 'member',
      allowed_group_ids: opts.allowed_group_ids ?? [],
      no_filter: opts.no_filter ?? false,
    },
    rawNodeReq: {} as http.IncomingMessage,
    rawNodeRes: {} as http.ServerResponse,
  };
}

function makeReq(url: string): Request {
  return new Request(url);
}

function setupDb(): void {
  const db = initTestDb();
  db.exec(`
    CREATE TABLE agent_groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE,
      agent_provider TEXT, workgroup_id TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE workgroups (
      id TEXT PRIMARY KEY, display_name TEXT, onecli_secrets TEXT NOT NULL DEFAULT '[]',
      mnemon_store_id TEXT, created_at TEXT NOT NULL, updated_at TEXT
    );
    CREATE TABLE messaging_groups (
      id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, platform_id TEXT NOT NULL,
      instance TEXT, name TEXT, created_at TEXT NOT NULL, UNIQUE(channel_type, platform_id)
    );
    CREATE TABLE messaging_group_agents (
      id TEXT PRIMARY KEY, messaging_group_id TEXT NOT NULL, agent_group_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL, messaging_group_id TEXT,
      thread_id TEXT, status TEXT DEFAULT 'active', last_outbound_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE container_configs (
      agent_group_id TEXT PRIMARY KEY, provider TEXT, model TEXT, effort TEXT, image_tag TEXT,
      assistant_name TEXT, max_messages_per_prompt INTEGER,
      skills TEXT NOT NULL DEFAULT '"all"', mcp_servers TEXT NOT NULL DEFAULT '{}',
      packages_apt TEXT NOT NULL DEFAULT '[]', packages_npm TEXT NOT NULL DEFAULT '[]',
      additional_mounts TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL
    );
    CREATE TABLE users (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT, created_at TEXT NOT NULL
    );
    -- migration 050: which thread an item has already been steered into.
    CREATE TABLE observatory_item_threads (
      workgroup_id TEXT NOT NULL, item_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL, created_by TEXT NOT NULL,
      PRIMARY KEY (workgroup_id, item_id)
    );
  `);
}

function addWorkgroup(id: string): void {
  getDb().prepare("INSERT INTO workgroups (id, created_at) VALUES (?, datetime('now'))").run(id);
}

function addGroup(id: string, workgroupId: string, name = id, folder = id): void {
  getDb()
    .prepare(
      "INSERT INTO agent_groups (id, name, folder, agent_provider, workgroup_id, created_at) VALUES (?, ?, ?, 'claude', ?, datetime('now'))",
    )
    .run(id, name, folder, workgroupId);
}

function addMessagingGroup(id: string, channelType: string, platformId: string, name: string | null = null): void {
  getDb()
    .prepare(
      "INSERT INTO messaging_groups (id, channel_type, platform_id, name, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .run(id, channelType, platformId, name);
}

function wire(mgId: string, agentGroupId: string): void {
  getDb()
    .prepare(
      "INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at) VALUES (?, ?, ?, datetime('now'))",
    )
    .run(`${mgId}-${agentGroupId}`, mgId, agentGroupId);
}

function addSession(
  id: string,
  agentGroupId: string,
  opts: { messagingGroupId?: string | null; lastOutboundAt?: string | null; threadId?: string | null } = {},
): void {
  getDb()
    .prepare(
      "INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, last_outbound_at, created_at) VALUES (?, ?, ?, ?, 'active', ?, datetime('now'))",
    )
    .run(id, agentGroupId, opts.messagingGroupId ?? null, opts.threadId ?? null, opts.lastOutboundAt ?? null);
}

function claimsDir(workgroupId: string): string {
  return path.join(TEST_DIR, 'workgroups', workgroupId, 'claims');
}

function writeClaim(workgroupId: string, slug: string, claim: Record<string, unknown>): void {
  const dir = claimsDir(workgroupId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(claim));
}

beforeEach(() => {
  setupDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('isNotARoom', () => {
  it('treats Slack DMs as private lines, not rooms', () => {
    expect(isNotARoom('slack:D0EXAMPLE1', [])).toBe(true);
    expect(isNotARoom('slack:C0EXAMPLE2', [])).toBe(false);
  });

  it('honours an explicit hide list — the canvas the API calls a channel', () => {
    expect(isNotARoom('slack:C0EXAMPLE3', ['slack:C0EXAMPLE3'])).toBe(true);
    expect(isNotARoom('slack:C0EXAMPLE3', [])).toBe(false);
  });

  it('leaves non-Slack platforms alone (a D there means nothing)', () => {
    expect(isNotARoom('discord:123:D456', [])).toBe(false);
  });
});

describe('platform allow-list and claim thread links', () => {
  it('hides rooms on platforms the workgroup did not allow-list', async () => {
    addWorkgroup('wg-1');
    addGroup('ag-1', 'wg-1', 'ava', 'ava-folder');
    addMessagingGroup('mg-s', 'slack-ava', 'slack:C1', '#build');
    addMessagingGroup('mg-d', 'discord', 'discord:g:c', 'general');
    wire('mg-s', 'ag-1');
    wire('mg-d', 'ag-1');

    const all = await buildObservatoryScene('wg-1', makeDeps());
    expect(all.rooms.map((r) => r.key).sort()).toEqual(['discord:g:c', 'slack:C1']);

    // Declaring platforms: ["slack"] keeps slack-* and drops the rest — the
    // wiring survives, only the floor hides it.
    const filtered = await buildObservatoryScene('wg-1', makeDeps({ platforms: ['slack'] }));
    expect(filtered.rooms.map((r) => r.key)).toEqual(['slack:C1']);
  });

  it('keeps DMs and explicitly hidden rooms off the floor entirely', async () => {
    addWorkgroup('wg-1');
    addGroup('ag-1', 'wg-1', 'ava', 'ava-folder');
    addMessagingGroup('mg-c', 'slack-ava', 'slack:C1', '#build');
    addMessagingGroup('mg-dm', 'slack-ava', 'slack:D9', 'Someone');
    addMessagingGroup('mg-hid', 'slack-ava', 'slack:C9', 'A canvas the API calls a channel');
    for (const mg of ['mg-c', 'mg-dm', 'mg-hid']) wire(mg, 'ag-1');

    const scene = await buildObservatoryScene('wg-1', makeDeps({ hiddenRooms: ['slack:C9'] }));

    expect(scene.rooms.map((r) => r.key)).toEqual(['slack:C1']);
  });

  it('resolves a thread url for every claim that recorded a thread', async () => {
    addWorkgroup('wg-1');
    addGroup('ag-1', 'wg-1', 'ava', 'ava-folder');
    writeClaim('wg-1', 'seam-1', { owner: 'ava', claimed_at: now(), ttl_hours: 4, thread_id: 'slack:C1:1.2' });
    writeClaim('wg-1', 'seam-2', { owner: 'ava', claimed_at: now(), ttl_hours: 4 });

    const scene = await buildObservatoryScene(
      'wg-1',
      makeDeps({ resolveThreadUrl: (t) => `https://acme.slack.com/${t}` }),
    );
    const byslug = Object.fromEntries(scene.claims.map((c) => [c.slug, c]));

    expect(byslug['seam-1'].threadUrl).toBe('https://acme.slack.com/slack:C1:1.2');
    expect(byslug['seam-2'].threadUrl).toBeNull();
  });
});

describe('avatarUrl', () => {
  it('resolves through the injected channel-type lookup and defaults to null', async () => {
    addWorkgroup('wg-1');
    addGroup('ag-1', 'wg-1');
    addGroup('ag-2', 'wg-1');
    addMessagingGroup('mg-1', 'slack-ava', 'C1');
    wire('mg-1', 'ag-1');

    const scene = await buildObservatoryScene(
      'wg-1',
      makeDeps({ avatarByChannelType: (ct) => (ct === 'slack-ava' ? 'https://cdn.example/ava-192.png' : null) }),
    );
    const byId = Object.fromEntries(scene.agents.map((a) => [a.id, a]));

    expect(byId['ag-1'].avatarUrl).toBe('https://cdn.example/ava-192.png');
    expect(byId['ag-2'].avatarUrl).toBeNull(); // no wiring, no face — never invented
  });
});

describe('readReleaseState', () => {
  function groupsDir(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-groups-'));
    for (const [rel, body] of Object.entries(files)) {
      const f = path.join(dir, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, body);
    }
    return dir;
  }

  it('reads the artifact from a member folder and rides it into the scene', async () => {
    addWorkgroup('wg-1');
    addGroup('ag-1', 'wg-1', 'ava', 'ava-folder');
    const dir = groupsDir({
      'ava-folder/releases/release-state.json': JSON.stringify({
        asOf: '2026-08-16T05:00:00Z',
        items: [{ id: 'X#1', kind: 'pr', title: 'ship me', nextMover: 'human', owner: 'ava' }],
      }),
    });

    const scene = await buildObservatoryScene('wg-1', makeDeps({ groupsDir: dir }));

    expect(scene.releaseState?.asOf).toBe('2026-08-16T05:00:00Z');
    expect(scene.releaseState?.items[0]).toMatchObject({ id: 'X#1', nextMover: 'human' });
  });

  it('is null when absent and skips an unparseable file without throwing', () => {
    addWorkgroup('wg-1');
    addGroup('ag-1', 'wg-1', 'ava', 'ava-folder');
    expect(readReleaseState('wg-1', groupsDir({}))).toBeNull();
    expect(readReleaseState('wg-1', groupsDir({ 'ava-folder/releases/release-state.json': '{nope' }))).toBeNull();
  });

  it('prefers the newest artifact when two member folders carry one', () => {
    addWorkgroup('wg-1');
    addGroup('ag-1', 'wg-1', 'ava', 'ava-folder');
    addGroup('ag-2', 'wg-1', 'kit', 'kit-folder');
    const dir = groupsDir({
      'ava-folder/releases/release-state.json': JSON.stringify({ asOf: 'old', items: [] }),
      'kit-folder/releases/release-state.json': JSON.stringify({ asOf: 'new', items: [] }),
    });
    fs.utimesSync(path.join(dir, 'ava-folder/releases/release-state.json'), new Date(0), new Date(0));

    expect(readReleaseState('wg-1', dir)?.asOf).toBe('new');
  });

  /* obs.C.33 — an item carries no thread of its own, so the board could not
   * tell it had already been shipped and a second press opened a rival thread.
   * The host remembers instead, and the memory rides onto the item at read
   * time — never into the watcher's own artifact. */
  describe('steeredThread decoration', () => {
    const board = (items: object[]) =>
      groupsDir({
        'ava-folder/releases/release-state.json': JSON.stringify({ asOf: '2026-08-18T00:00:00Z', items }),
      });
    const remember = (wg: string, item: string, thread: string, by: string) =>
      getDb()
        .prepare('INSERT INTO observatory_item_threads VALUES (?, ?, ?, ?, ?)')
        .run(wg, item, thread, '2026-08-18T01:00:00.000Z', by);

    const scene = async (dir: string) =>
      buildObservatoryScene('wg-1', makeDeps({ groupsDir: dir, resolveThreadUrl: (t) => `https://example.test/${t}` }));

    beforeEach(() => {
      addWorkgroup('wg-1');
      addGroup('ag-1', 'wg-1', 'ava', 'ava-folder');
    });

    it('names the thread, when it happened, and who fired it — by display name', async () => {
      getDb().prepare("INSERT INTO users VALUES ('u-dash', 'email', 'Olive Owner', datetime('now'))").run();
      remember('wg-1', 'X#1', 'slack:C1:1.1', 'u-dash');
      const dir = board([
        { id: 'X#1', kind: 'pr', title: 'shipped once', nextMover: 'human' },
        { id: 'X#2', kind: 'pr', title: 'never shipped', nextMover: 'human' },
      ]);

      const s = await scene(dir);
      expect(s.releaseState?.items[0]?.steeredThread).toEqual({
        threadId: 'slack:C1:1.1',
        threadUrl: 'https://example.test/slack:C1:1.1',
        at: '2026-08-18T01:00:00.000Z',
        by: 'Olive Owner',
      });
      // An item nobody has steered stays exactly as the watcher published it.
      expect(s.releaseState?.items[1]).not.toHaveProperty('steeredThread');
    });

    it('resolves the name at READ time, so a rename shows on the next poll', async () => {
      getDb().prepare("INSERT INTO users VALUES ('u-dash', 'email', 'Olive', datetime('now'))").run();
      remember('wg-1', 'X#1', 'slack:C1:1.1', 'u-dash');
      const dir = board([{ id: 'X#1', kind: 'pr', title: 't', nextMover: 'human' }]);
      expect((await scene(dir)).releaseState?.items[0]?.steeredThread?.by).toBe('Olive');

      getDb().prepare("UPDATE users SET display_name = 'Olive Renamed' WHERE id = 'u-dash'").run();
      expect((await scene(dir)).releaseState?.items[0]?.steeredThread?.by).toBe('Olive Renamed');
    });

    it('still reports the thread when the user row is gone — the thread is the point', async () => {
      remember('wg-1', 'X#1', 'slack:C1:1.1', 'u-deleted');
      const dir = board([{ id: 'X#1', kind: 'pr', title: 't', nextMover: 'human' }]);
      const t = (await scene(dir)).releaseState?.items[0]?.steeredThread;
      expect(t?.threadId).toBe('slack:C1:1.1');
      expect(t?.by).toBe('someone');
    });

    it("never decorates another workgroup's item of the same id", async () => {
      remember('wg-other', 'X#1', 'slack:C9:9.9', 'u-dash');
      const dir = board([{ id: 'X#1', kind: 'pr', title: 't', nextMover: 'human' }]);
      expect((await scene(dir)).releaseState?.items[0]).not.toHaveProperty('steeredThread');
    });

    it('renders the board rather than blanking it when the table is missing', async () => {
      getDb().exec('DROP TABLE observatory_item_threads');
      const dir = board([{ id: 'X#1', kind: 'pr', title: 't', nextMover: 'human' }]);
      const s = await scene(dir);
      expect(s.releaseState?.items).toHaveLength(1);
      expect(s.releaseState?.items[0]).not.toHaveProperty('steeredThread');
    });
  });
});

describe('readOfficeThemes', () => {
  // Fake, anonymous slot/channel names throughout — see office-data.test.ts
  // for why: this is install config, and real channel names never belong in
  // tracked source, fixtures included.
  function repoRoot(themesFile?: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-themes-'));
    if (themesFile !== undefined) {
      const nanoclawDir = path.join(dir, '.nanoclaw');
      fs.mkdirSync(nanoclawDir, { recursive: true });
      fs.writeFileSync(path.join(nanoclawDir, 'office-themes.json'), themesFile);
    }
    return dir;
  }

  it('is undefined when the file is absent', () => {
    expect(readOfficeThemes(repoRoot())).toBeUndefined();
  });

  it('parses a valid mapping', () => {
    expect(readOfficeThemes(repoRoot(JSON.stringify({ grill: 'kitchen', lobby: 'westFront' })))).toEqual({
      grill: 'kitchen',
      lobby: 'westFront',
    });
  });

  it('is undefined, not throwing, on unparseable JSON or a non-object shape', () => {
    expect(readOfficeThemes(repoRoot('{nope'))).toBeUndefined();
    expect(readOfficeThemes(repoRoot('[1,2,3]'))).toBeUndefined();
  });

  it('drops non-string values rather than passing them through', () => {
    expect(readOfficeThemes(repoRoot(JSON.stringify({ grill: 'kitchen', lobby: 42 })))).toEqual({ grill: 'kitchen' });
  });
});

describe('ownerMatchesAgent', () => {
  it('matches case-insensitively against name or folder', () => {
    const agent = { name: 'Ava', folder: 'ava-folder' };
    expect(ownerMatchesAgent('ava', agent)).toBe(true);
    expect(ownerMatchesAgent('AVA', agent)).toBe(true);
    expect(ownerMatchesAgent('ava-folder', agent)).toBe(true);
    expect(ownerMatchesAgent('zed', agent)).toBe(false);
  });
});

describe('buildObservatoryScene', () => {
  it('unknown workgroup → empty scene, same shape', async () => {
    const scene = await buildObservatoryScene('nope');
    expect(scene.workgroupId).toBe('nope');
    expect(scene.rooms).toEqual([]);
    expect(scene.agents).toEqual([]);
    expect(scene.claims).toEqual([]);
    expect(typeof scene.asOf).toBe('string');
  });

  it('dedupes 3 adapter wirings on one platform_id into 1 room with 3 members', async () => {
    addWorkgroup('wg-1');
    addGroup('ag-1', 'wg-1');
    addGroup('ag-2', 'wg-1');
    addGroup('ag-3', 'wg-1');
    addMessagingGroup('mg-1', 'discord', 'chan-123', 'general');
    addMessagingGroup('mg-2', 'discord-codex', 'chan-123', 'general');
    addMessagingGroup('mg-3', 'discord-opencode', 'chan-123', 'general');
    wire('mg-1', 'ag-1');
    wire('mg-2', 'ag-2');
    wire('mg-3', 'ag-3');

    const scene = await buildObservatoryScene('wg-1', makeDeps());
    expect(scene.rooms).toHaveLength(1);
    expect(scene.rooms[0].key).toBe('chan-123');
    expect(scene.rooms[0].memberAgentIds.sort()).toEqual(['ag-1', 'ag-2', 'ag-3']);
  });

  it('awake is true only when a session id is in the injected active-container set', async () => {
    addWorkgroup('wg-1');
    addGroup('ag-1', 'wg-1');
    addGroup('ag-2', 'wg-1');
    addSession('sess-1', 'ag-1');
    addSession('sess-2', 'ag-2');

    const scene = await buildObservatoryScene('wg-1', makeDeps({ getActiveContainerSessionIds: () => ['sess-1'] }));
    const byId = Object.fromEntries(scene.agents.map((a) => [a.id, a]));
    expect(byId['ag-1'].awake).toBe(true);
    expect(byId['ag-2'].awake).toBe(false);
  });

  it('location is the room key when last_outbound_at is within 8h, else null', async () => {
    addWorkgroup('wg-1');
    addGroup('ag-1', 'wg-1');
    addGroup('ag-2', 'wg-1');
    addMessagingGroup('mg-1', 'slack', 'C123');
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    const old = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString(); // 20h ago
    addSession('sess-1', 'ag-1', { messagingGroupId: 'mg-1', lastOutboundAt: recent });
    addSession('sess-2', 'ag-2', { messagingGroupId: 'mg-1', lastOutboundAt: old });

    const scene = await buildObservatoryScene('wg-1', makeDeps());
    const byId = Object.fromEntries(scene.agents.map((a) => [a.id, a]));
    expect(byId['ag-1'].location).toBe('C123');
    expect(byId['ag-1'].lastSeenAt).toBe(recent);
    expect(byId['ag-2'].location).toBeNull();
    expect(byId['ag-2'].lastSeenAt).toBe(old); // lastSeenAt is unconditional; location is the 8h-gated one
  });

  // The live report: an agent whose container was up and whose seat was still
  // (correctly) in #room rendered as pulsing/working there, four hours after
  // its last word in that room.
  it('active needs RECENT room outbound — a seat inside the 8h window is not a pulse', async () => {
    addWorkgroup('wg-1');
    addGroup('ag-now', 'wg-1');
    addGroup('ag-stale', 'wg-1');
    addMessagingGroup('mg-1', 'slack', 'C123');
    const justNow = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const hoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    addSession('sess-now', 'ag-now', { messagingGroupId: 'mg-1', lastOutboundAt: justNow });
    addSession('sess-stale', 'ag-stale', { messagingGroupId: 'mg-1', lastOutboundAt: hoursAgo });

    const scene = await buildObservatoryScene(
      'wg-1',
      makeDeps({ getActiveContainerSessionIds: () => ['sess-now', 'sess-stale'] }),
    );
    const byId = Object.fromEntries(scene.agents.map((a) => [a.id, a]));
    // Both are awake and both are still SEATED in the room — only one is working.
    expect(byId['ag-now'].awake).toBe(true);
    expect(byId['ag-stale'].awake).toBe(true);
    expect(byId['ag-now'].location).toBe('C123');
    expect(byId['ag-stale'].location).toBe('C123');
    expect(byId['ag-now'].active).toBe(true);
    expect(byId['ag-stale'].active).toBe(false);
  });

  it('active is false for an asleep container however fresh the room outbound', async () => {
    addWorkgroup('wg-1');
    addGroup('ag-1', 'wg-1');
    addMessagingGroup('mg-1', 'slack', 'C123');
    addSession('sess-1', 'ag-1', {
      messagingGroupId: 'mg-1',
      lastOutboundAt: new Date(Date.now() - 30 * 1000).toISOString(),
    });

    const scene = await buildObservatoryScene('wg-1', makeDeps({ getActiveContainerSessionIds: () => [] }));
    expect(scene.agents[0].active).toBe(false);
  });

  it('a busy task session does not make an agent active in a room it has not spoken in', async () => {
    addWorkgroup('wg-1');
    addGroup('ag-1', 'wg-1');
    addMessagingGroup('mg-1', 'slack', 'C123');
    addSession('sess-room', 'ag-1', {
      messagingGroupId: 'mg-1',
      lastOutboundAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });
    addSession('sess-task', 'ag-1', { lastOutboundAt: new Date(Date.now() - 30 * 1000).toISOString() });

    const scene = await buildObservatoryScene('wg-1', makeDeps({ getActiveContainerSessionIds: () => ['sess-task'] }));
    expect(scene.agents[0].location).toBe('C123');
    expect(scene.agents[0].active).toBe(false);
  });

  it('a newer room-less task session never pulls an agent off its real room', async () => {
    addWorkgroup('wg-1');
    addGroup('ag-1', 'wg-1');
    addMessagingGroup('mg-1', 'slack', 'C123');
    const inRoom = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago, in a room
    const newerTask = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago, no room
    addSession('sess-room', 'ag-1', { messagingGroupId: 'mg-1', lastOutboundAt: inRoom });
    addSession('sess-task', 'ag-1', { messagingGroupId: null, lastOutboundAt: newerTask });

    const scene = await buildObservatoryScene('wg-1', makeDeps());
    const agent = scene.agents[0];
    // Location comes from the most recent session WITH a room; lastSeenAt from any.
    expect(agent.location).toBe('C123');
    expect(agent.lastSeenAt).toBe(newerTask);
  });

  it('holding matches claim owner to agent name/folder case-insensitively (canonical name, no persona override)', async () => {
    addWorkgroup('wg-1');
    addGroup('ag-1', 'wg-1', 'Ava', 'ava-folder');
    writeClaim('wg-1', 'seam-1', { owner: 'AVA', claimed_at: now(), ttl_hours: 4 });
    writeClaim('wg-1', 'seam-2', { owner: 'nobody', claimed_at: now(), ttl_hours: 4 });

    const scene = await buildObservatoryScene('wg-1', makeDeps());
    expect(scene.agents[0].holding).toEqual(['seam-1']);
    // The unmatched claim still appears in claims, unattached.
    expect(scene.claims.map((c) => c.slug).sort()).toEqual(['seam-1', 'seam-2']);
  });

  it('holding matches against the RESOLVED persona name, not agent_groups.name, when they differ', async () => {
    addWorkgroup('wg-1');
    // Infrastructure name differs from the channel-facing persona name.
    addGroup('ag-1', 'wg-1', 'wg1-alpha', 'wg1-alpha');
    writeClaim('wg-1', 'seam-1', { owner: 'ava', claimed_at: now(), ttl_hours: 4 });

    const scene = await buildObservatoryScene('wg-1', makeDeps({ resolveAssistantName: async () => 'ava' }));
    expect(scene.agents[0].name).toBe('ava');
    expect(scene.agents[0].canonicalName).toBe('wg1-alpha');
    expect(scene.agents[0].holding).toEqual(['seam-1']);
  });

  it('a resolveAssistantName failure falls back to agent_groups.name and never blanks the scene', async () => {
    addWorkgroup('wg-1');
    addGroup('ag-1', 'wg-1', 'wg1-alpha', 'wg1-alpha');

    const scene = await buildObservatoryScene(
      'wg-1',
      makeDeps({
        resolveAssistantName: async () => {
          throw new Error('boom');
        },
      }),
    );
    expect(scene.agents[0].name).toBe('wg1-alpha');
    expect(scene.agents[0].canonicalName).toBe('wg1-alpha');
  });

  it('claims carry parked/stale/live states from real claim files, via an injected root', async () => {
    addWorkgroup('wg-1');
    const staleClaimedAt = new Date(Date.now() - 10 * 3600_000).toISOString(); // 10h ago, 1h TTL → stale
    writeClaim('wg-1', 'stale-one', { owner: 'ava', claimed_at: staleClaimedAt, ttl_hours: 1 });
    writeClaim('wg-1', 'live-one', { owner: 'zed', claimed_at: now(), ttl_hours: 4 });
    writeClaim('wg-1', 'parked-one', { owner: 'cy', status: 'parked', parked_at: now(), note: 'handoff' });

    const scene = await buildObservatoryScene('wg-1', makeDeps({ claimsRoot: path.join(TEST_DIR, 'workgroups') }));
    const byState = Object.fromEntries(scene.claims.map((c) => [c.slug, c.state]));
    expect(byState['stale-one']).toBe('stale');
    expect(byState['live-one']).toBe('live');
    expect(byState['parked-one']).toBe('parked');
  });

  // obs.C.26 — a claim slug is a code name, so the board carries the session
  // whose transcript explains it. Which session, when siblings share a thread,
  // is the whole question.
  describe('claim → sessionId', () => {
    const claimsRoot = () => path.join(TEST_DIR, 'workgroups');
    const thread = 'slack:C1:1.2';

    it('picks the OWNER’s session when siblings sit on the same thread', async () => {
      addWorkgroup('wg-1');
      addGroup('ag-ava', 'wg-1', 'ava');
      addGroup('ag-sib', 'wg-1', 'sib');
      // The sibling spoke more recently, and still does not win: the claim is
      // ava's, so ava's side of the thread is the one that explains it.
      addSession('sess-ava', 'ag-ava', {
        threadId: thread,
        lastOutboundAt: new Date(Date.now() - 60_000).toISOString(),
      });
      addSession('sess-sib', 'ag-sib', { threadId: thread, lastOutboundAt: now() });
      writeClaim('wg-1', 'mine', { owner: 'ava', claimed_at: now(), ttl_hours: 4, thread_id: thread });

      const scene = await buildObservatoryScene('wg-1', makeDeps({ claimsRoot: claimsRoot() }));
      expect(scene.claims[0].sessionId).toBe('sess-ava');
    });

    it('falls back to whoever spoke there last when the owner is not an agent here', async () => {
      addWorkgroup('wg-1');
      addGroup('ag-a', 'wg-1', 'a');
      addGroup('ag-b', 'wg-1', 'b');
      addSession('sess-old', 'ag-a', {
        threadId: thread,
        lastOutboundAt: new Date(Date.now() - 3600_000).toISOString(),
      });
      addSession('sess-new', 'ag-b', { threadId: thread, lastOutboundAt: now() });
      // A human holds it — no agent's `holding` names this slug.
      writeClaim('wg-1', 'a-persons', { owner: 'Robin', claimed_at: now(), ttl_hours: 4, thread_id: thread });

      const scene = await buildObservatoryScene('wg-1', makeDeps({ claimsRoot: claimsRoot() }));
      expect(scene.claims[0].sessionId).toBe('sess-new');
    });

    it('stays null for a claim with no thread, and for a thread nobody has a session on', async () => {
      addWorkgroup('wg-1');
      addGroup('ag-a', 'wg-1', 'a');
      addSession('sess-elsewhere', 'ag-a', { threadId: 'slack:C9:9.9', lastOutboundAt: now() });
      writeClaim('wg-1', 'no-thread', { owner: 'a', claimed_at: now(), ttl_hours: 4 });
      writeClaim('wg-1', 'no-session', { owner: 'a', claimed_at: now(), ttl_hours: 4, thread_id: thread });

      const scene = await buildObservatoryScene('wg-1', makeDeps({ claimsRoot: claimsRoot() }));
      const bySlug = Object.fromEntries(scene.claims.map((c) => [c.slug, c.sessionId]));
      expect(bySlug['no-thread']).toBeNull();
      expect(bySlug['no-session']).toBeNull();
    });

    it('never reaches outside the workgroup, however the thread is shared', async () => {
      addWorkgroup('wg-1');
      addWorkgroup('wg-2');
      addGroup('ag-mine', 'wg-1', 'mine');
      addGroup('ag-theirs', 'wg-2', 'theirs');
      addSession('sess-theirs', 'ag-theirs', { threadId: thread, lastOutboundAt: now() });
      writeClaim('wg-1', 'ours', { owner: 'mine', claimed_at: now(), ttl_hours: 4, thread_id: thread });

      const scene = await buildObservatoryScene('wg-1', makeDeps({ claimsRoot: claimsRoot() }));
      expect(scene.claims[0].sessionId).toBeNull();
    });
  });

  it('provider comes from container_configs when present, else agent_groups.agent_provider', async () => {
    addWorkgroup('wg-1');
    addGroup('ag-1', 'wg-1');
    addGroup('ag-2', 'wg-1');
    getDb()
      .prepare(
        "INSERT INTO container_configs (agent_group_id, provider, updated_at) VALUES ('ag-1', 'opencode', datetime('now'))",
      )
      .run();

    const scene = await buildObservatoryScene('wg-1', makeDeps());
    const byId = Object.fromEntries(scene.agents.map((a) => [a.id, a]));
    expect(byId['ag-1'].provider).toBe('opencode');
    expect(byId['ag-2'].provider).toBe('claude'); // falls back to agent_groups.agent_provider
  });

  it('lastSessionId follows the newest outbound, including a room-less task session', async () => {
    addWorkgroup('wg-1');
    addGroup('ag-1', 'wg-1');
    addMessagingGroup('mg-1', 'slack', 'slack:C0EXAMPLE2');
    // The room session spoke earlier; the task session (no room) spoke last.
    // location must stay on the room, but a steer belongs in the newest
    // conversation — the two trackers deliberately disagree here.
    // Relative, not absolute: location expires after LOCATION_WINDOW_MS (8h),
    // so a hard-coded date passes on the day it is written and fails forever
    // after — which is exactly how this test broke.
    const roomAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    const taskAt = new Date(Date.now() - 90 * 60 * 1000).toISOString(); // 1.5h ago, newer
    addSession('sess-room', 'ag-1', { messagingGroupId: 'mg-1', lastOutboundAt: roomAt });
    addSession('sess-task', 'ag-1', { messagingGroupId: null, lastOutboundAt: taskAt });

    const scene = await buildObservatoryScene('wg-1', makeDeps());
    expect(scene.agents[0].lastSessionId).toBe('sess-task');
    expect(scene.agents[0].location).toBe('slack:C0EXAMPLE2');
  });

  it('lastSessionId is null when the agent has never produced outbound', async () => {
    addWorkgroup('wg-1');
    addGroup('ag-1', 'wg-1');
    addSession('sess-quiet', 'ag-1', { lastOutboundAt: null });
    const scene = await buildObservatoryScene('wg-1', makeDeps());
    expect(scene.agents[0].lastSessionId).toBeNull();
  });

  describe('liveSession', () => {
    it('carries the same winning session as location, plus its thread link', async () => {
      addWorkgroup('wg-1');
      addGroup('ag-1', 'wg-1');
      addMessagingGroup('mg-1', 'slack', 'slack:C123');
      const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
      addSession('sess-room', 'ag-1', {
        messagingGroupId: 'mg-1',
        lastOutboundAt: recent,
        threadId: 'slack:C123:1.2',
      });

      const scene = await buildObservatoryScene(
        'wg-1',
        makeDeps({ resolveThreadUrl: (t) => `https://acme.slack.com/${t}` }),
      );
      expect(scene.agents[0].location).toBe('slack:C123');
      expect(scene.agents[0].liveSession).toEqual({
        channelKey: 'slack:C123',
        sessionId: 'sess-room',
        threadUrl: 'https://acme.slack.com/slack:C123:1.2',
        lastOutboundAt: recent,
      });
    });

    it('is null outside the 8h location window, in lockstep with location', async () => {
      addWorkgroup('wg-1');
      addGroup('ag-1', 'wg-1');
      addMessagingGroup('mg-1', 'slack', 'slack:C123');
      const old = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString(); // 20h ago
      addSession('sess-room', 'ag-1', { messagingGroupId: 'mg-1', lastOutboundAt: old, threadId: 'slack:C123:1.2' });

      const scene = await buildObservatoryScene('wg-1', makeDeps());
      expect(scene.agents[0].location).toBeNull();
      expect(scene.agents[0].liveSession).toBeNull();
    });

    it('threadUrl is null when the session carries no thread id, without dropping the session itself', async () => {
      addWorkgroup('wg-1');
      addGroup('ag-1', 'wg-1');
      addMessagingGroup('mg-1', 'slack', 'slack:C123');
      const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      // Channel-level (shared-mode) session — no thread_id.
      addSession('sess-room', 'ag-1', { messagingGroupId: 'mg-1', lastOutboundAt: recent, threadId: null });

      const scene = await buildObservatoryScene('wg-1', makeDeps());
      expect(scene.agents[0].liveSession).toEqual({
        channelKey: 'slack:C123',
        sessionId: 'sess-room',
        threadUrl: null,
        lastOutboundAt: recent,
      });
    });

    it('is null when the agent has never produced outbound in any room', async () => {
      addWorkgroup('wg-1');
      addGroup('ag-1', 'wg-1');
      addSession('sess-quiet', 'ag-1', { lastOutboundAt: null });
      const scene = await buildObservatoryScene('wg-1', makeDeps());
      expect(scene.agents[0].liveSession).toBeNull();
    });
  });

  it('nextTask is always null (no cheap titled read exists yet)', async () => {
    addWorkgroup('wg-1');
    addGroup('ag-1', 'wg-1');
    const scene = await buildObservatoryScene('wg-1', makeDeps());
    expect(scene.agents[0].nextTask).toBeNull();
  });
});

describe('observatoryHandler', () => {
  it('missing workgroup param → 200 empty scene', async () => {
    const res = (await observatoryHandler(
      makeReq('http://localhost/dashboard/api/observatory'),
      {},
      makeCtx({ no_filter: true }),
    ))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rooms: unknown[]; agents: unknown[]; claims: unknown[] };
    expect(body.rooms).toEqual([]);
    expect(body.agents).toEqual([]);
    expect(body.claims).toEqual([]);
  });

  it('out-of-scope workgroup → 200 empty scene (disclose-as-not-found, flattened to one status)', async () => {
    addWorkgroup('wg-1');
    addGroup('ag-1', 'wg-1');
    const res = (await observatoryHandler(
      makeReq('http://localhost/dashboard/api/observatory?workgroup=wg-1'),
      {},
      makeCtx({ allowed_group_ids: [] }),
    ))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: unknown[] };
    expect(body.agents).toEqual([]);
  });

  it('in-scope workgroup returns the full scene', async () => {
    addWorkgroup('wg-1');
    addGroup('ag-1', 'wg-1');
    const res = (await observatoryHandler(
      makeReq('http://localhost/dashboard/api/observatory?workgroup=wg-1'),
      {},
      makeCtx({ allowed_group_ids: ['ag-1'] }),
    ))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workgroupId: string; agents: { id: string }[] };
    expect(body.workgroupId).toBe('wg-1');
    expect(body.agents.map((a) => a.id)).toEqual(['ag-1']);
  });
});

describe('threadPermalink — multi-workspace adapter resolution', () => {
  /** Registers adapters under EXACT channel-type keys, the way a live install does. */
  function registerAdapters(byChannelType: Record<string, { permalink?: (p: string, t: string) => string | null }>) {
    vi.mocked(getChannelAdapter).mockImplementation(
      (key: string) => byChannelType[key] as ReturnType<typeof getChannelAdapter>,
    );
  }

  beforeEach(() => {
    vi.mocked(getChannelAdapter).mockImplementation(() => undefined);
  });

  it('resolves through the workspace-specific channel_type the thread’s channel is wired to', () => {
    addMessagingGroup('mg-a', 'slack-acme-support', 'slack:C0AAA', '#dispatch');

    // Only the workspace-specific key is registered — the bare "slack" prefix
    // is not an adapter key in a multi-workspace install. This is the bug:
    // before the mg lookup, every genuine Slack thread resolved to null here.
    registerAdapters({
      'slack-acme-support': { permalink: (p, t) => `https://acme.slack.com/archives/${p}/${t}` },
    });

    expect(threadPermalink('slack:C0AAA:1786901676.029669')).toBe(
      'https://acme.slack.com/archives/slack:C0AAA/slack:C0AAA:1786901676.029669',
    );
  });

  it('falls back to the bare platform prefix for a single-workspace install', () => {
    // No messaging_groups row for this channel at all — the prefix IS the key.
    registerAdapters({ slack: { permalink: () => 'https://one.slack.com/archives/C0BBB/p1786901676029669' } });

    expect(threadPermalink('slack:C0BBB:1786901676.029669')).toBe(
      'https://one.slack.com/archives/C0BBB/p1786901676029669',
    );
  });

  it('skips a sibling type whose adapter is offline and keeps trying the rest', () => {
    addMessagingGroup('mg-b1', 'slack-acme-alpha', 'slack:C0CCC', '#dispatch');
    addMessagingGroup('mg-b2', 'slack-acme-beta', 'slack:C0CCC', '#dispatch');

    // alpha sorts first but is not registered; beta must still answer.
    registerAdapters({ 'slack-acme-beta': { permalink: () => 'https://acme.slack.com/archives/C0CCC/p1' } });

    expect(threadPermalink('slack:C0CCC:1786901676.029669')).toBe('https://acme.slack.com/archives/C0CCC/p1');
  });

  it('returns null for a platform no adapter owns — including non-channel thread ids', () => {
    registerAdapters({ 'slack-acme-support': { permalink: () => 'https://acme.slack.com/archives/x/p1' } });

    // A task thread id ('system:tasks:<slug>') is not a channel and must not
    // be talked into one.
    expect(threadPermalink('system:tasks:nightly-sweep-f2ee')).toBeNull();
    expect(threadPermalink('teams:19:meeting')).toBeNull();
  });

  it('never throws when the owning adapter does', () => {
    addMessagingGroup('mg-c', 'slack-acme-support', 'slack:C0DDD', '#dispatch');
    registerAdapters({
      'slack-acme-support': {
        permalink: () => {
          throw new Error('adapter exploded');
        },
      },
    });

    expect(threadPermalink('slack:C0DDD:1786901676.029669')).toBeNull();
  });

  it('carries the resolved link onto every claim on the board', async () => {
    addWorkgroup('wg-tp');
    addGroup('ag-tp', 'wg-tp', 'ava', 'ava-folder');
    addMessagingGroup('mg-tp', 'slack-acme-support', 'slack:C0EEE', '#dispatch');
    wire('mg-tp', 'ag-tp');
    registerAdapters({ 'slack-acme-support': { permalink: () => 'https://acme.slack.com/archives/C0EEE/p1' } });
    writeClaim('wg-tp', 'money', {
      slug: 'money',
      owner: 'ava',
      state: 'active',
      thread_id: 'slack:C0EEE:1786901676.029669',
      claimed_at: new Date().toISOString(),
    });

    const scene = await buildObservatoryScene('wg-tp', makeDeps());
    expect(scene.claims.map((c) => c.threadUrl)).toEqual(['https://acme.slack.com/archives/C0EEE/p1']);
  });
});

/**
 * Room signals — the read-side that lets the floor draw a live indicator for a
 * room whose producer says something is happening in it right now.
 *
 * The contract these pin is TOTAL: the reader is called on every 15s poll and
 * must never throw, never blank the scene, and never claim a room is live on
 * anything softer than a fresh timestamp inside the workgroup's own directory.
 */
describe('readWorkgroupSignals', () => {
  const SIG_ROOT = path.join(os.tmpdir(), 'nanoclaw-observatory-signals-test');
  // Fixed clock. Nothing here is allowed to depend on how long the suite takes.
  const NOW = Date.parse('2026-08-19T12:00:00.000Z');
  const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

  const repoRoot = () => path.join(SIG_ROOT, 'repo');
  const dataDir = () => path.join(SIG_ROOT, 'data');
  const wgDir = (wg = 'wg-1') => path.join(dataDir(), 'workgroups', wg);

  function writeConfig(value: unknown | string): void {
    const dir = path.join(repoRoot(), '.nanoclaw');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'office-signals.json'), typeof value === 'string' ? value : JSON.stringify(value));
  }

  function writeState(relative: string, body: unknown | string, wg = 'wg-1'): string {
    const file = path.join(wgDir(wg), relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
    return file;
  }

  /** The producer-shaped binding the live install uses. */
  const binding = (over: Record<string, unknown> = {}) => ({
    room: 'slack:C0FEED',
    file: 'runner/run-active.json',
    freshKey: 'progressAt',
    maxAgeSeconds: 1800,
    vignette: 'smoke',
    ...over,
  });

  const read = (wg = 'wg-1') => readWorkgroupSignals(wg, NOW, repoRoot(), dataDir());

  beforeEach(() => {
    fs.rmSync(SIG_ROOT, { recursive: true, force: true });
    fs.mkdirSync(wgDir(), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(SIG_ROOT, { recursive: true, force: true });
  });

  it('reports a room live when its producer stamped progress inside the window', () => {
    writeConfig([binding()]);
    writeState('runner/run-active.json', { progressAt: minutesAgo(5), runId: 'r-1' });
    expect(read()).toEqual([{ room: 'slack:C0FEED', vignette: 'smoke', active: true }]);
  });

  it('reports it quiet once the stamp is older than the producer’s own staleness limit', () => {
    writeConfig([binding()]);
    // 1800s == 30m. At exactly the limit the producer already calls it stale.
    writeState('runner/run-active.json', { progressAt: minutesAgo(30) });
    expect(read()).toEqual([{ room: 'slack:C0FEED', vignette: 'smoke', active: false }]);

    writeState('runner/run-active.json', { progressAt: minutesAgo(29) });
    expect(read()![0]!.active).toBe(true);
  });

  it('still emits the entry when the state file is missing, unreadable or not JSON', () => {
    writeConfig([binding()]);
    // Never written at all — the campaign has simply never run.
    expect(read()).toEqual([{ room: 'slack:C0FEED', vignette: 'smoke', active: false }]);

    writeState('runner/run-active.json', 'not json at all');
    expect(read()).toEqual([{ room: 'slack:C0FEED', vignette: 'smoke', active: false }]);

    // A directory where a file was expected — readFileSync throws EISDIR.
    fs.rmSync(path.join(wgDir(), 'runner', 'run-active.json'));
    fs.mkdirSync(path.join(wgDir(), 'runner', 'run-active.json'));
    expect(read()).toEqual([{ room: 'slack:C0FEED', vignette: 'smoke', active: false }]);
  });

  it('refuses a timestamp that is absent, not a string, or not a date', () => {
    writeConfig([binding()]);
    for (const body of [{}, { progressAt: 12345 }, { progressAt: 'whenever' }, { progressAt: null }, []]) {
      writeState('runner/run-active.json', body);
      expect(read()![0]!.active).toBe(false);
    }
  });

  it('tolerates a little clock skew and refuses a stamp from the future', () => {
    writeConfig([binding()]);
    writeState('runner/run-active.json', { progressAt: new Date(NOW + 30_000).toISOString() });
    expect(read()![0]!.active).toBe(true);

    writeState('runner/run-active.json', { progressAt: new Date(NOW + 120_000).toISOString() });
    expect(read()![0]!.active).toBe(false);
  });

  it('ships no signals field at all when there is no config, or the config is not a JSON array', () => {
    expect(read()).toBeUndefined(); // no file

    writeConfig('{ this is not json');
    expect(read()).toBeUndefined();

    writeConfig({ room: 'slack:C0FEED' }); // an object, not an array
    expect(read()).toBeUndefined();
  });

  it('rejects the ENTRY, not the file, when a binding fails the closed schema', () => {
    const good = binding({ room: 'slack:GOOD' });
    writeState('runner/run-active.json', { progressAt: minutesAgo(1) });
    // Deliberately untyped: half of these are not objects at all, which is
    // exactly the case the reader has to survive.
    const bad: unknown[] = [
      binding({ room: 'a', vignette: 'fireworks' }), // not a vignette this build draws
      binding({ room: 'b', maxAgeSeconds: 0 }),
      binding({ room: 'c', maxAgeSeconds: -60 }),
      binding({ room: 'd', maxAgeSeconds: 12.5 }),
      binding({ room: 'e', maxAgeSeconds: '1800' }),
      binding({ room: 'f', freshKey: '' }),
      binding({ room: 'g', file: '' }),
      binding({ room: '' }),
      { ...binding({ room: 'h' }), extra: 'a key this build does not implement' },
      { room: 'i', file: 'x.json', freshKey: 'at', maxAgeSeconds: 60 }, // no vignette
      'not an object',
      null,
      ['nested'],
    ];
    writeConfig([...bad, good]);
    expect(read()).toEqual([{ room: 'slack:GOOD', vignette: 'smoke', active: true }]);
  });

  it('keeps the first binding for a room and drops the rest', () => {
    writeState('runner/run-active.json', { progressAt: minutesAgo(1) });
    writeState('other.json', { progressAt: minutesAgo(1) });
    writeConfig([binding(), binding({ file: 'other.json', maxAgeSeconds: 60 })]);
    const out = read()!;
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ room: 'slack:C0FEED', vignette: 'smoke', active: true });
  });

  it('rejects a file that escapes the workgroup directory, by any route', () => {
    // A real, fresh file OUTSIDE the workgroup dir — so a reader that followed
    // the escape would report `active: true` and be caught by it.
    const outside = path.join(SIG_ROOT, 'outside.json');
    fs.writeFileSync(outside, JSON.stringify({ progressAt: minutesAgo(1) }));

    writeConfig([binding({ file: outside })]); // absolute
    expect(read()).toEqual([]);

    writeConfig([binding({ file: '../../outside.json' })]); // traversal
    expect(read()).toEqual([]);

    writeConfig([binding({ file: './nested/../../../outside.json' })]); // dressed-up traversal
    expect(read()).toEqual([]);

    // Symlinked directory inside the workgroup dir, pointing out of it. Every
    // textual check passes; only the realpath catches it.
    fs.symlinkSync(SIG_ROOT, path.join(wgDir(), 'escape'), 'dir');
    writeConfig([binding({ file: 'escape/outside.json' })]);
    expect(read()).toEqual([]);
  });

  it('refuses a state file that is ITSELF a symlink pointing out of the workgroup', () => {
    // The parent chain is entirely legitimate here — only the final component
    // is the escape, which is exactly what a parent-only realpath check misses.
    const outside = path.join(SIG_ROOT, 'outside.json');
    fs.writeFileSync(outside, JSON.stringify({ progressAt: minutesAgo(1) }));
    fs.mkdirSync(path.join(wgDir(), 'runner'), { recursive: true });
    fs.symlinkSync(outside, path.join(wgDir(), 'runner', 'run-active.json'));
    writeConfig([binding()]);

    // The entry is still emitted (it is a bound room), but it reports quiet —
    // and, the part that matters, the file outside was never read. A reader
    // that followed the link would have found a 1-minute-old stamp and said
    // `active: true`.
    expect(read()).toEqual([{ room: 'slack:C0FEED', vignette: 'smoke', active: false }]);
  });

  it('refuses a state file that is not a regular file, rather than blocking the poll on it', () => {
    writeConfig([binding()]);
    fs.mkdirSync(path.join(wgDir(), 'runner'), { recursive: true });

    // A directory is the easy case — the read would throw EISDIR regardless.
    fs.mkdirSync(path.join(wgDir(), 'runner', 'run-active.json'));
    expect(read()![0]!.active).toBe(false);
    fs.rmdirSync(path.join(wgDir(), 'runner', 'run-active.json'));

    // A FIFO is the case O_NONBLOCK exists for: opening one for reading BLOCKS
    // until a writer shows up, and that open happens before fstat can reject
    // it — so without the flag this assertion does not fail, it hangs the
    // suite, exactly as it would hang the 15s observatory poll. The fstat
    // regular-file check beside it is defence in depth: with the flag, the
    // size cap and JSON.parse already refuse everything it refuses.
    execFileSync('mkfifo', [path.join(wgDir(), 'runner', 'run-active.json')]);
    expect(read()![0]!.active).toBe(false);
  });

  it('refuses a timestamp that parses but is not the ISO shape R7 names', () => {
    writeConfig([binding()]);
    // Every one of these is accepted by Date.parse and none is an ISO instant:
    // their meaning is engine- and locale-dependent, which is not something a
    // room's live state may be asserted from.
    for (const stamp of [
      'December 25, 2026 10:00:00',
      '12/25/2026',
      '2026-08-19 12:00:00',
      '2026-08-19T12:00:00',
      '2026-08-19T12:00:00+00:00',
      String(NOW),
    ]) {
      writeState('runner/run-active.json', { progressAt: stamp });
      expect(read()![0]!.active).toBe(false);
    }
    // …while the shape toISOString actually emits is accepted, with or
    // without the milliseconds.
    writeState('runner/run-active.json', { progressAt: new Date(NOW - 60_000).toISOString() });
    expect(read()![0]!.active).toBe(true);
    writeState('runner/run-active.json', { progressAt: '2026-08-19T11:59:00Z' });
    expect(read()![0]!.active).toBe(true);
  });

  it('reads the workgroup’s own directory, not a neighbour’s', () => {
    writeConfig([binding()]);
    writeState('runner/run-active.json', { progressAt: minutesAgo(1) }, 'wg-1');
    expect(read('wg-1')![0]!.active).toBe(true);
    expect(read('wg-2')![0]!.active).toBe(false);
  });

  it('reads nothing for a workgroup id that is not a single safe path segment', () => {
    writeConfig([binding()]);
    expect(read('../escape')).toBeUndefined();
  });
});

describe('the scene carries signals additively', () => {
  const SIG_ROOT = path.join(os.tmpdir(), 'nanoclaw-observatory-signals-scene-test');
  const repoRoot = path.join(SIG_ROOT, 'repo');

  beforeEach(() => {
    fs.rmSync(SIG_ROOT, { recursive: true, force: true });
    addWorkgroup('wg-sig');
    addGroup('ag-sig', 'wg-sig', 'ava', 'ava-folder');
  });
  afterEach(() => {
    fs.rmSync(SIG_ROOT, { recursive: true, force: true });
  });

  it('is byte-identical to the pre-change shape when nothing is configured', async () => {
    const scene = await buildObservatoryScene('wg-sig', makeDeps());
    expect(scene.signals).toBeUndefined();
    // The wire is what matters: an undefined optional must not put a key on it.
    const wireKeys = Object.keys(JSON.parse(JSON.stringify(scene))).sort();
    expect(wireKeys).not.toContain('signals');
    expect(wireKeys).toEqual([
      'agents',
      'asOf',
      'claims',
      'releaseState',
      'rooms',
      // Injected as `{}` by makeDeps, so it serializes; the live no-config
      // reader returns undefined and it drops off the wire the same way
      // `signals` does.
      'themedSlots',
      'workgroupId',
    ]);
  });

  it('adds the field and changes nothing else when signals ARE configured', async () => {
    const before = await buildObservatoryScene('wg-sig', makeDeps());
    const after = await buildObservatoryScene(
      'wg-sig',
      makeDeps({ signals: [{ room: 'slack:C0FEED', vignette: 'smoke', active: true }] }),
    );
    expect(after.signals).toEqual([{ room: 'slack:C0FEED', vignette: 'smoke', active: true }]);
    // Everything except asOf (a clock) and the new field is untouched.
    const strip = (s: typeof before) => ({ ...s, asOf: '', signals: undefined });
    expect(strip(after)).toEqual(strip(before));
  });

  it('never throws the poll when the config on disk is nonsense', async () => {
    fs.mkdirSync(path.join(repoRoot, '.nanoclaw'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, '.nanoclaw', 'office-signals.json'), '}{');
    expect(readWorkgroupSignals('wg-sig', Date.now(), repoRoot, TEST_DIR)).toBeUndefined();
    const scene = await buildObservatoryScene('wg-sig', makeDeps());
    expect(scene.rooms).toBeDefined();
  });
});
