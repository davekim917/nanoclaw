/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import os from 'os';

import {
  CONTAINER_GROUP_LABEL_KEY,
  CONTAINER_INSTALL_LABEL,
  CONTAINER_SESSION_LABEL_KEY,
  CONTAINER_WORKGROUP_LABEL_KEY,
} from './config.js';
import { log } from './log.js';

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

/** Stop a container by name after validating the name against shell metacharacters. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
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
      const [name, workgroupId, sessionId, groupId] = line.split('\t');
      return {
        name: (name ?? '').trim(),
        workgroupId: labelOrNull(workgroupId),
        sessionId: labelOrNull(sessionId),
        groupId: labelOrNull(groupId),
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
