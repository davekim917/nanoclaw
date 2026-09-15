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

  it('escapes every control byte a plugin filename may legally carry', () => {
    // A state key embeds the plugin's own relative hook filename, and codex
    // accepts a manifest declaring any legal Linux name — a form feed included.
    // TOML forbids raw C0/DEL in a basic string, and codex answers one such
    // byte with "Invalid configuration; using defaults" and then STARTS: the
    // whole file is discarded, so the PreToolUse/PostToolUse guard chain
    // disappears along with the plugin hook. The write succeeds and the launch
    // succeeds; only the protection is gone (docs/review-notes/822.md).
    const hostile = [
      { key: 'plug@mkt:hooks/h\u000Cf.json:session_start:0:0', hash: 'sha256:ccc' },
      { key: 'plug@mkt:hooks/h\u0000n.json:stop:0:0', hash: 'sha256:ddd' },
      { key: 'plug@mkt:hooks/h\u007Fd.json:interrupt:0:0', hash: 'sha256:eee' },
      { key: 'plug@mkt:hooks/h\u001Be.json:pre_tool_use:0:0', hash: 'sha256:fff' },
    ];
    const block = renderCodexHookTrustBlock(hostile);
    // No raw control byte survives into the rendered TOML...
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x1f\x7f]/.test(block.replace(/\n/g, ''))).toBe(false);
    // ...and each is emitted as TOML's \uXXXX escape, so the key still round-trips.
    expect(block).toContain('\\u000C');
    expect(block).toContain('\\u0000');
    expect(block).toContain('\\u007F');
    expect(block).toContain('\\u001B');
    for (const { hash } of hostile) expect(block).toContain(hash);
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

  it('returns nothing for a plugin with no declaration and no conventional file', () => {
    const dir = path.join(tmpdir(), 'plain');
    fs.mkdirSync(path.join(dir, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'plain' }));
    expect(declaredPluginHookFiles(dir)).toEqual([]);
    expect(collectPluginHookTrustEntries({ pluginId: 'plain@mkt', dir })).toEqual([]);
  });

  it('falls back to the conventional hooks/hooks.json when the manifest declares none', () => {
    // Verified against codex-cli 0.154.0: an undeclared `hooks/hooks.json` IS
    // loaded (key `<plugin>@<mkt>:hooks/hooks.json:...`), so skipping it leaves
    // a real hook untrusted and silently inert.
    const dir = path.join(tmpdir(), 'conventional');
    fs.mkdirSync(path.join(dir, '.codex-plugin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'conv' }));
    fs.writeFileSync(
      path.join(dir, 'hooks', 'hooks.json'),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/bin/true', timeout: 9 }] }] } }),
    );
    expect(declaredPluginHookFiles(dir)).toEqual(['hooks/hooks.json']);
    expect(collectPluginHookTrustEntries({ pluginId: 'conv@mkt', dir })).toEqual([
      {
        key: 'conv@mkt:hooks/hooks.json:session_start:0:0',
        hash: codexHookTrustHash('SessionStart', { type: 'command', command: '/bin/true', timeout: 9 }),
      },
    ]);
  });

  it('does NOT add the conventional file when the manifest declares one', () => {
    // A declaration REPLACES the default (verified: the sibling hooks/hooks.json
    // never appears in hooks/list). Emitting both would write a trust row keyed
    // on a file Codex never reads.
    const dir = path.join(tmpdir(), 'both');
    fs.mkdirSync(path.join(dir, '.codex-plugin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'both', hooks: './hooks/declared.json' }),
    );
    fs.writeFileSync(path.join(dir, 'hooks', 'declared.json'), JSON.stringify({ hooks: {} }));
    fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {} }));
    expect(declaredPluginHookFiles(dir)).toEqual(['hooks/declared.json']);
  });

  it('ignores a hooks declaration that only the Claude manifest makes', () => {
    // Measured against codex-cli 0.154.0, with a control in the same run: a
    // fixture declaring hooks in `.codex-plugin/plugin.json` is loaded, and a
    // fixture declaring the SAME file only in `.claude-plugin/plugin.json`
    // yields zero hooks. The real `wwbd@davekim917-bootstrap` is that second
    // shape and Codex reports no hooks for it. Trusting the Claude-declared
    // file would key a row on a file Codex never reads and record a hook as
    // covered when it does not run at all.
    const dir = path.join(tmpdir(), 'claude-declared-only');
    fs.mkdirSync(path.join(dir, '.codex-plugin'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'cldecl' }));
    fs.writeFileSync(
      path.join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'cldecl', hooks: './hooks/declared.json' }),
    );
    fs.writeFileSync(
      path.join(dir, 'hooks', 'declared.json'),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/bin/true' }] }] } }),
    );
    expect(declaredPluginHookFiles(dir)).toEqual([]);
    expect(collectPluginHookTrustEntries({ pluginId: 'cldecl@mkt', dir })).toEqual([]);
  });

  it('takes the conventional file when the Codex manifest declares none, even if the Claude manifest declares one', () => {
    // Same measurement, third fixture: `.codex-plugin` without `hooks`,
    // `.claude-plugin` declaring `hooks/declared.json`, both files on disk.
    // Codex 0.154.0 loads `hooks/hooks.json` — key
    // `cxnone@probemk:hooks/hooks.json:session_start:0:0` — and never
    // `hooks/declared.json`. The selecting manifest is the Codex one alone.
    const dir = path.join(tmpdir(), 'codex-none-claude-declares');
    fs.mkdirSync(path.join(dir, '.codex-plugin'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'cxnone' }));
    fs.writeFileSync(
      path.join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'cxnone', hooks: './hooks/declared.json' }),
    );
    fs.writeFileSync(path.join(dir, 'hooks', 'declared.json'), JSON.stringify({ hooks: {} }));
    fs.writeFileSync(
      path.join(dir, 'hooks', 'hooks.json'),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/bin/true', timeout: 9 }] }] } }),
    );
    expect(declaredPluginHookFiles(dir)).toEqual(['hooks/hooks.json']);
    expect(collectPluginHookTrustEntries({ pluginId: 'cxnone@mkt', dir })).toEqual([
      {
        key: 'cxnone@mkt:hooks/hooks.json:session_start:0:0',
        hash: codexHookTrustHash('SessionStart', { type: 'command', command: '/bin/true', timeout: 9 }),
      },
    ]);
  });
});
