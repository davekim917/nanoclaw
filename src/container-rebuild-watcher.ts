/**
 * Rebuilds the agent image when the spawn path's deps-drift check (agent-runner-image-check.ts) refuses a spawn.
 * requestContainerRebuild never blocks: the refusal still throws and host-sweep retries the spawn. In-process
 * single-flight coalesces concurrent refusals (build.sh's flock is the cross-process backstop); a failure starts a
 * cooldown and identical failures notify once.
 */
import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

import { checkAgentRunnerDepsDrift } from './agent-runner-image-check.js';
import { CONTAINER_IMAGE, REPO_ROOT } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { log } from './log.js';

const execFileAsync = promisify(execFile);

// Cooldown after a failed attempt, so a persistently refused spawn does not retry-storm the build.
export const MIN_RETRY_INTERVAL_MS = 10 * 60_000;

const BUILD_SCRIPT = path.join(REPO_ROOT, 'container', 'build.sh');

// The exact reference container-runner.ts spawns from.
const IMAGE_REF = CONTAINER_IMAGE;
const tagColon = IMAGE_REF.lastIndexOf(':');
const IMAGE_TAG = tagColon >= 0 ? IMAGE_REF.slice(tagColon + 1) : 'latest';

type Notifier = (message: string) => Promise<void>;

let started = false;
let notify: Notifier | null = null;
let rebuildPromise: Promise<void> | null = null;
let lastFailureAt: number | null = null;
let lastNotifiedDetail: string | null = null;

export function _resetWatcherStateForTest(): void {
  started = false;
  notify = null;
  rebuildPromise = null;
  lastFailureAt = null;
  lastNotifiedDetail = null;
}

/** Test-only: the in-flight rebuild attempt, so tests can await settlement. */
export function _pendingRebuildForTest(): Promise<void> | null {
  return rebuildPromise;
}

/** Test-only: set the notifier without the startup check's async side effect. */
export function _setNotifierForTest(notifier: Notifier | null): void {
  notify = notifier;
}

// The service env proxies HTTPS through the OneCLI gateway, which overrides Authorization and fails GitHub auth.
const GIT_ENV = {
  ...process.env,
  NO_PROXY: [process.env.NO_PROXY, 'github.com'].filter(Boolean).join(','),
  no_proxy: [process.env.no_proxy, 'github.com'].filter(Boolean).join(','),
};

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: REPO_ROOT, timeout: 30_000, env: GIT_ENV });
  return stdout.trim();
}

const short = (sha: string): string => sha.slice(0, 7);

/** The image's `nanoclaw.commit` label (stamped by build.sh), or null when the image or label is missing. */
async function imageCommitLabel(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      CONTAINER_RUNTIME_BIN,
      ['inspect', '--format', '{{index .Config.Labels "nanoclaw.commit"}}', IMAGE_REF],
      { timeout: 10_000 },
    );
    const label = stdout.trim();
    return label && label !== '<no value>' ? label : null;
  } catch {
    return null;
  }
}

interface StalenessCheck {
  stale: boolean;
  reason: string;
}

/**
 * Whether the image lags origin/main's container/ content, from git history alone. Not stale while a deps-drift
 * refusal fires means something else is wrong; a rebuild from disk would only paper over it (and mislabel the image).
 */
async function checkStaleness(): Promise<StalenessCheck> {
  const [toSha, imageCommit] = await Promise.all([git('rev-parse', 'origin/main'), imageCommitLabel()]);
  if (!imageCommit) return { stale: true, reason: 'no image or missing nanoclaw.commit label' };
  if (imageCommit === toSha) return { stale: false, reason: `image at HEAD (${short(imageCommit)})` };
  try {
    await git('merge-base', '--is-ancestor', toSha, imageCommit);
    return {
      stale: false,
      reason: `image (${short(imageCommit)}) already includes origin/main (${short(toSha)})`,
    };
  } catch {
    /* origin/main has commits the image lacks — fall through to diff check */
  }
  let changed: string;
  try {
    changed = await git('diff', '--name-only', imageCommit, toSha, '--', 'container/');
  } catch (err) {
    log.warn('git diff failed in staleness check — treating as stale', { err });
    return { stale: true, reason: `git diff failed (range ${short(imageCommit)}..${short(toSha)})` };
  }
  if (!changed) return { stale: false, reason: `no container/ changes since ${short(imageCommit)}` };
  return { stale: true, reason: `container/ changed in ${short(imageCommit)}..${short(toSha)}` };
}

/**
 * True when HEAD already has everything origin/main has under container/. False: build.sh builds the working tree,
 * so building now would bake unreviewed disk state into the spawn image instead of what was merged.
 */
async function headCoversOriginMainContainer(originMainSha: string): Promise<boolean> {
  const headSha = await git('rev-parse', 'HEAD');
  if (headSha === originMainSha) return true;
  try {
    await git('merge-base', '--is-ancestor', originMainSha, headSha);
    return true;
  } catch {
    /* origin/main has commits HEAD lacks — check if any touch container/ */
  }
  const changed = await git('diff', '--name-only', headSha, originMainSha, '--', 'container/');
  return changed === '';
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
  env?: NodeJS.ProcessEnv,
): Promise<StepResult> {
  try {
    await execFileAsync(bin, args, { cwd: REPO_ROOT, timeout: timeoutMs, env: env ?? GIT_ENV });
    return { ok: true, detail: label };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `${label} failed: ${msg.slice(0, maxErrChars)}` };
  }
}

async function fail(detail: string): Promise<void> {
  lastFailureAt = Date.now();
  if (detail === lastNotifiedDetail) {
    log.debug('Container-rebuild watcher: duplicate failure suppressed', { detail });
    return;
  }
  lastNotifiedDetail = detail;
  log.warn('Container-rebuild watcher: not rebuilt', { detail });
  if (!notify) return;
  try {
    await notify(`❌ ${detail}`);
  } catch (err) {
    log.warn('Container-rebuild watcher notify failed', { err });
  }
}

async function succeed(headSha: string): Promise<void> {
  lastFailureAt = null;
  lastNotifiedDetail = null;
  log.info('Container image rebuilt', { head: short(headSha) });
  if (!notify) return;
  try {
    await notify(`✅ Container image rebuilt (${short(headSha)}) — agent spawns will pick it up.`);
  } catch (err) {
    log.warn('Container-rebuild watcher recovery notify failed', { err });
  }
}

async function attemptRebuild(reason: string): Promise<void> {
  try {
    await execFileAsync('git', ['fetch', '--quiet', 'origin', 'main'], {
      cwd: REPO_ROOT,
      timeout: 30_000,
      env: GIT_ENV,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(
      `git fetch origin main failed (${msg.slice(0, 300)}) — cannot check whether a rebuild would fix the stale agent container image; agent containers cannot spawn. Check network/git config on the host, then run: ./container/build.sh`,
    );
  }

  let staleness: StalenessCheck;
  try {
    staleness = await checkStaleness();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(
      `Could not determine container image staleness (${msg.slice(0, 300)}). Run manually: ./container/build.sh`,
    );
  }

  if (!staleness.stale) {
    return fail(
      `Agent containers are being refused (${reason}) but the image already matches origin/main for container/ (${staleness.reason}) — rebuilding will not fix this, something else is wrong. Investigate on the host, then run ./container/build.sh once fixed.`,
    );
  }

  try {
    const originMainSha = await git('rev-parse', 'origin/main');
    if (!(await headCoversOriginMainContainer(originMainSha))) {
      return fail(
        `Agent containers cannot spawn — container/ changed on origin/main and the checked-out working tree hasn't picked it up. Run: git pull --ff-only origin main && ./container/build.sh`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(
      `Could not verify the checkout is current with origin/main (${msg.slice(0, 300)}). Run manually: ./container/build.sh`,
    );
  }

  // build.sh honors CONTAINER_IMAGE_REF; without it, it derives its own base and can drift from IMAGE_REF. No
  // `git pull`: the operator's live checkout is not ours to move, and build.sh stamps HEAD while building the
  // working tree, so a dirty tree would mislabel the image.
  const result = await runStep('image rebuild', 'bash', [BUILD_SCRIPT, IMAGE_TAG], 900_000, 500, {
    ...GIT_ENV,
    CONTAINER_IMAGE_REF: IMAGE_REF,
  });
  if (!result.ok) {
    return fail(
      `Container rebuild failed — agent containers cannot spawn until this is fixed: ${result.detail}. Run manually: ./container/build.sh`,
    );
  }
  const headSha = await git('rev-parse', 'HEAD').catch(() => 'unknown');
  return succeed(headSha);
}

/** Fire-and-forget; coalesces into an in-flight attempt, and is dropped silently within the failure cooldown. */
export function requestContainerRebuild(reason: string): void {
  if (rebuildPromise) return;
  if (lastFailureAt !== null && Date.now() - lastFailureAt < MIN_RETRY_INTERVAL_MS) return;
  rebuildPromise = attemptRebuild(reason)
    .catch((err) => {
      log.error('Container-rebuild watcher: attempt threw unexpectedly', { err });
    })
    .finally(() => {
      rebuildPromise = null;
    });
}

/** Wire the notifier plus one startup check, so a host booting with a stale image hears it before a refused spawn. */
export function startContainerRebuildWatcher(notifier?: Notifier): void {
  if (started) return;
  started = true;
  notify = notifier ?? null;
  void checkAgentRunnerDepsDrift()
    .then((check) => {
      if (!check.ok) requestContainerRebuild(check.message);
    })
    .catch((err) => log.warn('Container-rebuild watcher startup check failed', { err }));
  log.info('Container-rebuild watcher ready (event-driven, no poll loop)', { image: IMAGE_REF });
}

export function stopContainerRebuildWatcher(): void {
  started = false;
  notify = null;
}
