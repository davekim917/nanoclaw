import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { captureProtectedArchive, verifyProtectedArchives } from './repository-protected-archives.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'protected-archive-'));
  fs.writeFileSync(path.join(root, '.archive-sha'), 'a'.repeat(40));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'ongoing.ts'), 'export const ongoing = true;\n');
  fs.chmodSync(path.join(root, 'src', 'ongoing.ts'), 0o640);
  fs.symlinkSync('ongoing.ts', path.join(root, 'src', 'ongoing-link'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'cache.js'), 'generated\n');
  fs.mkdirSync(path.join(root, 'allure-results'));
  fs.writeFileSync(path.join(root, 'allure-results', 'result.json'), '{}\n');
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('protected non-Git archive evidence', () => {
  it('binds source bytes, modes, symlinks, and the archive marker while excluding generated caches', () => {
    const before = captureProtectedArchive(root);
    fs.writeFileSync(path.join(root, 'node_modules', 'cache.js'), 'regenerated\n');
    fs.writeFileSync(path.join(root, 'allure-results', 'result.json'), '{"new":true}\n');
    expect(() => verifyProtectedArchives([before])).not.toThrow();

    fs.chmodSync(path.join(root, 'src', 'ongoing.ts'), 0o600);
    expect(() => verifyProtectedArchives([before])).toThrow(/changed during repository migration/);
  });

  it('rejects a symlinked archive marker', () => {
    fs.rmSync(path.join(root, '.archive-sha'));
    fs.symlinkSync('src/ongoing.ts', path.join(root, '.archive-sha'));
    expect(() => captureProtectedArchive(root)).toThrow(/unsafe protected archive marker/);
  });
});
