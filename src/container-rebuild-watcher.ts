/**
 * Container rebuild watcher.
 *
 * Polls every minute and rebuilds `nanoclaw-agent:v2` whenever the running
 * image is older than any commit on origin/main that touches `container/`.
 * Posts a completion message to an optional Discord channel.
 *
 * State-driven (image timestamp + git diff), not GitHub-event-driven —
 * catches PR squash-merges, direct pushes, force-pushes, hand-edits, and
 * first runs where no image exists yet. No GitHub API dependency.
 *
 * If origin/main has new commits but none touch `container/`, the watcher
 * leaves the working tree alone — the user pulls when they want.
 */
import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

import { REPO_ROOT } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { log } from './log.js';

const execFileAsync = promisify(execFile);

const POLL_MS = 60_000;
const IMAGE_NAME = 'nanoclaw-agent';
const IMAGE_TAG = 'v2';
const IMAGE_REF = `${IMAGE_NAME}:${IMAGE_TAG}`;

type Notifier = (message: string) => Promise<void>;

let timer: NodeJS.Timeout | null = null;
let running = false;
let notify: Notifier | null = null;

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: REPO_ROOT, timeout: 30_000 });
  return stdout.trim();
}

const short = (sha: string): string => sha.slice(0, 7);

/**
 * Returns the running image's `Created` timestamp (ISO, no fractional secs)
 * suitable for `git log --before`, or null when the image doesn't exist.
 */
async function imageCreatedAt(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(CONTAINER_RUNTIME_BIN, ['inspect', '--format', '{{.Created}}', IMAGE_REF], {
      timeout: 10_000,
    });
    return stdout.trim().split('.')[0].replace('T', ' ');
  } catch {
    return null;
  }
}

interface StalenessCheck {
  stale: boolean;
  reason: string;
}

/**
 * Decide whether the image needs a rebuild. Always rebuilds when the image
 * doesn't exist or its build commit can't be located. Otherwise compares
 * `imageCommit..origin/main` for files under `container/`. A failed
 * `git diff` is logged and treated as "stale" (fail-open) so a transient
 * git error doesn't silently suppress rebuilds.
 */
async function checkStaleness(): Promise<StalenessCheck> {
  const [toSha, created] = await Promise.all([git('rev-parse', 'origin/main'), imageCreatedAt()]);
  if (!created) return { stale: true, reason: 'no image present' };
  const imageCommit = await git('log', '-1', `--before=${created}`, '--format=%H', 'origin/main').catch(() => '');
  if (!imageCommit) return { stale: true, reason: `no commit found before image ts ${created}` };
  if (imageCommit === toSha) return { stale: false, reason: 'image at HEAD' };
  let changed: string;
  try {
    changed = await git('diff', '--name-only', imageCommit, toSha, '--', 'container/');
  } catch (err) {
    log.warn('git diff failed in staleness check — treating as stale', { err });
    return { stale: true, reason: `git diff failed (range ${short(imageCommit)}..${short(toSha)})` };
  }
  if (!changed) return { stale: false, reason: 'no container/ changes since image' };
  return { stale: true, reason: `container/ changed in ${short(imageCommit)}..${short(toSha)}` };
}

interface StepResult {
  ok: boolean;
  detail: string;
}

async function runStep(
  label: string,
  bin: string,
  args: string[],
  timeoutMs: number,
  maxErrChars: number,
): Promise<StepResult> {
  try {
    await execFileAsync(bin, args, { cwd: REPO_ROOT, timeout: timeoutMs });
    return { ok: true, detail: label };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `${label} failed: ${msg.slice(0, maxErrChars)}` };
  }
}

async function pullAndBuild(): Promise<StepResult> {
  const pull = await runStep('git pull', 'git', ['pull', '--ff-only', 'origin', 'main'], 60_000, 300);
  if (!pull.ok) return pull;
  return runStep('image rebuild', 'bash', [path.join(REPO_ROOT, 'container', 'build.sh'), IMAGE_TAG], 900_000, 500);
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await execFileAsync('git', ['fetch', '--quiet', 'origin', 'main'], { cwd: REPO_ROOT, timeout: 30_000 });
    const check = await checkStaleness();
    if (!check.stale) {
      log.debug('Container image up to date', { reason: check.reason });
      return;
    }

    log.info('Container image stale — rebuilding', { reason: check.reason });
    const result = await pullAndBuild();
    // Post-pull HEAD always equals the origin/main SHA we already fetched.
    const headSha = await git('rev-parse', 'HEAD').catch(() => '');
    const message = result.ok
      ? `✅ Container image rebuilt${headSha ? ` (HEAD ${short(headSha)})` : ''}`
      : `❌ Container rebuild failed: ${result.detail}`;
    log.info('Container rebuild result', { ok: result.ok, detail: result.detail });
    if (notify) {
      try {
        await notify(message);
      } catch (err) {
        log.warn('Container-rebuild watcher notify failed', { err });
      }
    }
  } catch (err) {
    log.error('Container-rebuild watcher tick failed', { err });
  } finally {
    running = false;
  }
}

export function startContainerRebuildWatcher(notifier?: Notifier): void {
  if (timer) return;
  notify = notifier ?? null;
  // First tick in 30s (let the service finish booting), then every POLL_MS.
  timer = setTimeout(function loop() {
    void tick().finally(() => {
      timer = setTimeout(loop, POLL_MS);
    });
  }, 30_000);
  log.info('Container-rebuild watcher started', { pollMs: POLL_MS, image: IMAGE_REF });
}

export function stopContainerRebuildWatcher(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  notify = null;
}
