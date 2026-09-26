/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execFileSync, execSync, spawn, type ChildProcess } from 'child_process';
import os from 'os';

import {
  CONTAINER_GROUP_LABEL_KEY,
  CONTAINER_INSTALL_LABEL,
  CONTAINER_SESSION_LABEL_KEY,
  CONTAINER_WORKGROUP_LABEL_KEY,
} from './config.js';
import { log } from './log.js';
import { isShadowProcess, SHADOW_CONTAINER_LABEL_KEY } from './shadow-flag.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/**
 * Refuse anything that is not a plain container name. The stop path below
 * interpolates the name into a shell command; the argv-form helpers do not,
 * but they share the check so a name the runtime would reject never reaches
 * a subprocess at all.
 */
function assertContainerName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
}

/** Stop a container by name after validating the name against shell metacharacters. */
export function stopContainer(name: string): void {
  assertContainerName(name);
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/**
 * SIGKILL a container by name — the fallback when `stopContainer` itself
 * failed. For a container this host SPAWNED the equivalent is killing the
 * `docker run` client; for one it ADOPTED there is no client to kill, only a
 * `docker wait` observer, and killing that would abandon the container rather
 * than stop it (plan §7.E, the one place a naive channel union is wrong).
 */
export function killContainerHard(name: string): void {
  assertContainerName(name);
  execFileSync(CONTAINER_RUNTIME_BIN, ['kill', name], { stdio: 'pipe' });
}

/**
 * Is a container of THIS install with exactly this name running right now?
 *
 * A listing, deliberately not `docker inspect`: after a crash every session
 * whose container exited during the outage still carries its `container_ref`
 * (`releaseSessionClaim` nulls it only on a tracked exit), and `inspect` on an
 * auto-removed container THROWS exactly as a dead daemon does. With `ps`, an
 * empty result is a successful proof of absence and a throw is "the runtime
 * could not be asked" — the two callers want opposite closed sides for that
 * throw, so it is left to them: the claim fence refuses the spawn, the adopted
 * waiter re-arms (plan §4.3.3, §4.3.4 P2).
 *
 * The `name=` filter is a substring match in the runtime; the exact-name check
 * is made here so the answer never depends on the runtime's regex anchoring.
 */
export function runtimeShowsRunning(name: string): boolean {
  assertContainerName(name);
  const output = execFileSync(
    CONTAINER_RUNTIME_BIN,
    ['ps', '--filter', `label=${CONTAINER_INSTALL_LABEL}`, '--filter', `name=${name}`, '--format', '{{.Names}}'],
    { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
  );
  return output.trim().split('\n').filter(Boolean).includes(name);
}

/**
 * The supervision channel for a container this host did not spawn: a
 * `docker wait <name>` child whose `close` is the container's terminal, so the
 * `.once('close', …)` shape the kill, shutdown and finalize paths already use
 * keeps working for an adopted entry (plan §4.3.3).
 *
 * Exit vocabulary the caller classifies: exit 0 with the container's exit code
 * on stdout means it exited; exit 1 with `No such container` on stderr means
 * it is already gone (terminal, never re-armed); exit 1 with `Cannot connect
 * to the Docker daemon` means the daemon went away, which is NOT a terminal —
 * the caller re-reads truth and re-arms.
 */
export function waitForContainerExit(name: string): ChildProcess {
  assertContainerName(name);
  return spawn(CONTAINER_RUNTIME_BIN, ['wait', name], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart NanoClaw                                           ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/**
 * Kill orphaned NanoClaw containers from THIS install's previous runs.
 *
 * Scoped by label `nanoclaw-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. The label is
 * stamped onto every container at spawn time — see container-runner.ts.
 */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}

function listInstallContainersStrict(): string[] {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    return output.trim().split('\n').filter(Boolean);
  } catch (err) {
    throw new Error('Cannot prove install-scoped container absence: runtime listing failed', { cause: err });
  }
}

/** One install-labeled container as the boot inventory sees it. */
export interface InstallContainerScope {
  name: string;
  /** `nanoclaw-workgroup` label, or null when the container carries none. */
  workgroupId: string | null;
  /** `nanoclaw-session` label, or null when the container carries none. */
  sessionId: string | null;
  /** `nanoclaw-group` label, or null when the container carries none. */
  groupId: string | null;
  /** Read only on a shadow host: whether a shadow spawned it. */
  shadow?: boolean;
}

/** Docker emits an empty string for a label a container does not carry. */
function labelOrNull(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' || trimmed === '<no value>' ? null : trimmed;
}

/**
 * Every install-labeled container with the scope labels the boot quiescence
 * door needs (docs/specs/upstream-restart-survival-seam/plan.md §7.D).
 *
 * One `docker ps`, same install filter and same fail-closed contract as
 * `listInstallContainersStrict`: a listing failure is never read as "none
 * running". A container spawned before the scope labels shipped carries none
 * of them, so every field but `name` reads as null and the caller must treat
 * it as unknown scope (plan §3.5, divergence 7).
 */
export function listInstallContainersWithScope(): InstallContainerScope[] {
  const format = [
    '{{.Names}}',
    `{{.Label "${CONTAINER_WORKGROUP_LABEL_KEY}"}}`,
    `{{.Label "${CONTAINER_SESSION_LABEL_KEY}"}}`,
    `{{.Label "${CONTAINER_GROUP_LABEL_KEY}"}}`,
    ...(isShadowProcess() ? [`{{.Label "${SHADOW_CONTAINER_LABEL_KEY}"}}`] : []),
  ].join('\\t');
  let output: string;
  try {
    output = execSync(`${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '${format}'`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
  } catch (err) {
    throw new Error('Cannot prove install-scoped container absence: runtime listing failed', { cause: err });
  }
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, workgroupId, sessionId, groupId, shadow] = line.split('\t');
      return {
        name: (name ?? '').trim(),
        workgroupId: labelOrNull(workgroupId),
        sessionId: labelOrNull(sessionId),
        groupId: labelOrNull(groupId),
        ...(isShadowProcess() ? { shadow: labelOrNull(shadow) === '1' } : {}),
      };
    })
    .filter((entry) => entry.name !== '');
}

/**
 * Stop leftovers from this install and prove the install is quiescent.
 *
 * Unlike the legacy best-effort cleanup above, this is a hard precondition for
 * filesystem authority changes. Listing, stopping, and the post-stop listing
 * all fail closed.
 */
export function cleanupOrphansStrict(): string[] {
  const orphans = listInstallContainersStrict();
  for (const name of orphans) {
    try {
      stopContainer(name);
    } catch (err) {
      throw new Error(`Cannot prove install-scoped container absence: failed to stop ${name}`, { cause: err });
    }
  }
  const remaining = listInstallContainersStrict();
  if (remaining.length > 0) {
    throw new Error(`Install-scoped containers still running after cleanup: ${remaining.join(', ')}`);
  }
  if (orphans.length > 0) {
    log.info('Stopped orphaned containers and proved install quiescence', {
      count: orphans.length,
      names: orphans,
    });
  }
  return orphans;
}
