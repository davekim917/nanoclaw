/**
 * Init the first (or Nth) NanoClaw v2 agent.
 *
 * Two modes:
 *
 * 1. **DM channel mode** (default): wires a real DM channel (discord, telegram,
 *    etc.) + the CLI channel to the same agent, stages a welcome into the DM
 *    session so the agent greets the operator over that channel.
 *
 * 2. **CLI-only mode** (`--cli-only`): wires only the CLI channel. Used by
 *    `/new-setup` to get to a working 2-way CLI chat with the bare minimum.
 *    Owner grant uses a synthetic `cli:local` user so admin-gated flows work.
 *
 * Creates/reuses: user, owner grant (if none), agent group + filesystem,
 * messaging group(s), wiring, session. Stages a system welcome message so
 * the host sweep wakes the container and the agent sends the greeting via
 * the normal delivery path.
 *
 * Runs alongside the service (WAL-mode sqlite) — does NOT initialize
 * channel adapters, so there's no Gateway conflict.
 *
 * Usage:
 *   # DM mode
 *   pnpm exec tsx scripts/init-first-agent.ts \
 *     --channel discord \
 *     --user-id discord:1470183333427675709 \
 *     --platform-id discord:@me:1491573333382523708 \
 *     --display-name "Gavriel" \
 *     [--agent-name "Andy"] \
 *     [--welcome "System instruction: ..."]
 *
 *   # CLI-only mode
 *   pnpm exec tsx scripts/init-first-agent.ts --cli-only \
 *     --display-name "Gavriel" \
 *     [--agent-name "Andy"] \
 *     [--welcome "System instruction: ..."]
 *
 * For direct-addressable channels (telegram, whatsapp, etc.), --platform-id
 * is typically the same as the handle in --user-id, with the channel prefix.
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { normalizeName } from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { grantRole, hasAnyOwner } from '../src/modules/permissions/db/user-roles.js';
import { upsertUser } from '../src/modules/permissions/db/users.js';
import { initGroupFilesystem } from '../src/group-init.js';
import { resolveSession, writeSessionMessage } from '../src/session-manager.js';
import type { AgentGroup, MessagingGroup } from '../src/types.js';

interface Args {
  cliOnly: boolean;
  noCliBonus: boolean;
  channel: string;
  userId: string;
  platformId: string;
  displayName: string;
  agentName: string;
  welcome: string;
}

const DEFAULT_WELCOME =
  'System instruction: run /welcome to introduce yourself to the user on this new channel.';

const CLI_CHANNEL = 'cli';
const CLI_PLATFORM_ID = 'local';
const CLI_SYNTHETIC_USER_ID = `${CLI_CHANNEL}:${CLI_PLATFORM_ID}`;

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { cliOnly: false, noCliBonus: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    switch (key) {
      case '--cli-only':
        out.cliOnly = true;
        break;
      case '--no-cli-bonus':
        out.noCliBonus = true;
        break;
      case '--channel':
        out.channel = (val ?? '').toLowerCase();
        i++;
        break;
      case '--user-id':
        out.userId = val;
        i++;
        break;
      case '--platform-id':
        out.platformId = val;
        i++;
        break;
      case '--display-name':
        out.displayName = val;
        i++;
        break;
      case '--agent-name':
        out.agentName = val;
        i++;
        break;
      case '--welcome':
        out.welcome = val;
        i++;
        break;
    }
  }

  if (!out.displayName) {
    console.error('Missing required arg: --display-name');
    console.error('See scripts/init-first-agent.ts header for usage.');
    process.exit(2);
  }

  if (out.cliOnly) {
    // CLI-only: channel/user/platform default to the synthetic local CLI identity.
    return {
      cliOnly: true,
      noCliBonus: out.noCliBonus ?? false,
      channel: CLI_CHANNEL,
      userId: CLI_SYNTHETIC_USER_ID,
      platformId: CLI_PLATFORM_ID,
      displayName: out.displayName,
      agentName: out.agentName?.trim() || out.displayName,
      welcome: out.welcome?.trim() || DEFAULT_WELCOME,
    };
  }

  const required: (keyof Args)[] = ['channel', 'userId', 'platformId'];
  const missing = required.filter((k) => !out[k]);
  if (missing.length) {
    console.error(`Missing required args: ${missing.map((k) => `--${k.replace(/([A-Z])/g, '-$1').toLowerCase()}`).join(', ')}`);
    console.error('See scripts/init-first-agent.ts header for usage.');
    process.exit(2);
  }

  return {
    cliOnly: false,
    noCliBonus: out.noCliBonus ?? false,
    channel: out.channel!,
    userId: out.userId!,
    platformId: out.platformId!,
    displayName: out.displayName,
    agentName: out.agentName?.trim() || out.displayName,
    welcome: out.welcome?.trim() || DEFAULT_WELCOME,
  };
}

function namespacedUserId(channel: string, raw: string): string {
  return raw.includes(':') ? raw : `${channel}:${raw}`;
}

function namespacedPlatformId(channel: string, raw: string): string {
  return raw.startsWith(`${channel}:`) ? raw : `${channel}:${raw}`;
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ensureCliMessagingGroup(now: string): MessagingGroup {
  let cliMg = getMessagingGroupByPlatform(CLI_CHANNEL, CLI_PLATFORM_ID);
  if (cliMg) return cliMg;

  cliMg = {
    id: generateId('mg'),
    channel_type: CLI_CHANNEL,
    platform_id: CLI_PLATFORM_ID,
    name: 'Local CLI',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now,
  };
  createMessagingGroup(cliMg);
  console.log(`Created CLI messaging group: ${cliMg.id}`);
  return cliMg;
}

function wireIfMissing(mg: MessagingGroup, ag: AgentGroup, now: string, label: string): void {
  const existing = getMessagingGroupAgentByPair(mg.id, ag.id);
  if (existing) {
    console.log(`Wiring already exists: ${existing.id} (${label})`);
    return;
  }
  createMessagingGroupAgent({
    id: generateId('mga'),
    messaging_group_id: mg.id,
    agent_group_id: ag.id,
    // DM / CLI (is_group=0) default to "respond to everything" via a '.' regex.
    // Group chats default to mention-only; admins can upgrade to mention-sticky
    // via /manage-channels once the agent is in use.
    engage_mode: mg.is_group === 0 ? 'pattern' : 'mention',
    engage_pattern: mg.is_group === 0 ? '.' : null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    default_model: null,
    default_effort: null,
    default_tone: null,
    created_at: now,
  });
  console.log(`Wired ${label}: ${mg.id} -> ${ag.id}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db); // idempotent

  const now = new Date().toISOString();

  // 1. User + (conditional) owner grant.
  // In cli-only mode, the synthetic `cli:local` user becomes the first owner.
  const userId = namespacedUserId(args.channel, args.userId);
  upsertUser({
    id: userId,
    kind: args.channel,
    display_name: args.displayName,
    created_at: now,
  });

  let promotedToOwner = false;
  if (!hasAnyOwner()) {
    grantRole({
      user_id: userId,
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now,
    });
    promotedToOwner = true;
  }

  // 2. Agent group + filesystem
  const folder = args.cliOnly
    ? `cli-with-${normalizeName(args.displayName)}`
    : `dm-with-${normalizeName(args.displayName)}`;
  let ag: AgentGroup | undefined = getAgentGroupByFolder(folder);
  if (!ag) {
    const agId = generateId('ag');
    createAgentGroup({
      id: agId,
      name: args.agentName,
      folder,
      agent_provider: null,
      created_at: now,
    });
    ag = getAgentGroupByFolder(folder)!;
    console.log(`Created agent group: ${ag.id} (${folder})`);
  } else {
    console.log(`Reusing agent group: ${ag.id} (${folder})`);
  }
  initGroupFilesystem(ag, {
    instructions:
      `# ${args.agentName}\n\n` +
      `You are ${args.agentName}, a personal NanoClaw agent for ${args.displayName}. ` +
      'When you receive a system welcome prompt, introduce yourself briefly and invite them to chat. Keep replies concise.',
  });

  // 3. Primary messaging group + wiring + welcome session.
  // In DM mode: the DM messaging group is primary, CLI is wired as a bonus.
  // In cli-only mode: the CLI messaging group is primary; no DM group.
  const cliMg = ensureCliMessagingGroup(now);

  let primaryMg: MessagingGroup;
  if (args.cliOnly) {
    primaryMg = cliMg;
  } else {
    const platformId = namespacedPlatformId(args.channel, args.platformId);
    let dmMg = getMessagingGroupByPlatform(args.channel, platformId);
    if (!dmMg) {
      const mgId = generateId('mg');
      createMessagingGroup({
        id: mgId,
        channel_type: args.channel,
        platform_id: platformId,
        name: args.displayName,
        is_group: 0,
        unknown_sender_policy: 'strict',
        created_at: now,
      });
      dmMg = getMessagingGroupByPlatform(args.channel, platformId)!;
      console.log(`Created messaging group: ${dmMg.id} (${platformId})`);
    } else {
      console.log(`Reusing messaging group: ${dmMg.id} (${platformId})`);
    }
    primaryMg = dmMg;
  }

  // Wire primary (DM or CLI), auto-creates companion agent_destinations row.
  wireIfMissing(primaryMg, ag, now, args.cliOnly ? 'cli' : 'dm');

  // In DM mode also wire CLI so `pnpm run chat` works immediately.
  // Skip the bonus when --no-cli-bonus is set — used by /new-setup-2 so the
  // throwaway CLI-only agent from /new-setup still owns CLI routing cleanly.
  if (!args.cliOnly && !args.noCliBonus) {
    wireIfMissing(cliMg, ag, now, 'cli-bonus');
  }

  // 4. Session + staged welcome (on the primary messaging group)
  const { session, created } = resolveSession(ag.id, primaryMg.id, null, 'shared');
  console.log(`${created ? 'Created' : 'Reusing'} session: ${session.id}`);

  writeSessionMessage(ag.id, session.id, {
    id: generateId('sys-welcome'),
    kind: 'chat',
    timestamp: now,
    platformId: primaryMg.platform_id,
    channelType: primaryMg.channel_type,
    threadId: null,
    content: JSON.stringify({
      text: args.welcome,
      sender: 'system',
      senderId: 'system',
    }),
  });

  console.log('');
  console.log('Init complete.');
  console.log(`  owner:   ${userId}${promotedToOwner ? ' (promoted on first owner)' : ''}`);
  console.log(`  agent:   ${ag.name} [${ag.id}] @ groups/${folder}`);
  if (args.cliOnly) {
    console.log(`  channel: cli/${CLI_PLATFORM_ID}`);
  } else {
    console.log(`  channel: ${args.channel} ${primaryMg.platform_id}`);
    if (!args.noCliBonus) {
      console.log(`  cli:     cli/${CLI_PLATFORM_ID} wired — try \`pnpm run chat hi\``);
    }
  }
  console.log(`  session: ${session.id}`);
  console.log('');
  console.log(
    args.cliOnly
      ? 'Host sweep (<=60s) will wake the container. Try `pnpm run chat hi`.'
      : 'Host sweep (<=60s) will wake the container and the agent will send the welcome DM.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
