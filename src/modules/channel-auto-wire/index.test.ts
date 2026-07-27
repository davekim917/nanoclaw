/**
 * Tests for the channel-auto-wire resolver. Calls the exported resolver
 * directly so the test stays focused on the module's policy logic,
 * independent of the router hook registration (which fires as a side
 * effect of importing the module and is covered by the build's
 * self-registration typecheck).
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import type { InboundEvent } from '../../channels/adapter.js';
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

const ENV_FOLDER_KEY = 'NANOCLAW_DEFAULT_AGENT_GROUP_SLACK_EXAMPLE_LABS';
const ENV_MODE_KEY = 'NANOCLAW_DEFAULT_SESSION_MODE_SLACK_EXAMPLE_LABS';
const ENV_POLICY_KEY = 'NANOCLAW_DEFAULT_SENDER_POLICY_SLACK_EXAMPLE_LABS';
const ENV_IGNORED_KEY = 'NANOCLAW_DEFAULT_IGNORED_POLICY_SLACK_EXAMPLE_LABS';
const ENV_DISCORD_KEY = 'NANOCLAW_DEFAULT_AGENT_GROUP_DISCORD';

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  saved = {
    [ENV_FOLDER_KEY]: process.env[ENV_FOLDER_KEY],
    [ENV_MODE_KEY]: process.env[ENV_MODE_KEY],
    [ENV_POLICY_KEY]: process.env[ENV_POLICY_KEY],
    [ENV_IGNORED_KEY]: process.env[ENV_IGNORED_KEY],
    [ENV_DISCORD_KEY]: process.env[ENV_DISCORD_KEY],
  };
  delete process.env[ENV_FOLDER_KEY];
  delete process.env[ENV_MODE_KEY];
  delete process.env[ENV_POLICY_KEY];
  delete process.env[ENV_IGNORED_KEY];
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
    const mg = makeMg('mg-1', 'slack-example-labs', 'slack:C1');
    createMessagingGroup(mg);
    const result = resolver(makeEvent('slack-example-labs', 'slack:C1'), mg);
    expect(result).toEqual([]);
    expect(getMessagingGroupAgents('mg-1')).toEqual([]);
  });

  it('returns [] and writes no row when the configured folder is unknown', () => {
    process.env[ENV_FOLDER_KEY] = 'does-not-exist';
    const mg = makeMg('mg-2', 'slack-example-labs', 'slack:C2');
    createMessagingGroup(mg);
    const result = resolver(makeEvent('slack-example-labs', 'slack:C2'), mg);
    expect(result).toEqual([]);
    expect(getMessagingGroupAgents('mg-2')).toEqual([]);
  });

  it('wires and returns the agent when the folder resolves; defaults to per-thread', () => {
    const ag = makeAgentGroup('ag-auto', 'example-labs-v2', 'helper');
    createAgentGroup(ag);
    process.env[ENV_FOLDER_KEY] = 'example-labs-v2';

    const mg = makeMg('mg-3', 'slack-example-labs', 'slack:C3');
    createMessagingGroup(mg);
    const result = resolver(makeEvent('slack-example-labs', 'slack:C3'), mg);

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
    const ag = makeAgentGroup('ag-auto', 'example-labs-v2', 'helper');
    createAgentGroup(ag);
    process.env[ENV_FOLDER_KEY] = 'example-labs-v2';
    process.env[ENV_MODE_KEY] = 'shared';

    const mg = makeMg('mg-4', 'slack-example-labs', 'slack:C4');
    createMessagingGroup(mg);
    const result = resolver(makeEvent('slack-example-labs', 'slack:C4'), mg);

    expect(result[0].session_mode).toBe('shared');
  });

  it('defaults ignored_message_policy to accumulate when not configured', () => {
    const ag = makeAgentGroup('ag-auto', 'example-labs-v2', 'helper');
    createAgentGroup(ag);
    process.env[ENV_FOLDER_KEY] = 'example-labs-v2';

    const mg = makeMg('mg-ignored-1', 'slack-example-labs', 'slack:CI1');
    createMessagingGroup(mg);
    const result = resolver(makeEvent('slack-example-labs', 'slack:CI1'), mg);

    expect(result[0].ignored_message_policy).toBe('accumulate');
    const persisted = getMessagingGroupAgents('mg-ignored-1');
    expect(persisted[0].ignored_message_policy).toBe('accumulate');
  });

  it('honors an explicit ignored_message_policy override', () => {
    const ag = makeAgentGroup('ag-auto', 'example-labs-v2', 'helper');
    createAgentGroup(ag);
    process.env[ENV_FOLDER_KEY] = 'example-labs-v2';
    process.env[ENV_IGNORED_KEY] = 'drop';

    const mg = makeMg('mg-ignored-2', 'slack-example-labs', 'slack:CI2');
    createMessagingGroup(mg);
    const result = resolver(makeEvent('slack-example-labs', 'slack:CI2'), mg);

    expect(result[0].ignored_message_policy).toBe('drop');
    const persisted = getMessagingGroupAgents('mg-ignored-2');
    expect(persisted[0].ignored_message_policy).toBe('drop');
  });

  it('falls back to per-thread when session_mode is invalid', () => {
    const ag = makeAgentGroup('ag-auto', 'example-labs-v2', 'helper');
    createAgentGroup(ag);
    process.env[ENV_FOLDER_KEY] = 'example-labs-v2';
    process.env[ENV_MODE_KEY] = 'bogus';

    const mg = makeMg('mg-5', 'slack-example-labs', 'slack:C5');
    createMessagingGroup(mg);
    const result = resolver(makeEvent('slack-example-labs', 'slack:C5'), mg);

    expect(result[0].session_mode).toBe('per-thread');
  });

  it('leaves unknown_sender_policy at strict when not configured', () => {
    const ag = makeAgentGroup('ag-auto', 'example-labs-v2', 'helper');
    createAgentGroup(ag);
    process.env[ENV_FOLDER_KEY] = 'example-labs-v2';

    const mg = makeMg('mg-policy-1', 'slack-example-labs', 'slack:CP1');
    createMessagingGroup(mg);
    resolver(makeEvent('slack-example-labs', 'slack:CP1'), mg);

    const persisted = getMessagingGroupByPlatform('slack-example-labs', 'slack:CP1');
    expect(persisted?.unknown_sender_policy).toBe('strict');
    expect(mg.unknown_sender_policy).toBe('strict');
  });

  it('relaxes unknown_sender_policy when configured (public) — persists + mutates in-place', () => {
    const ag = makeAgentGroup('ag-auto', 'example-labs-v2', 'helper');
    createAgentGroup(ag);
    process.env[ENV_FOLDER_KEY] = 'example-labs-v2';
    process.env[ENV_POLICY_KEY] = 'public';

    const mg = makeMg('mg-policy-2', 'slack-example-labs', 'slack:CP2');
    createMessagingGroup(mg);
    resolver(makeEvent('slack-example-labs', 'slack:CP2'), mg);

    // Mutated in-place so router's current-message access gate sees it.
    expect(mg.unknown_sender_policy).toBe('public');
    // Persisted so subsequent messages skip the mutation path entirely.
    const persisted = getMessagingGroupByPlatform('slack-example-labs', 'slack:CP2');
    expect(persisted?.unknown_sender_policy).toBe('public');
  });

  it('ignores invalid sender_policy values (stays strict, logs warning)', () => {
    const ag = makeAgentGroup('ag-auto', 'example-labs-v2', 'helper');
    createAgentGroup(ag);
    process.env[ENV_FOLDER_KEY] = 'example-labs-v2';
    process.env[ENV_POLICY_KEY] = 'yolo';

    const mg = makeMg('mg-policy-3', 'slack-example-labs', 'slack:CP3');
    createMessagingGroup(mg);
    resolver(makeEvent('slack-example-labs', 'slack:CP3'), mg);

    expect(mg.unknown_sender_policy).toBe('strict');
    const persisted = getMessagingGroupByPlatform('slack-example-labs', 'slack:CP3');
    expect(persisted?.unknown_sender_policy).toBe('strict');
  });

  it('is scoped per channel_type — `discord` config does not wire `slack-example-labs`', () => {
    const ag = makeAgentGroup('ag-main', 'main', 'main');
    createAgentGroup(ag);
    process.env[ENV_DISCORD_KEY] = 'main';

    const mg = makeMg('mg-6', 'slack-example-labs', 'slack:C6');
    createMessagingGroup(mg);
    const result = resolver(makeEvent('slack-example-labs', 'slack:C6'), mg);

    expect(result).toEqual([]);
  });
});
