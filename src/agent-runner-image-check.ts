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
 * compare the on-disk hash against the image label. Mismatch → refuse to
 * spawn with an actionable message naming the rebuild command.
 *
 * Caches the OK result for the process lifetime so repeated spawns skip the
 * docker inspect. Drift results are NOT cached — the next spawn after
 * `./container/build.sh` picks up the new label without a host restart.
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

let cachedOk = false;

export interface DepsDriftCheck {
  ok: boolean;
  expected: string | null;
  actual: string | null;
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
  return createHash('sha256').update(pkgHash + lockHash).digest('hex').slice(0, 16);
}

async function imageLabel(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      CONTAINER_RUNTIME_BIN,
      ['inspect', '--format', `{{index .Config.Labels "${LABEL_KEY}"}}`, CONTAINER_IMAGE],
      { timeout: 10_000 },
    );
    const v = stdout.trim();
    return v && v !== '<no value>' ? v : null;
  } catch {
    return null;
  }
}

export async function checkAgentRunnerDepsDrift(): Promise<DepsDriftCheck> {
  if (cachedOk) {
    return { ok: true, expected: null, actual: null, message: 'cached OK' };
  }
  const [expected, actual] = await Promise.all([computeAgentRunnerDepsHash(), imageLabel()]);
  const rebuildHint = 'cd container/agent-runner && bun install && cd ../.. && ./container/build.sh';
  if (actual === null) {
    return {
      ok: false,
      expected,
      actual: null,
      message: `agent-runner image ${CONTAINER_IMAGE} missing ${LABEL_KEY} label — rebuild needed: ${rebuildHint}`,
    };
  }
  if (actual !== expected) {
    return {
      ok: false,
      expected,
      actual,
      message: `agent-runner deps drift: image baked from ${actual}, current files hash to ${expected}. Run: ${rebuildHint}`,
    };
  }
  cachedOk = true;
  return { ok: true, expected, actual, message: 'agent-runner deps in sync' };
}

export function _resetCacheForTests(): void {
  cachedOk = false;
}
