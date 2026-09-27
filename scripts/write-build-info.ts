#!/usr/bin/env tsx
/**
 * Postbuild stamp of what was compiled into dist/. `dirty` is true only for build-blocking dirt
 * that BUILD_ALLOW_DIRTY=1 let through, not docs-only dirt.
 *
 * Refuses, removing any BUILD_INFO.json, when HEAD moved since the prebuild guard recorded it or
 * new blocking dirt appeared mid-build. BUILD_ALLOW_DIRTY waives only the dirt present at
 * prebuild time, compared by content fingerprint.
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

export function checkBuildDidNotMove(params: {
  startSha: string | null;
  currentSha: string;
  blockingDirtNow: boolean;
  allowDirty: boolean;
  startDirtFingerprint: string | null;
  currentDirtFingerprint: string;
}): PostbuildCheck {
  const { startSha, currentSha, blockingDirtNow, allowDirty, startDirtFingerprint, currentDirtFingerprint } = params;

  // No recorded start sha (run without the prebuild guard): nothing to compare against.
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
    // A mismatched fingerprint means the allowed dirt changed mid-build.
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
  // Split before trimming: a whole-string .trim() eats the first line's leading-space status code.
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
