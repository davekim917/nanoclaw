import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ add: vi.fn(), list: vi.fn() }));

vi.mock('../../channels/slack-hot-attach.js', () => ({
  addSlackWorkspace: calls.add,
  listSlackWorkspaces: calls.list,
}));

import { guard } from '../../guard/index.js';
import { commandGuard, lookup } from '../registry.js';
import './slack-workspaces.js';

beforeEach(() => {
  calls.add.mockReset();
  calls.list.mockReset();
});

describe('slack workspaces commands', () => {
  it('parses the explicit attach arguments and passes them to the attach core', async () => {
    calls.add.mockResolvedValue({
      instance: 'helper',
      channelType: 'slack-helper',
      teamId: 'TTEST',
      botUserId: 'UBOTHELPER',
      active: true,
      status: 'started',
    });
    const command = lookup('slack-workspaces-add')!;

    await expect(
      command.handler(
        command.parseArgs({
          instance: 'helper',
          'bot-token': 'xoxb-synthetic-helper',
          'app-token': 'xapp-synthetic-helper',
          'agent-group-id': 'ag-synthetic',
        }),
        { caller: 'host' },
      ),
    ).resolves.toEqual({ channelType: 'slack-helper', teamId: 'TTEST', botUserId: 'UBOTHELPER' });

    expect(calls.add).toHaveBeenCalledWith({
      instance: 'helper',
      botToken: 'xoxb-synthetic-helper',
      appToken: 'xapp-synthetic-helper',
      agentGroupId: 'ag-synthetic',
    });
  });

  it('rejects every container caller, including global-scope agents, before their scope is consulted', () => {
    for (const name of ['slack-workspaces-add', 'slack-workspaces-list']) {
      const decision = guard(commandGuard(name), {
        actor: { kind: 'agent', agentGroupId: 'ag-synthetic', sessionId: 'sess-synthetic' },
        payload: {},
      });
      expect(decision).toMatchObject({ effect: 'deny' });
      expect(decision.reason).toContain('operator-only');
    }
  });

  it('does not accept omitted credential flags', () => {
    expect(() => lookup('slack-workspaces-add')!.parseArgs({ instance: 'helper' })).toThrow('--bot-token is required');
  });

  it('lists only Slack channel and identity fields', async () => {
    calls.list.mockReturnValue([
      {
        instance: 'helper',
        channelType: 'slack-helper',
        teamId: 'TTEST',
        botUserId: 'UBOTHELPER',
        active: true,
      },
    ]);

    await expect(lookup('slack-workspaces-list')!.handler({}, { caller: 'host' })).resolves.toEqual([
      { channelType: 'slack-helper', teamId: 'TTEST', botUserId: 'UBOTHELPER' },
    ]);
  });
});
