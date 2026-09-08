/**
 * src/notify-owner.ts — deliver one host-ops alert to the owner's DM, with a
 * VERIFIED receipt, depending on neither the nanoclaw-v2 host process nor the
 * OneCLI gateway.
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
 * This module posts directly to Slack's Web API and only reports success on
 * a verified `ok: true` response. It has no dependency on nanoclaw-v2 being
 * up, on a container spawning, or on the OneCLI gateway.
 *
 * The CLI entry point (arg parsing, stdin, exit-code mapping) lives in
 * scripts/notify-owner.ts, which imports the core from here. This half is in
 * `src/` — not `scripts/` — because `dist/` compiles `src/**` only
 * (tsconfig.json), and src/main.ts needs to call `notifyOwner` at boot
 * (build-drift detection) without reaching outside the compiled tree.
 *
 * Usage (CLI):
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
import { fileURLToPath } from 'url';

import Database from 'better-sqlite3';

import { readEnvValue } from './env-file.js';
import { botTokenKeyForChannelType, slackPostMessage } from './channels/slack-lib.js';
import { extractSlackChannelId } from './channels/slack.js';
import { formatLocalStamp, isValidTimezone } from './timezone.js';

/**
 * This install's root, derived from THIS FILE's location — deliberately not
 * the cwd-derived paths in `src/config.ts` (`PROJECT_ROOT = process.cwd()`,
 * config.ts:60). Every caller happens to `cd` first, but an alerting
 * primitive must not read a different install's central DB or `.env`
 * because someone invoked it from elsewhere: the failure mode is a silent
 * exit 2 ("no owner DM") at the exact moment an alert matters.
 *
 * `src/` sits at the same depth as `scripts/` (both one level below the
 * repo root), so the two `'..'` segments resolve to the repo root the same
 * way regardless of which of the two this file lives in.
 */
const INSTALL_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const OWNER_DB_PATH = path.join(INSTALL_ROOT, 'data', 'v2.db');

export interface OwnerDm {
  platformId: string;
  channelType: string;
}

/**
 * Every resolved owner DM, newest first — not just the newest one. An owner
 * can have DMs cached on several platforms and several Slack instances (this
 * install has seven), and taking only `LIMIT 1` means one unusable row — a
 * non-Slack platform, or a Slack instance whose token is not configured —
 * silences the alert even though a perfectly good DM sits behind it.
 * Read-only; never creates or migrates the DB.
 */
export function resolveOwnerDms(dbPath: string): OwnerDm[] {
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

/**
 * The install timezone, resolved from THIS install's `.env` rather than
 * `src/config.ts`'s `TIMEZONE`, which is a module-level constant built from
 * `process.cwd()` at import time. Same precedence and the same exported
 * validator as `resolveConfigTimezone` (config.ts:228) — only the `.env` it
 * reads differs. config.ts is upstream-owned, so parameterizing it there
 * would grow the divergence ratchet for a two-caller helper.
 */
export function resolveInstallTimezone(rootDir: string): string {
  const candidates = [process.env.TZ, readEnvValue(rootDir, 'TZ'), Intl.DateTimeFormat().resolvedOptions().timeZone];
  for (const tz of candidates) if (tz && isValidTimezone(tz)) return tz;
  return 'UTC';
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

  // Walk the candidates newest-first and take the first one we can actually
  // post to. Giving up on the newest row alone would let one unusable DM mute
  // an alert that a later row could have carried.
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
