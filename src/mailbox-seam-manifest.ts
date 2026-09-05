/**
 * Upstream mailbox-seam manifest.
 *
 * The files listed in UPSTREAM_FILES are ported byte-for-byte from upstream
 * nanocoai/nanoclaw and must never be hand-edited — src/mailbox-seam-upstream.test.ts
 * fails the build if any of them drifts from src/mailbox/UPSTREAM-MANIFEST.json.
 *
 * To intentionally sync with a newer upstream commit, re-run:
 *   pnpm exec tsx scripts/mailbox-seam-manifest.ts --update <upstream-sha>
 * from a worktree that has upstream's commit objects (e.g. after `git fetch
 * upstream`), review the resulting diff, then commit the regenerated manifest
 * alongside the ported file changes.
 *
 * See docs/specs/upstream-mailbox-seam/plan.md §4.6.1. Same vendor-then-CLI-shim
 * split as src/design-artifact-loop-vendor.ts + scripts/vendor-design-artifact-loop.ts
 * — the logic lives here (under src/, so src/*.test.ts can import it: the host
 * tsconfig's rootDir is src/), scripts/mailbox-seam-manifest.ts is a thin CLI shim.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_PATH = path.join(REPO_ROOT, 'src/mailbox/UPSTREAM-MANIFEST.json');

/**
 * Every file ported verbatim from upstream in this PR. Both compose.ts files
 * are the sanctioned fork edit points and are intentionally excluded — they
 * register the fork's mailbox implementation and are never byte-identical to
 * upstream's own compose.ts (which registers SqliteAgentMailbox directly).
 *
 * Grows as later PRs in the mailbox-seam series (R1, etc.) port more upstream
 * files (the runner's messages-in/messages-out/session-state/session-routing
 * compat shims) — add them here and re-run --update when that lands.
 */
export const UPSTREAM_FILES: readonly string[] = [
  // Host
  'src/mailbox/index.ts',
  'src/mailbox/model.test.ts',
  'src/mailbox/model.ts',
  // 'src/mailbox/registry.test.ts' — UNPORTABLE, see UNPORTABLE_UPSTREAM_FILES.
  'src/mailbox/sqlite/arm-next-task.test.ts',
  'src/mailbox/sqlite/index.ts',
  'src/mailbox/sqlite/paths.ts',
  'src/mailbox/sqlite/schema.ts',
  'src/mailbox/sqlite/session-db.test.ts',
  'src/mailbox/sqlite/session-db.ts',
  'src/mailbox/sqlite/sqlite.test.ts',
  'src/mailbox/sqlite/tasks.test.ts',
  'src/mailbox/sqlite/tasks.ts',
  'src/mailbox/types.ts',
  'docs/agent-mailbox-seam-migration.md',
  // Runner
  'container/agent-runner/src/mailbox/index.ts',
  'container/agent-runner/src/mailbox/model.generated.ts',
  'container/agent-runner/src/mailbox/registry.test.ts',
  'container/agent-runner/src/mailbox/sqlite/connection.ts',
  'container/agent-runner/src/mailbox/sqlite/index.ts',
  'container/agent-runner/src/mailbox/sqlite/operations.ts',
  'container/agent-runner/src/mailbox/sqlite/sqlite.test.ts',
  'container/agent-runner/src/mailbox/types.ts',
  'container/agent-runner/src/modules/index.ts',
  'container/agent-runner/src/heartbeat.ts',
  'container/agent-runner/src/db/container-state.ts',
  'container/agent-runner/src/db/index.ts',
  'container/agent-runner/src/db/messages-out.ts',
  'container/agent-runner/src/db/session-routing.ts',
  'container/agent-runner/src/db/session-state.ts',
  // Not in the plan's enumerated set, but the registry test ported in R3
  // asserts its exact `preload` line, so an unmanifested hand-edit would
  // silently break the guarantee that every runner entrypoint composes the
  // real barrel. Byte-identical to upstream.
  'container/agent-runner/bunfig.toml',
] as const;

/**
 * Deferred ported-file paths: not in UPSTREAM_FILES yet (they assert the end
 * state of the migration), but must land no later than their half of the
 * raw-access ratchet (RATCHET.json) being done — asserted in
 * src/mailbox-seam-ratchet.test.ts.
 */
export const DEFERRED_UPSTREAM_FILES: readonly string[] = [
  // Empty, and this is the PR that empties it. The runner half was ported in
  // R3 when its allowlist reached zero. The host half turned out to be
  // UNPORTABLE rather than merely deferred — see UNPORTABLE_UPSTREAM_FILES —
  // so nothing is waiting on a later PR any more.
] as const;

/**
 * Upstream files this fork CANNOT carry byte-for-byte, with the fork-owned
 * test that covers the same invariants instead.
 *
 * This is not a deferral and never becomes one: adding such a file to
 * UPSTREAM_FILES would put a permanently red test in CI. The ratchet test
 * asserts both halves of that — the replacement exists, and the upstream path
 * stays out of UPSTREAM_FILES.
 */
export const UNPORTABLE_UPSTREAM_FILES: ReadonlyArray<{
  upstream: string;
  forkTest: string;
  reason: string;
}> = [
  {
    upstream: 'src/mailbox/registry.test.ts',
    forkTest: 'src/modules/mailbox/registry.test.ts',
    reason:
      "Four assertions describe upstream's tree, not the migration's end state. It reads " +
      'src/modules/cross-session-context/prune.ts, which does not exist in this fork (theme T3 — scheduling — ' +
      'ported src/modules/scheduling/task-content.ts, so that half of the original objection no longer holds, ' +
      'but the assertion as a whole still describes upstream, not this fork). It forbids better-sqlite3 and ' +
      '.prepare( in session-manager.ts and host-sweep.ts, where the fork legitimately holds CENTRAL-DB access ' +
      'the seam never claimed. And it expects src/index.ts to import the modules barrel, where the fork keeps ' +
      'a three-line deploy crash-guard shim and the barrel import is one file further in (main.ts).',
  },
] as const;

/**
 * Files that WERE ported byte-for-byte from upstream but have since been
 * hand-edited for a fork-only feature. Unlike DEFERRED_UPSTREAM_FILES (not
 * yet ported, will become byte-identical later), these are never expected to
 * match upstream's hash again — the fork's own logic now lives in them. They
 * are tracked by name, not by hash, so a future re-port from a newer upstream
 * sha is a deliberate, reviewed act (diff against the sha in `upstream`
 * below) rather than a silent overwrite via --update.
 *
 * container/agent-runner/src/db/messages-in.ts: diverged in 1dfd2857
 * ("give a task occurrence its own scheduled_for") to add the fork-only
 * `scheduled_for` column so a retry backoff can't rewrite a task
 * occurrence's original slot. See docs/specs/upstream-mailbox-seam/plan.md.
 */
export const FORK_DIVERGED_UPSTREAM_FILES: readonly string[] = [
  'container/agent-runner/src/db/messages-in.ts',
] as const;

export interface MailboxSeamManifest {
  upstream: string;
  files: Record<string, string>;
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Hashes the working tree's current copy of every UPSTREAM_FILES entry. */
export function computeManifest(upstream: string): MailboxSeamManifest {
  const files: Record<string, string> = {};
  for (const relPath of UPSTREAM_FILES) {
    const abs = path.join(REPO_ROOT, relPath);
    if (!fs.existsSync(abs)) {
      throw new Error(`mailbox-seam-manifest: UPSTREAM_FILES entry missing from the working tree: ${relPath}`);
    }
    files[relPath] = sha256(fs.readFileSync(abs));
  }
  return { upstream, files: sortKeys(files) };
}

/** Hashes upstream's copy of every UPSTREAM_FILES entry at the given sha, via `git show`. */
export function computeManifestFromGit(upstreamSha: string): MailboxSeamManifest {
  const files: Record<string, string> = {};
  for (const relPath of UPSTREAM_FILES) {
    let content: Buffer;
    try {
      content = execFileSync('git', ['show', `${upstreamSha}:${relPath}`], {
        cwd: REPO_ROOT,
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (err) {
      throw new Error(
        `mailbox-seam-manifest: ${relPath} not found at upstream ${upstreamSha} (git show failed): ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    }
    files[relPath] = sha256(content);
  }
  return { upstream: upstreamSha, files: sortKeys(files) };
}

function sortKeys(files: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(files).sort()) sorted[key] = files[key];
  return sorted;
}

export function readManifest(): MailboxSeamManifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as MailboxSeamManifest;
}

export function writeManifest(manifest: MailboxSeamManifest): void {
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
}
