/**
 * scripts/open-a2a-room.ts — open a Slack agent-to-agent (A2A) room.
 *
 * Creates a group DM (MPIM) holding a human plus two or more sibling bots that
 * this host runs, posts an intro message from the first bot, and prints the
 * channel id plus the `ncl` commands that wire the room to each bot's agent
 * group.
 *
 * Usage:
 *   pnpm exec tsx scripts/open-a2a-room.ts --instances <name,name…> [--user <slack user id>]
 *
 * Instance names follow the adapter's suffix-token convention: each name reads
 * its bot token from `SLACK_BOT_TOKEN_<NAME>` (uppercased, dashes →
 * underscores). A `slack-` prefix is accepted so the channelType an operator
 * sees in `ncl messaging-groups list` can be pasted verbatim, and `slack` (or
 * `default`) means the primary workspace's `SLACK_BOT_TOKEN`. The first listed
 * instance is the caller — it opens the conversation and posts the intro. Bot
 * user ids are resolved via `auth.test` per token.
 *
 * Requires the `mpim:write` scope on the FIRST listed app — it is the one that
 * calls `conversations.open`. The others are members and need only the
 * `mpim:read` / `mpim:history` that `/add-slack` already asks for.
 * `/add-slack` does not ask for `mpim:write`, so it has to be added to the
 * caller and that app reinstalled before this runs (see the skill's
 * prerequisites). Without --user the room holds bots only,
 * which needs at least three instances (Slack turns a two-party open into a
 * 1:1 IM).
 *
 * Opening the room is the whole side effect: this reads `.env` and writes
 * nothing back, because a room carries no host-side registration. Sibling-bot
 * inbound reaches the router in every conversation via `isSiblingBotSender`
 * (src/modules/permissions/access.ts), and runaway loops are bounded per
 * thread by `SLACK_MAX_BOT_HOPS` (src/channels/slack-hop-limit.ts).
 *
 * Token values are never printed.
 */
import path from 'path';
import { fileURLToPath } from 'url';

import { readEnvFile } from '../src/env.js';

const SLACK_API = 'https://slack.com/api';

const USAGE = 'Usage: pnpm exec tsx scripts/open-a2a-room.ts --instances <name,name…> [--user <slack user id>]';

export interface SlackAuth {
  name: string;
  envKey: string;
  token: string;
  userId: string; // U… bot user id (auth.test user_id)
  botId: string | null; // B… bot id (auth.test bot_id)
}

function fail(msg: string): never {
  console.error(`open-a2a-room: ${msg}`);
  process.exit(1);
}

export function parseArgs(argv: string[]): { instances: string[]; user?: string } {
  let instances: string[] = [];
  let user: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--instances') {
      instances = (argv[++i] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (argv[i] === '--user') {
      user = argv[++i];
    } else {
      fail(`unknown argument: ${argv[i]}\n${USAGE}`);
    }
  }
  if (instances.length < 2) fail('--instances needs at least two comma-separated instance names');
  if (!user && instances.length < 3) {
    fail(
      'without --user the room holds bots only, which needs at least three instances (a two-party open becomes a 1:1 IM)',
    );
  }
  if (user && !/^[UW][A-Z0-9]+$/.test(user)) {
    fail(`--user must be a Slack user id (U…/W…), got: ${user}`);
  }
  return { instances, user };
}

/**
 * Strip the optional `slack-` prefix so an operator can paste either the
 * channelType (`slack-example-labs-codex`) or the bare suffix
 * (`example-labs-codex`). Exported for the convention test.
 */
export function normalizeInstance(name: string): string {
  // Lowercased first: the adapter derives its channelType from a lowercased
  // suffix, so anything that keeps the operator's capitalization here would
  // produce a channelType no registration ever used.
  const trimmed = name.trim().toLowerCase();
  if (trimmed === 'slack' || trimmed === 'default') return '';
  return trimmed.startsWith('slack-') ? trimmed.slice('slack-'.length) : trimmed;
}

/**
 * The `.env` key holding this instance's bot token.
 *
 * Mirrors the suffix regex inside `parseSlackWorkspaces` (src/channels/slack.ts)
 * in reverse: the adapter lowercases the suffix and maps `_` → `-` to derive a
 * channelType, so this uppercases and maps `-` → `_` to get back to the key.
 * `scripts/open-a2a-room.test.ts` pins the round trip against the real parser.
 */
export function tokenEnvKey(name: string): string {
  const suffix = normalizeInstance(name);
  if (suffix === '') return 'SLACK_BOT_TOKEN';
  return `SLACK_BOT_TOKEN_${suffix.toUpperCase().replace(/-/g, '_')}`;
}

/** The channelType the adapter registers for this instance. */
export function channelTypeForInstance(name: string): string {
  const suffix = normalizeInstance(name);
  return suffix === '' ? 'slack' : `slack-${suffix}`;
}

async function slackCall(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (json.ok !== true) {
    const err = String(json.error ?? `HTTP ${res.status}`);
    const hint =
      err === 'missing_scope' && method === 'conversations.open'
        ? ' — the app needs the mpim:write scope, then a reinstall to mint a new xoxb- token'
        : '';
    throw new Error(`${method} failed: ${err}${hint}`);
  }
  return json;
}

async function resolveAuth(name: string): Promise<SlackAuth> {
  const envKey = tokenEnvKey(name);
  const env = readEnvFile([envKey]);
  const token = env[envKey];
  if (!token) fail(`missing ${envKey} in .env (the adapter's suffix-token convention)`);
  const auth = await slackCall(token, 'auth.test', {});
  const userId = typeof auth.user_id === 'string' ? auth.user_id : null;
  if (!userId) fail(`auth.test for instance "${name}" returned no user_id`);
  return {
    name,
    envKey,
    token,
    userId,
    botId: typeof auth.bot_id === 'string' ? auth.bot_id : null,
  };
}

async function main(): Promise<void> {
  const { instances, user } = parseArgs(process.argv.slice(2));

  console.log(`Resolving bot identities for: ${instances.join(', ')}`);
  const auths: SlackAuth[] = [];
  for (const name of instances) {
    const auth = await resolveAuth(name);
    console.log(`  ${name}: bot user ${auth.userId}${auth.botId ? ` (bot id ${auth.botId})` : ''}`);
    auths.push(auth);
  }

  const caller = auths[0]!;
  const otherBotUserIds = auths.slice(1).map((a) => a.userId);
  const members = [...(user ? [user] : []), ...otherBotUserIds];

  console.log(`Opening group DM as "${caller.name}" with: ${members.join(', ')}`);
  const opened = await slackCall(caller.token, 'conversations.open', {
    users: members.join(','),
  });
  const channel = opened.channel as Record<string, unknown> | undefined;
  const channelId = typeof channel?.id === 'string' ? channel.id : null;
  if (!channelId) fail('conversations.open returned no channel id');
  if (channel?.is_mpim !== true) {
    console.warn(
      `warning: opened conversation ${channelId} is not an MPIM (is_mpim=${String(channel?.is_mpim)}) — with fewer than three members Slack returns a 1:1 IM`,
    );
  }

  const botMentions = otherBotUserIds.map((id) => `<@${id}>`).join(' ');
  const introText =
    `:robot_face: Agent-to-agent room opened by "${caller.name}". ` +
    `${botMentions}${user ? ` <@${user}>` : ''} — the agents in this room can hear each other. ` +
    `Conversation is mention-driven: @-mention an agent to get its reply, and it can @-mention the next one. ` +
    `After too many consecutive agent-to-agent turns the thread pauses until a human speaks.`;
  await slackCall(caller.token, 'chat.postMessage', {
    channel: channelId,
    text: introText,
  });

  console.log('');
  console.log(`A2A room channel id: ${channelId}`);
  console.log('No .env change is needed — this fork admits sibling-bot messages everywhere.');
  console.log('');
  console.log('Next steps (once per room, per participating agent):');
  console.log('  1. @-mention one bot in the room so the host auto-creates the messaging group.');
  console.log('  2. Confirm the row and wire the other agents to it:');
  for (const auth of auths) {
    console.log(`       ncl messaging-groups list --channel-type ${channelTypeForInstance(auth.name)} --json`);
  }
  console.log('       ncl wirings create --messaging-group-id <id> --agent-group-id <agent group id> \\');
  console.log('         --session-mode per-thread --ignored-message-policy accumulate');
  console.log('     Both flags are load-bearing: ncl wirings create falls back to shared/drop, while');
  console.log('     the router stamps per-thread/accumulate on the wirings it creates by itself.');
  console.log('  3. Each agent needs a wiring on ITS OWN instance row — one room, one row per bot.');
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
}
