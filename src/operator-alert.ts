/**
 * The one way host-originated code tells a human something is wrong: resolve the owner (then global admins) and
 * deliver OUTBOUND through the live adapter. Never via `data/cli.sock` (an inbound event, which an owner DM on
 * `unknown_sender_policy = strict` drops while `sendall()` reports success), nor the shell units' alert outbox (not
 * provisioned for the service). Returns whether a human was actually reached; callers stamp cooldowns on it.
 */
import { getDb } from './db/connection.js';
import { getDeliveryAdapter } from './delivery.js';
import { log } from './log.js';
import { ensureUserDm } from './modules/permissions/user-dm.js';
import { scrubSecrets } from './secret-scrubber.js';

/**
 * Deadline for the whole call, and the cap on each network step. Callers are sweep duties: a hung adapter would pin
 * the session in the sweep's running set, and slow recipients in series could pass the tick's stall ceiling
 * (`SWEEP_TICK_STALL_MS`). A literal, not an import, to avoid a cycle; `scheduling.test.ts` pins the relation. The
 * step cap lets failover reach the next recipient. A false timeout risks only a duplicate alert.
 */
export const OPERATOR_ALERT_DEADLINE_MS = 60_000;
export const OPERATOR_ALERT_STEP_TIMEOUT_MS = 20_000;

/** Reject after `ms` so the recipient loop's `catch` treats a hang like a throw. */
function bounded<T>(step: string, work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`operator-alert: ${step} did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export async function notifyOperators(rawText: string, context: Record<string, unknown> = {}): Promise<boolean> {
  // Alerts quote failed output; `adapter.deliver` bypasses delivery.ts's scrubber, so scrub here.
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

  // One alert through ONE bot: the owner has a user_id per platform instance, so later rows are failover only.
  const deadlineMs = Date.now() + OPERATOR_ALERT_DEADLINE_MS;
  const stepMs = (): number => Math.min(OPERATOR_ALERT_STEP_TIMEOUT_MS, deadlineMs - Date.now());
  for (const recipient of recipients) {
    if (stepMs() <= 0) {
      log.warn('operator-alert: deadline passed before every recipient was tried; alert undelivered', {
        ...context,
        deadlineMs: OPERATOR_ALERT_DEADLINE_MS,
        text,
      });
      return false;
    }
    try {
      const dm = await bounded('DM resolution', ensureUserDm(recipient.user_id), stepMs());
      if (!dm) {
        log.warn('operator-alert: administrator is unreachable', { ...context, userId: recipient.user_id });
        continue;
      }
      // The instance is load-bearing: adapters resolve by exact key, so omitting it on a multi-bot install finds no
      // adapter, or sends through the wrong bot identity. Never start a send with no time left: an abandoned send can
      // still land, and the caller would alert again on top of it.
      if (stepMs() <= 0) continue;
      await bounded(
        'delivery',
        adapter.deliver(
          dm.channel_type,
          dm.platform_id,
          null,
          'chat',
          JSON.stringify({ text }),
          undefined,
          dm.instance ?? dm.channel_type,
        ),
        stepMs(),
      );
      return true;
    } catch (err) {
      log.warn('operator-alert: delivery failed', { ...context, userId: recipient.user_id, err });
    }
  }
  log.warn('operator-alert: every recipient failed; alert undelivered', { ...context, text });
  return false;
}
