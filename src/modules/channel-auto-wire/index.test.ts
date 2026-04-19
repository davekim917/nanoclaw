/**
 * Tests for the channel-auto-wire resolver. Calls the exported resolver
 * directly so the test stays focused on the module's policy logic,
 * independent of the router hook registration (which fires as a side
 * effect of importing the module and is covered by the build's
 * self-registration typecheck).
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getMessagingGroupAgents } from '../../db/messaging-groups.js';
import type { InboundEvent } from '../../router.js';
import type { AgentGroup, MessagingGroup } from '../../types.js';
import { resolver } from './index.js';

function now(): string {
  return new Date().toISOString();
}

function makeEvent(channelType: string, platformId: string): InboundEvent {
  return {
    channelType,
    platformId,
    threadId: null,
    message: { id: 'm-1', kind: 'chat', content: '{}', timestamp: now() },
  };
}

function makeMg(id: string, channelType: string, platformId: string): MessagingGroup {
  return {
    id,
    channel_type: channelType,
    platform_id: platformId,
    name: null,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  };
}

function makeAgentGroup(id: string, folder: string, name: string): AgentGroup {
  return {
    id,
    folder,
    name,
    agent_provider: null,
    created_at: now(),
  };
}

const ENV_FOLDER_KEY = 'NANOCLAW_DEFAULT_AGENT_GROUP_SLACK_ILLYSIUM';
const ENV_MODE_KEY = 'NANOCLAW_DEFAULT_SESSION_MODE_SLACK_ILLYSIUM';
const ENV_DISCORD_KEY = 'NANOCLAW_DEFAULT_AGENT_GROUP_DISCORD';

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  saved = {
    [ENV_FOLDER_KEY]: process.env[ENV_FOLDER_KEY],
    [ENV_MODE_KEY]: process.env[ENV_MODE_KEY],
    [ENV_DISCORD_KEY]: process.env[ENV_DISCORD_KEY],
  };
  delete process.env[ENV_FOLDER_KEY];
  delete process.env[ENV_MODE_KEY];
  delete process.env[ENV_DISCORD_KEY];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  closeDb();
});

describe('channel-auto-wire resolver', () => {
  it('returns [] when no default is configured for the channel_type', () => {
    const mg = makeMg('mg-1', 'slack-illysium', 'slack:C1');
    createMessagingGroup(mg);
    const result = resolver(makeEvent('slack-illysium', 'slack:C1'), mg);
    expect(result).toEqual([]);
    expect(getMessagingGroupAgents('mg-1')).toEqual([]);
  });

  it('returns [] and writes no row when the configured folder is unknown', () => {
    process.env[ENV_FOLDER_KEY] = 'does-not-exist';
    const mg = makeMg('mg-2', 'slack-illysium', 'slack:C2');
    createMessagingGroup(mg);
    const result = resolver(makeEvent('slack-illysium', 'slack:C2'), mg);
    expect(result).toEqual([]);
    expect(getMessagingGroupAgents('mg-2')).toEqual([]);
  });

  it('wires and returns the agent when the folder resolves; defaults to per-thread', () => {
    const ag = makeAgentGroup('ag-auto', 'illysium-v2', 'illie');
    createAgentGroup(ag);
    process.env[ENV_FOLDER_KEY] = 'illysium-v2';

    const mg = makeMg('mg-3', 'slack-illysium', 'slack:C3');
    createMessagingGroup(mg);
    const result = resolver(makeEvent('slack-illysium', 'slack:C3'), mg);

    expect(result).toHaveLength(1);
    expect(result[0].agent_group_id).toBe('ag-auto');
    expect(result[0].session_mode).toBe('per-thread');
    expect(result[0].messaging_group_id).toBe('mg-3');

    const persisted = getMessagingGroupAgents('mg-3');
    expect(persisted).toHaveLength(1);
    expect(persisted[0].agent_group_id).toBe('ag-auto');
    expect(persisted[0].session_mode).toBe('per-thread');
  });

  it('honors an explicit session_mode override', () => {
    const ag = makeAgentGroup('ag-auto', 'illysium-v2', 'illie');
    createAgentGroup(ag);
    process.env[ENV_FOLDER_KEY] = 'illysium-v2';
    process.env[ENV_MODE_KEY] = 'shared';

    const mg = makeMg('mg-4', 'slack-illysium', 'slack:C4');
    createMessagingGroup(mg);
    const result = resolver(makeEvent('slack-illysium', 'slack:C4'), mg);

    expect(result[0].session_mode).toBe('shared');
  });

  it('falls back to per-thread when session_mode is invalid', () => {
    const ag = makeAgentGroup('ag-auto', 'illysium-v2', 'illie');
    createAgentGroup(ag);
    process.env[ENV_FOLDER_KEY] = 'illysium-v2';
    process.env[ENV_MODE_KEY] = 'bogus';

    const mg = makeMg('mg-5', 'slack-illysium', 'slack:C5');
    createMessagingGroup(mg);
    const result = resolver(makeEvent('slack-illysium', 'slack:C5'), mg);

    expect(result[0].session_mode).toBe('per-thread');
  });

  it('is scoped per channel_type — `discord` config does not wire `slack-illysium`', () => {
    const ag = makeAgentGroup('ag-main', 'main', 'main');
    createAgentGroup(ag);
    process.env[ENV_DISCORD_KEY] = 'main';

    const mg = makeMg('mg-6', 'slack-illysium', 'slack:C6');
    createMessagingGroup(mg);
    const result = resolver(makeEvent('slack-illysium', 'slack:C6'), mg);

    expect(result).toEqual([]);
  });
});
