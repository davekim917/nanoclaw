import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
describe('host/container copy parity', () => {
  // The container runs its OWN copy of this module against /workspace/plugins
  // (codex-companion-setup.ts). The two files are hand-maintained duplicates,
  // so a discovery rule added to one and not the other silently changes what
  // Codex/OpenCode agents see inside containers while host output looks fine.
  // Comments and `export` (each tree exports what its own callers use) may
  // diverge; logic may not.
  it('keeps container/agent-runner/src/plugin-skill-discovery.ts logically identical', async () => {
    const root = path.resolve(import.meta.dirname, '..');
    const strip = (source: string) =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .split('\n')
        .map((line) => line.trim().replace(/^export\s+/, ''))
        .filter(Boolean)
        .join('\n');
    const [host, container] = await Promise.all([
      fs.promises.readFile(path.join(root, 'src', 'plugin-skill-discovery.ts'), 'utf8'),
      fs.promises.readFile(path.join(root, 'container', 'agent-runner', 'src', 'plugin-skill-discovery.ts'), 'utf8'),
    ]);
    expect(strip(container)).toBe(strip(host));
  });
});
