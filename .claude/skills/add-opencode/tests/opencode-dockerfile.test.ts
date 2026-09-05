/**
 * Dependency guard for the OpenCode CLI integration point (host tree, vitest).
 *
 * add-opencode installs the `opencode-ai` CLI globally in the agent container
 * image via `container/Dockerfile`. A globally-installed CLI binary is not
 * importable or typed, so neither `tsc` nor a runtime import can catch its
 * removal — only the container image build would, and the skill's validate step
 * does not rebuild the image in CI. This structural test stands in for that
 * build leg: it parses the Dockerfile and asserts both halves of the install are
 * present — the pinned `ARG OPENCODE_VERSION=...` and the
 * `pnpm install -g "opencode-ai@${OPENCODE_VERSION}"` line. Drop or drift either
 * and this goes red.
 *
 * Pinning matters here beyond reproducibility: the `opencode-ai` CLI version
 * must match the `@opencode-ai/sdk` version the container provider imports. An
 * unpinned `latest` would silently upgrade the CLI past the SDK's compatible
 * range and break sessions. The test therefore also rejects `@latest`.
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
      .filter((snippet) => snippet.includes('OPENCODE_VERSION'));
    if (snippets.length === 0) throw new Error('OpenCode Dockerfile instructions not found in SKILL.md');
    return snippets.join('\n');
  }

  // The provider's installed test runs from the composed project.
  let dir = TEST_DIR;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'container', 'Dockerfile');
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8');
    dir = path.dirname(dir);
  }
  throw new Error('container/Dockerfile not found walking up from ' + TEST_DIR);
}

describe('container/Dockerfile installs the OpenCode CLI', () => {
  const text = dockerfile();

  it('declares a pinned OPENCODE_VERSION build arg (not latest)', () => {
    const declarations = [...text.matchAll(/^ARG\s+OPENCODE_VERSION=([^\s#]+)\s*$/gm)];
    expect(declarations).toHaveLength(1);
    expect(declarations[0]?.[1]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('globally installs the pinned opencode-ai package via pnpm', () => {
    expect(text).toMatch(/pnpm\s+install\s+-g[\s\S]*?"?opencode-ai@\$\{OPENCODE_VERSION\}"?/);
  });
});
