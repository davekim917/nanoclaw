/**
 * scripts/notify-owner.ts — deliver one host-ops alert to the owner's DM,
 * with a VERIFIED receipt, depending on neither the nanoclaw-v2 host process
 * nor the OneCLI gateway.
 *
 * WHY THIS EXISTS
 * ----------------
 * Three host-ops watchdogs (check-onecli-gateway-fds.sh, health-sentinel.sh,
 * check-onecli-drift.sh) used to "deliver" their alert by writing a `to:`
 * payload to `data/cli.sock`. That socket is the CLI *channel adapter*
 * (src/channels/cli.ts) — a payload with `to:` builds an InboundEvent and
 * calls `routeInbound`. It never posts to the platform directly: it queues a
 * row in the session's inbound.db and wakes a container, which must then
 * spawn and compose a reply before the owner sees anything. Spawn is REFUSED
 * while the OneCLI gateway is unreachable (src/container-runner.ts), so the
 * agent path is undeliverable in exactly the case those watchdogs exist to
 * report. Worse, `sock.sendall()` returns success unconditionally — there is
 * no ack frame on this path — so a script had no way to tell "delivered" from
 * "queued into a hole" (fork #538, #556's review).
 *
 * This script posts directly to Slack's Web API and only reports success on
 * a verified `ok: true` response. It has no dependency on nanoclaw-v2 being
 * up, on a container spawning, or on the OneCLI gateway.
 *
 * Usage:
 *   tsx scripts/notify-owner.ts --title "<title>" --body "<body>"
 *   tsx scripts/notify-owner.ts --title "<title>" --body -   # body from stdin
 *
 * Exit codes (distinct on purpose — shell callers branch on them):
 *   0 — delivered, receipt verified. One safe line on stdout (channel id only).
 *   2 — cannot even try: no owner DM row resolved, the owner's channel type
 *       isn't one this script can post to (Slack only, today), or no bot
 *       token is configured for it. Reason on stderr.
 *   1 — tried and failed: Slack API error, `ok:false`, or a network failure.
 *       Reason on stderr, including Slack's error code when present.
 * A token value is NEVER printed, logged, or included in any exit message.
 */
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import Database from 'better-sqlite3';

import { TIMEZONE } from '../src/config.js';
import { readEnvValue } from '../src/env-file.js';
import { botTokenKeyForChannelType, slackPostMessage } from '../src/channels/slack-lib.js';
import { extractSlackChannelId } from '../src/channels/slack.js';
import { formatLocalStamp } from '../src/timezone.js';

/**
 * This install's root, derived from THIS FILE's location — deliberately not
 * the cwd-derived paths in `src/config.ts` (`PROJECT_ROOT = process.cwd()`,
 * config.ts:60). Every caller happens to `cd` first, but an alerting
 * primitive must not read a different install's central DB or `.env`
 * because someone invoked it from elsewhere: the failure mode is a silent
 * exit 2 ("no owner DM") at the exact moment an alert matters.
 */
const INSTALL_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const OWNER_DB_PATH = path.join(INSTALL_ROOT, 'data', 'v2.db');

export interface OwnerDm {
  platformId: string;
  channelType: string;
}

/**
 * Most recent owner DM row, or null when none has been resolved yet.
 * Read-only; never creates or migrates the DB — a missing/unreadable file
 * throws, which the caller treats the same as "no row" (exit 2, can't try).
 */
export function resolveOwnerDm(dbPath: string): OwnerDm | null {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(
        `SELECT mg.platform_id AS platformId, ud.channel_type AS channelType
           FROM user_roles ur
           JOIN user_dms ud ON ud.user_id = ur.user_id
           JOIN messaging_groups mg ON mg.id = ud.messaging_group_id
          WHERE ur.role = 'owner'
          ORDER BY ud.resolved_at DESC
          LIMIT 1`,
      )
      .get() as OwnerDm | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}

/** Whether this channel type is one this script can post to. Slack only, today. */
function isSlackChannelType(channelType: string): boolean {
  return channelType === 'slack' || channelType.startsWith('slack-');
}

export interface NotifyResult {
  code: 0 | 1 | 2;
  /** stdout line on 0 (safe: names the channel, never the token); stderr reason on 1/2. */
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

/** Core delivery logic, exported for tests. Never throws — every failure mode returns a NotifyResult. */
export async function notifyOwner(opts: NotifyOwnerOptions): Promise<NotifyResult> {
  const dbPath = opts.dbPath ?? OWNER_DB_PATH;
  const rootDir = opts.rootDir ?? INSTALL_ROOT;
  const timezone = opts.timezone ?? TIMEZONE;
  const now = opts.now ?? new Date();

  let owner: OwnerDm | null;
  try {
    owner = resolveOwnerDm(dbPath);
  } catch (err) {
    return {
      code: 2,
      message: `could not read the owner DM from ${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!owner) return { code: 2, message: 'no owner DM resolved in user_dms — nobody to notify' };

  if (!isSlackChannelType(owner.channelType)) {
    return {
      code: 2,
      message: `owner DM channel type '${owner.channelType}' is not one this script can post to (Slack only, today)`,
    };
  }

  const tokenKey = botTokenKeyForChannelType(owner.channelType);
  const token = readEnvValue(rootDir, tokenKey);
  if (!token) return { code: 2, message: `no ${tokenKey} configured — cannot post to the owner DM` };

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

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function parseArgs(argv: string[]): { title: string; body: string } {
  let title: string | undefined;
  let body: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--title') title = argv[++i];
    else if (argv[i] === '--body') body = argv[++i];
  }
  if (title === undefined || body === undefined) {
    throw new Error('Usage: tsx scripts/notify-owner.ts --title "<title>" --body "<body>" (or --body - for stdin)');
  }
  return { title, body };
}

async function main(): Promise<number> {
  let title: string, bodyArg: string;
  try {
    ({ title, body: bodyArg } = parseArgs(process.argv.slice(2)));
  } catch (err) {
    // Malformed invocation is "cannot even try" too — same bucket as no
    // owner row / no token, so shell callers see one consistent shape.
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const body = bodyArg === '-' ? await readStdin() : bodyArg;
  const result = await notifyOwner({ title, body });
  if (result.code === 0) console.log(result.message);
  else console.error(result.message);
  return result.code;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
