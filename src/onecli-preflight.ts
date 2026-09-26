/**
 * Boot preflight for the OneCLI control API.
 *
 * Every container spawn calls `onecli.applyContainerConfig` and refuses to
 * launch when it comes back false ("OneCLI gateway not applied — refusing to
 * spawn container without credentials", `src/container-runner.ts`). That check
 * is correct and stays. What it cannot do is tell an operator that the whole
 * fleet is deaf: the refusal is per spawn, logged at WARN by the sweep's
 * retry path, so a host whose control API is unreachable boots looking clean —
 * adapters up, zero ERROR lines — and simply never spawns anything.
 *
 * That is exactly what happened on 2026-09-02 (11 minutes, 0/8 spawns). The
 * host had been moved to Node 22.23, which honors `NODE_USE_ENV_PROXY=1`
 * where Node 20 ignored it, so the host's own `fetch()` to the OneCLI control
 * API on 127.0.0.1 was routed through the OneCLI gateway proxy and failed.
 * Nothing in the boot sequence noticed.
 *
 * This module closes that gap by making the same call once, at boot, before
 * the sweep and the delivery polls start accepting work:
 *
 *   - `getContainerConfig({ agent })` is the exact request
 *     `applyContainerConfig` issues; the SDK's apply is that fetch plus the
 *     `-e`/`-v` argument pushes and the CA-file writes. Probing the read half
 *     is therefore a true dry run, using the same client, the same URL, and
 *     the same `fetch()` under the same process environment — which is the
 *     part that broke.
 *   - Failure logs ERROR and exits non-zero, so systemd's `OnFailure=`
 *     unit alert and `deploy-crash-guard` fire. The exit happens before
 *     `markDeployBootHealthy()`, so a bad deploy stays rollback-eligible.
 *   - Success logs one INFO line, `OneCLI preflight ok`, carrying the probed
 *     agent identifier and the round-trip latency. A post-restart gate can
 *     grep for it instead of inferring health from "adapters started".
 *
 * Deliberately NOT covered: the intermittent per-spawn refusal rate seen on
 * healthy hosts. A single boot probe cannot speak to that, and the per-spawn
 * check is still the thing that keeps an uncredentialed container from
 * launching.
 */
import { OneCLI } from '@onecli-sh/sdk';

import { ONECLI_API_KEY, ONECLI_URL } from './config.js';
import { getAllAgentGroups } from './db/agent-groups.js';
import { log } from './log.js';
import { onecliAgentIdentifier } from './shadow-host.js';

/**
 * Attempts before the boot is failed. The transport failures worth riding out
 * are a gateway container that is still coming up after a host reboot; three
 * tries two seconds apart covers that without turning a genuinely broken
 * control API into a slow boot.
 */
const PREFLIGHT_ATTEMPTS = 3;
const PREFLIGHT_RETRY_DELAY_MS = 2_000;

/**
 * Shorter than the spawn path's 30s. That timeout exists because spawns run
 * while the host may be hammering the gateway with container reaps; a boot
 * probe competes with nothing, and a control API that needs more than ten
 * seconds to answer one GET is not healthy.
 */
const PREFLIGHT_TIMEOUT_MS = 10_000;

export type PreflightResult =
  | { status: 'ok'; agent: string | null; latencyMs: number; attempts: number }
  | { status: 'ok-agent-unregistered'; agent: string; latencyMs: number; attempts: number }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; agent: string | null; attempts: number; httpStatus?: number; err: unknown };

export interface PreflightDeps {
  /** The dry-run call. Mirrors `OneCLI#getContainerConfig`. */
  getContainerConfig: (options: { agent?: string }) => Promise<unknown>;
  /** Identifier to probe with, or null to probe the default agent. */
  probeAgent: () => Promise<string | null>;
  /** Whether this install is wired to a OneCLI gateway at all. */
  onecliConfigured: () => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  attempts: number;
  retryDelayMs: number;
  exit: (code: number) => never;
}

const realDeps: PreflightDeps = {
  getContainerConfig: (options) =>
    new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY, timeout: PREFLIGHT_TIMEOUT_MS }).getContainerConfig(options),
  probeAgent: async () => {
    const groupId = pickProbeAgent(await getAllAgentGroups());
    return groupId === null ? null : onecliAgentIdentifier(groupId);
  },
  onecliConfigured: () => Boolean(ONECLI_URL || ONECLI_API_KEY),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts: PREFLIGHT_ATTEMPTS,
  retryDelayMs: PREFLIGHT_RETRY_DELAY_MS,
  exit: (code) => process.exit(code),
};

/**
 * Pick the agent identifier to probe with: the oldest agent group.
 *
 * The spawn path derives the OneCLI agent identifier from `agentGroup.id`, so
 * any group is a representative probe. Oldest wins because it is deterministic
 * across restarts and is the group most likely to already exist in the vault
 * (`ensureOnecliAgent` creates the vault agent on first spawn, so a group that
 * has never spawned has no vault agent yet — see the 404 handling below).
 *
 * Pure, exported for tests.
 */
export function pickProbeAgent(groups: Array<{ id: string; created_at: string }>): string | null {
  let oldest: { id: string; created_at: string } | undefined;
  for (const group of groups) {
    if (!group?.id) continue;
    if (
      !oldest ||
      group.created_at < oldest.created_at ||
      (group.created_at === oldest.created_at && group.id < oldest.id)
    ) {
      oldest = group;
    }
  }
  return oldest?.id ?? null;
}

/**
 * HTTP status carried by `OneCLIRequestError`, when the failure had one.
 *
 * Exported because the spawn path classifies the same errors from the same
 * SDK client (`src/onecli-apply.ts`). One classifier, one place to correct it.
 */
export function httpStatusOf(err: unknown): number | undefined {
  const status = (err as { statusCode?: unknown } | null | undefined)?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

/**
 * 4xx statuses that describe a moment rather than a misconfiguration:
 * 408 Request Timeout, 425 Too Early, 429 Too Many Requests. A cloud gateway
 * rate-limiting one boot probe must not take the host down — these ride the
 * same retry path as a transport failure. Every other 4xx (400/401/403/404 and
 * friends) is a credential or wiring fault that no amount of retrying fixes.
 *
 * `Retry-After` is deliberately not honored: the SDK's `OneCLIRequestError`
 * carries only `url` and `statusCode`, and reading the header would mean
 * bypassing `getContainerConfig` — the very call this probe exists to make.
 */
const RETRYABLE_4XX: ReadonlySet<number> = new Set([408, 425, 429]);

/**
 * Shared with the spawn path (`src/onecli-apply.ts`) — see `httpStatusOf`.
 */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true; // transport failure — no response at all
  if (status >= 500) return true;
  return RETRYABLE_4XX.has(status);
}

/**
 * Run the probe. Pure of logging and exiting so tests can assert the decision
 * separately from its consequences.
 *
 * Retry policy follows what the failure can mean:
 *   - No HTTP status (DNS, connection refused, proxy interception, timeout),
 *     a 5xx, or a momentary 4xx (408/425/429 — see RETRYABLE_4XX): the gateway
 *     may still be coming up or be briefly rate-limiting. Retry.
 *   - Any other 4xx: a deterministic misconfiguration (bad API key, unknown
 *     agent). Retrying cannot heal it, so fail immediately.
 *   - The one exception is a 404 for a NAMED agent, which means the vault has
 *     no such agent yet rather than that the control API is unreachable. Verified
 *     against a live gateway: an unknown `?agent=` returns 404 while the same
 *     endpoint with no agent returns 200. Re-probe the default agent to tell
 *     the two apart, and treat a reachable control API as a pass.
 */
export async function probeOnecliControlApi(deps: PreflightDeps): Promise<PreflightResult> {
  if (!deps.onecliConfigured()) {
    return { status: 'skipped', reason: 'neither ONECLI_URL nor ONECLI_API_KEY is configured' };
  }

  const agent = await deps.probeAgent();
  let lastErr: unknown;
  let lastHttpStatus: number | undefined;
  let attemptsUsed = 0;

  for (let attempt = 1; attempt <= deps.attempts; attempt++) {
    attemptsUsed = attempt;
    const startedAt = deps.now();
    try {
      await deps.getContainerConfig(agent ? { agent } : {});
      return { status: 'ok', agent, latencyMs: deps.now() - startedAt, attempts: attempt };
    } catch (err) {
      lastErr = err;
      lastHttpStatus = httpStatusOf(err);

      if (lastHttpStatus === 404 && agent) {
        const agentlessStartedAt = deps.now();
        try {
          await deps.getContainerConfig({});
          return {
            status: 'ok-agent-unregistered',
            agent,
            latencyMs: deps.now() - agentlessStartedAt,
            attempts: attempt,
          };
        } catch (agentlessErr) {
          lastErr = agentlessErr;
          lastHttpStatus = httpStatusOf(agentlessErr);
        }
      }

      if (!isRetryableStatus(lastHttpStatus)) break;
      if (attempt < deps.attempts) await deps.sleep(deps.retryDelayMs);
    }
  }

  return { status: 'failed', agent, attempts: attemptsUsed, httpStatus: lastHttpStatus, err: lastErr };
}

/**
 * Boot gate. Probes the control API, emits the health signal, and exits the
 * process when the spawn path's credential call cannot succeed.
 *
 * Returns the result (rather than only exiting) so callers and tests can see
 * what was decided; in production the failure branch never returns.
 */
export async function runOnecliBootPreflight(overrides: Partial<PreflightDeps> = {}): Promise<PreflightResult> {
  const deps: PreflightDeps = { ...realDeps, ...overrides };
  const result = await probeOnecliControlApi(deps);

  switch (result.status) {
    case 'skipped':
      log.info('OneCLI preflight skipped — install is not wired to a gateway', { reason: result.reason });
      return result;

    case 'ok':
      log.info('OneCLI preflight ok', {
        agent: result.agent,
        latencyMs: result.latencyMs,
        attempts: result.attempts,
      });
      return result;

    case 'ok-agent-unregistered':
      // The control API answered; only the probe agent is missing from the
      // vault, which the next spawn of that group fixes via ensureOnecliAgent.
      log.warn('OneCLI preflight probe agent is not registered in the vault yet', { agent: result.agent });
      log.info('OneCLI preflight ok', {
        agent: null,
        probeAgent: result.agent,
        latencyMs: result.latencyMs,
        attempts: result.attempts,
      });
      return result;

    case 'failed':
      log.error(
        'OneCLI preflight failed — the control API the spawn path depends on is unreachable; every container spawn would be refused. Refusing to start.',
        {
          agent: result.agent,
          attempts: result.attempts,
          httpStatus: result.httpStatus,
          url: ONECLI_URL ?? null,
          err: result.err,
        },
      );
      return deps.exit(1);
  }
}
