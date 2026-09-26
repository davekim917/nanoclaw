/**
 * Container rebuild watcher — event-driven, not polled.
 *
 * Old design polled every 60s comparing the running image's commit label
 * against origin/main (~1440 ticks/day for ~8 real events). container-runner.ts
 * already computes the authoritative "this image is stale and is actively
 * blocking work" signal on every spawn — checkAgentRunnerDepsDrift() in
 * agent-runner-image-check.ts. When that check refuses a spawn, it calls
 * requestContainerRebuild() here instead of waiting for a timer to notice.
 *
 * requestContainerRebuild() never blocks the caller: it's a synchronous,
 * fire-and-forget kickoff. The refusal still throws immediately; host-sweep
 * retries the spawn, and by then the rebuild (if one ran) has likely landed.
 *
 * Single-flight in-process (rebuildPromise) coalesces a wake-storm of
 * concurrent refusals into one rebuild — container/build.sh's flock on
 * logs/container-build.lock is the cross-process backstop, not duplicated
 * here. A failed attempt (build failure, or a precondition that means a
 * rebuild wouldn't help anyway) starts a MIN_RETRY_INTERVAL_MS cooldown so a
 * persistently broken build doesn't get retried on every subsequent refused
 * spawn; a successful rebuild clears it. Repeated identical failures are
 * deduped (lastNotifiedDetail) so the operator gets one actionable message,
 * not one per refused spawn.
 */
import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

import { checkAgentRunnerDepsDrift } from './agent-runner-image-check.js';
import { CONTAINER_IMAGE, REPO_ROOT } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { log } from './log.js';
import { isShadowHost } from './shadow-host.js';

const execFileAsync = promisify(execFile);

// Floor between rebuild attempts once one has failed (or a precondition
// determined a rebuild wouldn't help). Prevents a storm of back-to-back
// rebuild attempts when spawns keep getting refused for the same unresolved
// reason. A successful rebuild resets this to null.
export const MIN_RETRY_INTERVAL_MS = 10 * 60_000;

const BUILD_SCRIPT = path.join(REPO_ROOT, 'container', 'build.sh');

// Same full reference container-runner.ts spawns from — CONTAINER_IMAGE
// resolves to `<install-slug-base>:<tag>` (default `:latest`).
const IMAGE_REF = CONTAINER_IMAGE;
const tagColon = IMAGE_REF.lastIndexOf(':');
const IMAGE_TAG = tagColon >= 0 ? IMAGE_REF.slice(tagColon + 1) : 'latest';

type Notifier = (message: string) => Promise<void>;

let started = false;
let notify: Notifier | null = null;
let rebuildPromise: Promise<void> | null = null;
let lastFailureAt: number | null = null;
let lastNotifiedDetail: string | null = null;
let shadowRefusalLogged = false;

export function _resetWatcherStateForTest(): void {
  started = false;
  notify = null;
  rebuildPromise = null;
  lastFailureAt = null;
  lastNotifiedDetail = null;
  shadowRefusalLogged = false;
}

/** Test-only: the in-flight rebuild attempt, so tests can await settlement. */
export function _pendingRebuildForTest(): Promise<void> | null {
  return rebuildPromise;
}

/**
 * Test-only: set the notifier directly without running startContainerRebuildWatcher's
 * startup check side effect, so requestContainerRebuild tests don't have to
 * race that check's own async settlement.
 */
export function _setNotifierForTest(notifier: Notifier | null): void {
  notify = notifier;
}

// Same gotcha as repo-freshness: the service env proxies HTTPS through the
// onecli gateway, which overrides Authorization; GitHub creds are env-only,
// so proxied fetches always fail auth. Bypass the proxy for github.com.
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

/**
 * Returns the running image's `nanoclaw.commit` label (stamped by
 * `container/build.sh`), or null when the image doesn't exist or wasn't
 * built by a version of build.sh that stamps the label.
 */
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
 * Decide whether the image needs a rebuild, purely from git history vs the
 * image's commit label (independent of the deps-hash check that triggers
 * requestContainerRebuild). Kept as a precondition: if this says the image
 * already reflects origin/main's container/ content, a deps-drift refusal
 * means something else is wrong — a rebuild driven by stale/local disk state
 * would just paper over it (and mislabel the image), so we say so instead of
 * looping. See headCoversOriginMainContainer() for the "would a rebuild here
 * actually pick up origin/main's fix" half of the decision.
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
 * True when HEAD already contains everything origin/main has under
 * container/ — building from the working tree right now bakes in the same
 * container/ content a `git pull` would produce. False means origin/main has
 * container/-relevant commits HEAD lacks: building anyway would bake
 * whatever's on disk (possibly unrelated local edits, per CLAUDE.md's
 * warning that build.sh builds from the working tree) into the canonical
 * spawn image instead of what's actually reviewed and merged upstream.
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

/** Failure path: start the retry cooldown, dedup, and notify. */
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

/** Success path: clear the cooldown/dedup state and send a quiet confirmation. */
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

  // Pass the exact image reference container-runner.ts spawns from. build.sh
  // honors CONTAINER_IMAGE_REF when set — without this, build.sh derives its
  // own base via container_image_base() and can drift from what we inspect if
  // CONTAINER_IMAGE is overridden (env var, custom install slug, etc.).
  //
  // Deliberately no `git pull` here: build.sh builds from the WORKING TREE
  // while stamping NANOCLAW_COMMIT from `git rev-parse HEAD`.
  // Moving the operator's live checkout out from under them is out of scope
  // for an automated process, and a build against a dirty tree would produce
  // an image whose commit label misrepresents its actual contents anyway.
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

/**
 * Request a rebuild. Fire-and-forget: returns immediately, never awaited by
 * callers on the spawn path. Concurrent calls while a rebuild is already in
 * flight coalesce into that one attempt; calls within MIN_RETRY_INTERVAL_MS
 * of a failed attempt are dropped silently (the failure was already
 * notified) so a persistently refused spawn doesn't retry-storm the build.
 */
export function requestContainerRebuild(reason: string): void {
  if (isShadowHost()) {
    if (!shadowRefusalLogged) {
      shadowRefusalLogged = true;
      log.warn('Container rebuild refused: shadow host never builds images', { reason });
    }
    return;
  }
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

/**
 * Wire the rebuild notifier. No timer/poll loop anymore — "start" just means
 * "the watcher is now listening", plus one startup check so a host that
 * boots with an already-stale image doesn't sit quiet until the first
 * refused spawn finds out.
 */
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
