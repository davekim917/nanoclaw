/**
 * Upstream mailbox-seam manifest: UPSTREAM_FILES are ported byte-for-byte from upstream and must never be
 * hand-edited (src/mailbox-seam-upstream.test.ts fails on drift). To sync with a newer upstream, run
 * `pnpm exec tsx scripts/mailbox-seam-manifest.ts --update <upstream-sha>` from a worktree holding upstream's
 * objects and commit the regenerated manifest with the ported changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashFilesAtGitSha } from './seam-manifest-git.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_PATH = path.join(REPO_ROOT, 'src/mailbox/UPSTREAM-MANIFEST.json');

/** Both compose.ts files are the sanctioned fork edit points (they register the fork's mailbox) and are excluded. */
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
  // 'container/agent-runner/src/mailbox/sqlite/connection.ts' — FORK DIVERGED, see FORK_DIVERGED_UPSTREAM_FILES.
  // 'container/agent-runner/src/mailbox/sqlite/index.ts' — FORK DIVERGED, see FORK_DIVERGED_UPSTREAM_FILES.
  'container/agent-runner/src/mailbox/sqlite/operations.ts',
  // 'container/agent-runner/src/mailbox/sqlite/sqlite.test.ts' — FORK DIVERGED, see FORK_DIVERGED_UPSTREAM_FILES.
  // 'container/agent-runner/src/mailbox/types.ts' — FORK DIVERGED, see FORK_DIVERGED_UPSTREAM_FILES.
  'container/agent-runner/src/modules/index.ts',
  'container/agent-runner/src/heartbeat.ts',
  'container/agent-runner/src/db/container-state.ts',
  'container/agent-runner/src/db/index.ts',
  'container/agent-runner/src/db/messages-out.ts',
  'container/agent-runner/src/db/session-routing.ts',
  'container/agent-runner/src/db/session-state.ts',
  // The runner registry test asserts its exact `preload` line.
  'container/agent-runner/bunfig.toml',
] as const;

/** Not yet ported; each must land no later than its half of RATCHET.json is done (mailbox-seam-ratchet.test.ts). */
export const DEFERRED_UPSTREAM_FILES: readonly string[] = [] as const;

/**
 * Upstream files this fork CANNOT carry byte-for-byte, each with the fork-owned test covering the same invariants.
 * Never a deferral: in UPSTREAM_FILES they would be a permanently red test.
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
 * Ported from upstream, since hand-edited for fork-only features, so never expected to match upstream's hash again;
 * tracked by name so a re-port is a reviewed act, not a silent --update overwrite. Fork additions: messages-in.ts
 * `scheduled_for` (a retry backoff must not rewrite an occurrence's slot); connection.ts
 * refuseProductionSessionDbUnderTest; sqlite/index.ts, sqlite.test.ts and types.ts the task-list reads.
 */
export const FORK_DIVERGED_UPSTREAM_FILES: readonly string[] = [
  'container/agent-runner/src/db/messages-in.ts',
  'container/agent-runner/src/mailbox/sqlite/connection.ts',
  'container/agent-runner/src/mailbox/sqlite/index.ts',
  'container/agent-runner/src/mailbox/sqlite/sqlite.test.ts',
  'container/agent-runner/src/mailbox/types.ts',
] as const;

export interface MailboxSeamManifest {
  upstream: string;
  files: Record<string, string>;
}

/** Hashes upstream's copy of every UPSTREAM_FILES entry at the given sha, via `git show`. */
export function computeManifestFromGit(upstreamSha: string): MailboxSeamManifest {
  return {
    upstream: upstreamSha,
    files: hashFilesAtGitSha('mailbox-seam-manifest', REPO_ROOT, upstreamSha, UPSTREAM_FILES),
  };
}

export function readManifest(): MailboxSeamManifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as MailboxSeamManifest;
}

export function writeManifest(manifest: MailboxSeamManifest): void {
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
}
