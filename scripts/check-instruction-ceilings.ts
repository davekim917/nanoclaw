#!/usr/bin/env tsx
/**
 * Blocking CI gate for the always-on instruction surface.
 *
 * `scripts/fleet-drift.ts` already computes these breaches, but only *reports*
 * them into a periodic run. Reporting has not held: the repo-root CLAUDE.md was
 * deliberately pruned back under its ceiling on 2026-09-03 (16,370 B) and six
 * feature commits pushed it to 17,926 B the same day. That is the third
 * prune/re-inflate cycle in the file's history.
 *
 * So this is the same check, wired where it can say no. It fails the build when
 * a standing-instruction file exceeds its ceiling plus the allowance recorded in
 * `instruction-ceilings.json` — and it also fails when a recorded allowance is
 * larger than the file needs, so headroom given up can never be silently
 * re-taken. That second rule is the ratchet: growth costs a visible, reviewable
 * edit to a tracked file instead of passing unnoticed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTAINER_BYTES_CEILING, TRUNK_DOC_BYTES_CEILING, scanBannedPatterns } from './instruction-surface.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWANCE_FILE = 'instruction-ceilings.json';

interface Allowances {
  /** Bytes of temporary headroom above the ceiling, per repo-relative path. Target: every value 0. */
  allowances: Record<string, number>;
}

interface Target {
  file: string;
  ceiling: number;
  /** Banned-pattern scanning only applies to files meant to hold timeless rules. */
  scanPatterns: boolean;
}

const TARGETS: Target[] = [
  { file: 'CLAUDE.md', ceiling: TRUNK_DOC_BYTES_CEILING, scanPatterns: true },
  { file: 'container/CLAUDE.md', ceiling: CONTAINER_BYTES_CEILING, scanPatterns: true },
];

function readAllowances(): Allowances {
  const p = path.join(repoRoot, ALLOWANCE_FILE);
  if (!fs.existsSync(p)) return { allowances: {} };
  const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<Allowances>;
  return { allowances: parsed.allowances ?? {} };
}

export interface CeilingFailure {
  file: string;
  kind: 'over-budget' | 'stale-allowance' | 'banned-pattern';
  message: string;
}

export function checkCeilings(root: string, targets: Target[], allowances: Record<string, number>): CeilingFailure[] {
  const failures: CeilingFailure[] = [];

  for (const { file, ceiling, scanPatterns } of targets) {
    const abs = path.join(root, file);
    if (!fs.existsSync(abs)) continue;

    const content = fs.readFileSync(abs, 'utf-8');
    const bytes = Buffer.byteLength(content, 'utf-8');
    const allowance = allowances[file] ?? 0;
    const budget = ceiling + allowance;

    if (bytes > budget) {
      const over = bytes - budget;
      failures.push({
        file,
        kind: 'over-budget',
        message:
          `${file} is ${bytes} B, over its ${budget} B budget by ${over} B ` +
          `(ceiling ${ceiling}${allowance ? ` + allowance ${allowance}` : ''}).\n` +
          `    Cut ${over} B of derivable content, or raise "${file}" in ${ALLOWANCE_FILE} ` +
          `to ${bytes - ceiling} and say why in the PR body.`,
      });
    } else if (allowance > 0 && bytes <= ceiling) {
      failures.push({
        file,
        kind: 'stale-allowance',
        message:
          `${file} is ${bytes} B — back under its ${ceiling} B ceiling, but ` +
          `${ALLOWANCE_FILE} still grants it ${allowance} B of allowance.\n` +
          `    Set "${file}" to 0 in ${ALLOWANCE_FILE} so the headroom cannot be silently re-taken.`,
      });
    }

    if (scanPatterns) {
      const hits = scanBannedPatterns(content);
      if (hits.length > 0) {
        failures.push({
          file,
          kind: 'banned-pattern',
          message:
            `${file} contains point-in-time facts that do not belong in a standing ` +
            `instruction file: ${hits.join(', ')}.\n` +
            `    Move them to a doc, a spec, or a memory — this file holds timeless rules.`,
        });
      }
    }
  }

  return failures;
}

function main(): void {
  const { allowances } = readAllowances();
  const failures = checkCeilings(repoRoot, TARGETS, allowances);

  if (failures.length === 0) {
    for (const { file, ceiling } of TARGETS) {
      const abs = path.join(repoRoot, file);
      if (!fs.existsSync(abs)) continue;
      const bytes = Buffer.byteLength(fs.readFileSync(abs, 'utf-8'), 'utf-8');
      const allowance = allowances[file] ?? 0;
      const budget = ceiling + allowance;
      console.log(`ok  ${file}: ${bytes} B / ${budget} B${allowance ? ' (allowance in use)' : ''}`);
    }
    return;
  }

  console.error('Instruction-surface ceiling check failed:\n');
  for (const f of failures) console.error(`  ✘ ${f.message}\n`);
  console.error(
    'These files load into every session. Over-budget standing instructions get skimmed,\n' +
      'which is how a real gotcha stops being read. See scripts/fleet-drift.ts for the ceilings.',
  );
  process.exitCode = 1;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
