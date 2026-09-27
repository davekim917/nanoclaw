/**
 * Deliver one host-ops alert to the owner's Slack DM with a VERIFIED `ok: true` receipt, depending on neither the
 * nanoclaw-v2 host nor the OneCLI gateway. `data/cli.sock` cannot do this: it queues an inbound message whose reply
 * needs a container spawn, which is refused while the gateway is down, and `sendall()` reports success regardless.
 * CLI: scripts/notify-owner.ts; exit 0 delivered, 2 cannot try (no owner DM, non-Slack, no token), 1 tried and
 * failed. A token value is NEVER printed or logged.
 */
import path from 'path';
import { fileURLToPath } from 'url';

import Database from 'better-sqlite3';

import { readEnvValue } from './env-file.js';
import { botTokenKeyForChannelType, slackPostMessage } from './channels/slack-lib.js';
import { extractSlackChannelId } from './channels/slack.js';
import { formatLocalStamp, isValidTimezone } from './timezone.js';

/**
 * From THIS FILE's location, not `src/config.ts`'s cwd-derived paths: invoked from elsewhere, an alerting primitive
 * would read another install's DB and exit 2 exactly when the alert matters.
 */
export const INSTALL_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
export const OWNER_DB_PATH = path.join(INSTALL_ROOT, 'data', 'v2.db');

interface OwnerDm {
  platformId: string;
  channelType: string;
}

/** Every owner DM, newest first: one unusable row (non-Slack, no token) must not silence the alert. Read-only. */
function resolveOwnerDms(dbPath: string): OwnerDm[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(
        `SELECT mg.platform_id AS platformId, ud.channel_type AS channelType
           FROM user_roles ur
           JOIN user_dms ud ON ud.user_id = ur.user_id
           JOIN messaging_groups mg ON mg.id = ud.messaging_group_id
          WHERE ur.role = 'owner'
          ORDER BY ud.resolved_at DESC`,
      )
      .all() as OwnerDm[];
  } finally {
    db.close();
  }
}

/** The install timezone from THIS install's `.env`, with `resolveConfigTimezone`'s precedence and validator. */
function resolveInstallTimezone(rootDir: string): string {
  const candidates = [process.env.TZ, readEnvValue(rootDir, 'TZ'), Intl.DateTimeFormat().resolvedOptions().timeZone];
  for (const tz of candidates) if (tz && isValidTimezone(tz)) return tz;
  return 'UTC';
}

function isSlackChannelType(channelType: string): boolean {
  return channelType === 'slack' || channelType.startsWith('slack-');
}

export interface NotifyResult {
  code: 0 | 1 | 2;
  message: string;
}

export interface NotifyOwnerOptions {
  title: string;
  body: string;
  dbPath?: string;
  rootDir?: string;
  timezone?: string;
  now?: Date;
}

/** Never throws: every failure mode returns a NotifyResult. */
export async function notifyOwner(opts: NotifyOwnerOptions): Promise<NotifyResult> {
  const dbPath = opts.dbPath ?? OWNER_DB_PATH;
  const rootDir = opts.rootDir ?? INSTALL_ROOT;
  const timezone = opts.timezone ?? resolveInstallTimezone(rootDir);
  const now = opts.now ?? new Date();

  let owners: OwnerDm[];
  try {
    owners = resolveOwnerDms(dbPath);
  } catch (err) {
    return {
      code: 2,
      message: `could not read the owner DM from ${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (owners.length === 0) return { code: 2, message: 'no owner DM resolved in user_dms — nobody to notify' };

  let owner: OwnerDm | undefined;
  let token: string | undefined;
  const skipped: string[] = [];
  for (const candidate of owners) {
    if (!isSlackChannelType(candidate.channelType)) {
      skipped.push(`${candidate.channelType} (not a platform this script can post to)`);
      continue;
    }
    const key = botTokenKeyForChannelType(candidate.channelType);
    const value = readEnvValue(rootDir, key);
    if (!value) {
      skipped.push(`${candidate.channelType} (no ${key} configured)`);
      continue;
    }
    owner = candidate;
    token = value;
    break;
  }
  if (!owner || !token) {
    return {
      code: 2,
      message: `no reachable owner DM among ${owners.length} candidate(s): ${skipped.join('; ')}`,
    };
  }

  const channelId = extractSlackChannelId(owner.platformId);
  const stamp = formatLocalStamp(now, timezone);
  const text = `*${opts.title}* (${stamp})\n\n${opts.body}`;

  try {
    await slackPostMessage(token, channelId, text, 'notify-owner');
  } catch (err) {
    return { code: 1, message: err instanceof Error ? err.message : String(err) };
  }

  return { code: 0, message: `delivered to ${owner.channelType}:${channelId}` };
}
