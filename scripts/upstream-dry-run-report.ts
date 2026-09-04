#!/usr/bin/env tsx
/**
 * CLI shim — print the weekly upstream dry-run report to stdout.
 * All logic lives in src/upstream-dry-run-report.ts. Read-only: fetches
 * upstream and runs `git merge-tree` (in-memory), never `git merge` or
 * checkout. Safe to run from the live checkout or any worktree — it always
 * reports origin/main vs upstream/main regardless of what HEAD is checked
 * out to in the repo it's invoked from.
 *
 * Usage: pnpm exec tsx scripts/upstream-dry-run-report.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateDryRunReport } from '../src/upstream-dry-run-report.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

console.log(generateDryRunReport({ repoRoot }));
