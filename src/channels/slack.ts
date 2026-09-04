/**
 * Slack channel adapter — FORK DEVIATION from upstream /add-slack.
 *
 * Upstream ships a single-workspace adapter (one SLACK_BOT_TOKEN +
 * SLACK_SIGNING_SECRET, channelType "slack"). Our fork needs multiple
 * concurrent Slack workspaces in one host process because we run a
 * primary Slack + the Example Labs Slack side-by-side.
 *
 * Multi-workspace env-var convention:
 *   SLACK_BOT_TOKEN=xoxb-…                    → channelType "slack"
 *   SLACK_SIGNING_SECRET=…
 *   SLACK_BOT_TOKEN_<SUFFIX>=xoxb-…           → channelType "slack-<suffix>"
 *   SLACK_SIGNING_SECRET_<SUFFIX>=…
 *
 * Each workspace is a separate Slack app (created per-workspace at
 * api.slack.com/apps, "Not distributed"). Suffix is any [A-Za-z0-9_]+
 * (alphanumerics + underscore — matches the convention used by other
 * scoped env vars in this fork like GITHUB_TOKEN_EXAMPLE_RETAIL) and is
 * lowercased for the channelType.
 *
 * This file is re-applied on top of the upstream /add-slack output so
 * `/add-slack` remains an idempotent install that preserves the
 * channels-via-skills model, and the deviation is a single clearly-
 * commented overlay. Revisit upstreaming after cutover — the only piece
 * of the NanoClaw core this requires is the optional `channelType`
 * override on createChatSdkBridge (already merged upstream-compatible).
 */
import { createSlackAdapter } from '@chat-adapter/slack';
import { WebClient } from '@slack/web-api';

import { readEnvFileMatching } from '../env.js';
import { log } from '../log.js';
import { markdownHeadingsToBold } from '../text-styles.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { conversationDisplayName } from './adapter.js';
import type { ChannelConversation, ChannelDefaults, ChannelRecoveryRequest, ChannelRecoveryTarget } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { extractSlackRawText } from './slack-raw-text.js';
import { createSlackHopGovernor, type SlackHopGovernor } from './slack-hop-limit.js';
import {
  fetchSlackBotIdentity,
  getSlackBotSenderName,
  getKnownSlackBots,
  registerSlackBot,
  registerSlackWorkspaceHumans,
  slackMentionOutsideCode,
  slackPermalink,
  slackChannelPermalink,
  normalizeSlackOrderedListContinuations,
  resolveInboundSlackIds,
  resolveSlackMentions,
  upgradeSlackBotProfile,
  type SlackBotIdentity,
} from './slack-mentions.js';

// Slack Block Kit section text objects cap at 3,000 characters. Keep a
// little headroom for adapter-side serialization while preserving complete
// replies by letting the shared bridge split longer chat messages.
export const SLACK_MESSAGE_MAX_TEXT_LENGTH = 2800;

/**
 * Declared wiring-time defaults for every Slack instance.
 *
 * Until this existed, `registerChannelAdapter` passed no `defaults` and every
 * Slack wiring resolved through `fallbackChannelDefaults` — the lenient
 * undeclared-adapter path. That was not neutral: the `ncl`/wizard creation
 * surfaces gate declaration-derived defaults on `hasDeclaredChannelDefaults`,
 * so a Slack wiring created through `ncl` got the static schema defaults
 * (engage_mode 'mention', unknown_sender_policy 'strict') while the router's
 * auto-create branch and the card-approval flow used the fallback. The live
 * install shows the split: some Slack DM messaging_groups carry 'strict',
 * their card-approved siblings 'public'.
 *
 * Shape mirrors upstream/channels slack.ts, VALUES are the fork's policies:
 *  - group.engageMode 'mention', not upstream's 'mention-sticky' (owner
 *    directive 2026-05-26 — sibling agents co-reside in channels and sticky
 *    let one agent auto-dominate a thread);
 *  - group.unknownSenderPolicy 'public', not upstream's 'request_approval'
 *    (owner directive 2026-08-06 — inviting the bot to a channel IS the
 *    access decision);
 *  - dm.unknownSenderPolicy 'request_approval' (upstream's 'decline_notify'
 *    is not in this fork's enum);
 *  - no sessionMode: this fork's ChannelContextDefaults has no such field;
 *    session_mode 'per-thread' is stamped by `wireApprovedChannel`.
 *
 * CREATION-TIME STAMPS vs LIVE INHERIT — the rule that keeps existing
 * installs still: engageMode, engagePattern and unknownSenderPolicy are read
 * only when a wiring or messaging_groups row is CREATED, so they can differ
 * from history without touching a single existing row. `threads` is the one
 * value re-read on every routed message (`resolveThreadPolicy`, NULL =
 * inherit), so it MUST equal what the fallback resolved to or ~48 live Slack
 * wirings would silently change threading on deploy. The fallback resolves
 * `threads: supportsThreads`, and the Slack bridge declares
 * supportsThreads:true — hence true in BOTH contexts. Upstream declares
 * dm.threads:false; adopting that here would collapse every existing Slack DM
 * sub-thread into one session (this fork threads DM replies by default — see
 * the DM auto-threading block in chat-sdk-bridge.ts). Operators who want a
 * different value set it per wiring with `--threads`.
 */
export const SLACK_DEFAULTS: ChannelDefaults = {
  dm: {
    engageMode: 'pattern',
    engagePattern: '.',
    threads: true,
    unknownSenderPolicy: 'request_approval',
  },
  group: {
    engageMode: 'mention',
    threads: true,
    unknownSenderPolicy: 'public',
  },
  mentions: 'platform',
};

/**
 * Bridge `inboundFilter` that applies the sibling-bot loop governor.
 *
 * Projects a Chat SDK message onto the three facts the governor needs. Two
 * judgments live here rather than in the governor:
 *
 *  - **Sibling detection is registry-based and team-scoped.** Only ids in this
 *    workspace's known-bot registry count as ours. Without our own identity
 *    there is no teamId to scope by, so this fails CLOSED — nothing is treated
 *    as a sibling and the governor never drops. Same discipline as
 *    resolveInboundSlackIds, and for the same reason: an unscoped id match
 *    could pick up another workspace's bot.
 *  - **"Human" is everything that is not one of ours and not flagged a bot.**
 *    The SDK's `isBot` is `boolean | 'unknown'`; an unknown author resets the
 *    counter rather than being ignored. Failing open on the RESET is the safe
 *    direction — the alternative silently mutes a channel forever.
 */
export function slackHopInboundFilter(
  governor: SlackHopGovernor,
  identity: SlackBotIdentity | null,
  message: { threadId: string; author?: { userId?: string; isBot?: boolean | 'unknown' } },
): boolean {
  const authorId = message.author?.userId;
  const isSiblingBot =
    identity !== null &&
    authorId !== undefined &&
    [...getKnownSlackBots().values()].some((bot) => bot.teamId === identity.teamId && bot.userId === authorId);
  return governor.admit({
    threadId: message.threadId,
    isSiblingBot,
    isHuman: !isSiblingBot && message.author?.isBot !== true,
  });
}

/**
 * Is this workspace member a human we would name to another human?
 *
 * Bots, Slack app users, Slackbot and deactivated accounts are not. Shared by
 * the mention directory (syncSlackWorkspaceHumans) and the group-DM roster so
 * the two cannot drift — `is_app_user` without `is_bot` is a real Slack shape,
 * and an app identity listed as a participant on an approval card reads as a
 * person who is not there.
 */
export function isSlackHumanMember(
  userId: string,
  member: { is_bot?: boolean; is_app_user?: boolean; deleted?: boolean },
): boolean {
  return !member.is_bot && !member.is_app_user && !member.deleted && userId !== 'USLACKBOT';
}

/**
 * Fetch the workspace's human members and register them for outbound
 * mention resolution. Bots/apps/deleted users are excluded — bot mentions
 * resolve through the sibling-bot registry, and Slackbot is never a target.
 * Fail-soft: a missing `users:read` scope logs a warning and leaves human
 * mentions unresolved (bot mentions keep working).
 */
async function syncSlackWorkspaceHumans(client: WebClient, teamId: string, channelType: string): Promise<void> {
  try {
    const humans: SlackBotIdentity[] = [];
    let cursor: string | undefined;
    do {
      const res = await client.users.list({ limit: 200, cursor });
      for (const m of res.members ?? []) {
        if (!m.id || !isSlackHumanMember(m.id, m)) continue;
        humans.push({
          userId: m.id,
          username: m.name ?? '',
          displayName: m.profile?.display_name || undefined,
          realName: m.profile?.real_name || undefined,
          teamId,
        });
      }
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);
    registerSlackWorkspaceHumans(teamId, humans);
    log.info('Slack workspace humans registered for mention resolution', {
      channelType,
      teamId,
      count: humans.length,
    });
  } catch (err) {
    log.warn('Slack users.list failed — human @-mentions will not resolve for this workspace', {
      channelType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface SlackWorkspace {
  channelType: string;
  botToken: string;
  /** Webhook-mode credential. Absent when the workspace runs Socket Mode. */
  signingSecret?: string;
  /**
   * App-level token (`xapp-…`). Its presence IS the Socket Mode switch — the
   * contract the add-slack skill already documents to operators.
   */
  appToken?: string;
}

interface SlackRecoveryMessage {
  ts?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
}

type SlackRecoveryAdapter = ReturnType<typeof createSlackAdapter> & {
  parseSlackMessage(raw: unknown, encodedThreadId: string): Promise<import('chat').Message>;
};

export function makeSlackRecoveryPageFetcher(slackAdapter: ReturnType<typeof createSlackAdapter>, client: WebClient) {
  return async (
    threadId: string,
    options: { limit: number; direction: 'backward'; cursor?: string; since: string },
  ) => {
    const parts = threadId.split(':');
    const channel = parts[1];
    const threadTs = parts[2] ?? '';
    const oldest = String(Date.parse(options.since) / 1000);
    const response = threadTs
      ? await client.conversations.replies({
          channel,
          ts: threadTs,
          limit: options.limit,
          cursor: options.cursor,
          oldest,
        })
      : await client.conversations.history({
          channel,
          limit: options.limit,
          cursor: options.cursor,
          oldest,
        });
    const parseSlackMessage = (slackAdapter as SlackRecoveryAdapter).parseSlackMessage;
    const messages = await Promise.all(
      (response.messages ?? []).map((raw) => {
        const slackMessage = raw as SlackRecoveryMessage;
        const nativeThreadTs = threadTs
          ? threadTs
          : channel.startsWith('D')
            ? (slackMessage.thread_ts ?? '')
            : (slackMessage.thread_ts ?? slackMessage.ts ?? '');
        return parseSlackMessage.call(slackAdapter, raw, `slack:${channel}:${nativeThreadTs}`);
      }),
    );
    messages.sort((a, b) => a.metadata.dateSent.getTime() - b.metadata.dateSent.getTime());
    return { messages, nextCursor: response.response_metadata?.next_cursor || undefined };
  };
}

/**
 * Slack error codes that mean a recovery target is unreachable by WIRING, not
 * by outage: the channel is gone, archived, or the bot was removed. Retrying
 * cannot succeed until a human changes the wiring, so the bridge parks the
 * target instead of failing the pass.
 */
const PERMANENT_SLACK_RECOVERY_ERRORS = ['channel_not_found', 'is_archived', 'not_in_channel', 'missing_scope'];

export function classifySlackRecoveryError(err: unknown): 'permanent' | 'transient' {
  const code = (err as { data?: { error?: string } })?.data?.error;
  if (code && PERMANENT_SLACK_RECOVERY_ERRORS.includes(code)) return 'permanent';
  // WebClient sometimes surfaces only "An API error occurred: <code>".
  const message = err instanceof Error ? err.message : '';
  return PERMANENT_SLACK_RECOVERY_ERRORS.some((c) => message.includes(c)) ? 'permanent' : 'transient';
}

/** Find threads created or updated during the gap before they have a session. */
export async function discoverSlackRecoveryTargets(
  client: WebClient,
  request: ChannelRecoveryRequest,
): Promise<{
  targets: ChannelRecoveryTarget[];
  complete: boolean;
  failed: Array<{ target: ChannelRecoveryTarget; error: unknown }>;
}> {
  const sinceMs = Date.parse(request.since);
  const targets: ChannelRecoveryTarget[] = [];
  const failed: Array<{ target: ChannelRecoveryTarget; error: unknown }> = [];
  let complete = true;

  // Per-root fault isolation: one unreachable channel must not abort
  // discovery for every other root (it did — the bridge then failed the
  // whole pass and froze the recovery window).
  for (const root of request.targets) {
    if (root.threadId !== null) continue;
    const channel = root.platformId.split(':')[1];
    if (!channel) continue;
    let cursor: string | undefined;
    let coveredBoundary = false;
    const seenCursors = new Set<string>();
    try {
      for (;;) {
        const response = await client.conversations.history({ channel, limit: 100, cursor });
        const messages = (response.messages ?? []) as SlackRecoveryMessage[];
        for (const message of messages) {
          const rootTs = message.ts ?? '';
          const rootMs = Number(rootTs) * 1000;
          const latestReplyMs = Number(message.latest_reply) * 1000;
          const hasGapReply =
            (message.reply_count ?? 0) > 0 && Number.isFinite(latestReplyMs) && latestReplyMs > sinceMs;
          const createdInGap = Number.isFinite(rootMs) && rootMs > sinceMs;
          if ((hasGapReply || createdInGap) && rootTs) {
            targets.push({ platformId: root.platformId, threadId: `slack:${channel}:${rootTs}`, isDM: root.isDM });
          }
        }
        const nextCursor = response.response_metadata?.next_cursor || undefined;
        // Slack has no thread-activity index: an old channel or DM root can
        // receive its first reply during the gap. Cover the conversation's full
        // root history so those threads are discoverable, not just roots newer
        // than `since`.
        if (!nextCursor) {
          coveredBoundary = true;
          break;
        }
        if (seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      if (!coveredBoundary) complete = false;
    } catch (err) {
      failed.push({ target: root, error: err });
    }
  }

  return { targets, complete, failed };
}

/**
 * Pure helper — parse workspace configs from an env key/value map.
 * Exported for testing.
 *
 * Suffix-to-channelType derivation: lowercase, then map `_` → `-`. This
 * keeps env-var names readable when an underscore appears (e.g.
 * SLACK_BOT_TOKEN_EXAMPLE_LABS_CODEX) while producing a channelType that
 * matches the existing dash-separated convention (slack-example-labs-codex).
 * The reverse direction at channel-auto-wire/index.ts:67 already maps
 * `-` → `_` when building env-var lookups, so the round-trip is stable.
 */

/** The slice of the Slack Web API these two helpers need. Structural so tests
 *  can pass a two-method stub instead of a WebClient. */
export interface SlackConversationClient {
  conversations: {
    info(args: { channel: string }): Promise<{
      ok?: boolean;
      channel?: { name?: string; is_im?: boolean; is_mpim?: boolean; user?: string };
    }>;
    members?(args: { channel: string; limit?: number }): Promise<{ ok?: boolean; members?: string[] }>;
  };
  users?: {
    info(args: { user: string }): Promise<{
      ok?: boolean;
      user?: {
        name?: string;
        real_name?: string;
        is_bot?: boolean;
        deleted?: boolean;
        profile?: { display_name?: string; real_name?: string };
      };
    }>;
  };
}

function slackUserDisplayName(u: {
  name?: string;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string };
}): string | null {
  return u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || null;
}

/**
 * Classify a Slack conversation for surfaces that render it to a human: a 1:1
 * DM, a group DM (MPDM), or a channel.
 *
 * Ported from upstream/channels `resolveSlackConversation`, with two fork
 * deviations:
 *  - a 1:1 DM resolves the counterpart's profile name rather than returning
 *    `name: null`. `resolveChannelName` is built on this function and has
 *    named Slack DMs since 04f9a5f9; losing that would rename every DM
 *    messaging group back to a raw `slack:D…` id.
 *  - it runs on this fork's `WebClient` rather than upstream's adapter
 *    wrapper, which does not exist here.
 *
 * Returns null when the API cannot classify the conversation (network
 * failure, missing scope) so callers fall back to generic rendering. Never
 * throws — a naming lookup must not take down an approval card.
 */
export async function resolveSlackConversation(
  client: SlackConversationClient,
  platformId: string,
): Promise<ChannelConversation | null> {
  try {
    const id = extractSlackChannelId(platformId);
    const info = await client.conversations.info({ channel: id });
    if (!info.ok || !info.channel) return null;
    const ch = info.channel;

    if (ch.is_im) {
      if (!ch.user || !client.users) return { type: 'direct', name: null };
      const res = await client.users.info({ user: ch.user });
      return { type: 'direct', name: res.ok && res.user ? slackUserDisplayName(res.user) : null };
    }

    // A channel keeps its `#name`. Only an MPDM pays for the roster lookup.
    if (!ch.is_mpim) return { type: 'channel', name: ch.name ? `#${ch.name}` : null };

    const participantNames = await resolveMpdmParticipants(client, id);
    return participantNames
      ? { type: 'group_dm', name: null, participantNames }
      : // The roster is unresolvable (no members scope, no users.info) but the
        // conversation IS a group DM — say so rather than falling back to the
        // `mpdm-a--b--c-1` slug Slack puts in `name`.
        { type: 'group_dm', name: null };
  } catch {
    return null;
  }
}

/** Human members of an MPDM, or null when the roster can't be resolved.
 *  Bots (including our own) and deactivated accounts are excluded. */
async function resolveMpdmParticipants(client: SlackConversationClient, channelId: string): Promise<string[] | null> {
  if (!client.conversations.members || !client.users) return null;
  // Same `.catch()` the per-member `users.info` calls carry below: a transient
  // roster failure must degrade to "group DM, no names", not escape to
  // `resolveSlackConversation`'s catch — that returns null for the whole
  // conversation, which loses the one fact we already know for certain (this
  // IS a group DM) and drops the card back to generic rendering.
  const { ok, members } = await client.conversations
    .members({ channel: channelId, limit: 100 })
    .catch(() => ({ ok: false }) as { ok?: boolean; members?: string[] });
  if (ok === false || !members || members.length === 0) return null;
  const users = await Promise.all(
    members.map((userId) => client.users!.info({ user: userId }).catch(() => ({ ok: false }) as { ok?: boolean })),
  );
  const names: string[] = [];
  for (const [index, res] of users.entries()) {
    const u = (
      res as {
        ok?: boolean;
        user?: Parameters<typeof slackUserDisplayName>[0] & {
          is_bot?: boolean;
          is_app_user?: boolean;
          deleted?: boolean;
        };
      }
    ).user;
    // A LOOKUP FAILURE is not a filtered member. Skipping it would present a
    // truncated roster as complete — "a group DM with Alice" when Bob's
    // profile call merely failed — and that label is then persisted as the
    // messaging group's name. All-or-nothing: an unresolved roster degrades
    // the card to "a group DM", which is true.
    if (!res.ok || !u) return null;
    if (!isSlackHumanMember(members[index]!, u)) continue;
    const name = slackUserDisplayName(u);
    // A resolvable human with no usable name is the same problem: naming the
    // rest would claim a completeness we do not have.
    if (!name) return null;
    names.push(name);
  }
  return names.length > 0 ? names : null;
}

/**
 * Human-facing name for a Slack conversation, for `messaging_groups.name`:
 * `#name` for channels, the counterpart's profile name for a 1:1 DM, and the
 * participant list for a group DM. Null whenever the API cannot say — callers
 * keep the wiring and fall back to the platform id, so a lookup failure must
 * never throw.
 *
 * This is the fleet's only implementation of the adapter's optional
 * `resolveChannelName`: the router names every auto-wired conversation
 * through it, and until it existed every auto-wired Slack DM stayed nameless
 * forever and rendered as a raw `slack:D…` id on human surfaces. It is now a
 * projection of `resolveSlackConversation` so the two seams cannot disagree.
 */
export async function slackChannelDisplayName(
  client: SlackConversationClient,
  platformId: string,
): Promise<string | null> {
  const conversation = await resolveSlackConversation(client, platformId);
  return conversation ? conversationDisplayName(conversation) : null;
}

export function parseSlackWorkspaces(env: Record<string, string>): SlackWorkspace[] {
  const bySuffix = new Map<string, { botToken?: string; signingSecret?: string; appToken?: string }>();

  for (const [key, value] of Object.entries(env)) {
    const m = key.match(/^SLACK_(BOT_TOKEN|SIGNING_SECRET|APP_TOKEN)(?:_([A-Za-z0-9_]+))?$/);
    if (!m) continue;
    const [, kind, rawSuffix] = m;
    const suffix = rawSuffix ? rawSuffix.toLowerCase().replace(/_/g, '-') : '';
    const entry = bySuffix.get(suffix) ?? {};
    if (kind === 'BOT_TOKEN') entry.botToken = value;
    else if (kind === 'APP_TOKEN') entry.appToken = value;
    else entry.signingSecret = value;
    bySuffix.set(suffix, entry);
  }

  const workspaces: SlackWorkspace[] = [];
  for (const [suffix, pair] of bySuffix) {
    if (!pair.botToken) continue;
    // Each delivery mode needs only its own second credential: Socket Mode
    // holds an outbound WebSocket (no public URL, nothing to sign), webhook
    // delivery needs the signing secret to authenticate Slack's POSTs.
    if (!pair.signingSecret && !pair.appToken) {
      log.warn('Slack workspace has no signing secret and no app token, skipping', {
        suffix: suffix || '(primary)',
      });
      continue;
    }
    const workspace: SlackWorkspace = {
      channelType: suffix ? `slack-${suffix}` : 'slack',
      botToken: pair.botToken,
    };
    if (pair.signingSecret) workspace.signingSecret = pair.signingSecret;
    if (pair.appToken) workspace.appToken = pair.appToken;
    workspaces.push(workspace);
  }
  return workspaces;
}

/**
 * ChannelTypes that must carry the declaration but cannot serve traffic.
 *
 * The registration is credential-gated, but the DECLARATION must not be:
 * `getChannelDefaults` resolves through the REGISTRY when no adapter is live
 * (tier 3, "factories that returned null for missing creds"), and without an
 * entry `ncl`/setup stamp the legacy `strict` schema default on a
 * messaging_groups row — a creation-time value that survives the credentials
 * being completed.
 *
 * Two sources:
 *  - any suffix seen with a Slack env key but not a complete token/secret
 *    pair — a bot token pasted before its signing secret, or the reverse;
 *  - the default `slack` instance when NOTHING is configured, which is the
 *    state `setup/register.ts` and an offline `ncl` run in. It is added only
 *    then, so a host with real workspaces does not advertise a phantom
 *    unconfigured channel in `getRegisteredChannelNames`.
 *
 * A suffix that IS complete is excluded here — the bridge factory loop
 * registers it with a live factory.
 *
 * Exported for testing. Same suffix→channelType derivation as
 * parseSlackWorkspaces, deliberately duplicated rather than folded into it:
 * that function's contract is "workspaces that can serve traffic", and the
 * bridge factory loop depends on that.
 */
export function declarationOnlySlackTypes(env: Record<string, string>): string[] {
  const bySuffix = new Map<string, { botToken?: string; signingSecret?: string }>();
  for (const [key, value] of Object.entries(env)) {
    const m = key.match(/^SLACK_(BOT_TOKEN|SIGNING_SECRET)(?:_([A-Za-z0-9_]+))?$/);
    if (!m) continue;
    const [, kind, rawSuffix] = m;
    const suffix = rawSuffix ? rawSuffix.toLowerCase().replace(/_/g, '-') : '';
    const entry = bySuffix.get(suffix) ?? {};
    if (kind === 'BOT_TOKEN') entry.botToken = value;
    else entry.signingSecret = value;
    bySuffix.set(suffix, entry);
  }

  const types: string[] = [];
  let anyComplete = false;
  for (const [suffix, pair] of bySuffix) {
    if (pair.botToken && pair.signingSecret) {
      anyComplete = true;
      continue;
    }
    types.push(suffix ? `slack-${suffix}` : 'slack');
  }
  if (!anyComplete && types.length === 0) types.push('slack');
  return types;
}

/**
 * The env keys a Slack workspace is assembled from. ONE definition, because a
 * second copy is how Socket Mode broke `backlog-canvas`: it had its own
 * regex, that regex predated `APP_TOKEN`, and a socket workspace therefore
 * looked credential-less to it while working fine for the adapter.
 */
const SLACK_ENV_PATTERN = /^SLACK_(BOT_TOKEN|SIGNING_SECRET|APP_TOKEN)(_[A-Za-z0-9_]+)?$/;

/** Every configured Slack workspace, read from `.env`. The one entry point —
 *  callers outside this module must not re-derive the env pattern. */
export function loadSlackWorkspaces(): SlackWorkspace[] {
  return parseSlackWorkspaces(readEnvFileMatching(SLACK_ENV_PATTERN));
}

/** Minimal interface for the Slack chat.postMessage client — narrow surface for testing. */
export interface SlackPostMessageClient {
  chat: {
    postMessage(args: { channel: string; text: string; thread_ts?: string }): Promise<{ ts?: string | null }>;
  };
}

/**
 * Strip the `slack:` scheme prefix from a NanoClaw platform_id, leaving the
 * raw Slack channel ID the Web API expects. Tolerates both prefixed
 * (`slack:CTEST00004`, the canonical messaging_groups.platform_id form) and
 * raw (`CTEST00004`, used in unit tests) inputs. The host's regular delivery
 * path normalizes via the chat-sdk bridge — these helpers are called from
 * orchestrator-dispatch directly and need to do their own normalization or
 * Slack returns `channel_not_found`.
 */
export function extractSlackChannelId(platformId: string): string {
  return platformId.startsWith('slack:') ? platformId.slice('slack:'.length) : platformId;
}

/**
 * Post a message to the top level of a Slack channel.
 * Exported for unit testing.
 */
export async function slackPostParent(
  client: SlackPostMessageClient,
  platformId: string,
  text: string,
): Promise<{ messageId: string }> {
  const channel = extractSlackChannelId(platformId);
  const response = await client.chat.postMessage({ channel, text });
  return { messageId: response.ts as string };
}

/**
 * Create a Slack thread by posting a reply to an existing parent message.
 * threadId IS the parent message's ts (Slack thread_ts semantic) — NOT reply.ts.
 * Exported for unit testing.
 */
export async function slackCreateThread(
  client: SlackPostMessageClient,
  platformId: string,
  parentMessageId: string,
  _title: string,
  firstMessage: string,
): Promise<{ threadId: string; messageId: string }> {
  const channel = extractSlackChannelId(platformId);
  const reply = await client.chat.postMessage({
    channel,
    thread_ts: parentMessageId,
    text: firstMessage,
  });
  return { threadId: parentMessageId, messageId: reply.ts as string };
}

// Keep SLACK_ENV_PATTERN in sync with the suffix regex inside
// parseSlackWorkspaces — both must allow `_` in the suffix, otherwise env vars
// like SLACK_BOT_TOKEN_EXAMPLE_LABS_CODEX get dropped before they ever reach
// the parser, and both must list APP_TOKEN or a Socket Mode workspace looks
// credential-less. Read once here (rather than via loadSlackWorkspaces) so the
// raw env dict is also available to declarationOnlySlackTypes below.
const slackEnv = readEnvFileMatching(SLACK_ENV_PATTERN);
const workspaces = parseSlackWorkspaces(slackEnv);

// Declaration-only registrations run BEFORE the live ones so a complete
// workspace's real factory always wins the key. A half-configured or entirely
// unconfigured Slack still gets its declaration into the registry, so a
// messaging group created before the credentials land is not stamped with the
// legacy `strict` schema default forever. The factory returns null —
// initChannelAdapters logs the missing credentials and moves on.
for (const channelType of declarationOnlySlackTypes(slackEnv)) {
  registerChannelAdapter(channelType, { defaults: SLACK_DEFAULTS, factory: () => null });
}

for (const ws of workspaces) {
  registerChannelAdapter(ws.channelType, {
    // Also on the registration, so offline creation paths (setup wizard,
    // scripts, `ncl` against a host whose factory returned null for missing
    // creds) resolve the same declaration without instantiating the adapter.
    defaults: SLACK_DEFAULTS,
    factory: async () => {
      // Socket Mode when an app-level token is configured, webhook otherwise.
      // The app token IS the switch — the contract the add-slack skill has
      // documented to operators all along, and the reason a Socket Mode
      // install used to write SLACK_APP_TOKEN, no signing secret, and get a
      // bot that could send but never receive. Existing webhook instances
      // have no app token and are unaffected.
      const slackAdapter = createSlackAdapter({
        botToken: ws.botToken,
        signingSecret: ws.signingSecret,
        appToken: ws.appToken,
        mode: ws.appToken ? 'socket' : 'webhook',
      });
      log.info('Slack workspace connecting', {
        channelType: ws.channelType,
        mode: ws.appToken ? 'socket' : 'webhook',
      });
      // Multi-workspace dedup isolation. The @chat library's message dedup
      // key is `dedupe:${adapter.name}:${message.id}`. SlackAdapter defaults
      // `name = "slack"` for all instances; combined with a shared SqliteState
      // adapter (state-sqlite.ts uses getDb()), two slack adapters processing
      // the same Slack event (same `ts`) collide on the dedup key and the
      // second one silently drops the message. This bites the two-bots-in-
      // same-workspace case (e.g. helper + helper-codex both seeing user
      // messages in #agents-example). Across-workspace it doesn't bite because
      // each Slack workspace's `ts` values are disjoint.
      //
      // Override the adapter name to the channelType so each workspace has
      // its own dedup keyspace. The name also keys `chat.webhooks[...]` so
      // the webhook-server lookup matches.
      (slackAdapter as unknown as { name: string }).name = ws.channelType;
      const client = new WebClient(ws.botToken);

      // Discover this bot's user_id + username + team_id so sibling bots in
      // the same Slack workspace can resolve `@username` → `<@USER_ID>` on
      // outbound. One auth.test call at adapter init; cached for the
      // lifetime of the process. Mirrors discord.ts's fetchDiscordBotIdentity.
      //
      // Profile alias enrichment (displayName/realName from users.info)
      // runs as fire-and-forget AFTER registration so it doesn't extend
      // serial channel-factory startup. The registry has username
      // resolution working immediately; the additional aliases appear
      // once the (typically sub-second) users.info call completes.
      const identity = await fetchSlackBotIdentity(client);
      if (identity) {
        registerSlackBot(ws.channelType, identity);
        void upgradeSlackBotProfile(client, ws.channelType);
        // Workspace humans → mention registry, so agent-emitted `@Alice` /
        // `<@bob>` resolve without a hand-maintained roster. Fire-and-forget
        // at init (same pattern as profile enrichment) + hourly refresh so
        // new teammates resolve without a restart. Degrades gracefully when
        // the token lacks users:read.
        void syncSlackWorkspaceHumans(client, identity.teamId, ws.channelType);
        setInterval(
          () => void syncSlackWorkspaceHumans(client, identity.teamId, ws.channelType),
          60 * 60 * 1000,
        ).unref();
      } else {
        log.warn('Slack bot identity unavailable — outbound @-mentions for this bot will not resolve', {
          channelType: ws.channelType,
        });
      }

      // One governor per bridge instance — each instance is one bot identity.
      const hopGovernor = createSlackHopGovernor(ws.channelType);

      const bridge = createChatSdkBridge({
        adapter: slackAdapter,
        // Slack sends a pasted table as attachments[].blocks[] — it appears in
        // neither the message text nor the file list, so without this the agent
        // gets only the sentence before the table.
        extractRawText: extractSlackRawText,
        concurrency: 'concurrent',
        supportsThreads: true,
        defaults: SLACK_DEFAULTS,
        maxTextLength: SLACK_MESSAGE_MAX_TEXT_LENGTH,
        // Oversize channel-level posts: continuation chunks reply in the
        // first chunk's thread rather than landing as sibling parents that
        // repliers thread under by mistake.
        threadContinuationChunks: true,
        channelType: ws.channelType,
        // ATX headings → bold so Block Kit table delivery stays on the
        // `markdown` path (table-block conversion only fires for markdown/ast
        // input). The adapter handles bold/italic/links/lists/tables natively.
        //
        // resolveSlackMentions runs first so `@bot-username` becomes
        // `<@USER_ID>` (Slack's required mention syntax) BEFORE Markdown
        // heading conversion — the rewriter only touches `@…` tokens, and
        // markdownHeadingsToBold only touches line-anchored `#` prefixes,
        // so order is independent for correctness but consistent for
        // intent.
        transformOutboundMarkdown: (text) => {
          // A bot has no legitimate reason to emit a raw bot <@id> — it only
          // shows up when the model echoes the inbound mention wire form
          // (observed live: gate-syntax examples like "<@U…> hold 304"
          // reaching humans as literal text, from the gate bot AND siblings
          // quoting it, despite persona bans). Rewrite every known bot id in
          // this workspace to its plain @name BEFORE mention resolution:
          // inside code spans it stays literal (the documented gate syntax),
          // in prose the resolver turns it back into a proper mention pill.
          // Human raw ids pass through — those are legitimate deterministic
          // mentions, and re-resolution by alias could drop an ambiguous one.
          const self = getKnownSlackBots().get(ws.channelType);
          let named = text;
          if (self && named.includes('<@')) {
            for (const bot of getKnownSlackBots().values()) {
              if (bot.teamId !== self.teamId) continue;
              named = named.replaceAll(`<@${bot.userId}>`, `@${bot.displayName || bot.realName || bot.username}`);
            }
          }
          const structured = normalizeSlackOrderedListContinuations(named);
          return markdownHeadingsToBold(resolveSlackMentions(structured, ws.channelType));
        },
        // Inbound wire text carries mentions as raw <@U…>; resolving them to
        // @name here is what stops agents from ever LEARNING the raw form —
        // the outbound rewrite above is the backstop, this is the cure.
        transformInboundText: (text) => resolveInboundSlackIds(text, ws.channelType),
        // Chat SDK can retain a bot's immutable install-time username in
        // author.fullName even after Slack shows a new profile name. Resolve
        // sibling authors through the same live, workspace-scoped registry as
        // mentions so thread context and archive rows never teach the agent a
        // deprecated backend codename.
        transformInboundSender: (author) =>
          author.userId ? getSlackBotSenderName(ws.channelType, author.userId) : null,
        // Slack's markdown_text parser fires app_mention even for literal
        // `@name` inside backticks (gate-syntax documentation). Demote the
        // mention when it appears ONLY inside code regions; keep the
        // platform verdict when identity is unavailable.
        refineInboundMention: (text) => {
          const self = getKnownSlackBots().get(ws.channelType);
          return self ? slackMentionOutsideCode(text, self) : true;
        },
        // Loop governor: bound a sibling-bot ping-pong that no human is in.
        // Live dispatch only. Recovery pages arrive newest-first and are
        // sorted afterwards, so counting them would both mis-order the hop
        // state and re-judge history the live path already judged; recovery
        // is separately bounded by its window and allowRecoveredBotMessage.
        inboundFilter: (message, ctx) => (ctx.recovered ? true : slackHopInboundFilter(hopGovernor, identity, message)),
        detectRecoveredMention: (message) => {
          if (!identity) return false;
          const raw = message.raw as Record<string, unknown> | undefined;
          if (!raw) return false;
          const mention = `<@${identity.userId}>`;
          if (typeof raw.text === 'string' && raw.text.includes(mention)) return true;
          // A pasted table can be the only place the bot is addressed, and a
          // REST-fetched recovery row carries no isMention. The same
          // projection the bridge appends to the body answers this question
          // too — see the invariant note in slack-raw-text.ts.
          return extractSlackRawText(raw)?.includes(mention) === true;
        },
        // Sibling-bot messages are admissible in recovery (mirrors discord.ts):
        // without this, a sibling's @-mention that arrives during an event-loop
        // stall is dropped by recovery's default bot filter and the assignment
        // is silently lost.
        allowRecoveredBotMessage: (message) => {
          const authorId = message.author.userId;
          return authorId !== identity?.userId && [...getKnownSlackBots().values()].some((b) => b.userId === authorId);
        },
        fetchRecoveryPage: makeSlackRecoveryPageFetcher(slackAdapter, client),
        discoverRecoveryTargets: (request) => discoverSlackRecoveryTargets(client, request),
        classifyRecoveryError: classifySlackRecoveryError,
      });
      bridge.resolveChannelName = (platformId) => slackChannelDisplayName(client, platformId);
      bridge.resolveConversation = (platformId) => resolveSlackConversation(client, platformId);
      bridge.permalink = (platformId, threadId) => slackPermalink(ws.channelType, platformId, threadId);
      bridge.channelPermalink = (platformId) => slackChannelPermalink(ws.channelType, platformId);
      bridge.postParent = (platformId, text) => slackPostParent(client, platformId, text);
      bridge.createThread = (platformId, parentMessageId, title, firstMessage) =>
        slackCreateThread(client, platformId, parentMessageId, title, firstMessage);
      return bridge;
    },
  });
}

if (workspaces.length > 1) {
  log.info('Multiple Slack workspaces registered', {
    channelTypes: workspaces.map((w) => w.channelType),
  });
}
