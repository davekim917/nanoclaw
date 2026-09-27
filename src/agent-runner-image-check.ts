/**
 * Agent-runner deps drift check. Runner source is bind-mounted live but node_modules are baked into the image, so
 * a new dependency without a rebuild crash-loops every fresh spawn silently. `container/build.sh` stamps a hash
 * of package.json + bun.lock as an image LABEL; a mismatch refuses the spawn with the rebuild command.
 *
 * Only passing results are cached, keyed on imageRef plus the files' mtime+size (so any edit re-checks) and
 * bounded by a TTL (the image can vanish without a file edit). Failures are never cached: their fix is a rebuild,
 * which touches neither file. Concurrent checks are coalesced.
 *
 * During a containerd image-index rewrite, `docker inspect` can return an empty label map (exit 0), which a
 * single-key read cannot tell from an unlabeled image; the whole map is read and an absent one gets one re-read.
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
  | { kind: 'missing' }
  | { kind: 'unresolved' }
  | { kind: 'no-image' }
  | { kind: 'inspect-error'; reason: string };

export interface DepsDriftCheck {
  ok: boolean;
  imageRef: string;
  expected: string | null;
  actual: string | null;
  lookup: LabelLookup;
  retried: boolean;
  message: string;
}

/** Clears a BuildKit export window while an unlabeled image still fails well inside one sweep cycle. */
export const LABEL_RETRY_DELAY_MS = 2_000;

/** Raw `docker inspect` stdout producer — the one seam tests replace. */
type InspectRunner = (imageRef: string) => Promise<string>;

export interface DriftCheckOptions {
  inspect?: InspectRunner;
  retryDelayMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
 * One sweep cycle: a `docker rmi`/retag leaves the files untouched, and since a rebuild is requested only when this
 * check fails, an unbounded passing cache would never self-heal.
 */
export const DEPS_DRIFT_CACHE_TTL_MS = 60_000;

/** Passing results only, for the process lifetime. */
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

export function resetDepsDriftCacheForTests(): void {
  okResultCache.clear();
  inFlightChecks.clear();
}

async function fileSha256Hex(p: string): Promise<string> {
  const buf = await readFile(p);
  return createHash('sha256').update(buf).digest('hex');
}

/** sha256(sha256(package.json) || sha256(bun.lock)), 16 hex chars; must stay byte-identical to container/build.sh. */
export async function computeAgentRunnerDepsHash(): Promise<string> {
  const [pkgHash, lockHash] = await Promise.all([fileSha256Hex(PKG_PATH), fileSha256Hex(LOCK_PATH)]);
  return createHash('sha256')
    .update(pkgHash + lockHash)
    .digest('hex')
    .slice(0, 16);
}

/**
 * The WHOLE label map: an index read prints an empty line for both "no map" and "not our key". `--type=image`
 * keeps a same-named container from answering.
 */
const dockerInspectLabels: InspectRunner = async (imageRef) => {
  const { stdout } = await execFileAsync(
    CONTAINER_RUNTIME_BIN,
    ['inspect', '--type=image', '--format', '{{json .Config.Labels}}', imageRef],
    { timeout: 10_000 },
  );
  return stdout;
};

/** An absent or empty map is 'unresolved' (worth one re-read); a map lacking our key is 'missing' (older build.sh). */
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
  return Object.keys(labels).length === 0 ? { kind: 'unresolved' } : { kind: 'missing' };
}

/** Distinguishes daemon failure, missing image, unresolved map and missing label; each has a different remedy. */
async function lookupImageLabel(imageRef: string, inspect: InspectRunner): Promise<LabelLookup> {
  try {
    return classifyLabels(await inspect(imageRef));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
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
  // Rebuilding the base does not update a derived per-agent image; install_packages must be re-run.
  return (
    'this is a per-agent override image (built via install_packages). ' +
    'Rebuild the base first: cd container/agent-runner && bun install && cd ../.. && ./container/build.sh — ' +
    'then re-run the install_packages self-mod (or equivalent) so the derived image inherits the new label.'
  );
}

/**
 * In-flight checks keyed on (imageRef, fingerprint): wakeRepositoryMountSessions spawns a burst without awaiting,
 * which would otherwise each pay the full check. A caller joins only a check against the fingerprint it observed,
 * and entries are removed on settle.
 */
const inFlightChecks = new Map<string, Promise<{ fingerprint: DepsFileFingerprint; result: DepsDriftCheck }>>();

function inFlightKey(imageRef: string, fingerprint: DepsFileFingerprint): string {
  return `${imageRef}::${fingerprint.pkgMtimeMs}:${fingerprint.pkgSize}:${fingerprint.lockMtimeMs}:${fingerprint.lockSize}`;
}

/**
 * Pass the resolved spawn image: per-agent images from install_packages override the base. Concurrent callers with
 * the same (imageRef, fingerprint) share one check, including the options of whichever call started it.
 */
export async function checkAgentRunnerDepsDrift(
  imageRef: string = CONTAINER_IMAGE,
  options: DriftCheckOptions = {},
): Promise<DepsDriftCheck> {
  const fingerprint = await currentDepsFileFingerprint();
  const key = inFlightKey(imageRef, fingerprint);

  const existing = inFlightChecks.get(key);
  if (existing) {
    return (await existing).result;
  }

  const check = performDriftCheck(imageRef, options, fingerprint)
    .then((result) => ({ fingerprint, result }))
    .finally(() => {
      inFlightChecks.delete(key);
    });
  inFlightChecks.set(key, check);
  return (await check).result;
}

async function performDriftCheck(
  imageRef: string,
  options: DriftCheckOptions,
  fingerprint: DepsFileFingerprint,
): Promise<DepsDriftCheck> {
  const inspect = options.inspect ?? dockerInspectLabels;
  const retryDelayMs = options.retryDelayMs ?? LABEL_RETRY_DELAY_MS;

  // Two stats (by the caller) skip hashing and `docker inspect` when the files have not moved since a pass.
  const cached = okResultCache.get(imageRef);
  if (
    cached &&
    fingerprintsMatch(cached.fingerprint, fingerprint) &&
    Date.now() - cached.cachedAt < DEPS_DRIFT_CACHE_TTL_MS
  ) {
    return cached.result;
  }

  const [expected, first] = await Promise.all([computeAgentRunnerDepsHash(), lookupImageLabel(imageRef, inspect)]);

  // Exactly one re-read: a genuinely unlabeled image must still refuse, and the spawn path must not poll.
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
        // Still no deps-hash label: the base image needs a rebuild (fail closed), but an admin image_tag override
        // may be a custom prebuilt image, so that fails open with a warning.
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

  if (result.ok) {
    okResultCache.set(imageRef, { fingerprint, result, cachedAt: Date.now() });
  }
  return result;
}
