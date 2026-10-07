import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bootFollowsSuccessfulDeploy, RECENT_DEPLOY_MS } from './deploy-status.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-status-'));
  file = path.join(dir, 'deploy-status.json');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('bootFollowsSuccessfulDeploy', () => {
  it.each([
    ['a fresh ok status', 'ok', 1_000, true],
    ['an ok status older than the deploy window', 'ok', RECENT_DEPLOY_MS + 1_000, false],
    ['a fresh failed status, as after a crash-guard rollback', 'failed', 1_000, false],
    ['a fresh running status, as mid-deploy', 'running', 1_000, false],
  ] as const)('answers %s', (_label, status, ageMs, expected) => {
    fs.writeFileSync(file, JSON.stringify({ status, step: 'done', error: '', timestamp: '' }));
    const mtime = fs.statSync(file).mtimeMs;
    expect(bootFollowsSuccessfulDeploy(mtime + ageMs, file)).toBe(expected);
  });

  it('answers false with no status file', () => {
    expect(bootFollowsSuccessfulDeploy(Date.now(), file)).toBe(false);
  });
});
