/**
 * Bind-mount inspection for running containers.
 *
 * Its own module rather than a member of container-runtime.ts: worktree-cleanup
 * imports storage-manager, so storage-manager cannot import worktree-cleanup
 * back for this, and both need the same answer from the same implementation.
 * Keeping the runtime binary as a live import binding also leaves the existing
 * container-runtime mocks in place for callers' tests.
 */
import { execFileSync } from 'child_process';

import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';

/**
 * Every host path bind-mounted into a currently running container.
 *
 * `isContainerRunning` reads this process's own bookkeeping, which is empty in
 * any out-of-process caller and says nothing about a container started by
 * someone else. Before removing anything, apply mode asks the runtime directly.
 * `null` means the runtime could not be listed, and a container we cannot see
 * is a container we must assume owns the path.
 */
export function runningContainerMounts(): string[] | null {
  try {
    const ids = execFileSync(CONTAINER_RUNTIME_BIN, ['ps', '-q'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (ids.length === 0) return [];
    const inspected = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['inspect', '--format', '{{range .Mounts}}{{.Source}}\n{{end}}', ...ids],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
    );
    return inspected
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}
