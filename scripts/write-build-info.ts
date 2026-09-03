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
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { partitionDirt } from './check-build-clean.js';

const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const shortSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
// See scripts/check-build-clean.ts's main() for why the raw output is split
// before trimming: a leading-space status code on the first line would
// otherwise be swallowed by a whole-string .trim(), corrupting path parsing.
const rawStatus = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
const statusLines = rawStatus.trim() ? rawStatus.split('\n').filter((line) => line.length > 0) : [];
const dirty = partitionDirt(statusLines).blocking.length > 0;

const buildInfo = {
  sha,
  shortSha,
  builtAt: new Date().toISOString(),
  branch,
  dirty,
};

fs.writeFileSync(path.join('dist', 'BUILD_INFO.json'), JSON.stringify(buildInfo, null, 2) + '\n');
console.log(`dist/BUILD_INFO.json written (${shortSha}${dirty ? ', dirty' : ''})`);
