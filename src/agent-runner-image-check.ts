/**
 * Agent-runner deps drift check.
 *
 * Agent-runner has a deliberate split:
 *   - Source (container/agent-runner/src) is bind-mounted live into /app/src.
 *   - Dependencies (node_modules) are baked into the image at build time from
 *     container/agent-runner/package.json + bun.lock.
 *
 * Adding a runtime dep + a new `import` of it without rebuilding the image
 * silently crash-loops every fresh spawn: bun resolves the import against the
 * stale baked node_modules, throws "Cannot find module", exits 1. The host
 * sweep retries 60s later — no surfaced error, all affected agents bricked.
 *
 * Defense: container/build.sh hashes package.json + bun.lock, bakes the hash
 * into the image as a LABEL (nanoclaw.agentRunnerDepsHash). On every spawn we
 * recompute the on-disk hash and compare against the image label. Mismatch →
 * refuse to spawn with an actionable message naming the rebuild command.
 *
 * Success is cached, keyed on (imageRef, package.json/bun.lock mtime+size) —
 * NOT on imageRef alone, which is the case the original "intentionally
 * uncached" design was guarding against: a cache keyed only on imageRef would
 * mask "operator edits package.json without rebuilding", since the edit
 * never touches the key. Keying on the file stats instead means any edit
 * (which always bumps mtime) busts the cache and forces a fresh check, so
 * that failure mode stays fully covered. What the cache buys back is the
 * steady-state case — package.json/bun.lock unchanged since the last check —
 * which is the overwhelming majority of spawns; those skip both file hashing
 * and the `docker inspect` round-trip (and, when the label read landed
 * mid-relabel, the LABEL_RETRY_DELAY_MS pause) entirely.
 *
 * Only `ok: true` results are cached. A failing check (drift, missing image,
 * inspect error, unresolved label) is never cached, deliberately: the fix for
 * those is almost always "rebuild the image", which doesn't touch
 * package.json/bun.lock, so caching a failure would mask the fix landing —
 * host-sweep's retry loop needs every subsequent spawn to actually re-check
 * until the rebuild lands. See checkAgentRunnerDepsDrift's cache lookup below
 * for where this is enforced.
 *
 * A passing result is also only cached for DEPS_DRIFT_CACHE_TTL_MS: the file
 * fingerprint says nothing about the image being removed or retagged
 * out-of-band (no file edit involved), and an unbounded cache would serve a
 * stale "in sync" forever in that case — see the constant's doc comment.
 *
 * Concurrent calls for the same imageRef are coalesced onto one in-flight
 * check (see inFlightChecks below) — a burst of spawns waking together
 * (e.g. wakeRepositoryMountSessions) would otherwise all race past an empty
 * cache and each pay the full check cost independently.
 *
 * The read has to be careful about one thing. `container/build.sh` re-stamps
 * the ARG-driven retention LABEL layer on every run, which means a periodic
 * `docker build` against the canonical tag; on a containerd image store that
 * export writes an OCI image index, and while the index is being rewritten
 * `docker inspect` can return a resolved-but-labelless config — exit 0, empty
 * output. Reading a single key by name renders that identically to a genuinely
 * unlabeled image, which is how a self-healing 30-second window produced
 * spawn refusals telling the operator to rebuild a perfectly good image
 * (2026-09-01/02: refusals at 00:25:02Z while a spawn 90ms later passed the
 * same check on the same tag). So we read the whole label map and give an
 * absent map exactly one re-read before refusing.
 */
import { createHash } from 'crypto';
import { readFile, stat } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

import { CONTAINER_IMAGE, REPO_ROOT } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';

const execFileAsync = promisify(execFile);

const LABEL_KEY = 'nanoclaw.agentRunnerDepsHash';
const PKG_PATH = path.join(REPO_ROOT, 'container/agent-runner/package.json');
const LOCK_PATH = path.join(REPO_ROOT, 'container/agent-runner/bun.lock');

export type LabelLookup =
  | { kind: 'found'; value: string }
  | { kind: 'missing' } // image carries labels, ours isn't among them (old build.sh)
  | { kind: 'unresolved' } // no label map came back at all — ambiguous, see below
  | { kind: 'no-image' } // docker doesn't know this image ref
  | { kind: 'inspect-error'; reason: string }; // daemon down, timeout, permissions, etc.

export interface DepsDriftCheck {
  ok: boolean;
  imageRef: string;
  expected: string | null;
  actual: string | null;
  lookup: LabelLookup;
  /** True when the first read came back 'unresolved' and we re-read once. */
  retried: boolean;
  message: string;
}

/**
 * Delay before the single re-read of an 'unresolved' label map. Long enough to
 * clear a BuildKit image-export window, short enough that a genuinely
 * unlabeled image still fails the spawn well inside one sweep cycle.
 */
export const LABEL_RETRY_DELAY_MS = 2_000;

/** Raw `docker inspect` stdout producer — the one seam tests replace. */
export type InspectRunner = (imageRef: string) => Promise<string>;

export interface DriftCheckOptions {
  /** Test seam: stands in for the real `docker inspect`. */
  inspect?: InspectRunner;
  /** Test seam: transient re-read delay; defaults to LABEL_RETRY_DELAY_MS. */
  retryDelayMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** package.json + bun.lock identity at the moment a cached result was produced. */
interface DepsFileFingerprint {
  pkgMtimeMs: number;
  pkgSize: number;
  lockMtimeMs: number;
  lockSize: number;
}

interface CachedDriftCheck {
  fingerprint: DepsFileFingerprint;
  result: DepsDriftCheck;
  cachedAt: number;
}

/**
 * Cache lifetime. The fingerprint (package.json/bun.lock mtime+size) only
 * catches drift introduced by editing those files — it says nothing about
 * the image itself being removed or retagged out-of-band (`docker rmi`, a
 * manual `docker tag` to something else) while the files stay untouched. An
 * unbounded cache would then serve a stale `ok: true` forever: `docker run`
 * fails downstream, but `requestContainerRebuild` in container-runner.ts is
 * only called when this check itself returns `!ok`, so that failure mode
 * would never self-heal. Bounding the cache to one host-sweep cycle keeps
 * the common-case win (a burst of near-simultaneous spawns across many
 * sessions/agent groups shares one check) while guaranteeing every image is
 * re-verified against reality at least this often, same order of magnitude
 * as the sweep that already retries refused spawns.
 */
export const DEPS_DRIFT_CACHE_TTL_MS = 60_000;

/**
 * imageRef -> last known-good (ok: true) result + the file fingerprint it was
 * computed against. Only ever holds passing results — see the module doc
 * comment above for why failures are never cached. Module-scoped, so it
 * lives for the host process's lifetime and is naturally cleared by a
 * restart, same as the rest of this check was already implicitly
 * process-lifetime-scoped (nothing here was ever persisted).
 */
const okResultCache = new Map<string, CachedDriftCheck>();

async function currentDepsFileFingerprint(): Promise<DepsFileFingerprint> {
  const [pkgStat, lockStat] = await Promise.all([stat(PKG_PATH), stat(LOCK_PATH)]);
  return {
    pkgMtimeMs: pkgStat.mtimeMs,
    pkgSize: pkgStat.size,
    lockMtimeMs: lockStat.mtimeMs,
    lockSize: lockStat.size,
  };
}

function fingerprintsMatch(a: DepsFileFingerprint, b: DepsFileFingerprint): boolean {
  return (
    a.pkgMtimeMs === b.pkgMtimeMs &&
    a.pkgSize === b.pkgSize &&
    a.lockMtimeMs === b.lockMtimeMs &&
    a.lockSize === b.lockSize
  );
}

/**
 * Test-only: clear the result cache and any coalesced in-flight check so
 * cases don't leak state across `it()` blocks. inFlightChecks self-cleans on
 * settle, so it's normally already empty between tests — cleared here too
 * defensively, in case a test ever leaves one unawaited.
 */
export function resetDepsDriftCacheForTests(): void {
  okResultCache.clear();
  inFlightChecks.clear();
}

async function fileSha256Hex(p: string): Promise<string> {
  const buf = await readFile(p);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Hash = sha256(sha256(package.json) || sha256(bun.lock)), 16 hex chars.
 * Must stay byte-identical to container/build.sh — change them in lockstep.
 */
export async function computeAgentRunnerDepsHash(): Promise<string> {
  const [pkgHash, lockHash] = await Promise.all([fileSha256Hex(PKG_PATH), fileSha256Hex(LOCK_PATH)]);
  return createHash('sha256')
    .update(pkgHash + lockHash)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Read the image's WHOLE label map, not just our key.
 *
 * `{{index .Config.Labels "<key>"}}` cannot tell "this image has labels and
 * ours is not one of them" apart from "no label map resolved at all": docker
 * prints an empty line and exits 0 for both. That conflation is what made a
 * transient read look like a permanently broken image (see classifyLabels).
 *
 * --type=image: `docker inspect <name>` is ambiguous across object types
 * (image / container / volume / network). Without --type a name collision
 * could surface container metadata and falsely report a missing label.
 */
const dockerInspectLabels: InspectRunner = async (imageRef) => {
  const { stdout } = await execFileAsync(
    CONTAINER_RUNTIME_BIN,
    ['inspect', '--type=image', '--format', '{{json .Config.Labels}}', imageRef],
    { timeout: 10_000 },
  );
  return stdout;
};

/**
 * Classify one `{{json .Config.Labels}}` read.
 *
 * `null` / empty is NOT evidence of an unlabeled image. On a containerd image
 * store the canonical tag resolves to an OCI image index (BuildKit exports one
 * whenever attestations are on), and resolving `.Config` for an index means
 * picking the host-platform child manifest and reading its config blob. While
 * an export is rewriting that index the resolution can come back with no label
 * map — exit 0, empty output. So an absent map is 'unresolved' (ambiguous,
 * worth one re-read); only a map that resolved and genuinely lacks our key is
 * 'missing' (settled: this image really was built by an older build.sh).
 */
export function classifyLabels(stdout: string): LabelLookup {
  const raw = stdout.trim();
  if (!raw || raw === 'null' || raw === '<no value>') return { kind: 'unresolved' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'inspect-error', reason: `unparseable label output: ${raw.slice(0, 120)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'unresolved' };
  const labels = parsed as Record<string, unknown>;
  const value = labels[LABEL_KEY];
  if (typeof value === 'string' && value !== '') return { kind: 'found', value };
  // An empty map is the same ambiguous "config resolved to nothing" shape as
  // `null`; a populated map without our key is a settled answer.
  return Object.keys(labels).length === 0 ? { kind: 'unresolved' } : { kind: 'missing' };
}

/**
 * Inspect the image's labels, distinguishing operational failures (daemon
 * down, timeout) from "image is labeled but not by us", "no label map
 * resolved" and "image not found." Conflating these would send operators to
 * the wrong remediation.
 */
async function lookupImageLabel(imageRef: string, inspect: InspectRunner): Promise<LabelLookup> {
  try {
    return classifyLabels(await inspect(imageRef));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // `docker inspect` writes "Error: No such object: <ref>" / "No such image"
    // to stderr and exits 1. node's execFile surfaces it in the thrown error.
    if (/No such (object|image|container)/i.test(msg)) {
      return { kind: 'no-image' };
    }
    return { kind: 'inspect-error', reason: msg };
  }
}

function rebuildHint(imageRef: string): string {
  if (imageRef === CONTAINER_IMAGE) {
    return 'cd container/agent-runner && bun install && cd ../.. && ./container/build.sh';
  }
  // Per-agent override (buildAgentGroupImage / install_packages). Rebuilding
  // just the base does NOT update the derived image — operator must re-run
  // install_packages so the derived image inherits the freshly-stamped label.
  return (
    'this is a per-agent override image (built via install_packages). ' +
    'Rebuild the base first: cd container/agent-runner && bun install && cd ../.. && ./container/build.sh — ' +
    'then re-run the install_packages self-mod (or equivalent) so the derived image inherits the new label.'
  );
}

/**
 * imageRef -> the in-flight check for it, if one is already running. Coalesces
 * concurrent calls into a single check: wakeRepositoryMountSessions
 * (src/container-restart.ts) fires wakeContainer for every session in a
 * repository-mount group WITHOUT awaiting between them, so a burst of spawns
 * sharing an image can all reach checkAgentRunnerDepsDrift before any one of
 * them has populated okResultCache — without this, each would independently
 * pay the full file-hash + docker-inspect (+ possible retry-sleep) cost,
 * defeating the point of caching for exactly the burst case it's meant to
 * help most. The entry is removed once the check settles (success or
 * failure) so the next call — including one arriving microtasks later, once
 * this one already resolved — goes through okResultCache/TTL normally rather
 * than being coalesced onto a check that isn't running anymore.
 */
const inFlightChecks = new Map<string, Promise<DepsDriftCheck>>();

/**
 * Check the given image (defaults to CONTAINER_IMAGE — the shared base).
 * Per-agent images built via install_packages override the spawn image, so
 * spawnContainer passes the resolved containerConfig.imageTag to catch
 * derived-image drift too. Docker label inheritance means per-agent images
 * derived FROM a freshly-rebuilt base get the new label automatically.
 *
 * Thin coalescing wrapper around performDriftCheck — see inFlightChecks doc
 * comment for why. Concurrent callers for the same imageRef share one
 * in-flight check and its result (including the options — inspect/
 * retryDelayMs — of whichever call started it); a call that arrives after
 * the in-flight one has already settled runs its own fresh check (subject to
 * okResultCache as usual), it is never coalesced onto a finished promise.
 */
export async function checkAgentRunnerDepsDrift(
  imageRef: string = CONTAINER_IMAGE,
  options: DriftCheckOptions = {},
): Promise<DepsDriftCheck> {
  const existing = inFlightChecks.get(imageRef);
  if (existing) {
    return existing;
  }
  const check = performDriftCheck(imageRef, options).finally(() => {
    inFlightChecks.delete(imageRef);
  });
  inFlightChecks.set(imageRef, check);
  return check;
}

async function performDriftCheck(imageRef: string, options: DriftCheckOptions): Promise<DepsDriftCheck> {
  const inspect = options.inspect ?? dockerInspectLabels;
  const retryDelayMs = options.retryDelayMs ?? LABEL_RETRY_DELAY_MS;

  // Cheap up front (two stat calls) so it's worth doing even on a miss: if
  // package.json/bun.lock haven't moved since the last *passing* check for
  // this exact imageRef, skip re-hashing the files and re-inspecting the
  // image entirely — that's the `docker inspect` round-trip (and, on a
  // relabel race, the LABEL_RETRY_DELAY_MS pause) most spawns pay for a
  // question that was already answered "yes, in sync".
  const fingerprint = await currentDepsFileFingerprint();
  const cached = okResultCache.get(imageRef);
  if (
    cached &&
    fingerprintsMatch(cached.fingerprint, fingerprint) &&
    Date.now() - cached.cachedAt < DEPS_DRIFT_CACHE_TTL_MS
  ) {
    return cached.result;
  }

  const [expected, first] = await Promise.all([computeAgentRunnerDepsHash(), lookupImageLabel(imageRef, inspect)]);

  // A label map that didn't resolve is ambiguous, and the ambiguity is
  // self-clearing: re-read once after a short pause. Exactly one retry — a
  // genuinely unlabeled image must still refuse the spawn loudly, and the
  // spawn path is not allowed to sit here polling.
  let lookup = first;
  let retried = false;
  if (lookup.kind === 'unresolved') {
    retried = true;
    await sleep(retryDelayMs);
    lookup = await lookupImageLabel(imageRef, inspect);
  }

  const result: DepsDriftCheck = ((): DepsDriftCheck => {
    switch (lookup.kind) {
      case 'inspect-error':
        return {
          ok: false,
          imageRef,
          expected,
          actual: null,
          lookup,
          retried,
          message: `agent-runner deps check: docker inspect ${imageRef} failed, so no label was read (${lookup.reason}). This is an inspect failure, NOT a missing label — verify the container runtime is reachable before rebuilding anything.`,
        };
      case 'no-image':
        return {
          ok: false,
          imageRef,
          expected,
          actual: null,
          lookup,
          retried,
          message: `agent-runner image ${imageRef} not found — build it: ${rebuildHint(imageRef)}`,
        };
      case 'missing':
      case 'unresolved': {
        // The image inspected cleanly and still has no deps-hash label — either
        // it carries other labels but not ours ('missing'), or two reads a
        // retry-delay apart both came back with no label map at all
        // ('unresolved'). Two interpretations:
        //  - For the shared base image, this means an older build.sh was used →
        //    require a rebuild (fail closed).
        //  - For an admin-set image_tag override, this can legitimately be a
        //    custom prebuilt image that never went through container/build.sh.
        //    Permanently blocking those would lock admins out of their override.
        //    Fail open with a warning — operator opted into the override.
        const evidence =
          lookup.kind === 'missing'
            ? 'the image is labeled but carries no such label'
            : `no label map resolved on two reads ${retryDelayMs}ms apart`;
        if (imageRef !== CONTAINER_IMAGE) {
          return {
            ok: true,
            imageRef,
            expected,
            actual: null,
            lookup,
            retried,
            message: `agent-runner image ${imageRef} has no ${LABEL_KEY} label (${evidence}) — treating admin-set image_tag override as opt-out from drift check. If this is a derived image from ${CONTAINER_IMAGE}, rebuild base then re-run install_packages.`,
          };
        }
        return {
          ok: false,
          imageRef,
          expected,
          actual: null,
          lookup,
          retried,
          message: `agent-runner image ${imageRef} has no ${LABEL_KEY} label (${evidence}; built by an older build.sh) — rebuild: ${rebuildHint(imageRef)}`,
        };
      }
      case 'found': {
        const actual = lookup.value;
        if (actual !== expected) {
          return {
            ok: false,
            imageRef,
            expected,
            actual,
            lookup,
            retried,
            message: `agent-runner deps drift on ${imageRef}: image baked from ${actual}, current files hash to ${expected}. Run: ${rebuildHint(imageRef)}`,
          };
        }
        return { ok: true, imageRef, expected, actual, lookup, retried, message: 'agent-runner deps in sync' };
      }
    }
  })();

  // Only a passing result is safe to cache — see the module doc comment for
  // why a failure never is. The fingerprint captured at the top of this call
  // is the right key: if the files change between now and the next call,
  // that call's own fingerprint won't match and it re-checks for real.
  if (result.ok) {
    okResultCache.set(imageRef, { fingerprint, result, cachedAt: Date.now() });
  }
  return result;
}
