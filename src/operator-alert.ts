/**
 * The one way host-originated code tells a human something is wrong.
 *
 * Two delivery paths exist in this install and only one of them works from
 * inside the host process:
 *
 *   - `data/cli.sock` with a `to:` payload. Condemned (#538/#541): a socket
 *     payload becomes an INBOUND event, so the router applies its unknown-sender
 *     gate, the synthetic `system:*` sender is not a known user, and an owner DM
 *     on `unknown_sender_policy = strict` DROPS it — while `sendall()` returns
 *     success. Never use it for an alert.
 *   - The workgroup alert outbox (`scripts/health-sentinel.sh` and friends).
 *     Right for a SHELL unit: it is shipped to Slack by a separate 60s timer
 *     with its own bot token, so it survives nanoclaw-v2 being down, which is
 *     the state those scripts exist to report. Wrong here — the path is
 *     install-private, carried per-unit as `UNIT_ALERT_OUTBOX` in a systemd
 *     drop-in that the nanoclaw-v2 service does not have, so a host-process
 *     writer would need new provisioning to reach it, and an install without a
 *     workgroup outbox would silently get nothing.
 *
 * What is left, and what this is, is the path `storage-pressure-alert.ts`
 * already uses: resolve the owner (falling back to global admins) and deliver
 * OUTBOUND through the live channel adapter. Outbound never meets the
 * unknown-sender gate, needs no configuration beyond the wiring an install
 * already has, and lands in the operator's DM rather than a shared ops channel.
 *
 * Returns whether a human was actually reached, so callers can decide whether
 * to stamp a cooldown on it. A false receipt is what made the health sentinel
 * go quiet for three days; nothing here may repeat that.
 */
import { getDb } from './db/connection.js';
import { getDeliveryAdapter } from './delivery.js';
import { log } from './log.js';
import { ensureUserDm } from './modules/permissions/user-dm.js';
import { scrubSecrets } from './secret-scrubber.js';

export async function notifyOperators(rawText: string, context: Record<string, unknown> = {}): Promise<boolean> {
  // Alerts quote things that failed, and what failed is often agent or command
  // output. `scrubSecrets` is applied on the normal outbound path in
  // delivery.ts, not inside the adapter, so an alert delivered straight through
  // `adapter.deliver` would meet no scrubber. Done once here, in the primitive,
  // rather than trusting each caller to remember.
  const text = scrubSecrets(rawText);
  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('operator-alert: no delivery adapter; alert undelivered', { ...context, text });
    return false;
  }

  let recipients: Array<{ user_id: string }>;
  try {
    recipients = await getDb().all<{ user_id: string }>(
      `SELECT user_id, MIN(CASE role WHEN 'owner' THEN 0 ELSE 1 END) AS priority
           FROM user_roles
          WHERE role = 'owner'
             OR (role = 'admin' AND agent_group_id IS NULL)
          GROUP BY user_id
          ORDER BY priority, user_id`,
    );
  } catch (err) {
    log.warn('operator-alert: cannot resolve recipients; alert undelivered', { ...context, err, text });
    return false;
  }

  if (recipients.length === 0) {
    log.warn('operator-alert: no owner or global administrator to alert', { ...context, text });
    return false;
  }

  // One alert through ONE bot. The owner typically holds a distinct user_id per
  // platform instance, so delivering to every owner/admin row fanned the SAME
  // text out through every wired bot (observed live: one storage-pressure
  // episode -> a DM from every agent). Recipients are ordered owner-first;
  // later rows are failover only.
  for (const recipient of recipients) {
    try {
      const dm = await ensureUserDm(recipient.user_id);
      if (!dm) {
        log.warn('operator-alert: administrator is unreachable', { ...context, userId: recipient.user_id });
        continue;
      }
      // The INSTANCE is load-bearing, not optional decoration. The registry
      // resolves adapters by exact key — `getChannelAdapterExact(instance ??
      // channelType)` — so on a multi-bot install where the owner's DM belongs
      // to a named instance, omitting it looks up a bare `discord`/`slack`
      // adapter that does not exist and the alert is never delivered; where a
      // default sibling does exist, it goes out through the WRONG bot identity.
      //
      // This PR's whole premise is that the existing notification path was
      // undeliverable exactly when it mattered. Dropping the instance here
      // would have shipped a second undeliverable path with a receipt that
      // still said `true` (Codex round 3).
      await adapter.deliver(
        dm.channel_type,
        dm.platform_id,
        null,
        'chat',
        JSON.stringify({ text }),
        undefined,
        dm.instance ?? dm.channel_type,
      );
      return true;
    } catch (err) {
      log.warn('operator-alert: delivery failed', { ...context, userId: recipient.user_id, err });
    }
  }
  log.warn('operator-alert: every recipient failed; alert undelivered', { ...context, text });
  return false;
}
