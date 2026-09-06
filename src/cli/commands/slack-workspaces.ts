import {
  addSlackWorkspace,
  listSlackWorkspaces,
  type SlackWorkspaceAttachment,
} from '../../channels/slack-hot-attach.js';
import { register } from '../registry.js';

type AddArgs = { instance: string; botToken: string; appToken: string; agentGroupId?: string };
type SlackWorkspaceIdentity = Pick<SlackWorkspaceAttachment, 'channelType' | 'teamId' | 'botUserId'>;

function workspaceIdentity({ channelType, teamId, botUserId }: SlackWorkspaceAttachment): SlackWorkspaceIdentity {
  return { channelType, teamId, botUserId };
}

function requiredString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key] ?? raw[key.replace(/_/g, '-')];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`--${key.replace(/_/g, '-')} is required`);
  return value;
}

function parseAdd(raw: Record<string, unknown>): AddArgs {
  const agentGroupId = raw.agent_group_id ?? raw['agent-group-id'];
  if (agentGroupId !== undefined && (typeof agentGroupId !== 'string' || agentGroupId.trim() === '')) {
    throw new Error('--agent-group-id must be a non-empty string');
  }
  return {
    instance: requiredString(raw, 'instance'),
    botToken: requiredString(raw, 'bot_token'),
    appToken: requiredString(raw, 'app_token'),
    ...(agentGroupId === undefined ? {} : { agentGroupId }),
  };
}

register({
  name: 'slack-workspaces-add',
  action: 'slack.workspaces.add',
  description:
    'Attach a hand-created Slack Socket Mode app without restarting. OPERATOR-ONLY: use --instance, --bot-token, --app-token, and optionally --agent-group-id.',
  access: 'open',
  hostOnly: true,
  parseArgs: parseAdd,
  handler: async (args) => workspaceIdentity(await addSlackWorkspace(args)),
});

register({
  name: 'slack-workspaces-list',
  action: 'slack.workspaces.list',
  description: 'List attached Slack workspaces and their live identity status without exposing tokens. OPERATOR-ONLY.',
  access: 'open',
  hostOnly: true,
  parseArgs: () => ({}),
  handler: async () => listSlackWorkspaces().map(workspaceIdentity),
});
