import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  GH_TOKEN_CONTAINER_DIR,
  GH_TOKEN_CONTAINER_PATH,
  clearGroupTokenRefreshers,
  githubTokenInEnv,
  groupTokenPath,
  planGitHubTokenSpawn,
  readGroupGitHubTokenFile,
  refreshGroupGitHubTokenFiles,
  registerGroupTokenRefresher,
  writeGroupGitHubTokenFile,
} from './github-token-file.js';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-token-file-'));
  clearGroupTokenRefreshers();
});

afterEach(() => {
  clearGroupTokenRefreshers();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('writeGroupGitHubTokenFile', () => {
  it('writes <token>\\n at 0600 under a 0700 per-group directory', () => {
    const file = writeGroupGitHubTokenFile('group-a', 'ghs_alpha', dataDir);

    expect(file).toBe(path.join(dataDir, 'gh-token', 'group-a', 'token'));
    expect(fs.readFileSync(file, 'utf-8')).toBe('ghs_alpha\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  it('rewrites the SAME inode, so a handle opened before the rewrite sees the new token — this is exactly what a container holding the bind mount does', () => {
    // Asserting on `stat().ino` alone is not enough: tmpfs and ext4 recycle
    // inode numbers, so a write-temp-then-rename can land on the number it
    // just freed and pass. Reading through a descriptor opened BEFORE the
    // rewrite cannot be fooled — a replaced inode keeps serving the old bytes,
    // which is precisely the stale-credential failure this design avoids.
    const file = writeGroupGitHubTokenFile('group-a', 'ghs_alpha', dataDir);
    const fd = fs.openSync(file, 'r');
    try {
      writeGroupGitHubTokenFile('group-a', 'ghs_bravo', dataDir);
      const buf = Buffer.alloc(128);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      expect(buf.subarray(0, n).toString('utf-8')).toBe('ghs_bravo\n');

      writeGroupGitHubTokenFile('group-a', 'ghs_charlie_is_a_much_longer_token_value', dataDir);
      const n2 = fs.readSync(fd, buf, 0, buf.length, 0);
      expect(buf.subarray(0, n2).toString('utf-8')).toBe('ghs_charlie_is_a_much_longer_token_value\n');
    } finally {
      fs.closeSync(fd);
    }
  });

  it('truncates rather than leaving a tail of the previous, longer token', () => {
    writeGroupGitHubTokenFile('group-a', 'ghs_a_very_long_previous_token_value', dataDir);
    const file = writeGroupGitHubTokenFile('group-a', 'ghs_short', dataDir);

    expect(fs.readFileSync(file, 'utf-8')).toBe('ghs_short\n');
  });

  it('keeps groups in separate directories', () => {
    writeGroupGitHubTokenFile('group-a', 'ghs_alpha', dataDir);
    writeGroupGitHubTokenFile('group-b', 'ghs_bravo', dataDir);

    expect(readGroupGitHubTokenFile('group-a', dataDir)).toBe('ghs_alpha');
    expect(readGroupGitHubTokenFile('group-b', dataDir)).toBe('ghs_bravo');
  });

  it('re-applies 0600 even when the file was left world-readable', () => {
    const file = writeGroupGitHubTokenFile('group-a', 'ghs_alpha', dataDir);
    fs.chmodSync(file, 0o644);

    writeGroupGitHubTokenFile('group-a', 'ghs_bravo', dataDir);

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('readGroupGitHubTokenFile', () => {
  it('rejects a torn read — content with no trailing newline is a partial write', () => {
    const file = groupTokenPath('group-a', dataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'ghs_partia');

    expect(readGroupGitHubTokenFile('group-a', dataDir)).toBeUndefined();
  });

  it('returns undefined for an empty file and for a missing one', () => {
    const file = groupTokenPath('group-a', dataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '\n');

    expect(readGroupGitHubTokenFile('group-a', dataDir)).toBeUndefined();
    expect(readGroupGitHubTokenFile('group-missing', dataDir)).toBeUndefined();
  });
});

describe('planGitHubTokenSpawn', () => {
  it('by default puts a PATH in the spec and no credential value anywhere', () => {
    const plan = planGitHubTokenSpawn({ agentGroupId: 'group-a', token: 'ghs_alpha', env: {}, dataDir });

    expect(plan.envArgs).toEqual(['-e', `GITHUB_TOKEN_FILE=${GH_TOKEN_CONTAINER_PATH}`]);
    expect(plan.envArgs.join(' ')).not.toContain('ghs_alpha');
    expect(plan.mount).toEqual({
      hostPath: path.join(dataDir, 'gh-token', 'group-a'),
      containerPath: GH_TOKEN_CONTAINER_DIR,
      readonly: true,
    });
    expect(readGroupGitHubTokenFile('group-a', dataDir)).toBe('ghs_alpha');
  });

  it('mounts the group directory read-only, not the file — the host rewrites the file underneath it', () => {
    const plan = planGitHubTokenSpawn({ agentGroupId: 'group-a', token: 'ghs_alpha', env: {}, dataDir });

    expect(plan.mount?.readonly).toBe(true);
    expect(fs.statSync(plan.mount!.hostPath).isDirectory()).toBe(true);
  });

  it('GITHUB_TOKEN_IN_ENV=1 restores value forwarding exactly, with no file and no mount', () => {
    const plan = planGitHubTokenSpawn({
      agentGroupId: 'group-a',
      token: 'ghs_alpha',
      env: { GITHUB_TOKEN_IN_ENV: '1' },
      dataDir,
    });

    expect(plan.envArgs).toEqual(['-e', 'GH_TOKEN=ghs_alpha', '-e', 'GITHUB_TOKEN=ghs_alpha']);
    expect(plan.envArgs.join(' ')).not.toContain('GITHUB_TOKEN_FILE');
    expect(plan.mount).toBeUndefined();
    expect(fs.existsSync(groupTokenPath('group-a', dataDir))).toBe(false);
  });

  it('accepts "true" as well as "1" for the rollback flag, and nothing else', () => {
    expect(githubTokenInEnv({ GITHUB_TOKEN_IN_ENV: 'true' })).toBe(true);
    expect(githubTokenInEnv({ GITHUB_TOKEN_IN_ENV: '1' })).toBe(true);
    expect(githubTokenInEnv({ GITHUB_TOKEN_IN_ENV: '0' })).toBe(false);
    expect(githubTokenInEnv({ GITHUB_TOKEN_IN_ENV: 'yes' })).toBe(false);
    expect(githubTokenInEnv({})).toBe(false);
  });
});

describe('refreshGroupGitHubTokenFiles', () => {
  it('rewrites in place when the resolver returns a new token, so a running container sees it', async () => {
    planGitHubTokenSpawn({ agentGroupId: 'group-a', token: 'ghs_old', env: {}, dataDir });
    // Stand in for the running container: a descriptor opened at spawn time.
    const fd = fs.openSync(groupTokenPath('group-a', dataDir), 'r');
    registerGroupTokenRefresher('group-a', async () => 'ghs_new');

    await expect(refreshGroupGitHubTokenFiles(dataDir)).resolves.toBe(1);
    expect(readGroupGitHubTokenFile('group-a', dataDir)).toBe('ghs_new');
    try {
      const buf = Buffer.alloc(128);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      expect(buf.subarray(0, n).toString('utf-8')).toBe('ghs_new\n');
    } finally {
      fs.closeSync(fd);
    }
  });

  it('is a no-op when the token is unchanged', async () => {
    planGitHubTokenSpawn({ agentGroupId: 'group-a', token: 'ghs_same', env: {}, dataDir });
    registerGroupTokenRefresher('group-a', async () => 'ghs_same');

    await expect(refreshGroupGitHubTokenFiles(dataDir)).resolves.toBe(0);
  });

  it('leaves the last good token in place when a resolver fails or returns nothing', async () => {
    planGitHubTokenSpawn({ agentGroupId: 'group-a', token: 'ghs_good', env: {}, dataDir });
    planGitHubTokenSpawn({ agentGroupId: 'group-b', token: 'ghs_good_b', env: {}, dataDir });
    registerGroupTokenRefresher('group-a', async () => {
      throw new Error('mint down');
    });
    registerGroupTokenRefresher('group-b', async () => undefined);

    await expect(refreshGroupGitHubTokenFiles(dataDir)).resolves.toBe(0);
    expect(readGroupGitHubTokenFile('group-a', dataDir)).toBe('ghs_good');
    expect(readGroupGitHubTokenFile('group-b', dataDir)).toBe('ghs_good_b');
  });

  it('one failing group does not stop the others', async () => {
    planGitHubTokenSpawn({ agentGroupId: 'group-a', token: 'ghs_old_a', env: {}, dataDir });
    planGitHubTokenSpawn({ agentGroupId: 'group-b', token: 'ghs_old_b', env: {}, dataDir });
    registerGroupTokenRefresher('group-a', async () => {
      throw new Error('mint down');
    });
    registerGroupTokenRefresher('group-b', async () => 'ghs_new_b');

    await expect(refreshGroupGitHubTokenFiles(dataDir)).resolves.toBe(1);
    expect(readGroupGitHubTokenFile('group-b', dataDir)).toBe('ghs_new_b');
  });

  it('re-registering a group replaces its resolver instead of accumulating entries', async () => {
    planGitHubTokenSpawn({ agentGroupId: 'group-a', token: 'ghs_old', env: {}, dataDir });
    registerGroupTokenRefresher('group-a', async () => 'ghs_first');
    registerGroupTokenRefresher('group-a', async () => 'ghs_second');

    await expect(refreshGroupGitHubTokenFiles(dataDir)).resolves.toBe(1);
    expect(readGroupGitHubTokenFile('group-a', dataDir)).toBe('ghs_second');
  });
});

describe('path safety', () => {
  it('refuses an agent group id that is not a single plain path segment', () => {
    expect(() => writeGroupGitHubTokenFile('../escape', 'ghs_x', dataDir)).toThrow(/path segment/);
    expect(() => writeGroupGitHubTokenFile('a/b', 'ghs_x', dataDir)).toThrow(/path segment/);
    expect(() => writeGroupGitHubTokenFile('..', 'ghs_x', dataDir)).toThrow(/path segment/);
    expect(() => writeGroupGitHubTokenFile('', 'ghs_x', dataDir)).toThrow(/path segment/);
  });

  it('locks down the shared gh-token parent directory too', () => {
    writeGroupGitHubTokenFile('ag-1776377699463-2axxhg', 'ghs_x', dataDir);
    expect(fs.statSync(path.join(dataDir, 'gh-token')).mode & 0o777).toBe(0o700);
  });
});
