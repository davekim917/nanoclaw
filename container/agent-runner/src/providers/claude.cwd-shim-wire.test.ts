import { describe, it, expect } from 'bun:test';

import { ClaudeProvider } from './claude.js';

// T5 PR 2 acceptance case 10 (docs/specs/upstream-theme-ports/plan.md):
// "the Claude provider wraps a cwd-bearing stdio server through /bin/sh with
// cwd, command and args as positional parameters — asserts no shell
// interpolation. Fails on revert of the claude.ts constructor's shimCwd wire."
describe('ClaudeProvider constructor wires shimCwd onto mcpServers', () => {
  it('wraps a cwd-bearing stdio server through /bin/sh with cwd, command and args positional', () => {
    const provider = new ClaudeProvider({
      mcpServers: {
        plugged: {
          command: 'node',
          args: ['server.js', '--flag'],
          cwd: '/workspace/agent/plugins/sales-sdr',
        },
      },
    });

    // mcpServers is a private field; inspected via runtime property access
    // rather than a public getter, since none exists and adding one purely
    // for this test would widen the class's surface beyond what PR 2 needs.
    const shimmed = (provider as unknown as { mcpServers: Record<string, { command: string; args?: string[] }> })
      .mcpServers.plugged;

    expect(shimmed.command).toBe('/bin/sh');
    expect(shimmed.args).toEqual([
      '-c',
      'cd "$0" && exec "$@"',
      '/workspace/agent/plugins/sales-sdr',
      'node',
      'server.js',
      '--flag',
    ]);
  });

  it('leaves a cwd-less stdio server untouched', () => {
    const provider = new ClaudeProvider({
      mcpServers: {
        plain: { command: 'node', args: ['server.js'] },
      },
    });

    const server = (provider as unknown as { mcpServers: Record<string, { command: string; args?: string[] }> })
      .mcpServers.plain;

    expect(server.command).toBe('node');
    expect(server.args).toEqual(['server.js']);
  });
});
