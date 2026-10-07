import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR } = vi.hoisted(() => ({ TEST_DATA_DIR: uniqueTmpRoot('live-work-digest') }));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DATA_DIR };
});

import { closeDb, createAgentGroup, createMessagingGroup, getDb, initMigratedTestDb } from './db/index.js';
import { createSession } from './db/sessions.js';
import { buildLiveWorkDigest, LIVE_WORK_BOUNDS } from './live-work-digest.js';
import { outboundDbPath } from './mailbox/sqlite/paths.js';
import { initSessionFolder } from './session-manager.js';

const AG = 'ag-live';
const ME = 'sess-me';
const MY_THREAD = 'slack:CREVIEW:1.000';
const NOW = Date.parse('2026-10-06T22:03:11.000Z');
const HOUR = 60 * 60 * 1000;
const CLAIMS_ROOT = path.join(TEST_DATA_DIR, 'claims-root');
const linkFor = (threadId: string) => Promise.resolve(`https://chat.example/${threadId}`);

const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

async function session(
  id: string,
  threadId: string | null,
  list?: Record<string, unknown>,
  agentGroupId = AG,
): Promise<void> {
  await createSession({
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: threadId?.startsWith('slack:') ? 'mg-build' : null,
    thread_id: threadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: at(-HOUR),
    created_at: at(-2 * HOUR),
  });
  initSessionFolder(agentGroupId, id);
  if (!list) return;
  const db = new Database(outboundDbPath(agentGroupId, id));
  try {
    db.prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      'task_list',
      JSON.stringify({ version: 1, finished: false, ...list }),
      at(0),
    );
  } finally {
    db.close();
  }
}

function claim(slug: string, body: Record<string, unknown>): void {
  const dir = path.join(CLAIMS_ROOT, 'wg-live', 'claims');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(body));
}

const liveClaim = (owner: string, threadId?: string) => ({
  owner,
  claimed_at: at(-HOUR),
  ttl_hours: 4,
  note: `${owner} work`,
  ...(threadId ? { thread_id: threadId } : {}),
});

describe('buildLiveWorkDigest', () => {
  beforeEach(async () => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    await initMigratedTestDb();
    await createAgentGroup({ id: AG, name: 'Live', folder: 'live', agent_provider: null, created_at: at(-HOUR) });
    await getDb().run(`INSERT INTO workgroups (id, display_name, created_at) VALUES ('wg-live', 'Live', ?)`, at(-HOUR));
    await getDb().run(`UPDATE agent_groups SET workgroup_id = 'wg-live' WHERE id = ?`, AG);
    await createMessagingGroup({
      id: 'mg-build',
      channel_type: 'slack',
      platform_id: 'slack:CBUILD',
      name: '#build-room',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: at(-HOUR),
    });
    await session(ME, MY_THREAD, {
      title: 'This conversation’s own list',
      items: [{ text: 'mine', status: 'in_progress' }],
      touchedAt: at(0),
    });
  });

  afterEach(async () => {
    await closeDb();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('lists unfinished, recent work outside this conversation, most recent list first', async () => {
    await session('sess-build', 'slack:CBUILD:2.000', {
      title: 'Acme QA deploy',
      items: [
        { text: 'Seed reviewed', status: 'done' },
        { text: 'Rebuild APK', status: 'pending' },
        { text: 'Deploy web', status: 'waiting', waitingOn: 'kit' },
        { text: 'Provision QA', status: 'in_progress' },
        { text: 'Post logins', status: 'pending' },
      ],
      touchedAt: at(-30 * 60 * 1000),
    });
    await session('sess-task', 'system:tasks:nightly', {
      title: 'Nightly sweep',
      items: [{ text: 'Sweep', status: 'pending' }],
      touchedAt: at(-60 * 1000),
    });
    await session('sess-finished', 'slack:CBUILD:3.000', {
      title: 'Done build',
      items: [{ text: 'Ship', status: 'done' }],
      finished: true,
      touchedAt: at(-60 * 1000),
    });
    await session('sess-abandoned', 'slack:CBUILD:4.000', {
      title: 'Abandoned list',
      items: [{ text: 'Never finished', status: 'in_progress' }],
      touchedAt: at(-LIVE_WORK_BOUNDS.listWindowMs - HOUR),
    });
    await session('sess-corrupt', 'slack:CBUILD:5.000');
    fs.writeFileSync(outboundDbPath(AG, 'sess-corrupt'), 'not a database');

    claim('qa-env', liveClaim('kit', 'slack:CBUILD:2.000'));
    claim('other-build', liveClaim('ava'));
    claim('here', liveClaim('ava', MY_THREAD));
    claim('old', { ...liveClaim('kit', 'slack:CBUILD:6.000'), claimed_at: '2020-01-01T00:00:00Z' });
    claim('held', { ...liveClaim('kit', 'slack:CBUILD:7.000'), status: 'paused', paused_at: at(-HOUR) });
    claim('handoff', { ...liveClaim('kit', 'slack:CBUILD:8.000'), status: 'parked', parked_at: at(-HOUR) });

    const digest = await buildLiveWorkDigest(AG, ME, { now: NOW, claimsRoot: CLAIMS_ROOT, linkFor });

    expect(digest?.sessions).toEqual([
      {
        owner: 'Live',
        self: true,
        channel: 'scheduled task',
        threadId: 'system:tasks:nightly',
        link: null,
        title: 'Nightly sweep',
        items: ['○ Sweep'],
        updatedAt: at(-60 * 1000),
      },
      {
        owner: 'Live',
        self: true,
        channel: '#build-room',
        threadId: 'slack:CBUILD:2.000',
        link: 'https://chat.example/slack:CBUILD:2.000',
        title: 'Acme QA deploy',
        items: ['✱ Provision QA', '◷ Deploy web (waiting on kit)', '○ Rebuild APK'],
        updatedAt: at(-30 * 60 * 1000),
      },
    ]);
    expect(digest?.claims.map((c) => [c.slug, c.state, c.link])).toEqual([
      ['other-build', 'live', null],
      ['qa-env', 'live', 'https://chat.example/slack:CBUILD:2.000'],
      ['held', 'paused', 'https://chat.example/slack:CBUILD:7.000'],
      ['handoff', 'parked', 'https://chat.example/slack:CBUILD:8.000'],
    ]);
    expect(digest?.omitted).toBe(0);
    expect(digest?.partial).toBe(true);
  });

  it('returns an empty snapshot when the only work is this conversation’s own', async () => {
    claim('here', liveClaim('ava', MY_THREAD));

    await expect(buildLiveWorkDigest(AG, ME, { now: NOW, claimsRoot: CLAIMS_ROOT, linkFor })).resolves.toEqual({
      sessions: [],
      claims: [],
      omitted: 0,
      partial: false,
    });
  });

  it('includes open lists from sibling agent groups in the same workgroup, labelled by owner, and none beyond it', async () => {
    await createAgentGroup({ id: 'ag-sib', name: 'Sib', folder: 'sib', agent_provider: null, created_at: at(-HOUR) });
    await createAgentGroup({ id: 'ag-far', name: 'Far', folder: 'far', agent_provider: null, created_at: at(-HOUR) });
    await getDb().run(`INSERT INTO workgroups (id, display_name, created_at) VALUES ('wg-far', 'Far', ?)`, at(-HOUR));
    await getDb().run(`UPDATE agent_groups SET workgroup_id = 'wg-live' WHERE id = 'ag-sib'`);
    await getDb().run(`UPDATE agent_groups SET workgroup_id = 'wg-far' WHERE id = 'ag-far'`);
    await session(
      'sess-sib',
      'slack:CBUILD:2.000',
      { title: 'Hosted QA environment', items: [{ text: 'Provision QA', status: 'in_progress' }], touchedAt: at(0) },
      'ag-sib',
    );
    await session(
      'sess-sib-here',
      MY_THREAD,
      { title: 'Shared thread work', items: [{ text: 'Pair on it', status: 'in_progress' }], touchedAt: at(0) },
      'ag-sib',
    );
    await session(
      'sess-far',
      'slack:CBUILD:3.000',
      { title: 'Other workgroup build', items: [{ text: 'Build', status: 'in_progress' }], touchedAt: at(0) },
      'ag-far',
    );

    const digest = await buildLiveWorkDigest(AG, ME, { now: NOW, claimsRoot: CLAIMS_ROOT, linkFor });

    expect(digest?.sessions.map((s) => [s.owner, s.self, s.title, s.link])).toEqual([
      ['Sib', false, 'Hosted QA environment', 'https://chat.example/slack:CBUILD:2.000'],
    ]);
  });

  it('marks the snapshot partial when the candidate scan hits its cap', async () => {
    for (let i = 0; i < LIVE_WORK_BOUNDS.candidateSessions; i++) {
      await createSession({
        id: `sess-quiet-${i}`,
        agent_group_id: AG,
        messaging_group_id: null,
        thread_id: `system:tasks:quiet-${i}`,
        agent_provider: null,
        status: 'active',
        container_status: 'stopped',
        last_active: at(-30 * 60 * 1000),
        created_at: at(-2 * HOUR),
      });
    }
    await session('sess-long-build', 'slack:CBUILD:2.000', {
      title: 'Long build',
      items: [{ text: 'Provision QA', status: 'in_progress' }],
      touchedAt: at(0),
    });

    const digest = await buildLiveWorkDigest(AG, ME, { now: NOW, claimsRoot: CLAIMS_ROOT, linkFor });

    expect(digest).toEqual({ sessions: [], claims: [], omitted: 0, partial: true });
  });

  it('caps the claims it carries and counts the rest as omitted', async () => {
    for (let i = 0; i < LIVE_WORK_BOUNDS.claims + 2; i++) claim(`c-${i}`, liveClaim('kit'));

    const digest = await buildLiveWorkDigest(AG, ME, { now: NOW, claimsRoot: CLAIMS_ROOT, linkFor });

    expect(digest?.claims).toHaveLength(LIVE_WORK_BOUNDS.claims);
    expect(digest?.omitted).toBe(2);
  });
});
