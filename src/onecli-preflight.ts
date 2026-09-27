/**
 * Boot preflight for the OneCLI control API. The per-spawn credential check refuses at WARN, so a host whose
 * control API is unreachable boots looking clean and never spawns anything; this makes the same request once
 * (`getContainerConfig`, the read half of `applyContainerConfig`, same client and process env) before work is
 * accepted. Failure exits non-zero before `markDeployBootHealthy()`, so a bad deploy stays rollback-eligible.
 * Success logs `OneCLI preflight ok`, which post-restart gates grep for.
 */
import { OneCLI } from '@onecli-sh/sdk';

import { ONECLI_API_KEY, ONECLI_URL } from './config.js';
import { getAllAgentGroups } from './db/agent-groups.js';
import { log } from './log.js';

const PREFLIGHT_ATTEMPTS = 3;
const PREFLIGHT_RETRY_DELAY_MS = 2_000;

const PREFLIGHT_TIMEOUT_MS = 10_000;

export type PreflightResult =
  | { status: 'ok'; agent: string | null; latencyMs: number; attempts: number }
  | { status: 'ok-agent-unregistered'; agent: string; latencyMs: number; attempts: number }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; agent: string | null; attempts: number; httpStatus?: number; err: unknown };

export interface PreflightDeps {
  getContainerConfig: (options: { agent?: string }) => Promise<unknown>;
  /** Null probes the default agent. */
  probeAgent: () => Promise<string | null>;
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
  probeAgent: async () => pickProbeAgent(await getAllAgentGroups()),
  onecliConfigured: () => Boolean(ONECLI_URL || ONECLI_API_KEY),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts: PREFLIGHT_ATTEMPTS,
  retryDelayMs: PREFLIGHT_RETRY_DELAY_MS,
  exit: (code) => process.exit(code),
};

/** Oldest group: deterministic, and most likely to already have a vault agent (created on first spawn). */
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

export function httpStatusOf(err: unknown): number | undefined {
  const status = (err as { statusCode?: unknown } | null | undefined)?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

/**
 * 4xx statuses describing a moment, not a misconfiguration; every other 4xx is a fault retrying can't fix.
 * `Retry-After` is ignored on purpose: the SDK error carries no headers, and reading them would mean bypassing
 * `getContainerConfig`, the very call this probe exists to make.
 */
const RETRYABLE_4XX: ReadonlySet<number> = new Set([408, 425, 429]);

export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true; // transport failure — no response at all
  if (status >= 500) return true;
  return RETRYABLE_4XX.has(status);
}

/**
 * A 404 for a named agent means the vault has no such agent yet (an unknown `?agent=` 404s while the agentless
 * call returns 200), so the default agent is re-probed and a reachable control API passes.
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
