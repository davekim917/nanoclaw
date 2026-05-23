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
 * Intentionally uncached: the failure mode is exactly "operator edits
 * package.json without rebuilding", so a cache keyed on imageRef alone would
 * mask the very edits we're guarding against. ~50ms per spawn (two file reads
 * + one docker inspect) is negligible against multi-second spawn cost.
 */
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
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
  | { kind: 'missing' } // image exists but has no label (built by an old build.sh)
  | { kind: 'no-image' } // docker doesn't know this image ref
  | { kind: 'inspect-error'; reason: string }; // daemon down, timeout, permissions, etc.

export interface DepsDriftCheck {
  ok: boolean;
  imageRef: string;
  expected: string | null;
  actual: string | null;
  lookup: LabelLookup;
  message: string;
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
 * Inspect the image's deps-hash label, distinguishing operational failures
 * (daemon down, timeout) from "image exists but unlabeled" and "image not
 * found." Conflating these would send operators to the wrong remediation.
 */
async function lookupImageLabel(imageRef: string): Promise<LabelLookup> {
  try {
    const { stdout } = await execFileAsync(
      CONTAINER_RUNTIME_BIN,
      // --type=image: `docker inspect <name>` is ambiguous across object types
      // (image / container / volume / network). Without --type a name collision
      // could surface container metadata and falsely report a missing label.
      ['inspect', '--type=image', '--format', `{{index .Config.Labels "${LABEL_KEY}"}}`, imageRef],
      { timeout: 10_000 },
    );
    const v = stdout.trim();
    if (v && v !== '<no value>') return { kind: 'found', value: v };
    return { kind: 'missing' };
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
 * Check the given image (defaults to CONTAINER_IMAGE — the shared base).
 * Per-agent images built via install_packages override the spawn image, so
 * spawnContainer passes the resolved containerConfig.imageTag to catch
 * derived-image drift too. Docker label inheritance means per-agent images
 * derived FROM a freshly-rebuilt base get the new label automatically.
 */
export async function checkAgentRunnerDepsDrift(imageRef: string = CONTAINER_IMAGE): Promise<DepsDriftCheck> {
  const [expected, lookup] = await Promise.all([computeAgentRunnerDepsHash(), lookupImageLabel(imageRef)]);

  switch (lookup.kind) {
    case 'inspect-error':
      return {
        ok: false,
        imageRef,
        expected,
        actual: null,
        lookup,
        message: `agent-runner deps check: docker inspect ${imageRef} failed (${lookup.reason}). Not necessarily a drift — verify the container runtime is reachable.`,
      };
    case 'no-image':
      return {
        ok: false,
        imageRef,
        expected,
        actual: null,
        lookup,
        message: `agent-runner image ${imageRef} not found — build it: ${rebuildHint(imageRef)}`,
      };
    case 'missing': {
      // Image exists but lacks our label. Two interpretations:
      //  - For the shared base image, this means an older build.sh was used →
      //    require a rebuild (fail closed).
      //  - For an admin-set image_tag override, this can legitimately be a
      //    custom prebuilt image that never went through container/build.sh.
      //    Permanently blocking those would lock admins out of their override.
      //    Fail open with a warning — operator opted into the override.
      if (imageRef !== CONTAINER_IMAGE) {
        return {
          ok: true,
          imageRef,
          expected,
          actual: null,
          lookup,
          message: `agent-runner image ${imageRef} has no ${LABEL_KEY} label — treating admin-set image_tag override as opt-out from drift check. If this is a derived image from ${CONTAINER_IMAGE}, rebuild base then re-run install_packages.`,
        };
      }
      return {
        ok: false,
        imageRef,
        expected,
        actual: null,
        lookup,
        message: `agent-runner image ${imageRef} has no ${LABEL_KEY} label (built by an older build.sh) — rebuild: ${rebuildHint(imageRef)}`,
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
          message: `agent-runner deps drift on ${imageRef}: image baked from ${actual}, current files hash to ${expected}. Run: ${rebuildHint(imageRef)}`,
        };
      }
      return { ok: true, imageRef, expected, actual, lookup, message: 'agent-runner deps in sync' };
    }
  }
}
