import fs from 'fs';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// groupFolderExistsOnDisk reads GROUPS_DIR directly — point it at a unique
// per-file tmp root so the presence/absence tests below control what's on
// disk without touching the real groups/ directory. The validation tests
// further down only check the `groups/<folder>` suffix of resolved paths, so
// they hold under the mock too.
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  GROUPS_DIR: `${TEST_DIR}/groups`,
}));

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('group-folder-test') }));
const GROUPS_TEST_DIR = path.join(TEST_DIR, 'groups');

import { groupFolderExistsOnDisk, isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';

describe('group folder validation', () => {
  it('accepts normal group folder names', () => {
    expect(isValidGroupFolder('main')).toBe(true);
    expect(isValidGroupFolder('family-chat')).toBe(true);
    expect(isValidGroupFolder('Team_42')).toBe(true);
  });

  it('rejects traversal and reserved names', () => {
    expect(isValidGroupFolder('../../etc')).toBe(false);
    expect(isValidGroupFolder('/tmp')).toBe(false);
    expect(isValidGroupFolder('global')).toBe(false);
    expect(isValidGroupFolder('')).toBe(false);
  });

  it('resolves safe paths under groups directory', () => {
    const resolved = resolveGroupFolderPath('family-chat');
    expect(resolved.endsWith(`${path.sep}groups${path.sep}family-chat`)).toBe(true);
  });

  it('throws for unsafe folder names', () => {
    expect(() => resolveGroupFolderPath('../../etc')).toThrow();
  });
});

describe('groupFolderExistsOnDisk', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(GROUPS_TEST_DIR, { recursive: true });
  });

  it('a regular file at the folder path counts as present', () => {
    fs.writeFileSync(path.join(GROUPS_TEST_DIR, 'residue-file'), '');
    expect(groupFolderExistsOnDisk('residue-file')).toBe(true);
  });

  it('a dangling symlink counts as present', () => {
    // A symlink whose target is gone still occupies groups/<folder> (mkdir
    // would EEXIST on it). existsSync follows the link and reports absent —
    // "any form" requires lstat semantics, which is the point of this case.
    fs.symlinkSync(path.join(TEST_DIR, 'no-such-target'), path.join(GROUPS_TEST_DIR, 'residue-link'));
    expect(fs.existsSync(path.join(GROUPS_TEST_DIR, 'residue-link'))).toBe(false); // precondition: link is dangling
    expect(groupFolderExistsOnDisk('residue-link')).toBe(true);
  });

  it('a plain missing folder counts as absent', () => {
    expect(groupFolderExistsOnDisk('never-created')).toBe(false);
  });

  it('throws when the name escapes the groups dir', () => {
    expect(() => groupFolderExistsOnDisk('../../etc')).toThrow(/escapes/);
  });
});
