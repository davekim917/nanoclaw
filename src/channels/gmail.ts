import fs from 'fs';
import os from 'os';
import path from 'path';

import { google } from 'googleapis';

import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';

interface GmailAccount {
  label: string;
  email: string;
}

/**
 * Multi-account Gmail channel (digest mode).
 * Connects and validates all accounts at startup but does not poll.
 * Email recaps are handled by daily scheduled tasks using Gmail MCP tools
 * in the container agent.
 */
export class GmailChannel implements Channel {
  name = 'gmail';

  private accounts: GmailAccount[] = [];

  constructor(_opts: ChannelOpts) {}

  async connect(): Promise<void> {
    const homeDir = os.homedir();
    const credDirs = discoverCredentialDirs(homeDir);

    if (credDirs.length === 0) {
      logger.warn(
        'Gmail: no credential directories found (~/.gmail-mcp*). Skipping.',
      );
      return;
    }

    const results = await Promise.allSettled(
      credDirs.map(({ label, credDir }) => this.connectAccount(label, credDir)),
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        this.accounts.push(result.value);
      } else if (result.status === 'rejected') {
        logger.error({ err: result.reason }, 'Failed to connect Gmail account');
      }
    }

    if (this.accounts.length === 0) {
      logger.warn('Gmail: no accounts connected');
      return;
    }

    logger.info(
      {
        accountCount: this.accounts.length,
        emails: this.accounts.map((a) => a.email),
      },
      'Gmail channel connected (daily digest mode)',
    );
  }

  async sendMessage(): Promise<void> {
    // Replies are handled by Gmail MCP tools in the container agent
  }

  isConnected(): boolean {
    return this.accounts.length > 0;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('gmail:');
  }

  async disconnect(): Promise<void> {
    this.accounts = [];
    logger.info('Gmail channel stopped');
  }

  // --- Private ---

  private async connectAccount(
    label: string,
    credDir: string,
  ): Promise<GmailAccount | null> {
    const keysPath = path.join(credDir, 'gcp-oauth.keys.json');
    const tokensPath = path.join(credDir, 'credentials.json');

    if (!fs.existsSync(keysPath) || !fs.existsSync(tokensPath)) {
      logger.debug(
        { label, credDir },
        'Gmail credentials incomplete, skipping',
      );
      return null;
    }

    const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
    const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));

    const clientConfig = keys.installed || keys.web || keys;
    const { client_id, client_secret, redirect_uris } = clientConfig;
    const oauth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris?.[0],
    );
    oauth2Client.setCredentials(tokens);

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Verify connection and retrieve email
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress || '';
    logger.info({ label, email }, 'Gmail account connected');

    return { label, email };
  }
}

/**
 * Discover all Gmail credential directories.
 * Looks for ~/.gmail-mcp (primary) and ~/.gmail-mcp-* (additional accounts).
 */
function discoverCredentialDirs(
  homeDir: string,
): { label: string; credDir: string }[] {
  const results: { label: string; credDir: string }[] = [];

  // Primary account
  const primaryDir = path.join(homeDir, '.gmail-mcp');
  if (
    fs.existsSync(path.join(primaryDir, 'gcp-oauth.keys.json')) &&
    fs.existsSync(path.join(primaryDir, 'credentials.json'))
  ) {
    results.push({ label: 'primary', credDir: primaryDir });
  }

  // Additional accounts: ~/.gmail-mcp-*
  try {
    const entries = fs.readdirSync(homeDir);
    for (const entry of entries) {
      if (!entry.startsWith('.gmail-mcp-')) continue;
      const suffix = entry.replace('.gmail-mcp-', '');
      const dir = path.join(homeDir, entry);
      if (!fs.statSync(dir).isDirectory()) continue;
      if (
        !fs.existsSync(path.join(dir, 'gcp-oauth.keys.json')) ||
        !fs.existsSync(path.join(dir, 'credentials.json'))
      ) {
        continue;
      }
      results.push({ label: suffix, credDir: dir });
    }
  } catch {
    // ignore readdir errors
  }

  return results;
}

registerChannel('gmail', (opts: ChannelOpts) => new GmailChannel(opts));
