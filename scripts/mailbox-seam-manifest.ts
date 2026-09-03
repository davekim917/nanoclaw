#!/usr/bin/env tsx
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
 * See docs/specs/upstream-mailbox-seam/plan.md §4.6.1.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'src/mailbox/UPSTREAM-MANIFEST.json');

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
  'src/mailbox/registry.test.ts',
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
function computeManifestFromGit(upstreamSha: string): MailboxSeamManifest {
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

function readManifest(): MailboxSeamManifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as MailboxSeamManifest;
}

function writeManifest(manifest: MailboxSeamManifest): void {
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
}

function main(): void {
  const args = process.argv.slice(2);
  const updateIdx = args.indexOf('--update');
  if (updateIdx === -1) {
    // No CLI action requested — just validate the file exists and print it.
    console.log(JSON.stringify(readManifest(), null, 2));
    return;
  }
  const sha = args[updateIdx + 1];
  if (!sha) {
    console.error('Usage: mailbox-seam-manifest.ts --update <upstream-sha>');
    process.exit(1);
  }
  const manifest = computeManifestFromGit(sha);
  writeManifest(manifest);
  console.log(`Wrote ${MANIFEST_PATH} for upstream ${sha} (${Object.keys(manifest.files).length} files)`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
