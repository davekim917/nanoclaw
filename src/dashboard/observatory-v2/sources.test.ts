import type http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { SIGNAL_SCHEMA } from '../../db/migrations/072-observatory-signal.js';
import type { ObservatoryScene, ReleaseStateItem } from '../api/observatory.js';
import type { ThreadSummary } from '../api/threads.js';
import type { AuthedRequestContext } from '../router.js';
import { buildSignalData, type SourceDeps } from './sources.js';

const WORKGROUP_ID = 'wg-source-fixture';
const AS_OF = '2026-09-06T01:00:00.000Z';
const NOW = Date.parse('2026-09-06T01:30:00.000Z');

function ctx(): AuthedRequestContext {
  return {
    user: { id: 'dashboard-user', kind: 'dashboard', display_name: 'Dashboard user', created_at: AS_OF },
    scopes: { role: 'owner', allowed_group_ids: [], no_filter: true },
    rawNodeReq: {} as http.IncomingMessage,
  };
}

function scene(): ObservatoryScene {
  return {
    workgroupId: WORKGROUP_ID,
    asOf: AS_OF,
    rooms: [
      {
        key: 'slack:CFIXTURE01',
        name: '#fixture-room',
        platform: 'slack',
        memberAgentIds: [],
        lastActivityAt: null,
        permalink: null,
      },
    ],
    agents: [],
    claims: [],
    releaseState: null,
  };
}

function deps(items: ReleaseStateItem[], threads: ThreadSummary[] = []): SourceDeps {
  return {
    scene: async () => scene(),
    release: async () => ({ asOf: AS_OF, items }),
    threads: async () => threads,
    now: NOW,
  };
}

function fixtureThread(): ThreadSummary {
  return {
    thread_id: 'slack:CFIXTURE01:1.000001',
    channel_key: 'slack:CFIXTURE01',
    channel_name: '#fixture-room',
    session_ids: ['session-fixture'],
    participants: [],
    state: 'idle',
    title: null,
    last_activity_at: null,
    synthetic: false,
    assignable_agents: [],
    needs_you_reason: null,
    container_status: 'idle',
    provider_status: null,
    current_tool: null,
    tool_started_at: null,
    reply_target_session_id: 'session-fixture',
    snoozed: false,
    scheduled_task: false,
    done_proposal: null,
    closing: false,
    close_confirmations_required: 2,
  };
}

async function seedProject(id: string, name: string, repositories: string[], channelKeys: string[]): Promise<void> {
  await getDb().run(
    `INSERT INTO observatory_projects
       (id, workgroup_id, name, description, repositories, channel_keys, version, updated_by, updated_at)
     VALUES (?, ?, ?, '', ?, ?, 1, 'fixture', ?)`,
    id,
    WORKGROUP_ID,
    name,
    JSON.stringify(repositories),
    JSON.stringify(channelKeys),
    AS_OF,
  );
}

beforeEach(async () => {
  await initTestDb();
  await getDb().exec(`
    CREATE TABLE workgroups(id TEXT PRIMARY KEY, display_name TEXT, attention_sources TEXT);
    CREATE TABLE agent_groups(id TEXT PRIMARY KEY, workgroup_id TEXT, name TEXT);
    CREATE TABLE sessions(id TEXT PRIMARY KEY, agent_group_id TEXT);
    CREATE TABLE pending_approvals(
      approval_id TEXT PRIMARY KEY, agent_group_id TEXT, session_id TEXT, title TEXT, action TEXT,
      created_at TEXT, expires_at TEXT, approver_user_id TEXT, channel_type TEXT, platform_id TEXT,
      platform_message_id TEXT, status TEXT
    );
    INSERT INTO workgroups VALUES('${WORKGROUP_ID}', 'Source fixture', NULL);
  `);
  await getDb().exec(SIGNAL_SCHEMA);
});
afterEach(closeDb);

describe('Signal source validation and mapping ambiguity', () => {
  it('keeps healthy release items while marking a malformed item source unavailable', async () => {
    const malformed = {
      id: 'invalid-channel',
      kind: 'release',
      title: 'Malformed item',
      nextMover: 'human',
      channel: 42,
    } as unknown as ReleaseStateItem;
    const healthy: ReleaseStateItem = {
      id: 'healthy-item',
      kind: 'release',
      title: 'Healthy item',
      nextMover: 'human',
      channel: '#fixture-room',
    };

    const data = await buildSignalData(ctx(), WORKGROUP_ID, deps([malformed, healthy]));

    expect(data.projects.find((project) => project.unmapped)?.items.map((item) => item.id)).toEqual(['healthy-item']);
    expect(data.decisions.map((decision) => decision.source_id)).toEqual(['healthy-item']);
    expect(data.sources.find((source) => source.source === 'release board')).toMatchObject({
      status: 'unavailable',
      detail: 'Skipped malformed release-board item; healthy items remain available.',
    });
  });

  it('keeps overlapping release and channel mappings under Unmapped work', async () => {
    await seedProject('project-before-rename', 'Before rename', ['fixture/repository'], []);
    await seedProject('project-after-rename', 'After rename', ['fixture/repository'], []);
    await seedProject('project-channel-one', 'Channel one', [], ['slack:CFIXTURE01']);
    await seedProject('project-channel-two', 'Channel two', [], ['slack:CFIXTURE01']);
    const item: ReleaseStateItem = {
      id: 'rename-overlap',
      kind: 'release',
      title: 'Mapped by two renamed projects',
      nextMover: 'human',
      url: 'https://github.com/fixture/repository/issues/1',
    };

    const data = await buildSignalData(ctx(), WORKGROUP_ID, deps([item], [fixtureThread()]));
    const unmapped = data.projects.find((project) => project.unmapped)!;

    expect(unmapped.items.map((work) => work.id)).toEqual(['rename-overlap']);
    expect(unmapped.thread_ids).toEqual(['slack:CFIXTURE01:1.000001']);
    expect(data.decisions.find((decision) => decision.source_id === 'rename-overlap')?.project_id).toBe(unmapped.id);
    expect(data.sources.find((source) => source.source === 'project mappings')).toMatchObject({
      status: 'unavailable',
      detail: 'Multiple project mappings match source facts; affected work remains under Unmapped work.',
    });
  });
});
