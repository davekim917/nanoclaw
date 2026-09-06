import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  rootDir: '',
  configured: [] as Array<{ channelType: string; botToken: string; appToken?: string }>,
  knownBots: new Map<string, { teamId: string; userId: string }>(),
  active: new Set<string>(),
  auth: new Map<string, { teamId: string; userId: string; botId?: string }>(),
  groups: new Set<string>(),
  messagingGroup: undefined as { id: string } | undefined,
  wiringExists: false,
  startError: undefined as string | undefined,
  secrets: new Set<string>(),
}));

const spies = vi.hoisted(() => ({
  upsert: vi.fn(),
  registerWorkspace: vi.fn(),
  start: vi.fn(),
  auth: vi.fn(),
  openDm: vi.fn(),
  dbRun: vi.fn(),
  createMessagingGroup: vi.fn(),
  ensureDestination: vi.fn(),
  registerSecrets: vi.fn(),
}));

vi.mock('../config.js', () => ({
  get REPO_ROOT() {
    return state.rootDir;
  },
}));

vi.mock('../env-file.js', () => ({
  upsertEnvKeys: (rootDir: string, values: Record<string, string>) => {
    spies.upsert(rootDir, values);
    const botKey = Object.keys(values).find((key) => key.startsWith('SLACK_BOT_TOKEN'))!;
    const appKey = Object.keys(values).find((key) => key.startsWith('SLACK_APP_TOKEN'))!;
    const suffix = botKey.slice('SLACK_BOT_TOKEN'.length).replace(/^_/, '').toLowerCase().replace(/_/g, '-');
    const channelType = suffix ? `slack-${suffix}` : 'slack';
    state.configured = [
      ...state.configured.filter((workspace) => workspace.channelType !== channelType),
      { channelType, botToken: values[botKey]!, appToken: values[appKey] },
    ];
  },
}));

vi.mock('../secret-scrubber.js', () => ({
  registerSecrets: (values: Record<string, string>) => {
    spies.registerSecrets(values);
    for (const value of Object.values(values)) state.secrets.add(value);
  },
  scrubSecrets: (text: string) =>
    [...state.secrets].reduce((scrubbed, secret) => scrubbed.replaceAll(secret, '[REDACTED]'), text),
}));

vi.mock('../modules/agent-to-agent/db/agent-destinations.js', () => ({
  normalizeName: (name: string) =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unnamed',
}));

vi.mock('../db/agent-groups.js', () => ({
  getAgentGroup: async (id: string) => (state.groups.has(id) ? { id, name: id, folder: id } : undefined),
}));

vi.mock('../db/messaging-groups.js', () => ({
  createMessagingGroup: async (group: { id: string }) => {
    spies.createMessagingGroup(group);
    state.messagingGroup = group;
  },
  getMessagingGroupByPlatform: async () => state.messagingGroup,
  assertSameWorkgroupWiring: async () => undefined,
  ensureAgentDestinationForWiring: async (wiring: unknown) => spies.ensureDestination(wiring),
  getMessagingGroupAgentByPair: async () => (state.wiringExists ? { id: 'wiring-existing' } : undefined),
}));

vi.mock('../db/central-lease.js', () => ({
  centralTransaction: async <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('../db/connection.js', () => ({
  getDb: () => ({
    run: async (sql: string, values: Record<string, unknown>) => {
      spies.dbRun(sql, values);
      if (sql.includes('INSERT INTO messaging_groups')) state.messagingGroup = values as { id: string };
      if (sql.includes('INSERT INTO messaging_group_agents')) state.wiringExists = true;
    },
  }),
}));

vi.mock('../modules/permissions/db/user-roles.js', () => ({
  getOwners: async () => [{ user_id: 'slack-origin:UOPERATOR' }],
}));

vi.mock('../slack-user-identity.js', () => ({
  resolveOperatorSlackUserId: () => ({ userId: 'slack-origin:UOPERATOR', slackUserId: 'UOPERATOR' }),
}));

vi.mock('./slack-lib.js', () => ({
  slackChannelTypeForSlug: (slug: string) => (slug ? `slack-${slug}` : 'slack'),
  slugForSlackChannelType: (channelType: string) => (channelType === 'slack' ? '' : channelType.slice('slack-'.length)),
  botTokenKeyForChannelType: (channelType: string) =>
    channelType === 'slack'
      ? 'SLACK_BOT_TOKEN'
      : `SLACK_BOT_TOKEN_${channelType.slice(6).toUpperCase().replace(/-/g, '_')}`,
  appTokenKeyForChannelType: (channelType: string) =>
    channelType === 'slack'
      ? 'SLACK_APP_TOKEN'
      : `SLACK_APP_TOKEN_${channelType.slice(6).toUpperCase().replace(/-/g, '_')}`,
  slackCall: async (token: string) => {
    spies.auth(token);
    const identity = state.auth.get(token);
    if (!identity) throw new Error('invalid_auth');
    return {
      ok: true,
      team_id: identity.teamId,
      user_id: identity.userId,
      ...(identity.botId === undefined ? {} : { bot_id: identity.botId }),
    };
  },
  slackConversationsOpen: async (token: string, users: string[]) => {
    spies.openDm(token, users);
    return 'DTEST00001';
  },
}));

vi.mock('./slack.js', () => ({
  loadSlackWorkspaces: () => state.configured,
  registerSlackWorkspace: (workspace: unknown) => spies.registerWorkspace(workspace),
}));

vi.mock('./slack-mentions.js', () => ({
  getKnownSlackBots: () => state.knownBots,
}));

vi.mock('./channel-registry.js', () => ({
  getChannelAdapterExact: (channelType: string) => (state.active.has(channelType) ? { channelType } : undefined),
  getActiveAdapters: () => [...state.active].map((channelType) => ({ channelType, instance: channelType })),
  startChannelAdapter: async (channelType: string) => {
    spies.start(channelType);
    if (state.startError) throw new Error(state.startError);
    state.active.add(channelType);
    return 'started';
  },
}));

import { addSlackWorkspace, duplicateSlackBotChannelType, listSlackWorkspaces } from './slack-hot-attach.js';

beforeEach(() => {
  state.rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-hot-attach-'));
  state.configured = [];
  state.knownBots.clear();
  state.active.clear();
  state.auth.clear();
  state.auth.set('xoxb-synthetic-helper', { teamId: 'TTEST', userId: 'UBOTHELPER', botId: 'BTEST' });
  state.groups.clear();
  state.messagingGroup = undefined;
  state.wiringExists = false;
  state.startError = undefined;
  state.secrets.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(state.rootDir, { recursive: true, force: true });
});

describe('addSlackWorkspace', () => {
  it('persists canonical keys, reloads the workspace, and hot-starts once without returning tokens', async () => {
    const input = {
      instance: 'Helper',
      botToken: 'xoxb-synthetic-helper',
      appToken: 'xapp-synthetic-helper',
    };

    const attached = await addSlackWorkspace(input);

    expect(spies.upsert).toHaveBeenCalledWith(state.rootDir, {
      SLACK_BOT_TOKEN_HELPER: input.botToken,
      SLACK_APP_TOKEN_HELPER: input.appToken,
    });
    expect(spies.registerWorkspace).toHaveBeenCalledWith({
      channelType: 'slack-helper',
      botToken: input.botToken,
      appToken: input.appToken,
    });
    expect(spies.start).toHaveBeenCalledTimes(1);
    expect(attached).toMatchObject({
      instance: 'helper',
      channelType: 'slack-helper',
      teamId: 'TTEST',
      botUserId: 'UBOTHELPER',
      status: 'started',
    });
    expect(JSON.stringify(attached)).not.toContain(input.botToken);
    expect(JSON.stringify(attached)).not.toContain(input.appToken);

    await expect(addSlackWorkspace(input)).resolves.toMatchObject({ status: 'already-active' });
    expect(spies.start).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent attachments so the adapter starts once', async () => {
    const input = { instance: 'helper', botToken: 'xoxb-synthetic-helper', appToken: 'xapp-synthetic-helper' };
    const results = await Promise.all([addSlackWorkspace(input), addSlackWorkspace(input)]);
    expect(results.map((result) => result.status)).toEqual(['started', 'already-active']);
    expect(spies.upsert).toHaveBeenCalledTimes(1);
    expect(spies.start).toHaveBeenCalledTimes(1);
  });

  it('allows correcting an app token after Socket Mode startup failed', async () => {
    const input = { instance: 'helper', botToken: 'xoxb-synthetic-helper', appToken: 'xapp-synthetic-invalid' };
    state.startError = 'invalid_auth';
    await expect(addSlackWorkspace(input)).rejects.toThrow('invalid_auth');
    expect(state.configured[0]?.appToken).toBe(input.appToken);

    state.startError = undefined;
    await expect(addSlackWorkspace({ ...input, appToken: 'xapp-synthetic-corrected' })).resolves.toMatchObject({
      status: 'started',
    });
    expect(spies.registerWorkspace).toHaveBeenLastCalledWith(
      expect.objectContaining({ appToken: 'xapp-synthetic-corrected' }),
    );
    expect(state.configured[0]?.appToken).toBe('xapp-synthetic-corrected');
    expect(spies.start).toHaveBeenCalledTimes(2);

    await expect(addSlackWorkspace(input)).rejects.toThrow('refusing to replace');
    expect(state.configured[0]?.appToken).toBe('xapp-synthetic-corrected');
    expect(spies.start).toHaveBeenCalledTimes(2);
  });

  it('refuses an active instance with a different bot before changing stored credentials', async () => {
    state.active.add('slack-helper');
    state.knownBots.set('slack-helper', { teamId: 'TTEST', userId: 'UOTHER' });

    await expect(
      addSlackWorkspace({
        instance: 'helper',
        botToken: 'xoxb-synthetic-helper',
        appToken: 'xapp-synthetic-helper',
      }),
    ).rejects.toThrow('different bot identity');

    expect(spies.upsert).not.toHaveBeenCalled();
    expect(spies.start).not.toHaveBeenCalled();
  });

  it('attaches a sibling bot into an already-wired Slack team and refuses only the same bot user', async () => {
    state.knownBots.set('slack-existing', { teamId: 'TTEST', userId: 'UOTHERBOT' });
    state.auth.set('xoxb-synthetic-sibling', { teamId: 'TTEST', userId: 'USIBLINGBOT', botId: 'BOTHER' });

    await expect(
      addSlackWorkspace({
        instance: 'sibling',
        botToken: 'xoxb-synthetic-sibling',
        appToken: 'xapp-synthetic-sibling',
      }),
    ).resolves.toBeDefined();
    expect(spies.upsert).toHaveBeenCalledTimes(1);
    expect(
      duplicateSlackBotChannelType('slack-another', { teamId: 'TTEST', userId: 'UOTHERBOT', botId: 'BOTHER' }),
    ).toBe('slack-existing');
    expect(
      duplicateSlackBotChannelType('slack-another', { teamId: 'TTEST', userId: 'UTHIRDBOT', botId: 'BTHIRD' }),
    ).toBeNull();
  });

  it('refuses the same bot user attached under another instance', async () => {
    state.knownBots.set('slack-existing', { teamId: 'TTEST', userId: 'UOTHERBOT' });
    state.auth.set('xoxb-synthetic-dup', { teamId: 'TTEST', userId: 'UOTHERBOT', botId: 'BOTHER' });

    await expect(
      addSlackWorkspace({ instance: 'dup', botToken: 'xoxb-synthetic-dup', appToken: 'xapp-synthetic-dup' }),
    ).rejects.toThrow('already attached as slack-existing');
    expect(spies.upsert).not.toHaveBeenCalled();
  });

  it('also refuses a duplicate bot user belonging to an offline configured app', async () => {
    state.configured = [
      { channelType: 'slack-offline', botToken: 'xoxb-synthetic-offline', appToken: 'xapp-synthetic-offline' },
    ];
    state.auth.set('xoxb-synthetic-offline', { teamId: 'TTEST', userId: 'UOFFLINE', botId: 'BOFFLINE' });
    state.auth.set('xoxb-synthetic-helper', { teamId: 'TTEST', userId: 'UOFFLINE', botId: 'BHELPER' });
    await expect(
      addSlackWorkspace({ instance: 'helper', botToken: 'xoxb-synthetic-helper', appToken: 'xapp-synthetic-helper' }),
    ).rejects.toThrow('already attached as slack-offline');
    expect(spies.upsert).not.toHaveBeenCalled();
    expect(spies.start).not.toHaveBeenCalled();
  });

  it('refuses auth.test responses without a Slack bot identity', async () => {
    state.auth.set('xoxb-synthetic-no-bot-id', { teamId: 'TTEST', userId: 'UBOTHELPER' });

    await expect(
      addSlackWorkspace({
        instance: 'helper',
        botToken: 'xoxb-synthetic-no-bot-id',
        appToken: 'xapp-synthetic-no-bot-id',
      }),
    ).rejects.toThrow('no team, bot user, or bot identity');

    expect(spies.upsert).not.toHaveBeenCalled();
  });

  it('rejects token line injection before network or persistence work', async () => {
    await expect(
      addSlackWorkspace({
        instance: 'helper',
        botToken: 'xoxb-synthetic-helper\nSLACK_APP_TOKEN_OTHER=bad',
        appToken: 'xapp-synthetic-helper',
      }),
    ).rejects.toThrow('invalid token shape');

    expect(spies.auth).not.toHaveBeenCalled();
    expect(spies.upsert).not.toHaveBeenCalled();
  });

  it('rejects a symbolic .env path before persistence', async () => {
    const target = path.join(state.rootDir, 'real-env');
    fs.writeFileSync(target, '');
    fs.symlinkSync(target, path.join(state.rootDir, '.env'));

    await expect(
      addSlackWorkspace({
        instance: 'helper',
        botToken: 'xoxb-synthetic-helper',
        appToken: 'xapp-synthetic-helper',
      }),
    ).rejects.toThrow('must not be a symbolic link');

    expect(spies.upsert).not.toHaveBeenCalled();
  });

  it('opens and wires the owner DM only when an explicit agent group is supplied', async () => {
    state.groups.add('ag-synthetic');

    const attached = await addSlackWorkspace({
      instance: 'helper',
      botToken: 'xoxb-synthetic-helper',
      appToken: 'xapp-synthetic-helper',
      agentGroupId: 'ag-synthetic',
    });

    expect(spies.openDm).toHaveBeenCalledWith('xoxb-synthetic-helper', ['UOPERATOR']);
    expect(spies.createMessagingGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_type: 'slack-helper',
        instance: 'slack-helper',
        platform_id: 'slack:DTEST00001',
        is_group: 0,
      }),
    );
    expect(spies.dbRun).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO messaging_group_agents'),
      expect.objectContaining({
        agent_group_id: 'ag-synthetic',
        session_mode: 'per-thread',
        ignored_message_policy: 'accumulate',
      }),
    );
    expect(attached.wiringCreated).toBe(true);
  });

  it('scrubs supplied tokens from hot-start failures before they reach CLI serialization', async () => {
    const input = {
      instance: 'helper',
      botToken: 'xoxb-synthetic-secret-bot',
      appToken: 'xapp-synthetic-secret-app',
    };
    state.auth.set(input.botToken, { teamId: 'TTEST', userId: 'UBOTHELPER', botId: 'BTEST' });
    state.startError = `socket startup rejected ${input.botToken} ${input.appToken}`;

    const error = await addSlackWorkspace(input).catch((err: unknown) => err as Error);

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('Expected attachment to fail');
    expect(error.message).toContain('[REDACTED]');
    expect(JSON.stringify({ error: error.message })).not.toContain(input.botToken);
    expect(JSON.stringify({ error: error.message })).not.toContain(input.appToken);
  });
});

describe('listSlackWorkspaces', () => {
  it('lists channel, team, and bot metadata without exposing credential values', () => {
    state.configured = [
      { channelType: 'slack-helper', botToken: 'xoxb-synthetic-helper', appToken: 'xapp-synthetic-helper' },
    ];
    state.knownBots.set('slack-helper', { teamId: 'TTEST', userId: 'UBOTHELPER' });
    state.active.add('slack-helper');

    const listed = listSlackWorkspaces();

    expect(listed).toEqual([
      {
        instance: 'helper',
        channelType: 'slack-helper',
        teamId: 'TTEST',
        botUserId: 'UBOTHELPER',
        active: true,
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain('xoxb-synthetic-helper');
    expect(JSON.stringify(listed)).not.toContain('xapp-synthetic-helper');
  });
});
