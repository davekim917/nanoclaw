import { getMessagingGroup } from '../../db/messaging-groups.js';
import { buildManagedAppManifest } from '../../provisioning/slack-manifest.js';
import { registerCreateAgentFollowUp, type CreateAgentFollowUpContext } from '../agent-to-agent/create-agent.js';

export async function followUpSlackAgentCreation({
  session,
  group,
  notify,
}: CreateAgentFollowUpContext): Promise<void> {
  if (!session.messaging_group_id) return;
  const origin = await getMessagingGroup(session.messaging_group_id);
  if (!origin || !/^slack(?:-|$)/.test(origin.channel_type)) return;
  const manifest = buildManagedAppManifest({ name: group.name, agentView: false });
  await notify(
    [
      `The agent is created. The operator can now give it its own Slack app in the same workspace as ${origin.channel_type}.`,
      'At https://api.slack.com/apps choose Create New App → From a manifest, select that workspace, and paste this JSON:',
      '```json',
      JSON.stringify(manifest, null, 2),
      '```',
      'Install the app to the workspace (request workspace approval if required). Copy its Bot User OAuth Token (xoxb-…).',
      'In Basic Information → App-Level Tokens, generate an app token (xapp-…) with connections:write.',
      'Paste the tokens only into the owner’s host terminal, not into this chat:',
      `ncl slack workspaces add --instance ${group.folder} --agent-group-id ${group.id} --bot-token <xoxb-token> --app-token <xapp-token>`,
      'The command saves the app credentials in the host .env, attaches the bot, and wires its operator DM without restarting the host.',
      'Keep the existing agent group if app setup is interrupted; rerun the attach command to finish. Use ncl slack workspaces list to inspect the attachment.',
    ].join('\n\n'),
  );
}

registerCreateAgentFollowUp(followUpSlackAgentCreation);
