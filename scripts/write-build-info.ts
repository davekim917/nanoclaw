#!/usr/bin/env tsx
/**
 * Postbuild stamp: records what was actually compiled into dist/, so "what
 * is actually deployed" is answerable after the fact. Written after tsc (and
 * build:spa) so dist/ exists. `dirty` is true only when the tree carries
 * build-blocking dirt — the same partition the prebuild guard
 * (scripts/check-build-clean.ts) uses. A build can reach this script on a
 * dirty tree two ways: BUILD_ALLOW_DIRTY=1 let blocking dirt through, or the
 * dirt was docs-only and never blocked in the first place. Only the former
 * should stamp dirty:true.
 *
 * Second check: the prebuild guard writes the HEAD sha it built the freshness
 * check against to dist/.build-start-sha. If HEAD has since moved (a peer
 * committed and reset local main mid-build, say) or new build-blocking dirt
 * has appeared that wasn't allowed via BUILD_ALLOW_DIRTY at prebuild time, the
 * tree tsc actually compiled no longer matches what's on disk now — refuse
 * and remove any BUILD_INFO.json rather than stamp a build that doesn't match
 * either the tree it started from or the tree it finished on.
 *
 * Third check, closing a gap in the second: BUILD_ALLOW_DIRTY=1 must waive
 * the "new blocking dirt" refusal for exactly the dirt present at prebuild
 * time, not for any blocking dirt whatsoever — otherwise a peer's mid-build
 * edit to an already-dirty (or newly dirty) file would be silently accepted
 * just because *some* dirt was already permitted. dist/.build-allowed-dirt-fingerprint
 * (written by the prebuild guard) is compared against a fresh fingerprint of
 * the current blocking dirt; a mismatch under BUILD_ALLOW_DIRTY still refuses.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fingerprintDirt, partitionDirt } from './check-build-clean.js';

const BUILD_INFO_PATH = path.join('dist', 'BUILD_INFO.json');
const START_SHA_PATH = path.join('dist', '.build-start-sha');
const ALLOWED_DIRT_FINGERPRINT_PATH = path.join('dist', '.build-allowed-dirt-fingerprint');

export interface PostbuildCheck {
  ok: boolean;
  /** Printed via console.error when refused. Null when the build is consistent. */
  message: string | null;
}

/**
 * Decides whether the build that just finished is still trustworthy: HEAD
 * must not have moved since the prebuild guard recorded it, and no new
 * build-blocking dirt may have appeared — even under BUILD_ALLOW_DIRTY,
 * which only waives the check for the SAME dirt (by content fingerprint)
 * that was present at prebuild time, not for whatever is dirty now.
 */
export function checkBuildDidNotMove(params: {
  startSha: string | null;
  currentSha: string;
  blockingDirtNow: boolean;
  allowDirty: boolean;
  startDirtFingerprint: string | null;
  currentDirtFingerprint: string;
}): PostbuildCheck {
  const { startSha, currentSha, blockingDirtNow, allowDirty, startDirtFingerprint, currentDirtFingerprint } = params;

  // No recorded start sha (e.g. write-build-info.ts run directly, without the
  // prebuild guard having run first) — nothing to compare against.
  if (startSha === null) return { ok: true, message: null };

  if (startSha !== currentSha) {
    return {
      ok: false,
      message: `BUILD REFUSED: HEAD moved during the build (started at ${startSha}, now at ${currentSha}).`,
    };
  }

  if (blockingDirtNow) {
    if (!allowDirty) {
      return {
        ok: false,
        message:
          'BUILD REFUSED: HEAD moved during the build (the working tree picked up new build-blocking changes since the prebuild check ran).',
      };
    }
    // BUILD_ALLOW_DIRTY waives the refusal above, but only for the dirt that
    // was actually present at prebuild time — a mismatched fingerprint means
    // the allowed dirt's content (or membership) changed mid-build, which is
    // exactly the drift this whole guard exists to catch.
    if (startDirtFingerprint !== null && startDirtFingerprint !== currentDirtFingerprint) {
      return {
        ok: false,
        message:
          'BUILD REFUSED: HEAD moved during the build (the BUILD_ALLOW_DIRTY-permitted dirt changed content since the prebuild check ran).',
      };
    }
  }

  return { ok: true, message: null };
}

function main(): void {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const shortSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  // See scripts/check-build-clean.ts's main() for why the raw output is split
  // before trimming: a leading-space status code on the first line would
  // otherwise be swallowed by a whole-string .trim(), corrupting path parsing.
  const rawStatus = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  const statusLines = rawStatus.trim() ? rawStatus.split('\n').filter((line) => line.length > 0) : [];
  const currentBlocking = partitionDirt(statusLines).blocking;
  const dirty = currentBlocking.length > 0;

  let startSha: string | null;
  try {
    startSha = fs.readFileSync(START_SHA_PATH, 'utf8').trim();
  } catch {
    startSha = null;
  }

  let startDirtFingerprint: string | null;
  try {
    startDirtFingerprint = fs.readFileSync(ALLOWED_DIRT_FINGERPRINT_PATH, 'utf8').trim();
  } catch {
    startDirtFingerprint = null;
  }

  const moveCheck = checkBuildDidNotMove({
    startSha,
    currentSha: sha,
    blockingDirtNow: dirty,
    allowDirty: process.env.BUILD_ALLOW_DIRTY === '1',
    startDirtFingerprint,
    currentDirtFingerprint: fingerprintDirt(currentBlocking),
  });

  if (!moveCheck.ok) {
    console.error(moveCheck.message);
    try {
      fs.unlinkSync(BUILD_INFO_PATH);
    } catch {
      // nothing to remove — fine.
    }
    process.exit(1);
  }

  const buildInfo = {
    sha,
    shortSha,
    builtAt: new Date().toISOString(),
    branch,
    dirty,
  };

  fs.writeFileSync(BUILD_INFO_PATH, JSON.stringify(buildInfo, null, 2) + '\n');
  console.log(`dist/BUILD_INFO.json written (${shortSha}${dirty ? ', dirty' : ''})`);
}

// tsx runs this file directly; vitest imports it for the pure helper above,
// so guard the side-effecting entry point behind a direct-execution check.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
