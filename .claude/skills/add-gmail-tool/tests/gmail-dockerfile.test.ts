/**
 * Structural guard for the Gmail MCP package-install integration point (container image).
 *
 * `@gongrzhe/server-gmail-autoauth-mcp` is a CLI binary installed into the image via the
 * Dockerfile — it is not importable or typed from this tree, so the build leg can't catch
 * its removal and there's no runtime seam to behavior-test. This asserts the Dockerfile
 * still carries the ARG and the pinned pnpm global-install line. Drop either and this goes
 * red, signalling the agent would boot without the `gmail-mcp` binary on PATH.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { describe, it, expect } = (await import(
  (globalThis as { Bun?: unknown }).Bun === undefined ? 'vitest' : 'bun:test',
)) as typeof import('vitest');

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

function dockerfile(): string {
  const skill = path.join(TEST_DIR, '..', 'SKILL.md');
  if (fs.existsSync(skill)) {
    const instructions = fs.readFileSync(skill, 'utf8');
    const snippets = [...instructions.matchAll(/```dockerfile\n([\s\S]*?)```/g)]
      .map((match) => match[1])
      .filter((snippet) => snippet.includes('GMAIL_MCP_VERSION'));
    if (snippets.length === 0) throw new Error('Gmail Dockerfile instructions not found in SKILL.md');
    return snippets.join('\n');
  }
  // Installed under container/agent-runner/src/providers/: ../../../Dockerfile.
  return fs.readFileSync(path.join(TEST_DIR, '..', '..', '..', 'Dockerfile'), 'utf8');
}

describe('container/Dockerfile installs the Gmail MCP server', () => {
  const text = dockerfile();

  it('declares the GMAIL_MCP_VERSION ARG', () => {
    expect(/ARG\s+GMAIL_MCP_VERSION=/.test(text)).toBe(true);
  });

  it('pnpm-installs @gongrzhe/server-gmail-autoauth-mcp pinned to the ARG', () => {
    expect(text).toContain('pnpm install -g');
    expect(/@gongrzhe\/server-gmail-autoauth-mcp@\$\{GMAIL_MCP_VERSION\}/.test(text)).toBe(true);
  });

  it('pins the zod-to-json-schema workaround version', () => {
    expect(/zod-to-json-schema@3\.22\.5/.test(text)).toBe(true);
  });
});
