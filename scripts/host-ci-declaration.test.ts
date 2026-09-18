import fs from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * Drift guard for .github/host-ci.sh, the host-CI declaration run-host-ci.sh
 * executes when GitHub Actions cannot start a job. merge-check lets its
 * `CI (host)` status stand in for the required `CI` workflow, so it must run
 * exactly what that workflow's pull_request lane runs: every `run:` step of
 * ci.yml's `typecheck` job, in order, a step with a `working-directory` as
 * `(cd <dir> && <cmd>)`. A step added, removed, reordered or reworded on
 * either side fails here.
 */

const ROOT = path.join(__dirname, '..');
const CI_YML = path.join(ROOT, '.github', 'workflows', 'ci.yml');
const DECLARATION = path.join(ROOT, '.github', 'host-ci.sh');

type Step = { run?: unknown; 'working-directory'?: unknown };

function ciRunSteps(): string[] {
  const workflow = parse(fs.readFileSync(CI_YML, 'utf8')) as { jobs: Record<string, { steps: Step[] }> };
  const jobs = Object.keys(workflow.jobs);
  // One job today. A second job is new CI the declaration would silently not
  // cover, so it fails here until this test and the declaration learn it.
  expect(jobs).toEqual(['typecheck']);
  return workflow.jobs.typecheck.steps
    .filter((step) => step.run !== undefined)
    .map((step) => {
      expect(typeof step.run).toBe('string');
      const run = (step.run as string).trim();
      // A multi-line run block would need its own mirroring rule.
      expect(run).not.toContain('\n');
      const dir = step['working-directory'];
      return dir === undefined ? run : `(cd ${String(dir)} && ${run})`;
    });
}

function declaredSteps(): string[] {
  const lines = fs.readFileSync(DECLARATION, 'utf8').split('\n');
  const start = lines.indexOf('set -euo pipefail');
  expect(start).toBeGreaterThan(0);
  return lines
    .slice(start + 1)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

describe('.github/host-ci.sh mirrors ci.yml', () => {
  it("runs exactly ci.yml's pull_request-lane run steps, in order", () => {
    const steps = ciRunSteps();
    expect(steps.length).toBeGreaterThan(0);
    expect(declaredSteps()).toEqual(steps);
  });

  it('is a strict bash script', () => {
    const text = fs.readFileSync(DECLARATION, 'utf8');
    expect(text.startsWith('#!/usr/bin/env bash\n')).toBe(true);
  });
});
