/**
 * Instrumented wrapper around the spawn path's `onecli.applyContainerConfig`.
 *
 * ## Why this module exists
 *
 * `applyContainerConfig` returning `false` aborts the spawn
 * ("OneCLI gateway not applied — refusing to spawn container without
 * credentials", `src/container-runner.ts`) and costs a ~60s sweep cycle of
 * latency. On the live host that happened on **26% of spawns** under Node 20
 * and still happens on ~2% under Node 22. Until now the log said
 * only that it happened — never why — because the SDK throws the reason away
 * twice over:
 *
 *   1. `ContainerClient.applyContainerConfig` rethrows `OneCLIRequestError`
 *      only for a 4xx. Everything else — every transport failure, every 5xx —
 *      becomes a bare `return false` with no error object at all.
 *   2. `getContainerConfig`'s catch runs non-SDK errors through
 *      `toOneCLIError`, which copies `error.message` and **drops `.cause`**.
 *      An undici `TypeError: fetch failed` therefore arrives as
 *      `OneCLIError("fetch failed")` with the real `cause.code`
 *      (`UND_ERR_SOCKET`, `ECONNRESET`, …) already destroyed.
 *
 * So naming the cause requires a request this module makes itself, with the
 * cause chain intact. That is `diagnose` below: it runs only on the failure
 * path, and issues the same `GET /v1/container-config?agent=…` the SDK issues.
 *
 * ## Why exactly one retry, and only here
 *
 * 48h of forensics pinned the failure class precisely:
 *
 *   - **Not a timeout.** Refusals had a p50 of 39ms and a max of 21s against a
 *     30s ceiling; 174 of 274 finished under 50ms. Refusals were *faster* than
 *     successes (p50 149ms). The request dies at the connection.
 *   - **Not a 4xx, and not the agent-creation race.** Zero `OneCLIRequestError`
 *     in 48h. `ensureOnecliAgent`/`applyOnecliSecrets` ran immediately before
 *     every refusal and succeeded, so the vault agent existed.
 *   - **Not a gateway outage.** 230 of 237 refusals were immediately preceded
 *     by a *successful* apply, median 19.4s earlier. They interleave with
 *     successes rather than clustering.
 *   - **Not the gateway at all.** `applyOnecliSecrets` reaches the same URL
 *     with the same key ~30ms earlier via a `curl` subprocess and failed 0 out
 *     of 1378 times, while the pooled `fetch()` failed 281 times.
 *
 * That is a per-request transport fault on a control API proved to be up at
 * the instant of failure — a transient class, and a narrow one. One retry
 * costs ~40ms against a 60s sweep cycle. It is deliberately not a blanket
 * retry: a non-retryable 4xx (400/401/403/404 — a bad key or an unregistered
 * identity) still fails on the first attempt, because retrying cannot heal a
 * misconfiguration and pretending otherwise just delays the alarm.
 *
 * Status classification is imported from `./onecli-preflight.js` rather than
 * restated, so the boot probe and the spawn path can never disagree about what
 * counts as transient.
 */
import { ONECLI_API_KEY, ONECLI_URL } from './config.js';
import { log } from './log.js';
import { httpStatusOf, isRetryableStatus } from './onecli-preflight.js';

/**
 * Delay before the single retry. Short because the failure is a connection
 * fault that resolves as soon as the pool hands out a different socket, not a
 * busy gateway that needs time to recover — the forensics measured a 39ms p50
 * failure, so a long backoff would only add latency to the thing it fixes.
 */
const APPLY_RETRY_DELAY_MS = 250;

/** Bound on the diagnostic probe, which must never itself stall a spawn. */
const DIAGNOSE_TIMEOUT_MS = 5_000;

/**
 * How slow a first attempt may be and still be worth retrying.
 *
 * The retry exists for one measured class: a per-request transport fault with
 * a p50 of 39ms, a p90 of 294ms and a p99 of 5.5s. A first attempt slower than
 * that is not in the class — it is a gateway that has gone away, where the
 * SDK's 30s timeout is the only thing that ends the call. Retrying there buys
 * nothing and costs another 30s.
 *
 * The cost is not local. `sweepOnce` in `src/host-sweep.ts` awaits each
 * `wakeContainer` serially, so one refused spawn holds the whole 60s sweep —
 * every later session's wake, plus the stale, recurrence and ceiling work the
 * same tick owns. Without this cap the worst case is 30s + 30s + a 5s probe.
 * With it, a timed-out first attempt goes straight to the probe: ~35s.
 */
export const FAST_TRANSIENT_BUDGET_MS = 5_000;

/** Why the apply failed, as far as we can name it. */
export interface ApplyDiagnosis {
  /** `false` when the SDK returned false; `throw` when it threw. */
  outcome: 'returned-false' | 'threw';
  /** HTTP status, when the failure carried one. `undefined` = transport fault. */
  statusCode?: number;
  /** Error message as the SDK surfaced it (already flattened for transport faults). */
  message?: string;
  /** Node/undici error code recovered by the diagnostic probe, e.g. `ECONNRESET`. */
  causeCode?: string;
  /** What the diagnostic probe found, when one ran. */
  probe?: string;
}

export interface ApplyResult {
  applied: boolean;
  attempts: number;
  /** Wall time of every attempt, in order. */
  durationsMs: number[];
  /**
   * What each failed attempt reported, in order. A mixed sequence — attempt 1
   * throws a 429, attempt 2 returns a bare `false` — is exactly the case where
   * a single overwritten field would throw away the only concrete status the
   * host ever saw, so every attempt keeps its own record.
   */
  attemptDiagnoses: ApplyDiagnosis[];
  /** `attemptDiagnoses` folded field by field, for the one-line refusal message. */
  diagnosis?: ApplyDiagnosis;
}

export interface ApplyDeps {
  /** The SDK call under test. Mirrors `OneCLI#applyContainerConfig`. */
  applyContainerConfig: (args: string[], options: { addHostMapping: boolean; agent?: string }) => Promise<boolean>;
  /** Names the transport fault the SDK flattened away. Returns a description. */
  diagnose: (agent: string | undefined) => Promise<{ probe: string; causeCode?: string; statusCode?: number }>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  retryDelayMs: number;
  /** Above this, a first attempt is out of the retryable class — see the const. */
  fastTransientBudgetMs: number;
}

/**
 * Recover the `cause.code` an undici `TypeError: fetch failed` carries, walking
 * one level of nesting. Exported for tests; pure.
 */
export function causeCodeOf(err: unknown): string | undefined {
  let cursor: unknown = err;
  for (let depth = 0; depth < 3 && cursor; depth++) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Issue the SDK's own read request with the cause chain intact.
 *
 * Deliberately a raw `fetch` and not `getContainerConfig`: going back through
 * the SDK would re-flatten the error through `toOneCLIError` and lose the very
 * `cause.code` this call exists to recover. The URL and headers mirror
 * `ContainerClient.getContainerConfig` exactly — if that shape ever moves, the
 * probe reports a status mismatch rather than lying about the cause.
 */
export async function diagnoseControlApi(agent: string | undefined): Promise<{
  probe: string;
  causeCode?: string;
  statusCode?: number;
}> {
  const base = (ONECLI_URL || 'http://127.0.0.1:10254').replace(/\/+$/, '');
  const url = agent ? `${base}/v1/container-config?agent=${encodeURIComponent(agent)}` : `${base}/v1/container-config`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ONECLI_API_KEY) headers.Authorization = `Bearer ${ONECLI_API_KEY}`;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(DIAGNOSE_TIMEOUT_MS) });
    // Drain the body before returning. An unread undici response pins its
    // connection until GC, and leaking sockets from the very path that
    // investigates pooled-connection failures would feed the bug it is here
    // to diagnose. The payload is a small container config, so reading and
    // discarding it is cheaper than cancelling and destroying the socket.
    //
    // Deliberately uncaught. A truncated body or a socket reset mid-read is
    // not bookkeeping noise — the SDK must consume this same body to build the
    // container arguments, so a read fault here can be the exact reason both
    // apply attempts failed. Letting it fall to the outer catch reports it
    // with its undici cause instead of claiming the control API answered 200.
    await res.text();
    if (!res.ok) return { probe: `control API answered ${res.status} ${res.statusText}`, statusCode: res.status };
    return { probe: 'control API answered 200 on the diagnostic probe — the failure was transient' };
  } catch (err) {
    const code = causeCodeOf(err);
    const message = err instanceof Error ? err.message : String(err);
    return { probe: `diagnostic probe failed: ${message}${code ? ` (${code})` : ''}`, causeCode: code };
  }
}

const realDeps: Omit<ApplyDeps, 'applyContainerConfig'> = {
  diagnose: diagnoseControlApi,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  retryDelayMs: APPLY_RETRY_DELAY_MS,
  fastTransientBudgetMs: FAST_TRANSIENT_BUDGET_MS,
};

/**
 * Fold the attempts into the one summary line, taking each field from whichever
 * attempt actually observed it.
 *
 * Choosing a single attempt to represent both cannot work, and the two review
 * rounds that landed here proved it from opposite directions: pick the last and
 * a 429 followed by a bare `false` reports nothing; pick the first that named
 * anything and a flattened `fetch failed` followed by a 503 hides the 503. The
 * invariant underneath is that no concrete field any attempt observed may be
 * dropped, so this merges per field rather than ranking attempts. `outcome` and
 * `message` follow the status, because they describe the same failure.
 *
 * The full per-attempt sequence is logged alongside this, so nothing is lost
 * even when two attempts fail differently. Pure, exported for tests.
 */
export function mergeDiagnoses(attemptDiagnoses: ApplyDiagnosis[]): ApplyDiagnosis | undefined {
  if (attemptDiagnoses.length === 0) return undefined;
  const withStatus = attemptDiagnoses.find((d) => d.statusCode !== undefined);
  const withCause = attemptDiagnoses.find((d) => d.causeCode !== undefined);
  const withMessage = attemptDiagnoses.find((d) => d.message !== undefined);
  const primary = withStatus ?? withCause ?? withMessage ?? attemptDiagnoses[attemptDiagnoses.length - 1];
  return {
    outcome: primary.outcome,
    statusCode: withStatus?.statusCode,
    causeCode: withCause?.causeCode,
    message: primary.message ?? withMessage?.message,
  };
}

/**
 * Run the apply with at most one retry, and only for the proved-transient
 * class: a first attempt that failed fast. A first attempt that burned the
 * fast-transient budget is a different failure and gets no second one.
 *
 * Safe to retry with the same `args` array: the SDK fetches the config before
 * pushing a single `-e`/`-v`, so a failed attempt leaves `args` untouched and
 * a successful retry pushes exactly one copy.
 *
 * Pure of logging so tests can assert the decision separately from its
 * consequences; `applyOnecliContainerConfig` adds the log lines.
 */
export async function runApplyWithRetry(
  args: string[],
  options: { addHostMapping: boolean; agent?: string },
  deps: ApplyDeps,
): Promise<ApplyResult> {
  const durationsMs: number[] = [];
  const attemptDiagnoses: ApplyDiagnosis[] = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const startedAt = deps.now();
    try {
      const applied = await deps.applyContainerConfig(args, options);
      durationsMs.push(deps.now() - startedAt);
      if (applied) {
        return {
          applied: true,
          attempts: attempt,
          durationsMs,
          attemptDiagnoses,
          diagnosis: mergeDiagnoses(attemptDiagnoses),
        };
      }
      // `false` is transport-or-5xx by construction (the SDK rethrows 4xx), so
      // it is always in the retryable class. It carries no detail at all, which
      // is why it is appended rather than allowed to overwrite attempt 1.
      attemptDiagnoses.push({ outcome: 'returned-false' });
    } catch (err) {
      durationsMs.push(deps.now() - startedAt);
      const statusCode = httpStatusOf(err);
      attemptDiagnoses.push({
        outcome: 'threw',
        statusCode,
        message: err instanceof Error ? err.message : String(err),
        causeCode: causeCodeOf(err),
      });
      // A deterministic 4xx (bad key, unregistered identity) cannot be retried
      // into success. Rethrow so the caller sees the real error, not a generic
      // refusal — this is the one path that must stay loud and immediate.
      if (!isRetryableStatus(statusCode)) throw err;
    }

    // A first attempt slower than the fast-transient budget is a different
    // failure — a gateway that has gone away, ended only by the SDK's 30s
    // timeout. Go straight to the probe rather than holding the serial sweep
    // for another one.
    if (durationsMs[durationsMs.length - 1] >= deps.fastTransientBudgetMs) break;
    if (attempt === 1) await deps.sleep(deps.retryDelayMs);
  }

  // Both attempts failed. Name the cause the SDK flattened away, without
  // letting the probe's verdict overwrite a status an attempt already reported.
  const probe = await deps.diagnose(options.agent);
  const merged = mergeDiagnoses(attemptDiagnoses) ?? { outcome: 'returned-false' };
  const diagnosis: ApplyDiagnosis = {
    ...merged,
    probe: probe.probe,
    causeCode: merged.causeCode ?? probe.causeCode,
    statusCode: merged.statusCode ?? probe.statusCode,
  };
  return { applied: false, attempts: durationsMs.length, durationsMs, attemptDiagnoses, diagnosis };
}

/**
 * Spawn-path entry point: apply the gateway config, retry once for the proved
 * transient class, and log what actually happened either way.
 *
 * Returns the result rather than throwing so the caller keeps ownership of the
 * "refusing to spawn" decision and its existing message.
 */
export async function applyOnecliContainerConfig(
  args: string[],
  options: { addHostMapping: boolean; agent?: string },
  overrides: Partial<ApplyDeps> & Pick<ApplyDeps, 'applyContainerConfig'>,
): Promise<ApplyResult> {
  const deps: ApplyDeps = { ...realDeps, ...overrides };
  const result = await runApplyWithRetry(args, options, deps);

  if (result.applied && result.attempts === 1) return result;

  if (result.applied) {
    log.warn('OneCLI gateway apply failed once, retry succeeded', {
      agent: options.agent ?? null,
      attempts: result.attempts,
      durationsMs: result.durationsMs,
      outcome: result.diagnosis?.outcome ?? null,
      statusCode: result.diagnosis?.statusCode ?? null,
      causeCode: result.diagnosis?.causeCode ?? null,
      perAttempt: result.attemptDiagnoses.map(describeDiagnosis),
    });
    return result;
  }

  log.warn('OneCLI gateway apply failed — spawn will be refused', {
    agent: options.agent ?? null,
    attempts: result.attempts,
    durationsMs: result.durationsMs,
    outcome: result.diagnosis?.outcome ?? null,
    statusCode: result.diagnosis?.statusCode ?? null,
    causeCode: result.diagnosis?.causeCode ?? null,
    message: result.diagnosis?.message ?? null,
    probe: result.diagnosis?.probe ?? null,
    perAttempt: result.attemptDiagnoses.map(describeDiagnosis),
    url: ONECLI_URL ?? null,
  });
  return result;
}

/** One-line summary for the refusal error message. Pure, exported for tests. */
export function describeDiagnosis(diagnosis: ApplyDiagnosis | undefined): string {
  if (!diagnosis) return 'no diagnosis captured';
  const parts: string[] = [diagnosis.outcome === 'threw' ? 'SDK threw' : 'SDK returned false'];
  if (diagnosis.statusCode !== undefined) parts.push(`status ${diagnosis.statusCode}`);
  if (diagnosis.causeCode) parts.push(diagnosis.causeCode);
  if (diagnosis.message) parts.push(diagnosis.message);
  if (diagnosis.probe) parts.push(diagnosis.probe);
  return parts.join('; ');
}
