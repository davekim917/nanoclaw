/**
 * Discord slash commands — administrative surface for managing nanoclaw:
 *   /deploy           — pull main, build, rebuild image if needed, restart
 *   /update-container — audit repository dependency drift, agent opens PRs
 *   /update-plugins   — git pull every ~/plugins/<name>
 *
 * Runs a dedicated discord.js Client parallel to @chat-adapter/discord's
 * chat client, gated on ENABLE_DISCORD_SLASH_COMMANDS=1. Scoped via
 * DISCORD_SLASH_CHANNEL_IDS (comma-separated channel ids) so accidental
 * invocations in random channels don't run deploy commands.
 *
 * Multi-bot note: slash commands are bound to the PRIMARY DISCORD_BOT_TOKEN
 * only — these are operator/admin commands and shouldn't be duplicated
 * across secondary bots (e.g. an "example-agent-codex" bot). Secondary bots
 * registered via DISCORD_BOT_TOKEN_<SUFFIX> still receive @mentions through
 * the chat adapter but don't expose /deploy etc.
 *
 * /update-container injects a synthetic chat message into the router
 * (routeInbound) carrying an audit prompt. The agent (running in a
 * container for the receiving messaging group) invokes the shared deterministic
 * audit/apply CLI, asks which exact items to bump, and keeps host, container,
 * and bootstrap changes in separate approval and activation boundaries.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  type ChatInputCommandInteraction,
  type Interaction,
  type TextChannel,
} from 'discord.js';

import { REPO_ROOT } from '../config.js';
import { startContainerRebuildWatcher, stopContainerRebuildWatcher } from '../container-rebuild-watcher.js';
import { log } from '../log.js';
import { runPluginUpdates } from '../plugin-updater.js';
import { routeInbound } from '../router.js';

const COMMANDS = [
  { name: 'deploy', description: 'Pull, build, and restart NanoClaw v2 from main' },
  { name: 'update-container', description: 'Audit stable dependency drift and open reviewed PRs' },
  { name: 'update-plugins', description: 'Run git pull on all ~/plugins repos now' },
];

const DEPLOY_SCRIPT = path.resolve(REPO_ROOT, 'scripts', 'deploy.sh');
const DEPLOY_LOG = path.resolve(REPO_ROOT, 'logs', 'deploy.log');
const DEPLOY_STATUS = path.resolve(REPO_ROOT, 'logs', 'deploy-status.json');
let client: Client | null = null;

async function registerCommands(botToken: string, clientId: string, guildId: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(botToken);
  try {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: COMMANDS });
    log.info('Discord slash commands registered', { guildId, count: COMMANDS.length });
  } catch (err) {
    log.error('Failed to register Discord slash commands', { err });
  }
}

function allowedChannels(): Set<string> {
  const raw = process.env.DISCORD_SLASH_CHANNEL_IDS || '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function channelIsAllowed(interaction: ChatInputCommandInteraction): boolean {
  const ids = allowedChannels();
  if (ids.size === 0) return false;
  if (interaction.channelId && ids.has(interaction.channelId)) return true;
  const ch = interaction.channel;
  if (ch && 'isThread' in ch && typeof ch.isThread === 'function' && ch.isThread()) {
    const parentId = (ch as { parentId?: string | null }).parentId;
    if (parentId && ids.has(parentId)) return true;
  }
  return false;
}

function deployChannelId(): string | null {
  const explicit = process.env.DISCORD_DEPLOY_CHANNEL_ID?.trim();
  if (explicit) return explicit;
  const ids = allowedChannels();
  const first = ids.values().next().value;
  return first ?? null;
}

/**
 * Get the parent channel id for thread interactions, or the channel id
 * itself when not in a thread. Injected synthetic messages must route to
 * the parent channel (threads on the Discord side aren't first-class to
 * the router today — messages land on the parent messaging_group).
 */
function getInteractionParentId(interaction: ChatInputCommandInteraction): string | null {
  const ch = interaction.channel;
  if (ch && 'isThread' in ch && typeof ch.isThread === 'function' && ch.isThread()) {
    return (ch as { parentId?: string | null }).parentId ?? null;
  }
  return interaction.channelId ?? null;
}

function spawnDetachedLogged(script: string): void {
  const logFd = fs.openSync(DEPLOY_LOG, 'a');
  const child = spawn('bash', [script], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);
  log.info('Detached deploy spawned', { pid: child.pid });
}

interface DeployStatus {
  status?: 'ok' | 'failed';
  step?: string;
  error?: string;
  mtimeMs: number;
}

function readDeployStatus(): DeployStatus | null {
  try {
    const raw = fs.readFileSync(DEPLOY_STATUS, 'utf-8');
    const { mtimeMs } = fs.statSync(DEPLOY_STATUS);
    return { ...(JSON.parse(raw) as Omit<DeployStatus, 'mtimeMs'>), mtimeMs };
  } catch {
    return null;
  }
}

function consumeDeployStatus(): void {
  try {
    fs.unlinkSync(DEPLOY_STATUS);
  } catch {
    /* ignore — racy unlink is fine */
  }
}

function formatFailure(status: DeployStatus): string {
  return `Deploy failed at **${status.step ?? 'unknown'}**: ${status.error ?? 'no detail'}`;
}

/**
 * Poll deploy-status.json for pre-restart failures. If deploy succeeds,
 * the service restarts mid-poll — announceDeployStatus on the next boot
 * picks up the "ok" status and posts success.
 */
function pollDeployStatus(interaction: ChatInputCommandInteraction): void {
  const startTime = Date.now();
  let stopped = false;

  const poll = async (): Promise<void> => {
    if (stopped) return;
    const status = readDeployStatus();
    if (status && status.mtimeMs >= startTime) {
      if (status.status === 'failed') {
        stopped = true;
        await interaction.followUp({ content: formatFailure(status) });
        consumeDeployStatus();
        return;
      }
      if (status.status === 'ok') {
        stopped = true;
        return;
      }
    }
    if (Date.now() - startTime > 120_000) {
      stopped = true;
      return;
    }
    setTimeout(() => void poll(), 2_000);
  };
  setTimeout(() => void poll(), 2_000);
}

/**
 * One-shot at boot: if deploy-status.json was written in the last 5 min,
 * post the outcome (paired with pollDeployStatus which catches failures
 * *before* restart).
 */
async function announceDeployStatus(): Promise<void> {
  const status = readDeployStatus();
  if (!status) return;
  if (Date.now() - status.mtimeMs > 300_000) return;
  const channelId = deployChannelId();
  if (!channelId) return;
  const textChannel = await getTextChannel(channelId);
  if (!textChannel) return;
  if (status.status === 'ok') {
    await textChannel.send('Deploy complete — service is up.');
  } else if (status.status === 'failed') {
    await textChannel.send(formatFailure(status));
  }
  consumeDeployStatus();
}

async function getTextChannel(channelId: string): Promise<TextChannel | null> {
  if (!client) return null;
  try {
    const ch = await client.channels.fetch(channelId);
    if (!ch || !('send' in ch)) return null;
    return ch as TextChannel;
  } catch {
    return null;
  }
}

async function handleDeploy(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({ content: 'Deploying v2: pulling main, building, restarting…' });
  if (!fs.existsSync(DEPLOY_SCRIPT)) {
    await interaction.followUp({ content: `Deploy script missing at ${DEPLOY_SCRIPT}` });
    return;
  }
  spawnDetachedLogged(DEPLOY_SCRIPT);
  pollDeployStatus(interaction);
}

async function handleUpdatePlugins(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({ content: 'Running git pull on all ~/plugins…' });
  try {
    const results = await runPluginUpdates();
    if (results.length === 0) {
      await interaction.followUp({ content: 'No plugins found in ~/plugins.' });
      return;
    }
    const lines = results.map((r) => {
      if (r.error) return `✗ ${r.plugin}: ${r.error}`;
      return r.changed ? `↑ ${r.plugin}: updated` : `· ${r.plugin}: up to date`;
    });
    const changedCount = results.filter((r) => r.changed).length;
    const errCount = results.filter((r) => r.error).length;
    const summary = `${changedCount} updated, ${errCount} failed, ${results.length - changedCount - errCount} up to date`;
    const body = [summary, '', ...lines].join('\n').slice(0, 1900);
    await interaction.followUp({ content: `\`\`\`\n${body}\n\`\`\`` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await interaction.followUp({ content: `Plugin update failed: ${msg.slice(0, 1800)}` });
  }
}

export const UPDATE_CONTAINER_PROMPT = [
  'Run the deterministic repository update audit with:',
  '`bun /workspace/project/scripts/container-updates.ts audit --format json`',
  '',
  'Treat the JSON as the source of truth. Do not parse Dockerfiles, package manifests, registries, or upstream tables yourself.',
  'If every item is current, reply with one concise no-op result and stop.',
  'If any item is unknown or blocked, report the exact diagnostic; never call it current and never apply it.',
  '',
  'Present outdated items grouped by activation boundary:',
  '- host: host package.json/pnpm-lock changes; these require the host deploy flow after manual merge.',
  '- container: Docker pins, agent-runner Bun dependencies, and Graphify; these require an image rebuild after manual merge.',
  '- bootstrap: Codex-synced files; these belong in a separate bootstrap-repository PR.',
  'Latest stable includes major versions. Show the exact item IDs and ask which IDs to update. This is the approval gate; do not clone, edit, branch, commit, push, or open a PR before the user answers.',
  '',
  // Added after @onecli-sh/sdk ^0.5.0 -> ^2.8.0 (#135) took the whole fleet down
  // on 2026-07-25. That bump passed every gate the prompt asked for: it touched
  // only package.json + pnpm-lock.yaml, build and tests were green, and the
  // method names the host calls were unchanged across both majors. Only the HTTP
  // path moved (/api -> /v1), against a gateway that serves only /api. Two
  // reporting duties exist because of it:
  'The audit derives these three itself — read the fields, do not re-derive them with git:',
  "- `upstreamPin` is that dependency's pin in `upstream/main`. Report it NEXT TO latest-stable and say explicitly when they differ. For anything exact-pinned, upstream parity is the DEFAULT recommendation and latest-stable is the exception: an exact pin is usually load-bearing, and upstream is the strongest evidence about what a version is compatible with. Never present latest-stable as the only option.",
  '- `heldByMerge: true` means the last upstream merge resolved that dependency KEEP-OURS — it kept our pin over a different upstream one. That is a standing decision. Report it as HELD and do not propose moving past it without saying so explicitly and asking. It is stronger than upstream parity: in #135 upstream 2.2.1 was ALSO incompatible with our gateway, so parity alone would not have caught it.',
  '- `pairedWith` names a locally-running component that must move in the SAME change. These CANNOT be validated by compiling — client and server share a wire contract no type or unit test sees, so a version-skewed pair type-checks perfectly and fails at the first real call. Treat the pair as one item, approved or skipped together; never bundle it into a bulk bump.',
  'Absence of these fields is not evidence of parity: the derivation fails OPEN, so a missing `upstreamPin` can equally mean no upstream remote or a shallow clone. If none of the items carry one, say the signal was unavailable rather than reporting parity.',
  '',
  'After approval, create writable clones. Never edit /workspace/project in place.',
  'Keep host and container changes in separate NanoClaw PRs because their activation and rollback boundaries differ. Keep bootstrap changes in a separate bootstrap PR.',
  'In each NanoClaw clone, rerun the audit, then apply only the approved IDs:',
  '`bun scripts/container-updates.ts apply --repo <clone> --items <comma-separated-ids>`',
  'If Graphify fails its installed-engine behavior contract, or the temporary compatibility patch no longer repairs it, stop and route it to a dedicated Graphify-review PR.',
  '',
  'Validate before publishing:',
  '- host: `pnpm install --frozen-lockfile && pnpm run build && pnpm test`, plus `pnpm run lint` and `pnpm run format:check` — CI runs format:check, and the pre-commit hook would otherwise leak an unrelated reformat into the next PR.',
  '- client/server pairs: a LIVE call against the running service, not a compile. For the OneCLI SDK that means constructing the client the way `src/container-runner.ts` does and invoking a real method; a green build proves nothing about the wire contract. If you cannot make that call, say so and mark the item unverified rather than validated.',
  '- container: `cd container/agent-runner && bun install --frozen-lockfile && bun test`, then from the repo root run `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` and the Graphify Python contracts when Graphify changed.',
  '- Graphify: require the installed-engine behavior, supply-chain, and runtime acceptance checks before publishing.',
  // No models-cache reset here on purpose. ~/.codex/models_cache.json carries no
  // client-version gate (0 occurrences in the payload) and self-revalidates by
  // ETag, so a cache still stamped with the old client_version already serves the
  // current model list. Resetting it was folklore. Host parity stays: the host
  // runs its own codex for `codex plugin marketplace upgrade` (plugin-updater.ts)
  // and the Graphify codex backend, and the operator works in it directly.
  '- Codex CLI: put the exact host-parity installation command in the PR checklist. Do not add a models-cache reset.',
  'Show the final diff before committing. Commit and push only the validated, approved files, open the PR against davekim917/nanoclaw (or davekim917/bootstrap), verify the PR URL is in the intended repository, then stop.',
  'Never merge, deploy, restart services, or build Docker from inside the agent container.',
].join('\n');

async function handleUpdateContainer(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.channel && 'isThread' in interaction.channel && interaction.channel.isThread()) {
    await interaction.reply({
      content: 'Run /update-container in the parent channel, not inside a thread.',
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({ content: 'Auditing container packages and synced upstream files…' });
  const reply = await interaction.fetchReply();

  const parentChannelId = getInteractionParentId(interaction);
  if (!parentChannelId) {
    await interaction.followUp({ content: 'Could not resolve channel id for injection.' });
    return;
  }
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.followUp({ content: '/update-container must be run in a guild channel, not a DM.' });
    return;
  }
  // Discord chat-sdk adapter format: bare snowflakes fail downstream with
  // "Invalid Discord thread ID".
  const encodeId = (...parts: string[]): string => ['discord', guildId, parentChannelId, ...parts].join(':');
  const platformId = encodeId();

  // In-thread mention-sticky engages without @mention, so the user can just
  // reply "yes" inside the audit thread.
  const AUTO_ARCHIVE_24H = 1440;
  let threadId: string | null = null;
  try {
    const thread = await reply.startThread({ name: 'Container update', autoArchiveDuration: AUTO_ARCHIVE_24H });
    threadId = encodeId(thread.id);
  } catch (err) {
    log.warn('Failed to open audit thread, falling back to channel root', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const syntheticId = `slash-update-container-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const content = {
    text: UPDATE_CONTAINER_PROMPT,
    sender: interaction.user.username,
    senderId: interaction.user.id,
    senderName: interaction.user.username,
    isMention: true,
  };

  try {
    await routeInbound({
      channelType: 'discord',
      platformId,
      threadId,
      message: {
        id: syntheticId,
        kind: 'chat-sdk',
        content: JSON.stringify(content),
        timestamp: new Date().toISOString(),
        isMention: true,
      },
    });
  } catch (err) {
    log.error('/update-container injection failed', { err });
    await interaction.followUp({
      content: `Failed to start audit: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

async function onInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;

  if (!channelIsAllowed(interaction)) {
    await interaction.reply({
      content: 'This channel is not in `DISCORD_SLASH_CHANNEL_IDS`. Admin commands are scoped.',
      ephemeral: true,
    });
    return;
  }

  try {
    if (interaction.commandName === 'deploy') await handleDeploy(interaction);
    else if (interaction.commandName === 'update-container') await handleUpdateContainer(interaction);
    else if (interaction.commandName === 'update-plugins') await handleUpdatePlugins(interaction);
    else {
      await interaction.reply({ content: `Unknown command: ${interaction.commandName}`, ephemeral: true });
    }
  } catch (err) {
    log.error('Slash command handler threw', { command: interaction.commandName, err });
    try {
      await interaction.followUp({
        content: `Handler error: ${err instanceof Error ? err.message : String(err)}`,
        ephemeral: true,
      });
    } catch {
      /* already replied / no channel */
    }
  }
}

/**
 * Start the slash-command client. No-op unless
 * ENABLE_DISCORD_SLASH_COMMANDS=1 AND DISCORD_BOT_TOKEN is set.
 * Also boots the container-rebuild watcher (which pushes rebuild-complete
 * notifications into the deploy channel).
 */
export async function startDiscordSlashCommands(): Promise<boolean> {
  if (process.env.ENABLE_DISCORD_SLASH_COMMANDS !== '1') {
    log.debug('Discord slash commands disabled — ENABLE_DISCORD_SLASH_COMMANDS != 1');
    return false;
  }
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) {
    log.warn('Discord slash commands: DISCORD_BOT_TOKEN not set');
    return false;
  }

  client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once('clientReady', async () => {
    log.info('Discord slash-command client ready', { username: client?.user?.username });
    const clientId = client?.user?.id;
    if (clientId) {
      for (const [guildId] of client?.guilds?.cache ?? new Map()) {
        await registerCommands(botToken, clientId, guildId);
      }
    }
    await announceDeployStatus();
    startContainerRebuildWatcher(async (message: string) => {
      const channelId = deployChannelId();
      if (!channelId) return;
      const textChannel = await getTextChannel(channelId);
      if (textChannel) {
        await textChannel.send(message);
      }
    });
  });

  client.on('interactionCreate', (interaction) => {
    onInteraction(interaction).catch((err) => {
      log.error('Unhandled slash-command error', { err });
    });
  });

  await client.login(botToken);
  return true;
}

export async function stopDiscordSlashCommands(): Promise<void> {
  stopContainerRebuildWatcher();
  if (client) {
    try {
      await client.destroy();
    } catch {
      /* ignore */
    }
    client = null;
  }
}
