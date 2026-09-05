/**
 * Dependency guard for the Google Calendar MCP server (host/vitest tree).
 *
 * `@cocal/google-calendar-mcp` is a stdio CLI installed globally in the image,
 * not an imported module, so no behavior test can drive it and `tsc` never sees
 * it. The only in-tree footprint of this skill is the Dockerfile edit, so the
 * guard is structural: assert the pinned `ARG` and the pnpm global-install line
 * both exist. Drop either Phase 2 Dockerfile edit and this goes red.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { describe, it, expect } from 'vitest';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

function dockerfile(): string {
  const skill = path.join(TEST_DIR, '..', 'SKILL.md');
  if (fs.existsSync(skill)) {
    const instructions = fs.readFileSync(skill, 'utf8');
    const snippets = [...instructions.matchAll(/```dockerfile\n([\s\S]*?)```/g)]
      .map((match) => match[1])
      .filter((snippet) => snippet.includes('CALENDAR_MCP_VERSION'));
    if (snippets.length === 0) throw new Error('Calendar Dockerfile instructions not found in SKILL.md');
    return snippets.join('\n');
  }
  return fs.readFileSync(path.resolve(process.cwd(), 'container/Dockerfile'), 'utf8');
}

describe('container/Dockerfile installs @cocal/google-calendar-mcp', () => {
  const text = dockerfile();

  it('pins the version via an ARG', () => {
    expect(text).toMatch(/^\s*ARG\s+CALENDAR_MCP_VERSION=/m);
  });

  it('installs the package pinned to that ARG in a pnpm global-install block', () => {
    // Match `pnpm install -g ... "@cocal/google-calendar-mcp@${CALENDAR_MCP_VERSION}"`,
    // tolerating line continuations between `install -g` and the package.
    const installsCalendar =
      /pnpm\s+install\s+-g[\s\S]*?@cocal\/google-calendar-mcp@\$\{CALENDAR_MCP_VERSION\}/.test(
        text,
      );
    expect(installsCalendar).toBe(true);
  });
});
