import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT, DATA_DIR } = vi.hoisted(() => {
  const testRoot = uniqueTmpRoot('workgroup-read-access-test');
  return { TEST_ROOT: testRoot, DATA_DIR: `${testRoot}/data` };
});

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR,
}));

import { closeDb, getRawDb, initTestDb, runMigrations } from './db/index.js';
import {
  WORKGROUP_READ_ACCESS_POLICY_PATH,
  assertWorkgroupReadAccessMountStable,
  isDuplicateWorkgroupReadAccessMount,
  isWorkgroupReadAccessNamespace,
  resolveWorkgroupReadAccess,
  workgroupReadAccessInstructions,
} from './workgroup-read-access.js';

function registerWorkgroup(id: string): void {
  getRawDb()
    .prepare(`INSERT INTO workgroups (id, onecli_secrets, created_at) VALUES (?, '[]', ?)`)
    .run(id, new Date().toISOString());
}

function writePolicy(policy: unknown): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(WORKGROUP_READ_ACCESS_POLICY_PATH, JSON.stringify(policy));
}

function mkdir(relative: string): void {
  fs.mkdirSync(path.join(DATA_DIR, relative), { recursive: true });
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await initTestDb();
  runMigrations(getRawDb());
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('workgroup read-access policy', () => {
  it('defaults to no grant when the host policy file is absent', async () => {
    registerWorkgroup('recipient');
    await expect(resolveWorkgroupReadAccess('recipient')).resolves.toBeNull();
  });

  it('mounts only the explicit all-mode source and includes its fixed project roots read-only', async () => {
    registerWorkgroup('recipient');
    registerWorkgroup('source');
    registerWorkgroup('unrelated');
    mkdir('workgroups/source/memory');
    mkdir('workgroups/source/conversations');
    mkdir('repositories/source');
    mkdir('v2-topics/source');
    mkdir('v2-threads/wg-source');
    mkdir('workgroups/unrelated/memory');
    writePolicy({ version: 1, recipients: { recipient: { mode: 'all', sources: ['source'] } } });

    const resolved = await resolveWorkgroupReadAccess('recipient');

    expect(resolved?.grants).toEqual([{ sourceId: 'source', mode: 'all' }]);
    expect(resolved?.requests).toEqual([
      { hostPath: path.join(DATA_DIR, 'workgroups/source'), containerPath: 'work/source/files', readonly: true },
      {
        hostPath: path.join(DATA_DIR, 'repositories/source'),
        containerPath: 'work/source/repositories',
        readonly: true,
      },
      { hostPath: path.join(DATA_DIR, 'v2-topics/source'), containerPath: 'work/source/topics', readonly: true },
      {
        hostPath: path.join(DATA_DIR, 'v2-threads/wg-source'),
        containerPath: 'work/source/legacy-threads',
        readonly: true,
      },
      {
        hostPath: path.join(DATA_DIR, 'workgroups/source/memory'),
        containerPath: 'work/source/memory',
        readonly: true,
      },
      {
        hostPath: path.join(DATA_DIR, 'workgroups/source/conversations'),
        containerPath: 'work/source/conversations',
        readonly: true,
      },
    ]);
    expect(resolved?.requests.every((request) => request.readonly)).toBe(true);
    expect(resolved?.requests.some((request) => request.containerPath.includes('unrelated'))).toBe(false);
  });

  it('archives mode exposes only real memory and conversations directories', async () => {
    registerWorkgroup('recipient');
    registerWorkgroup('source');
    mkdir('workgroups/source/memory');
    mkdir('workgroups/source/conversations');
    mkdir('repositories/source');
    writePolicy({ version: 1, recipients: { recipient: { mode: 'archives', sources: '*' } } });

    const resolved = await resolveWorkgroupReadAccess('recipient');

    expect(resolved?.requests).toEqual([
      {
        hostPath: path.join(DATA_DIR, 'workgroups/source/memory'),
        containerPath: 'work/source/memory',
        readonly: true,
      },
      {
        hostPath: path.join(DATA_DIR, 'workgroups/source/conversations'),
        containerPath: 'work/source/conversations',
        readonly: true,
      },
    ]);
  });

  it('fails closed for malformed policy, unknown source IDs, unsafe registered IDs, and source-root symlinks', async () => {
    registerWorkgroup('recipient');
    registerWorkgroup('source');

    writePolicy({ version: 1, recipients: { recipient: { mode: 'all', sources: ['missing'] } } });
    await expect(resolveWorkgroupReadAccess('recipient')).rejects.toThrow(
      'source "missing" is not a registered workgroup',
    );

    writePolicy({ version: 1, recipients: { recipient: { mode: 'all', sources: ['source'], typo: true } } });
    await expect(resolveWorkgroupReadAccess('recipient')).rejects.toThrow('may contain only mode and sources');

    registerWorkgroup('unsafe/path');
    writePolicy({ version: 1, recipients: { recipient: { mode: 'all', sources: '*' } } });
    await expect(resolveWorkgroupReadAccess('recipient')).rejects.toThrow(
      'registered workgroup ID must be a lowercase workgroup slug',
    );

    getRawDb().prepare('DELETE FROM workgroups WHERE id = ?').run('unsafe/path');
    mkdir('outside');
    mkdir('workgroups');
    fs.symlinkSync(path.join(DATA_DIR, 'outside'), path.join(DATA_DIR, 'workgroups/source'));
    writePolicy({ version: 1, recipients: { recipient: { mode: 'all', sources: ['source'] } } });
    await expect(resolveWorkgroupReadAccess('recipient')).rejects.toThrow('must be a real directory');
  });

  it('keeps the shared namespace host-owned while safely deduplicating a read-only legacy archive overlay', () => {
    const policyMount = {
      hostPath: '/data/workgroups/source',
      containerPath: '/workspace/extra/work/source/files',
      readonly: true,
    };
    const policyArchive = {
      hostPath: '/data/workgroups/source/memory',
      containerPath: '/workspace/extra/work/source/memory',
      readonly: true,
    };
    const legacyArchive = {
      hostPath: '/data/workgroups/source/memory',
      containerPath: '/workspace/extra/work//source/memory',
      readonly: true,
    };
    expect(isWorkgroupReadAccessNamespace(legacyArchive.containerPath)).toBe(true);
    expect(isDuplicateWorkgroupReadAccessMount(legacyArchive, [policyMount, policyArchive])).toBe(true);
    expect(
      isDuplicateWorkgroupReadAccessMount({ ...legacyArchive, hostPath: '/data/workgroups/other/memory' }, [
        policyMount,
        policyArchive,
      ]),
    ).toBe(false);
    expect(
      isDuplicateWorkgroupReadAccessMount({ ...legacyArchive, readonly: false }, [policyMount, policyArchive]),
    ).toBe(false);
  });

  it('refuses a policy mount whose source changed after validation', () => {
    const source = path.join(DATA_DIR, 'workgroups', 'source', 'conversations');
    const replacement = path.join(DATA_DIR, 'replacement');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(replacement, { recursive: true });
    assertWorkgroupReadAccessMountStable({ hostPath: source });
    fs.rmSync(source, { recursive: true });
    fs.symlinkSync(replacement, source);
    expect(() => assertWorkgroupReadAccessMountStable({ hostPath: source })).toThrow(
      'changed between validation and spawn',
    );
  });

  it('describes only the paths that the existing mount allowlist admitted', () => {
    const instruction = workgroupReadAccessInstructions(
      { recipientId: 'recipient', grants: [{ sourceId: 'source', mode: 'all' }], requests: [] },
      [
        { containerPath: '/workspace/extra/work/source/files', readonly: true },
        {
          containerPath: '/workspace/extra/work/source/repositories',
          readonly: true,
        },
      ],
    );
    expect(instruction).toContain('/workspace/extra/work/source');
    expect(instruction).toContain('/workspace/extra/work/source/repositories');
    expect(instruction).toContain('read-only');
  });
});
