/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execFile, execSync } from 'child_process';
import os from 'os';
import { promisify } from 'util';

import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

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
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/**
 * Async version of stopContainer with a configurable grace period (seconds).
 * Used by the host shutdown handler to stop multiple containers in parallel
 * without blocking the event loop. The default 10s grace gives the agent
 * loop time to flush in-progress state before SIGKILL — `stopContainer` uses
 * 1s because it's only called from `cleanupOrphans` for known-zombie cleanup.
 */
export async function stopContainerAsync(
  name: string,
  gracePeriodSec: number = 10,
): Promise<void> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  // 300s is a sanity bound, not a real limit — guards against accidentally
  // passing Number.MAX_SAFE_INTEGER. Bumping it is safe.
  if (
    !Number.isInteger(gracePeriodSec) ||
    gracePeriodSec < 0 ||
    gracePeriodSec > 300
  ) {
    throw new Error(`Invalid grace period: ${gracePeriodSec}`);
  }
  await execFileAsync(
    CONTAINER_RUNTIME_BIN,
    ['stop', '-t', String(gracePeriodSec), name],
    {
      // Hard timeout slightly longer than docker's own grace period so we
      // never hang here if docker itself is unresponsive.
      timeout: (gracePeriodSec + 5) * 1000,
    },
  );
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
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
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
