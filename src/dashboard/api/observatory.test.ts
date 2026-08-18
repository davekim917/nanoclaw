/**
 * Tests for the observatory scene-graph endpoint:
 *   GET /dashboard/api/observatory?workgroup=<id>
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';

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
    // Isolate from whatever the live repo checkout's own .nanoclaw/office-themes.json
    // happens to contain — install config must never leak into a unit test's result.
    themedSlots: {},
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
