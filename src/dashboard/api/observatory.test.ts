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

const TEST_DIR = '/tmp/nanoclaw-observatory-api-test';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import {
  buildObservatoryScene,
  observatoryHandler,
  ownerMatchesAgent,
  readReleaseState,
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
    .prepare("INSERT INTO messaging_groups (id, channel_type, platform_id, name, created_at) VALUES (?, ?, ?, ?, datetime('now'))")
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
  opts: { messagingGroupId?: string | null; lastOutboundAt?: string | null } = {},
): void {
  getDb()
    .prepare(
      "INSERT INTO sessions (id, agent_group_id, messaging_group_id, status, last_outbound_at, created_at) VALUES (?, ?, ?, 'active', ?, datetime('now'))",
    )
    .run(id, agentGroupId, opts.messagingGroupId ?? null, opts.lastOutboundAt ?? null);
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

    const scene = await buildObservatoryScene(
      'wg-1',
      makeDeps({ resolveAssistantName: async () => 'ava' }),
    );
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

    const scene = await buildObservatoryScene(
      'wg-1',
      makeDeps({ claimsRoot: path.join(TEST_DIR, 'workgroups') }),
    );
    const byState = Object.fromEntries(scene.claims.map((c) => [c.slug, c.state]));
    expect(byState['stale-one']).toBe('stale');
    expect(byState['live-one']).toBe('live');
    expect(byState['parked-one']).toBe('parked');
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

  it('nextTask is always null (no cheap titled read exists yet)', async () => {
    addWorkgroup('wg-1');
    addGroup('ag-1', 'wg-1');
    const scene = await buildObservatoryScene('wg-1', makeDeps());
    expect(scene.agents[0].nextTask).toBeNull();
  });
});

describe('observatoryHandler', () => {
  it('missing workgroup param → 200 empty scene', async () => {
    const res = (await observatoryHandler(makeReq('http://localhost/dashboard/api/observatory'), {}, makeCtx({ no_filter: true })))!;
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
