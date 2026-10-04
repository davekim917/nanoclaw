import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Claude Code replaces `$0`…`$N` in a SKILL.md with the invocation's arguments (0-based, shell-style words), so a
// shell block that reads `$1` runs with whatever word the caller typed. Write shell without positional parameters;
// prose that needs a literal `$` before a digit escapes it as `\$`. Only exactly one backslash escapes: `\\$1` still
// expands.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKILL_ROOTS = ['.claude/skills', 'container/skills'];
const PLACEHOLDER = /(?<![^\\]\\)(?<!^\\)\$\d/m;

// Shrink-only: these predate the check.
const KNOWN = new Set([
  '.claude/skills/add-matrix/SKILL.md',
  '.claude/skills/add-vercel/SKILL.md',
  '.claude/skills/clone-as-codex/SKILL.md',
  '.claude/skills/clone-as-opencode/SKILL.md',
  '.claude/skills/migrate-from-openclaw/SKILL.md',
  '.claude/skills/update-nanoclaw/SKILL.md',
  'container/skills/narrated-deck/SKILL.md',
]);

function skillsWithPlaceholders(): string[] {
  const found: string[] = [];
  for (const root of SKILL_ROOTS) {
    for (const name of readdirSync(join(ROOT, root))) {
      const rel = `${root}/${name}/SKILL.md`;
      if (existsSync(join(ROOT, rel)) && PLACEHOLDER.test(readFileSync(join(ROOT, rel), 'utf8'))) found.push(rel);
    }
  }
  return found.sort();
}

describe('placeholder matcher', () => {
  it.each([
    ['$1', true],
    ['run $0 now', true],
    ['\\\\$1', true],
    ['x\\\\$1', true],
    ['\\$1.00', false],
    ['costs \\$4.2M', false],
    ['${1}', false],
    ['$x', false],
  ])('%s → %s', (text, expected) => {
    expect(PLACEHOLDER.test(text)).toBe(expected);
  });
});

describe('SKILL.md positional placeholders', () => {
  const found = skillsWithPlaceholders();

  it('no other skill reads a positional $N the skill loader overwrites', () => {
    expect(found.filter((f) => !KNOWN.has(f))).toEqual([]);
  });

  it('a fixed skill leaves the known list', () => {
    expect([...KNOWN].filter((f) => !found.includes(f))).toEqual([]);
  });
});
