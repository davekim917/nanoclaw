/**
 * Discord slash commands — administrative surface for managing nanoclaw:
 *   /deploy           — pull main, build, rebuild image if needed, restart
 *   /update-container — rebuild the container image on its own
 *   /update-plugins   — git pull every ~/plugins/<name>
 *
 * Runs a dedicated discord.js Client parallel to @chat-adapter/discord's
 * chat client, gated on ENABLE_DISCORD_SLASH_COMMANDS=1. Scoped via
 * DISCORD_SLASH_CHANNEL_IDS (comma-separated channel ids) so accidental
 * invocations in random channels don't run deploy commands.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';

import { GROUPS_DIR } from '../config.js';
import { log } from '../log.js';

const execFileAsync = promisify(execFile);

const COMMANDS = [
  { name: 'deploy', description: 'Pull, build, and restart NanoClaw v2 from dave/migration' },
  { name: 'update-container', description: 'Rebuild the v2 agent container image now' },
  { name: 'update-plugins', description: 'Run git pull on all ~/plugins repos now' },
];

let client: Client | null = null;

/**
 * Register guild-scoped slash commands with Discord.
 * Idempotent — re-running just overwrites the set.
 */
async function registerCommands(botToken: string, clientId: string, guildId: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(botToken);
  try {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: COMMANDS });
    log.info('Discord slash commands registered', { guildId, count: COMMANDS.length });
  } catch (err) {
    log.error('Failed to register Discord slash commands', { err });
  }
}

/**
 * Whitelist of channel ids where /deploy, /update-container,
 * /update-plugins are allowed. Gate keeps accidental deploys out of
 * random channels. Parent channels of threads are also honored.
 */
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
  // Thread: allow if the parent channel is whitelisted
  const ch = interaction.channel;
  if (ch && 'isThread' in ch && typeof ch.isThread === 'function' && ch.isThread()) {
    const parentId = (ch as { parentId?: string | null }).parentId;
    if (parentId && ids.has(parentId)) return true;
  }
  return false;
}

/**
 * Spawn a detached script so it survives the service restart. Caller
 * is expected to deferReply first and post completion separately — we
 * cannot wait for the script because it restarts our own process.
 */
function spawnDetached(script: string): void {
  // Using child_process.spawn for detachment. `execFile` doesn't accept
  // `detached` in its options signature the same way.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawn } = require('child_process') as typeof import('child_process');
  const proc = spawn('bash', [script], {
    cwd: path.resolve(GROUPS_DIR, '..'),
    detached: true,
    stdio: 'ignore',
  });
  proc.unref();
}

async function handleDeploy(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({
    content: 'Deploying v2: pulling main, building, restarting…',
  });
  const script = path.resolve(GROUPS_DIR, '..', 'scripts', 'deploy.sh');
  if (!fs.existsSync(script)) {
    await interaction.followUp({ content: `Deploy script missing at ${script}` });
    return;
  }
  spawnDetached(script);
}

async function handleUpdateContainer(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({ content: 'Rebuilding v2 container image…' });
  try {
    await execFileAsync('bash', [path.resolve(GROUPS_DIR, '..', 'container', 'build.sh'), 'v2'], {
      cwd: path.resolve(GROUPS_DIR, '..'),
      timeout: 600_000,
    });
    await interaction.followUp({ content: '✅ Container image rebuilt. New spawns will use nanoclaw-agent:v2.' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await interaction.followUp({ content: `❌ Image rebuild failed: ${msg.slice(0, 500)}` });
  }
}

async function handleUpdatePlugins(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({ content: 'Running git pull on all ~/plugins…' });
  try {
    // Dynamic import to avoid pulling plugin-updater into this module's
    // load path when the slash-command client is disabled.
    const mod = await import('../plugin-updater.js');
    // Trigger a one-off run via the same code path as the cron.
    // No public runOnce; emulate by starting + stopping with a 0-ms delay.
    // Simpler: just shell out directly — same behavior.
    const home = process.env.HOME || '/home/ubuntu';
    const pluginsRoot = path.join(home, 'plugins');
    if (!fs.existsSync(pluginsRoot)) {
      await interaction.followUp({ content: '~/plugins not found.' });
      return;
    }
    const entries = fs.readdirSync(pluginsRoot).filter((e) => {
      const p = path.join(pluginsRoot, e);
      try {
        return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, '.git'));
      } catch {
        return false;
      }
    });
    const results: string[] = [];
    for (const name of entries) {
      try {
        const { stdout } = await execFileAsync('git', ['pull', '--ff-only'], {
          cwd: path.join(pluginsRoot, name),
          timeout: 30_000,
          encoding: 'utf-8',
        });
        results.push(stdout.includes('Already up to date.') ? `${name}: up to date` : `${name}: updated`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push(`${name}: FAILED — ${msg.slice(0, 100)}`);
      }
    }
    void mod; // import is kept for side-effects / module discovery only
    await interaction.followUp({ content: '```\n' + results.join('\n') + '\n```' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await interaction.followUp({ content: `❌ Plugin update failed: ${msg}` });
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
 * Returns whether the client started.
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

  // Minimal intents — no GuildMessages / MessageContent — so we don't
  // duplicate chat events that @chat-adapter/discord's client already
  // handles. Interactions are delivered on Guilds intent alone.
  client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once('clientReady', async () => {
    log.info('Discord slash-command client ready', { username: client?.user?.username });
    const clientId = client?.user?.id;
    if (!clientId) return;
    // Register commands for every guild the bot is in. Guild-scoped so
    // updates propagate in ~seconds (global commands take up to 1h).
    for (const [guildId] of client?.guilds?.cache ?? new Map()) {
      await registerCommands(botToken, clientId, guildId);
    }
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
  if (client) {
    try {
      await client.destroy();
    } catch {
      /* ignore */
    }
    client = null;
  }
}
