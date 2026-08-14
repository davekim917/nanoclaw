/**
 * Equivalent Slack identities across sibling adapter instances.
 *
 * NanoClaw's persisted user id is `<channel_type>:<Slack user id>`. That is
 * intentionally distinct for separate adapters because a channel type is
 * also the delivery route. It becomes too strict when multiple NanoClaw
 * Slack apps are installed in one Slack workspace: the same human then
 * arrives as, for example, both `slack-illysium:U123` and
 * `slack-illysium-codex:U123`.
 *
 * Role checks may treat those forms as one principal only when both adapter
 * instances have registered the *same Slack teamId*. This deliberately does
 * not infer equivalence from a `slack-` name prefix: Slack user ids are
 * workspace-scoped, so that would let a matching raw id in another workspace
 * inherit a role.
 */
import { getKnownSlackBots, type SlackBotIdentity } from './channels/slack-mentions.js';

/**
 * Return the exact persisted id plus same-workspace Slack sibling forms.
 *
 * If the current adapter has not completed Slack identity registration, only
 * the exact id is returned. That is a safe, fail-closed startup behavior.
 * `bots` is injectable for deterministic unit tests.
 */
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
