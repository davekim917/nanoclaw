import fs from 'fs';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fork-only: `groupFolderExistsOnDisk` must refuse a base-directory alias
// (`.`, `x/..`, `./`) instead of reporting GROUPS_DIR itself as occupied
// residue — `ncl groups create --folder .` would otherwise advise the
// operator to move or remove every group's workspace (Codex on #486).
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  GROUPS_DIR: `${TEST_DIR}/groups`,
}));

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('group-folder-base-alias-test') }));
const GROUPS_TEST_DIR = path.join(TEST_DIR, 'groups');

import { groupFolderExistsOnDisk } from './group-folder.js';

describe('groupFolderExistsOnDisk — base-directory aliases', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(GROUPS_TEST_DIR, { recursive: true });
  });

  it.each(['.', './', 'x/..', 'a/b/../..'])('refuses %j rather than reporting groups/ as occupied', (alias) => {
    expect(() => groupFolderExistsOnDisk(alias)).toThrow(/names the groups directory itself/);
  });

  it('still reports a real residue directory as present', () => {
    fs.mkdirSync(path.join(GROUPS_TEST_DIR, 'residue'));
    expect(groupFolderExistsOnDisk('residue')).toBe(true);
    expect(groupFolderExistsOnDisk('never-created')).toBe(false);
  });
});
