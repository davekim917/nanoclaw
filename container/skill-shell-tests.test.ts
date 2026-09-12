import { execFileSync } from 'child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import type { Dirent } from 'fs';

import { describe, expect, it } from 'vitest';

/**
 * Structural gate for shadow-review #724's F3: `ab-net-redact.test.sh` — the
 * only regression check on the network/HAR credential-redaction control added
 * by #700 — never ran anywhere. `container/entrypoint-github-auth.test.ts`
 * already proves the pattern (nothing in this repo executes `*.test.sh` on its
 * own — see that file's own header comment — so a `.test.ts` wrapper that
 * shells out to it is what puts a suite in `pnpm test` and CI), but it only
 * gates the one sibling suite it names.
 *
 * Rather than hand-add a second one-off wrapper (and leave the next shell
 * suite exactly as ungated as this one was), this file DISCOVERS every
 * `*.test.sh` anywhere under `container/skills/` at test-collection time and
 * runs each one as its own `it()` case (see discoverShellSuites() below for
 * why the walk is recursive rather than a fixed `<skill>/scripts/*.test.sh`
 * pattern). A future shell suite is gated the moment it lands, with no
 * wrapper file to remember to add.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const SKILLS_DIR = path.join(REPO_ROOT, 'container', 'skills');

/** Give each suite generous headroom over vitest's 5s default: the slowest
 * discovered suite (smoke-pr-gate.test.sh) runs real poll/claim loops with
 * short internal sleeps and takes 80-100s on this host; smoke-develop-gate.test.sh
 * takes ~30s. The rest finish in a few seconds. */
const SUITE_TIMEOUT_MS = 400_000;

/**
 * Suites that cannot run in this hermetic CI sandbox (Docker, a real browser,
 * network, or a host-only path), each with the one-line reason. Every path
 * here is asserted to still exist below, so a rename or removal fails loudly
 * instead of the exclusion silently rotting into a no-op.
 */
const EXCLUDED_SUITES: ReadonlyArray<{ relPath: string; reason: string }> = [];

const EXCLUDED_REL_PATHS = new Set(EXCLUDED_SUITES.map((s) => s.relPath));

/**
 * Every `*.test.sh` anywhere under `container/skills/`, repo-relative, sorted.
 *
 * Most suites live at `<skill>/scripts/<name>.test.sh`, but not all —
 * `container/skills/work-claims/claim.test.sh` sits directly under the skill
 * directory with no `scripts/` level at all. A pattern hardcoded to one fixed
 * depth would silently miss that suite (and any future skill that lays itself
 * out differently), which is exactly the kind of gap this file exists to
 * close — so this walks the whole `container/skills/` tree recursively
 * instead of assuming a fixed shape.
 */
function discoverShellSuites(): string[] {
  const found: string[] = [];
  function walk(dir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && entry.name.endsWith('.test.sh')) {
        found.push(path.relative(REPO_ROOT, abs));
      }
    }
  }
  walk(SKILLS_DIR);
  return found.sort();
}

const ALL_SUITES = discoverShellSuites();
const RUNNABLE_SUITES = ALL_SUITES.filter((relPath) => !EXCLUDED_REL_PATHS.has(relPath));

describe('every container skill shell test suite (*.test.sh)', () => {
  it('discovery found the known shell suites (floor, not a fixed count)', () => {
    // A regression in the discovery glob (wrong directory depth, wrong
    // extension) would otherwise silently collapse this to zero suites and
    // pass green. Floor rather than exact count: a new *.test.sh landing
    // elsewhere should not have to edit this number.
    expect(ALL_SUITES.length).toBeGreaterThanOrEqual(10);
    expect(ALL_SUITES).toContain('container/skills/agent-browser/scripts/ab-net-redact.test.sh');
  });

  it('every excluded suite path still exists', () => {
    for (const { relPath } of EXCLUDED_SUITES) {
      const abs = path.join(REPO_ROOT, relPath);
      let isFile = false;
      try {
        isFile = statSync(abs).isFile();
      } catch {
        isFile = false;
      }
      expect(isFile, `excluded suite no longer exists at ${relPath} — update or remove this entry`).toBe(true);
    }
  });

  for (const relPath of RUNNABLE_SUITES) {
    const suitePath = path.join(REPO_ROOT, relPath);
    it(
      `passes: ${relPath}`,
      () => {
        // Fresh HOME per suite (never the real one) plus GIT_CONFIG_NOSYSTEM=1,
        // so a suite can't pick up this host's/runner's git config, gitignore,
        // or dotfiles and behave differently between a dev machine and CI.
        const freshHome = mkdtempSync(path.join(tmpdir(), 'skill-shell-test-home-'));
        try {
          execFileSync('bash', [suitePath], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              HOME: freshHome,
              GIT_CONFIG_NOSYSTEM: '1',
            },
          });
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string };
          throw new Error(`${relPath} failed:\n${e.stdout ?? ''}\n${e.stderr ?? ''}`);
        } finally {
          rmSync(freshHome, { recursive: true, force: true });
        }
      },
      SUITE_TIMEOUT_MS,
    );
  }
});
