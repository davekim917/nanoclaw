import { execFileSync, execSync, spawn, type ChildProcess } from 'child_process';
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

export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Plain container names only: the stop path interpolates the name into a shell command. */
function assertContainerName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
}

export function stopContainer(name: string): void {
  assertContainerName(name);
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/**
 * SIGKILL by name, the fallback when `stopContainer` failed. For an ADOPTED container there is no `docker run`
 * client to kill, and killing its `docker wait` observer would abandon it rather than stop it.
 */
export function killContainerHard(name: string): void {
  assertContainerName(name);
  execFileSync(CONTAINER_RUNTIME_BIN, ['kill', name], { stdio: 'pipe' });
}

/**
 * Is a container of THIS install with exactly this name running? A listing, not `docker inspect`: inspect on an
 * auto-removed container throws exactly as a dead daemon does, while an empty listing proves absence. A throw means
 * "could not ask", left to callers (the claim fence refuses, the adopted waiter re-arms). The `name=` filter is a
 * substring match, so the exact-name check is made here.
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
 * Supervision for a container this host did not spawn: a `docker wait <name>` child whose `close` is the container's
 * terminal. Exit 0 prints the exit code; exit 1 with `No such container` is already gone (terminal); exit 1 with
 * `Cannot connect to the Docker daemon` is NOT terminal: the caller re-reads truth and re-arms.
 */
export function waitForContainerExit(name: string): ChildProcess {
  assertContainerName(name);
  return spawn(CONTAINER_RUNTIME_BIN, ['wait', name], { stdio: ['ignore', 'pipe', 'pipe'] });
}

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

/** Kill orphans of THIS install only (label `nanoclaw-install=<slug>`), so peer installs never reap each other. */
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

export interface InstallContainerScope {
  name: string;
  workgroupId: string | null;
  sessionId: string | null;
  groupId: string | null;
}

/** Docker emits an empty string for a label a container does not carry. */
function labelOrNull(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' || trimmed === '<no value>' ? null : trimmed;
}

/**
 * Every install-labeled container with its scope labels, for the boot quiescence door. Fails closed like
 * `listInstallContainersStrict`. A container older than the scope labels reads null in every field but `name`, which
 * the caller must treat as unknown scope.
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

/** Stop this install's leftovers and prove quiescence; a precondition for filesystem authority changes, fail-closed. */
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
