/**
 * Instrumented wrapper around the spawn path's `onecli.applyContainerConfig`.
 *
 * The SDK discards the failure reason: a transport fault or 5xx becomes a bare `return false`, and
 * `toOneCLIError` drops `.cause`, so the undici `cause.code` is lost. `diagnoseControlApi` re-issues the same
 * request with the cause chain intact, on the failure path only.
 *
 * Exactly one retry, only for the measured class: a fast per-request transport fault against a control API that
 * is up. A non-retryable 4xx (bad key, unregistered identity) still fails on the first attempt.
 */
import { ONECLI_API_KEY, ONECLI_URL } from './config.js';
import { log } from './log.js';
import { httpStatusOf, isRetryableStatus } from './onecli-preflight.js';

/** Short: the fault resolves as soon as the pool hands out a different socket. */
const APPLY_RETRY_DELAY_MS = 250;

const DIAGNOSE_TIMEOUT_MS = 5_000;

/**
 * A slower first attempt is a gateway that has gone away, not the transient class; retrying costs another 30s
 * SDK timeout, and the sweep awaits each wake serially, so it would hold the whole tick.
 */
export const FAST_TRANSIENT_BUDGET_MS = 5_000;

export interface ApplyDiagnosis {
  outcome: 'returned-false' | 'threw';
  /** `undefined` = transport fault. */
  statusCode?: number;
  message?: string;
  causeCode?: string;
  probe?: string;
}

export interface ApplyResult {
  applied: boolean;
  attempts: number;
  durationsMs: number[];
  /** One record per failed attempt: a mixed sequence would otherwise lose the only concrete status seen. */
  attemptDiagnoses: ApplyDiagnosis[];
  diagnosis?: ApplyDiagnosis;
}

export interface ApplyDeps {
  applyContainerConfig: (args: string[], options: { addHostMapping: boolean; agent?: string }) => Promise<boolean>;
  diagnose: (agent: string | undefined) => Promise<{ probe: string; causeCode?: string; statusCode?: number }>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  retryDelayMs: number;
  fastTransientBudgetMs: number;
}

export function causeCodeOf(err: unknown): string | undefined {
  let cursor: unknown = err;
  for (let depth = 0; depth < 3 && cursor; depth++) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Raw `fetch`, not the SDK, which would flatten away the `cause.code`; URL and headers mirror the SDK's request. */
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
    // Drain: an unread undici response pins its connection until GC. Uncaught on purpose: a mid-read fault can be
    // the very reason the apply failed, and the outer catch reports its cause.
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
 * Merges per field, not by picking one attempt: no concrete field any attempt observed may be dropped.
 * `outcome` and `message` follow the status, since they describe the same failure.
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

/** Safe to retry with the same `args`: the SDK fetches before pushing any `-e`/`-v`, so failure leaves it as is. */
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
      // `false` is transport-or-5xx by construction (the SDK rethrows 4xx).
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
      if (!isRetryableStatus(statusCode)) throw err;
    }

    if (durationsMs[durationsMs.length - 1] >= deps.fastTransientBudgetMs) break;
    if (attempt === 1) await deps.sleep(deps.retryDelayMs);
  }

  // The probe must not overwrite a status an attempt already reported.
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

export function describeDiagnosis(diagnosis: ApplyDiagnosis | undefined): string {
  if (!diagnosis) return 'no diagnosis captured';
  const parts: string[] = [diagnosis.outcome === 'threw' ? 'SDK threw' : 'SDK returned false'];
  if (diagnosis.statusCode !== undefined) parts.push(`status ${diagnosis.statusCode}`);
  if (diagnosis.causeCode) parts.push(diagnosis.causeCode);
  if (diagnosis.message) parts.push(diagnosis.message);
  if (diagnosis.probe) parts.push(diagnosis.probe);
  return parts.join('; ');
}
