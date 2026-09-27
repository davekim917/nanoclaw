/**
 * Equivalent Slack identities across sibling adapter instances: one human arrives as `slack-a:U123` and
 * `slack-a-codex:U123` when several NanoClaw apps share a workspace. Forms are equivalent only when both instances
 * registered the SAME Slack teamId, never by name prefix: Slack user ids are workspace-scoped, so a matching raw id
 * in another workspace would inherit a role.
 */
import { getKnownSlackBots, getKnownSlackHumans, type SlackBotIdentity } from './channels/slack-mentions.js';

/** The exact id plus same-workspace sibling forms; only the exact id until the adapter registers its identity. */
export function equivalentSlackUserIds(
  userId: string,
  bots: ReadonlyMap<string, SlackBotIdentity> = getKnownSlackBots(),
): string[] {
  const separator = userId.indexOf(':');
  if (separator <= 0 || separator === userId.length - 1) return [userId];

  const channelType = userId.slice(0, separator);
  const handle = userId.slice(separator + 1);
  const currentBot = bots.get(channelType);
  if (!currentBot) return [userId];

  const equivalents = new Set<string>([userId]);
  for (const [siblingChannelType, siblingBot] of bots) {
    if (siblingBot.teamId === currentBot.teamId) {
      equivalents.add(`${siblingChannelType}:${handle}`);
    }
  }
  return [...equivalents];
}

/**
 * The operator's Slack identity for a privileged action in one workspace (provisioning a bot, the operator DM, an
 * approval card). The first `slack*` approver is wrong on a multi-workspace host: it could hand a workspace-A
 * install URL to whoever holds that raw id in workspace B. A candidate must (1) have an equivalentSlackUserIds form
 * in `originChannelType` (teamId-scoped; an unregistered origin yields null, never a prefix match), and (2) appear
 * in the origin team's synced roster when that roster is non-empty. Returns the persisted principal and the bare
 * Slack id Web API calls take; null when no approver belongs to the origin workspace.
 */
export function resolveOperatorSlackUserId(
  approvers: readonly string[],
  originChannelType: string,
  deps: {
    bots?: ReadonlyMap<string, SlackBotIdentity>;
    humans?: ReadonlyMap<string, SlackBotIdentity[]>;
  } = {},
): { userId: string; slackUserId: string } | null {
  const bots = deps.bots ?? getKnownSlackBots();
  const humans = deps.humans ?? getKnownSlackHumans();

  const originBot = bots.get(originChannelType);
  if (!originBot) return null;

  const roster = humans.get(originBot.teamId) ?? [];
  const rosterIds = new Set(roster.map((h) => h.userId));

  for (const approver of approvers) {
    const inWorkspace = equivalentSlackUserIds(approver, bots).find(
      (id) => id.slice(0, id.indexOf(':')) === originChannelType,
    );
    if (!inWorkspace) continue;

    const slackUserId = inWorkspace.slice(inWorkspace.indexOf(':') + 1);
    if (!/^[UW][A-Z0-9]+$/i.test(slackUserId)) continue;
    if (rosterIds.size > 0 && !rosterIds.has(slackUserId)) continue;

    return { userId: approver, slackUserId };
  }

  return null;
}
