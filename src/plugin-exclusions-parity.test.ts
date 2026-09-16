import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

/**
 * The host decides what an `excludePlugins` entry means for the mount and the
 * always-on composer; the three container walkers decide it for the SDK plugin
 * list, the Codex registration plan and the skill mirror. They agree only
 * because they run the same file.
 *
 * Unlike `plugin-skill-discovery.ts`'s parity test, this one compares BYTES:
 * the module is import-free and deliberately small, so there is no reason for
 * even a comment to diverge, and a comment that diverges here is a comment that
 * describes one side's behaviour while sitting in the other side's file.
 */
describe('plugin-exclusions host/container parity', () => {
  it('keeps container/agent-runner/src/plugin-exclusions.ts byte-identical', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const host = fs.readFileSync(path.join(root, 'src', 'plugin-exclusions.ts'), 'utf8');
    const container = fs.readFileSync(
      path.join(root, 'container', 'agent-runner', 'src', 'plugin-exclusions.ts'),
      'utf8',
    );
    expect(container).toBe(host);
  });

  it('imports nothing, so the two package trees can run the same bytes', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const host = fs.readFileSync(path.join(root, 'src', 'plugin-exclusions.ts'), 'utf8');
    expect(host).not.toMatch(/^\s*import\s/m);
    expect(host).not.toMatch(/\brequire\s*\(/);
  });
});
