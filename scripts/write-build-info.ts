#!/usr/bin/env tsx
/**
 * Postbuild stamp: records what was actually compiled into dist/, so "what
 * is actually deployed" is answerable after the fact. Written after tsc (and
 * build:spa) so dist/ exists. `dirty` is true only when the prebuild guard
 * (scripts/check-build-clean.ts) let a dirty tree through via
 * BUILD_ALLOW_DIRTY=1 — a build reaching this script on a dirty tree implies
 * the escape hatch was used, since the guard would otherwise have failed it.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const shortSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '';

const buildInfo = {
  sha,
  shortSha,
  builtAt: new Date().toISOString(),
  branch,
  dirty,
};

fs.writeFileSync(path.join('dist', 'BUILD_INFO.json'), JSON.stringify(buildInfo, null, 2) + '\n');
console.log(`dist/BUILD_INFO.json written (${shortSha}${dirty ? ', dirty' : ''})`);
