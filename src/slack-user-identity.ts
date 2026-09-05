/**
 * Equivalent Slack identities across sibling adapter instances.
 *
 * NanoClaw's persisted user id is `<channel_type>:<Slack user id>`. That is
 * intentionally distinct for separate adapters because a channel type is
 * also the delivery route. It becomes too strict when multiple NanoClaw
 * Slack apps are installed in one Slack workspace: the same human then
 * arrives as, for example, both `slack-example:U123` and
 * `slack-example-codex:U123`.
 *
 * Role checks may treat those forms as one principal only when both adapter
 * instances have registered the *same Slack teamId*. This deliberately does
 * not infer equivalence from a `slack-` name prefix: Slack user ids are
 * workspace-scoped, so that would let a matching raw id in another workspace
 * inherit a role.
 */
import { getKnownSlackBots, getKnownSlackHumans, type SlackBotIdentity } from './channels/slack-mentions.js';

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

/**
 * The Slack identity to treat as "the operator" for a privileged Slack-side
 * action taken in one workspace — provisioning a new bot, opening the
 * operator's DM with it, addressing an approval card.
 *
 * Upstream has one Slack workspace per install, so its equivalent
 * (`resolveOperatorSlackUserId` in the slack-agent-flow module) is just "the
 * first approver whose id starts with `slack:`". The fork runs several Slack
 * workspaces on one host, and the same human is a separate persisted
 * principal in each (`slack-a:U123`, `slack-b:U123`). Picking the first
 * `slack*`-prefixed approver would therefore DM an owner in workspace B about
 * a bot created in workspace A, and — worse — hand a workspace-A install URL
 * to whoever holds that raw user id in workspace B.
 *
 * Two filters, in order:
 *
 *  1. **Workspace equivalence.** A candidate qualifies only if one of its
 *     `equivalentSlackUserIds` forms is namespaced to `originChannelType`.
 *     That relation is `teamId`-scoped by construction, so a same-handle
 *     owner in another workspace never qualifies. An origin channel type
 *     with no registered bot identity yields null (fail closed) rather than
 *     falling back to a prefix match.
 *  2. **Workspace membership, when it is knowable.** `users.list` is synced
 *     into the workspace-humans registry at adapter init. When the origin
 *     team has a non-empty roster, the candidate's raw Slack id must appear
 *     in it. When the roster is empty — the bot lacks `users:read`, or the
 *     sync has not run yet — this filter is skipped rather than refusing
 *     everything, because filter 1 is already the workspace boundary and
 *     filter 2 only catches a hand-written `user_roles` row naming an id
 *     that is not a member of the workspace at all.
 *
 * Takes the approver list rather than an agent-group id: `pickApprover` is
 * the caller's business (and is moving to the async DB driver under seam 3),
 * while which workspace an approver belongs to is a pure question about
 * registered Slack identities. `bots` and `humans` are injectable for
 * deterministic unit tests, matching `equivalentSlackUserIds`.
 *
 * Returns the persisted principal (`userId`, e.g. `slack-a:U123`) alongside
 * the bare Slack id (`slackUserId`, e.g. `U123`) that Slack Web API calls
 * take. Null when no approver belongs to the origin workspace.
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
