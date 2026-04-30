/**
 * Stop any running Docker containers for a given group folder so the next
 * inbound message spawns a fresh container with up-to-date env (notably
 * MNEMON_STORE, which gates memory-capture hook registration in
 * container/agent-runner/src/providers/claude.ts).
 *
 * # Filter precision (Codex F1/F2)
 *
 * Two filter axes are required for safety:
 *
 *   1. `label=${CONTAINER_INSTALL_LABEL}` — guards against acting on
 *      containers from a *different* NanoClaw v2 install (a second checkout
 *      on the same Docker daemon, or a development clone). The label
 *      includes the install slug so concurrent installs don't collide.
 *
 *   2. An EXACT post-filter regex on the name (`^nanoclaw-v2-<folder>-\d+$`)
 *      — Docker's `--filter name=` is substring-based, so
 *      `name=nanoclaw-v2-axis-` would also match `nanoclaw-v2-axis-labs-…`.
 *      The regex catches future folders with shared prefixes.
 *
 * # Drain semantics (Codex F4 honesty)
 *
 * `-t 10` gives the kernel 10s before SIGKILL, but the agent-runner has no
 * SIGTERM drain handler today. This is a forced restart, not a graceful
 * drain — an in-flight Anthropic call WILL be aborted. The host's session
 * sweep (`processing_ack`) recovers stranded rows on the next pass; no
 * inbound.db / mnemon corruption.
 *
 * # Race window (Codex F3 — deferred to follow-up)
 *
 * If a `spawnContainer` is in flight (config snapshot T0 read, but
 * `docker run` not yet executed) at the moment we call `docker ps`, that
 * container can land AFTER our stop runs and live with stale env until the
 * next toggle or host restart. The architecture-advisor and Codex both
 * recommended deferring the proper fix (would require coordinated locks
 * foreign to NanoClaw's single-writer-per-file model). The operator-facing
 * mitigation is a two-pass restart + a runbook note in the calling script.
 *
 * Best-effort: a docker outage or permission issue is logged but does not
 * abort the enable/disable flow.
 */
import { spawnSync } from 'child_process';

import { CONTAINER_INSTALL_LABEL } from '../../src/config.js';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function restartGroupContainers(folder: string): { stopped: number; errors: string[] } {
  const errors: string[] = [];
  // Label scopes to THIS install; substring name filter scopes to candidate
  // group containers. Both must match.
  const psResult = spawnSync(
    'docker',
    [
      'ps',
      '--filter',
      `label=${CONTAINER_INSTALL_LABEL}`,
      '--filter',
      `name=nanoclaw-v2-${folder}-`,
      '--format',
      '{{.Names}}',
    ],
    { encoding: 'utf8' },
  );
  if (psResult.error) {
    errors.push(`docker ps failed: ${psResult.error.message}`);
    return { stopped: 0, errors };
  }
  if (psResult.status !== 0) {
    errors.push(`docker ps exited ${psResult.status}: ${psResult.stderr}`);
    return { stopped: 0, errors };
  }

  // Exact-match post-filter so prefix-shared folders (e.g., `axis` vs
  // `axis-labs`) don't cross-stop. Spawn timestamp is always digits.
  const exactRe = new RegExp(`^nanoclaw-v2-${escapeRegex(folder)}-\\d+$`);
  const names = (psResult.stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && exactRe.test(s));

  if (names.length === 0) {
    return { stopped: 0, errors };
  }

  // Forced restart — see header comment. 10s buys some best-case drain but
  // the runner has no SIGTERM handler.
  const stopResult = spawnSync('docker', ['stop', '-t', '10', ...names], {
    encoding: 'utf8',
  });
  if (stopResult.status !== 0) {
    errors.push(`docker stop exited ${stopResult.status}: ${stopResult.stderr}`);
  }

  return { stopped: names.length, errors };
}
