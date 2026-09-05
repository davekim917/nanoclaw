import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { configDefaults } from 'vitest/config';
import hostConfig from '../vitest.config.js';
import skillsConfig from '../vitest.skills.config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const configs = [hostConfig, skillsConfig];
function collected(file: string): boolean {
  return configs.some(
    ({ test }) =>
      (test?.include ?? configDefaults.include).some((glob) => path.matchesGlob(file, glob)) &&
      !(test?.exclude ?? configDefaults.exclude).some((glob) => path.matchesGlob(file, glob)),
  );
}

describe('skill test collection', () => {
  it('collects every canonical skill test in at least one config', () => {
    const files = fs
      .readdirSync(path.join(root, '.claude/skills'), { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.test.ts'))
      .map((file) => `.claude/skills/${file}`);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => !collected(file))).toEqual([]);
  });

  it('detects an orphan beside a script while accepting the tests directory', () => {
    expect(collected('.claude/skills/synthetic/scripts/example.test.ts')).toBe(false);
    expect(collected('.claude/skills/synthetic/tests/example.test.ts')).toBe(true);
  });
});
