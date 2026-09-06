import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { registerCreateAgentFollowUp, type CreateAgentFollowUpContext } from '../agent-to-agent/create-agent.js';
import { followUpSlackAgentCreation } from './index.js';

vi.mock('../../db/messaging-groups.js', () => ({ getMessagingGroup: vi.fn() }));
vi.mock('../agent-to-agent/create-agent.js', () => ({ registerCreateAgentFollowUp: vi.fn() }));

const context = (): CreateAgentFollowUpContext => ({
  session: {
    id: 'synthetic-session',
    agent_group_id: 'parent',
    messaging_group_id: 'origin',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: null,
    created_at: '2026-09-06T00:00:00Z',
  },
  group: {
    id: 'synthetic-child',
    name: 'Fixture Builder',
    folder: 'fixture-builder',
    agent_provider: null,
    created_at: '2026-09-06T00:00:00Z',
    workgroup_id: 'fixture-workspace',
  },
  notify: vi.fn(async () => {}),
});

beforeEach(() => {
  vi.mocked(getMessagingGroup).mockReset();
});

describe('manual Slack agent follow-up', () => {
  it('registers the post-create follow-up', () => {
    expect(registerCreateAgentFollowUp).toHaveBeenCalledWith(followUpSlackAgentCreation);
  });

  it('emits a plain manifest and host attach instructions for a Slack origin', async () => {
    vi.mocked(getMessagingGroup).mockResolvedValue({
      id: 'origin',
      channel_type: 'slack-fixture',
      platform_id: 'slack-fixture:CEXAMPLE',
      name: 'Fixture room',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: '2026-09-06T00:00:00Z',
    });
    const input = context();
    await followUpSlackAgentCreation(input);
    const message = vi.mocked(input.notify).mock.calls[0][0];
    expect(message).toContain('https://api.slack.com/apps');
    expect(message).toContain('From a manifest');
    expect(message).toContain('--instance fixture-builder --agent-group-id synthetic-child');
    expect(message).toContain('not into this chat');
    expect(message).toContain('without restarting the host');
    const manifest = JSON.parse(message.split('```json\n\n')[1].split('\n\n```')[0]);
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.features).not.toHaveProperty('agent_view');
    expect(manifest.oauth_config.scopes.bot).toContain('im:write');
    expect(manifest.display_information.name).toBe('Fixture Builder');
  });

  it.each(['discord', 'agent'])('keeps a %s origin unchanged', async (channel_type) => {
    vi.mocked(getMessagingGroup).mockResolvedValue({
      id: 'origin',
      channel_type,
      platform_id: 'fixture',
      name: 'Fixture room',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: '2026-09-06T00:00:00Z',
    });
    const input = context();
    await followUpSlackAgentCreation(input);
    expect(input.notify).not.toHaveBeenCalled();
  });
});
