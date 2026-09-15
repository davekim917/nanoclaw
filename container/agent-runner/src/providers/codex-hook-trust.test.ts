import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  HOOK_TRUST_MARKER,
  codexHookTrustHash,
  collectCodexHookTrustEntries,
  collectPluginHookTrustEntries,
  declaredPluginHookFiles,
  mergeCodexHookTrustIntoToml,
  renderCodexHookTrustBlock,
} from './codex-hook-trust.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-trust-'));
}

// ── Oracles ────────────────────────────────────────────────────────────────
// These three hashes were WRITTEN BY CODEX ITSELF (0.154.0) into
// ~/.codex/config.toml when a human accepted the trust prompt in the TUI.
// They are an independent oracle, not a snapshot of this implementation: if
// the normalization drifts from codex-rs, they stop matching.
describe('codexHookTrustHash — oracles from a real Codex-written config.toml', () => {
  it('matches the file-hook entry for the nanoclaw restart guard', () => {
    expect(
      codexHookTrustHash('PreToolUse', {
        type: 'command',
        command: '/usr/bin/python3 /home/ubuntu/.codex/hooks/nanoclaw-restart-guard/guard.py',
        timeout: 10,
      }),
    ).toBe('sha256:fea0199ac416a8aac0a502373f97b8289e2e8580e7899d02d24073d770e9cfa7');
  });

  it('matches the plugin PreToolUse entry, hashed on the UNEXPANDED command', () => {
    // `${PLUGIN_ROOT}` is expanded only into the dispatched command; the hashed
    // identity keeps the raw string (discovery.rs:562-577). Expanding it here
    // would produce a hash that never matches on any machine.
    expect(
      codexHookTrustHash('PreToolUse', {
        type: 'command',
        command: 'bun "${PLUGIN_ROOT}/hooks/codex-guard.ts" PreToolUse',
        timeout: 3600,
      }),
    ).toBe('sha256:098408625edddbfeabfdc5593d17ade95699bf36fd463bd17ffd604cf314cb4a');
  });

  it('matches the plugin SessionStart entry', () => {
    expect(
      codexHookTrustHash('SessionStart', {
        type: 'command',
        command: 'node "${PLUGIN_ROOT}/scripts/session-install-roles.mjs"',
        timeout: 20,
      }),
    ).toBe('sha256:b2a369fd0dd8571ebf598ba9993be1ee2b89eff1b82702d8ec897884436d1da1');
  });
});

describe('codexHookTrustHash — normalization', () => {
  const cmd = { type: 'command' as const, command: '/bin/true' };

  it('treats an absent timeout as 600 and clamps 0 up to 1', () => {
    expect(codexHookTrustHash('PreToolUse', cmd)).toBe(codexHookTrustHash('PreToolUse', { ...cmd, timeout: 600 }));
    expect(codexHookTrustHash('PreToolUse', { ...cmd, timeout: 0 })).toBe(
      codexHookTrustHash('PreToolUse', { ...cmd, timeout: 1 }),
    );
  });

  it('gives SessionEnd/Interrupt their own 1s default and 3s cap', () => {
    expect(codexHookTrustHash('SessionEnd', cmd)).toBe(codexHookTrustHash('SessionEnd', { ...cmd, timeout: 1 }));
    expect(codexHookTrustHash('Interrupt', { ...cmd, timeout: 99 })).toBe(
      codexHookTrustHash('Interrupt', { ...cmd, timeout: 3 }),
    );
    // …and NOT the 600s default every other event uses.
    expect(codexHookTrustHash('SessionEnd', cmd)).not.toBe(codexHookTrustHash('SessionEnd', { ...cmd, timeout: 600 }));
  });

  it('always serializes async, defaulting to false', () => {
    expect(codexHookTrustHash('PreToolUse', cmd)).toBe(codexHookTrustHash('PreToolUse', { ...cmd, async: false }));
    expect(codexHookTrustHash('PreToolUse', { ...cmd, async: true })).not.toBe(codexHookTrustHash('PreToolUse', cmd));
  });

  it('includes matcher only when the group declares one', () => {
    expect(codexHookTrustHash('PreToolUse', cmd, null)).toBe(codexHookTrustHash('PreToolUse', cmd));
    expect(codexHookTrustHash('PreToolUse', cmd, 'shell')).not.toBe(codexHookTrustHash('PreToolUse', cmd));
  });

  it('drops additionalContextLimit when it equals the default or the event cannot emit context', () => {
    expect(codexHookTrustHash('PreToolUse', { ...cmd, additionalContextLimit: 2500 })).toBe(
      codexHookTrustHash('PreToolUse', cmd),
    );
    expect(codexHookTrustHash('PreToolUse', { ...cmd, additionalContextLimit: 900 })).not.toBe(
      codexHookTrustHash('PreToolUse', cmd),
    );
    // Stop is not one of the five context-emitting events, so the limit is
    // normalized away there.
    expect(codexHookTrustHash('Stop', { ...cmd, additionalContextLimit: 900 })).toBe(codexHookTrustHash('Stop', cmd));
  });

  it('is independent of key order in the handler object', () => {
    const a = { command: '/bin/true', timeout: 5, type: 'command' as const, async: true };
    const b = { async: true, type: 'command' as const, timeout: 5, command: '/bin/true' };
    expect(codexHookTrustHash('PostToolUse', a)).toBe(codexHookTrustHash('PostToolUse', b));
  });

  it('distinguishes the event even for an identical handler', () => {
    expect(codexHookTrustHash('PreToolUse', cmd)).not.toBe(codexHookTrustHash('PostToolUse', cmd));
  });
});

describe('collectCodexHookTrustEntries', () => {
  it('keys each entry on <source>:<event_key>:<groupIndex>:<handlerIndex>', () => {
    const entries = collectCodexHookTrustEntries('/home/node/.codex/hooks.json', {
      PreToolUse: [
        {
          hooks: [
            { type: 'command', command: 'a' },
            { type: 'command', command: 'b' },
          ],
        },
        { matcher: 'shell', hooks: [{ type: 'command', command: 'c' }] },
      ],
      PostToolUse: [{ hooks: [{ type: 'command', command: 'd' }] }],
    });
    expect(entries.map((e) => e.key)).toEqual([
      '/home/node/.codex/hooks.json:pre_tool_use:0:0',
      '/home/node/.codex/hooks.json:pre_tool_use:0:1',
      '/home/node/.codex/hooks.json:pre_tool_use:1:0',
      '/home/node/.codex/hooks.json:post_tool_use:0:0',
    ]);
    // The matcher group's hash carries the matcher.
    expect(entries[2].hash).toBe(codexHookTrustHash('PreToolUse', { type: 'command', command: 'c' }, 'shell'));
  });

  it('skips unknown events, non-command handlers, and empty commands without shifting indices', () => {
    const entries = collectCodexHookTrustEntries('/x', {
      NotAnEvent: [{ hooks: [{ type: 'command', command: 'a' }] }],
      PreToolUse: [
        {
          hooks: [
            { type: 'mcp_tool', server: 's', tool: 't' },
            { type: 'command', command: '   ' },
            { type: 'command', command: 'real' },
          ],
        },
      ],
    });
    expect(entries).toEqual([
      { key: '/x:pre_tool_use:0:2', hash: codexHookTrustHash('PreToolUse', { type: 'command', command: 'real' }) },
    ]);
  });
});

describe('mergeCodexHookTrustIntoToml', () => {
  const entries = [
    { key: '/home/node/.codex/hooks.json:pre_tool_use:0:0', hash: 'sha256:aaa' },
    { key: 'plug@mkt:hooks/h.json:session_start:0:0', hash: 'sha256:bbb' },
  ];

  it('quotes keys and emits one table per entry, sorted', () => {
    const block = renderCodexHookTrustBlock(entries);
    expect(block.startsWith(HOOK_TRUST_MARKER)).toBe(true);
    expect(block).toContain(
      '[hooks.state."/home/node/.codex/hooks.json:pre_tool_use:0:0"]\ntrusted_hash = "sha256:aaa"',
    );
    expect(block).toContain('[hooks.state."plug@mkt:hooks/h.json:session_start:0:0"]\ntrusted_hash = "sha256:bbb"');
    expect(block.indexOf('/home/node')).toBeLessThan(block.indexOf('plug@mkt'));
  });

  it('replaces prior hooks.state tables and preserves everything else', () => {
    const before = [
      '[features]',
      'hooks = true',
      '',
      '[hooks.state]',
      '',
      '[hooks.state."stale:pre_tool_use:0:0"]',
      'trusted_hash = "sha256:old"',
      '',
      '[projects."/workspace/agent"]',
      'trust_level = "trusted"',
      '',
    ].join('\n');
    const after = mergeCodexHookTrustIntoToml(before, entries);
    expect(after).not.toContain('sha256:old');
    expect(after).not.toContain('stale:pre_tool_use');
    expect(after).toContain('hooks = true');
    expect(after).toContain('[projects."/workspace/agent"]');
    expect(after).toContain('sha256:aaa');
    // Idempotent: re-merging the same entries must not duplicate a table
    // (codex rejects a config.toml with a duplicate table outright).
    const twice = mergeCodexHookTrustIntoToml(after, entries);
    expect(twice).toBe(after);
    expect(twice.match(/\[hooks\.state\./g)).toHaveLength(2);
  });

  it('strips the block entirely when there are no entries', () => {
    const after = mergeCodexHookTrustIntoToml(
      '[features]\nhooks = true\n\n[hooks.state."k"]\ntrusted_hash = "x"\n',
      [],
    );
    expect(after).toBe('[features]\nhooks = true\n');
  });
});

describe('plugin hook trust', () => {
  it('reads the declared hooks file and keys it <plugin>@<marketplace>:<relative path>', () => {
    const dir = path.join(tmpdir(), 'workflow-agents');
    fs.mkdirSync(path.join(dir, '.codex-plugin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'bootstrap-workflow-agents', hooks: './hooks/workflow-hooks.json' }),
    );
    fs.writeFileSync(
      path.join(dir, 'hooks', 'workflow-hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: 'command', command: 'node "${PLUGIN_ROOT}/scripts/session-install-roles.mjs"', timeout: 20 },
              ],
            },
          ],
          PreToolUse: [
            {
              hooks: [
                { type: 'command', command: 'bun "${PLUGIN_ROOT}/hooks/codex-guard.ts" PreToolUse', timeout: 3600 },
              ],
            },
          ],
        },
      }),
    );

    expect(declaredPluginHookFiles(dir)).toEqual(['hooks/workflow-hooks.json']);
    const entries = collectPluginHookTrustEntries({
      pluginId: 'bootstrap-workflow-agents@davekim917-bootstrap',
      dir,
    });
    // Byte-for-byte the rows a human's trust prompt produced on the host.
    expect(entries).toContainEqual({
      key: 'bootstrap-workflow-agents@davekim917-bootstrap:hooks/workflow-hooks.json:session_start:0:0',
      hash: 'sha256:b2a369fd0dd8571ebf598ba9993be1ee2b89eff1b82702d8ec897884436d1da1',
    });
    expect(entries).toContainEqual({
      key: 'bootstrap-workflow-agents@davekim917-bootstrap:hooks/workflow-hooks.json:pre_tool_use:0:0',
      hash: 'sha256:098408625edddbfeabfdc5593d17ade95699bf36fd463bd17ffd604cf314cb4a',
    });
  });

  it('returns nothing for a plugin that declares no hooks', () => {
    const dir = path.join(tmpdir(), 'plain');
    fs.mkdirSync(path.join(dir, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'plain' }));
    expect(declaredPluginHookFiles(dir)).toEqual([]);
    expect(collectPluginHookTrustEntries({ pluginId: 'plain@mkt', dir })).toEqual([]);
  });

  it('falls back to the Claude-first manifest', () => {
    const dir = path.join(tmpdir(), 'claude-first');
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ hooks: 'hooks/h.json' }));
    expect(declaredPluginHookFiles(dir)).toEqual(['hooks/h.json']);
  });
});
