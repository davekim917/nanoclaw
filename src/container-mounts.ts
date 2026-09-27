/** Bind-mount inspection for running containers; a module of its own to avoid a worktree-cleanup import cycle. */
import { execFileSync } from 'child_process';

import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';

/**
 * Every host path bind-mounted into a running container, asked of the runtime directly (`isContainerRunning` sees
 * only this process's containers). `null`: the runtime could not be listed, so assume it owns the path.
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
