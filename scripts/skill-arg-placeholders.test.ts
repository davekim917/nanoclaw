import { readdirSync, readFileSync } from 'node:fs';
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

/** Every SKILL.md under the roots, at any depth: a skill can ship nested payloads it installs elsewhere. */
function skillFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : skillFiles(rel);
    return entry.name === 'SKILL.md' ? [rel] : [];
  });
}

function placeholderCounts(): Record<string, number> {
  const all = new RegExp(PLACEHOLDER.source, 'gm');
  const counts: Record<string, number> = {};
  for (const rel of SKILL_ROOTS.flatMap(skillFiles).sort()) {
    const n = readFileSync(join(ROOT, rel), 'utf8').match(all)?.length ?? 0;
    if (n > 0) counts[rel] = n;
  }
  return counts;
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
  it('no skill has an unescaped one', () => {
    expect(placeholderCounts()).toEqual({});
  });
});
