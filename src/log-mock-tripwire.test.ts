import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');

function listTestFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.test.ts')) files.push(full);
    }
  };
  walk(path.join(REPO_ROOT, root));
  return files;
}

function hasRealLogImportOriginal(source: string): boolean {
  return /\bvi\.(?:mock|doMock)\s*\(\s*(['"])(?:\.{1,2}\/)(?:[^'"]*\/)?log\.js\1\s*,\s*(?:async\s*)?\(\s*importOriginal\b/.test(
    source,
  );
}

describe('log mock tripwire', () => {
  it('flags a real log mock that imports the production module', () => {
    const logSpecifier = `./${'log.js'}`;
    expect(
      hasRealLogImportOriginal(`vi.mock('${logSpecifier}', async (importOriginal) => ({ ...importOriginal() }))`),
    ).toBe(true);
  });

  it('flags a deferred logger mock that imports the production module', () => {
    const logSpecifier = `./${'log.js'}`;
    expect(hasRealLogImportOriginal(`vi.doMock('${logSpecifier}', async (importOriginal) => importOriginal())`)).toBe(
      true,
    );
  });

  it('flags a synchronous script-side mock of the host log module', () => {
    const logSpecifier = `../src/${'log.js'}`;
    expect(hasRealLogImportOriginal(`vi.mock('${logSpecifier}', (importOriginal) => importOriginal())`)).toBe(true);
  });

  it('does not flag a complete log stub', () => {
    const logSpecifier = `./${'log.js'}`;
    expect(hasRealLogImportOriginal(`vi.mock('${logSpecifier}', () => ({ log: {} }))`)).toBe(false);
  });

  it('does not flag another module that uses importOriginal', () => {
    expect(
      hasRealLogImportOriginal(`vi.mock('./db/backlog.js', async (importOriginal) => ({ ...importOriginal() }))`),
    ).toBe(false);
  });

  it('rejects real log imports in host and script test factories', () => {
    const violations = ['src', 'scripts']
      .flatMap(listTestFiles)
      .filter((file) => hasRealLogImportOriginal(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(REPO_ROOT, file));

    expect(violations).toEqual([]);
  });
});
