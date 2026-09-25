/**
 * The one way host-originated code tells a human something is wrong.
 *
 * Two delivery paths exist in this install and only one of them works from
 * inside the host process:
 *
 *   - `data/cli.sock` with a `to:` payload. Condemned: a socket
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

/**
 * The whole call's deadline, and the cap on any one network step inside it.
 *
 * Every caller is a sweep duty awaiting this from inside a per-session or tick
 * window. An adapter promise that never settles would hold that window open for
 * good — the session stays in the driver's running set and every later tick
 * skips it (`sessionsRunning` in host-sweep) — and merely SLOW
 * recipients, tried one after another, could add up past the tick's own stall
 * ceiling (`SWEEP_TICK_STALL_MS`, 15 min), at which
 * point the driver abandons the tick. An alert is never worth the sweep.
 *
 * So the bound is on the CALL, not on the recipient count: one sweep interval
 * (60 s), a fifteenth of that ceiling, leaving a tick room for several alerts.
 * It is a literal rather than an import because host-sweep.ts reaches this
 * module through container-runner.ts → storage-pressure-alert.ts, and the
 * cycle is not worth a constant; `scheduling.test.ts` pins the relation.
 *
 * The step cap exists only so failover survives: without it the first hung
 * recipient would spend the whole deadline and the next would never be tried.
 * Each step gets min(step cap, time remaining).
 *
 * Generous on purpose — a healthy DM send is sub-second, and the cost of a
 * false timeout is a possible duplicate: the abandoned send may still land
 * after this returns false and the caller re-alerts later.
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
      // Never START a send there is no time left to wait for: an abandoned
      // send can still land, and the caller would alert again on top of it.
      // The loop head logs the deadline and returns.
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
