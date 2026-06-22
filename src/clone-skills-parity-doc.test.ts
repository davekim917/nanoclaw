import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

const root = process.cwd();

function readSkill(name: string): string {
  return fs.readFileSync(path.join(root, '.claude', 'skills', name, 'SKILL.md'), 'utf8');
}

describe('clone provider skills parity guidance', () => {
  it('requires future Codex/OpenCode clones to preserve native MCP and agent-browser parity', () => {
    for (const name of ['clone-as-codex', 'clone-as-opencode']) {
      const skill = readSkill(name);
      expect(skill).toContain('Capability parity invariant for new siblings');
      expect(skill).toContain('MCP native transport parity');
      expect(skill).toContain('agent-browser');
      expect(skill).toContain('remote-mcp-bridge');
      expect(skill).toContain('type: "sse"');
    }
  });

  it('carries the same requirements in the provider template for future runtimes', () => {
    const skill = readSkill('clone-as-provider-template');
    expect(skill).toContain('preserve NanoClaw capability parity');
    expect(skill).toContain('Preserve native MCP transport parity');
    expect(skill).toContain('Expose the shared global CLI surface');
    expect(skill).toContain('agent-browser');
  });
});
