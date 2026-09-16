import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  HOOK_TRUST_MARKER,
  classifyCodexHookList,
  codexHookTrustTables,
  codexHookEventUsesMatcher,
  codexHookTrustHash,
  collectCodexHookTrustEntries,
  collectPluginHookTrustEntries,
  declaredPluginHookFiles,
  isCodexHookDispatchable,
  mergeCodexHookTrustIntoToml,
  parseHooksJsonPreservingNumbers,
  resolveDeclaredPluginHookPath,
  resolvePluginHookBlocks,
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

  it('skips unknown events and unloadable handlers WITHOUT shifting the indices of the rest', () => {
    // `prompt` and `agent` handlers are recorded as unsupported and skipped by
    // codex, and an empty command likewise — but `append_matcher_groups`
    // enumerates the whole group and `continue`s, so each one still CONSUMES its
    // index. Emitting nothing for them while advancing the index is the only
    // correct behaviour; compacting would shift every later handler's key.
    const entries = collectCodexHookTrustEntries('/x', {
      NotAnEvent: [{ hooks: [{ type: 'command', command: 'a' }] }],
      PreToolUse: [
        {
          hooks: [
            { type: 'prompt' },
            { type: 'command', command: '   ' },
            { type: 'command', command: 'real' },
          ],
        },
      ],
    });
    expect(entries).toEqual([
      { key: '/x:pre_tool_use:0:2', hash: codexHookTrustHash('PreToolUse', { type: 'command', command: 'real' })! },
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
    // Both files carry a REAL hook: codex drops a hooks file whose `hooks` is
    // empty before recording a source at all (`append_plugin_hook_file`), so
    // empty fixtures would make this pass for the wrong reason.
    const oneHook = JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/bin/true', timeout: 9 }] }] },
    });
    fs.writeFileSync(path.join(dir, 'hooks', 'declared.json'), oneHook);
    fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), oneHook);
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

// ── runtime verification (hooks/list) ──────────────────────────────────────

/**
 * Real `hooks/list` rows from codex-cli 0.154.0, captured against a scratch
 * CODEX_HOME holding exactly the generated `hooks.json`
 * (`buildCodexHooksJson`). The first capture had NO `[hooks.state.*]` entries
 * and every row read back `untrusted`; writing the entries this module derives
 * flipped both to `trusted` with `currentHash` byte-identical to our hash.
 *
 * Kept as literal fixtures rather than a hand-written shape so the field
 * spelling (`trustStatus`, not `trust_status`; `enabled`, not `isEnabled`) is
 * pinned to what the binary emits.
 */
const LISTED_UNTRUSTED = {
  key: '/probe/home/hooks.json:pre_tool_use:0:0',
  eventName: 'preToolUse',
  handlerType: 'command',
  command: 'bun /app/src/codex-hooks/cli.ts PreToolUse',
  matcher: null,
  timeoutSec: 3600,
  sourcePath: '/probe/home/hooks.json',
  source: 'user',
  pluginId: null,
  enabled: true,
  isManaged: false,
  currentHash: 'sha256:ebc36aabcd4f59a8dbe0f85c78187466b8e568381df304cd1ad12e73d124d3e5',
  trustStatus: 'untrusted',
};
const LISTED_TRUSTED = { ...LISTED_UNTRUSTED, trustStatus: 'trusted' };

describe('isCodexHookDispatchable — codex’s own predicate', () => {
  // discovery.rs:713-718 — `enabled && (bypass || trust_status in {Managed, Trusted})`.
  it('accepts trusted and managed', () => {
    expect(isCodexHookDispatchable(LISTED_TRUSTED)).toBe(true);
    expect(isCodexHookDispatchable({ ...LISTED_TRUSTED, trustStatus: 'managed' })).toBe(true);
  });

  it('rejects untrusted and modified', () => {
    expect(isCodexHookDispatchable(LISTED_UNTRUSTED)).toBe(false);
    expect(isCodexHookDispatchable({ ...LISTED_TRUSTED, trustStatus: 'modified' })).toBe(false);
  });

  it('rejects a TRUSTED handler that is disabled', () => {
    // `hook_enabled` (discovery.rs:813-815) reads a separate `enabled` key on
    // the same `[hooks.state."<key>"]` table, so `enabled = false` leaves a
    // correctly-hashed handler trusted and still never dispatched. Checking
    // only trustStatus would pass this.
    expect(isCodexHookDispatchable({ ...LISTED_TRUSTED, enabled: false })).toBe(false);
  });

  it('rejects a row with no trustStatus at all', () => {
    expect(isCodexHookDispatchable({ key: 'k', enabled: true })).toBe(false);
  });
});

describe('classifyCodexHookList', () => {
  const expectedKeys = ['/probe/home/hooks.json:pre_tool_use:0:0', '/probe/home/hooks.json:post_tool_use:0:0'];
  const listedPost = { ...LISTED_TRUSTED, key: expectedKeys[1], eventName: 'postToolUse', timeoutSec: 30 };

  it('passes when every generated handler reads back dispatchable', () => {
    const verdict = classifyCodexHookList([LISTED_TRUSTED, listedPost], expectedKeys);
    expect(verdict.generated).toEqual([]);
    expect(verdict.plugin).toEqual([]);
    expect(verdict.generatedOk.sort()).toEqual([...expectedKeys].sort());
  });

  it('flags a generated handler that reads back untrusted', () => {
    const verdict = classifyCodexHookList([LISTED_UNTRUSTED, listedPost], expectedKeys);
    expect(verdict.generated).toEqual([
      {
        key: expectedKeys[0],
        trustStatus: 'untrusted',
        enabled: true,
        pluginId: null,
        source: 'user',
        reason: 'not-dispatchable',
      },
    ]);
  });

  it('flags a generated handler ABSENT from the listing', () => {
    // The case a "scan the listing for untrusted rows" check passes vacuously:
    // with the hooks feature off or the file unread, `hooks/list` is empty and
    // there is no bad row to find.
    const verdict = classifyCodexHookList([], expectedKeys);
    expect(verdict.generated.map((p) => p.reason)).toEqual(['missing', 'missing']);
    expect(verdict.generatedOk).toEqual([]);
  });

  it('reports an undispatchable PLUGIN handler separately from the generated ones', () => {
    const pluginRow = {
      key: 'bootstrap-workflow-agents@davekim917-bootstrap:hooks/workflow-hooks.json:pre_tool_use:0:0',
      source: 'plugin',
      pluginId: 'bootstrap-workflow-agents@davekim917-bootstrap',
      enabled: true,
      trustStatus: 'modified',
    };
    const verdict = classifyCodexHookList([LISTED_TRUSTED, listedPost, pluginRow], expectedKeys);
    expect(verdict.generated).toEqual([]);
    expect(verdict.plugin).toEqual([
      {
        key: pluginRow.key,
        trustStatus: 'modified',
        enabled: true,
        pluginId: pluginRow.pluginId,
        source: 'plugin',
        reason: 'not-dispatchable',
      },
    ]);
  });

  it('ignores a dispatchable plugin handler and rows with no key', () => {
    const verdict = classifyCodexHookList(
      [
        LISTED_TRUSTED,
        listedPost,
        { ...LISTED_TRUSTED, key: 'other@mkt:hooks/hooks.json:stop:0:0' },
        { enabled: true },
      ],
      expectedKeys,
    );
    expect(verdict.generated).toEqual([]);
    expect(verdict.plugin).toEqual([]);
  });
});

describe('codexHookTrustTables', () => {
  const entry = (key: string, hash: string) => ({ key, hash });

  it('renders the exact two-line tables the block emits, so a read-back cannot disagree', () => {
    const entries = [
      entry('/h/hooks.json:post_tool_use:0:0', 'sha256:b'),
      entry('/h/hooks.json:pre_tool_use:0:0', 'sha256:a'),
    ];
    const block = renderCodexHookTrustBlock(entries);
    for (const table of codexHookTrustTables(entries)) expect(block).toContain(table);
  });

  it('dedupes a repeated key last-writer-wins, matching the renderer', () => {
    // A post-write check built from the RAW entries would report the dropped
    // hash missing from a file the renderer wrote correctly, and refuse a
    // spawn over it.
    const entries = [entry('k', 'sha256:first'), entry('k', 'sha256:second')];
    const tables = codexHookTrustTables(entries);
    expect(tables).toEqual(['[hooks.state."k"]\ntrusted_hash = "sha256:second"']);
    expect(renderCodexHookTrustBlock(entries)).toContain(tables[0]);
  });

  it('sorts by key, and escapes a key the way the table header does', () => {
    const entries = [entry('z', 'sha256:z'), entry('a\u0000b', 'sha256:a')];
    expect(codexHookTrustTables(entries).map((t) => t.split('\n')[0])).toEqual([
      '[hooks.state."a\\u0000b"]',
      '[hooks.state."z"]',
    ]);
  });

  it('is empty for no entries', () => {
    expect(codexHookTrustTables([])).toEqual([]);
  });
});

// ── 0.154.0 grammar coverage (#830) ────────────────────────────────────────
//
// EVERY hash below was written by codex-cli 0.154.0 itself: the shape was
// declared in a hooks.json under a scratch CODEX_HOME, the app-server was asked
// for `hooks/list`, and `currentHash` is what it reported. They are an
// independent oracle, not a snapshot — if this module's normalization drifts
// from codex-rs, they stop matching.

describe('PermissionRequest — the event that had no entry at all', () => {
  it('matches the measured hash, matcher included', () => {
    // Absent from CodexHookEvent before this, so its handlers got no trust row,
    // loaded, and reported `untrusted`. Measured with matcher "Bash", timeout 11.
    expect(codexHookTrustHash('PermissionRequest', { type: 'command', command: '/bin/true', timeout: 11 }, 'Bash')).toBe(
      'sha256:2317f87b79113cbdf36095b3291608d1f069cda7e58d3e5b549d09d8ee04bc70',
    );
  });

  it('keeps its matcher — it is in HOOK_EVENT_NAMES_WITH_MATCHERS', () => {
    expect(codexHookEventUsesMatcher('PermissionRequest')).toBe(true);
  });
});

describe('matcher normalization — the three events that DROP it', () => {
  // `matcher_pattern_for_event` replaces the declared matcher with None for
  // these before `hook_hash` sees the group. Each hash was measured with a
  // matcher DECLARED in the file; reproducing it requires ignoring that matcher.
  const cases: Array<[Parameters<typeof codexHookTrustHash>[0], string, number, string, string]> = [
    ['Stop', '/bin/stop', 12, 'Bash', 'sha256:81a48e83bbef740654fcb55b5567428faa463d6fd317fcf5d0d465f8b5b9a3ec'],
    [
      'UserPromptSubmit',
      '/bin/ups',
      13,
      'X',
      'sha256:0c8daeef728f508b99fc78151fa908e3b4fd93cf19611bd3f10f94e966aec394',
    ],
    ['Interrupt', '/bin/int', 2, 'Y', 'sha256:ad9610fc918d604aa8f6d95ff51efe8641e72015d9d025410324dc744fca867c'],
  ];

  for (const [event, command, timeout, matcher, expected] of cases) {
    it(`${event}: the declared matcher is normalized away before hashing`, () => {
      const handler = { type: 'command' as const, command, timeout };
      expect(codexHookTrustHash(event, handler, matcher)).toBe(expected);
      // …and hashing it as if the matcher counted is what produced `modified`.
      expect(codexHookEventUsesMatcher(event)).toBe(false);
      expect(codexHookTrustHash(event, handler, matcher)).toBe(codexHookTrustHash(event, handler));
    });
  }

  it('a matcher-bearing event still hashes its matcher in', () => {
    const handler = { type: 'command' as const, command: '/bin/x', timeout: 5 };
    expect(codexHookTrustHash('PreToolUse', handler, 'Bash')).not.toBe(codexHookTrustHash('PreToolUse', handler));
  });
});

describe('mcp_tool handlers', () => {
  it('matches the measured hash for a bare mcp_tool handler', () => {
    expect(
      codexHookTrustHash('PostToolUse', { type: 'mcp_tool', server: 'srv', tool: 'tl', timeout: 21 }, 'Bash'),
    ).toBe('sha256:4e846c6ef819bf045d2a6cb0745ede2ebe84dc45ca3d894a18a6b8504d820cc5');
  });

  it('matches the measured hash with input and statusMessage', () => {
    expect(
      codexHookTrustHash(
        'PostToolUse',
        { type: 'mcp_tool', server: 'srv2', tool: 'tl2', input: { a: 1, b: 'x' }, timeout: 22, statusMessage: 'sm' },
        'Bash',
      ),
    ).toBe('sha256:dc42d33b45993adc89356666e0888878d23f96639d583d7ceb25545b877dbeb4');
  });

  it('an ABSENT input hashes identically to an empty one', () => {
    // `input` is a plain map with #[serde(default)] and no skip_serializing_if,
    // so it is always in the hashed document. Measured: the two forms produced
    // the same digest in one run.
    const bare = { type: 'mcp_tool' as const, server: 's', tool: 't', timeout: 10 };
    expect(codexHookTrustHash('PostToolUse', bare)).toBe(
      codexHookTrustHash('PostToolUse', { ...bare, input: {} }),
    );
    expect(codexHookTrustHash('PostToolUse', bare)).toBe(
      'sha256:dbe98f35c81a95856aeb7a067f475303ffa7cb161777038b44f1b03efdd98811',
    );
  });

  it('encodes a NUMBER inside input the way codex does, not as a JSON number', () => {
    // The one that hid: `input` is a serde_json::Map and the identity is hashed
    // through a toml::Value, so serde_json's Number serializes as its PRIVATE
    // one-field struct and reaches the hash as a TABLE. Strings and booleans are
    // unaffected — which is why the obvious fixture passes and this one did not.
    // Four values measured under key `a`, one under `b`; a plain JSON number
    // reproduced none of them.
    const mk = (input: Record<string, unknown>) =>
      codexHookTrustHash('PostToolUse', { type: 'mcp_tool', server: 's', tool: 't', timeout: 10, input });
    expect(mk({ a: 1 })).toBe('sha256:8b8d20971040f3bb499bdac9084bcabc23791e7b9cc9c3c5be764d15b6a4cd14');
    expect(mk({ a: 2 })).toBe('sha256:d5fcc772d1d8472447a3cf08712718ad33437393af95a8d1ef1cc8fdf6aecb4f');
    expect(mk({ a: 0 })).toBe('sha256:c484e4200531c5d951bf1230cae904b37c4c421285ffa03beb7a2e1decd537dd');
    expect(mk({ a: 1.5 })).toBe('sha256:a1e1e1c15f03742f9cb44570d78a9fad4809fc45fa7821e463b60d1f70baa9c5');
    expect(mk({ b: 1 })).toBe('sha256:8387fa8a73f2915fd0052503310cb26e8e4446aca386d58a6a785362d709784a');
  });

  it('a STRING or BOOLEAN inside input hashes as itself', () => {
    const mk = (input: Record<string, unknown>) =>
      codexHookTrustHash('PostToolUse', { type: 'mcp_tool', server: 's', tool: 't', timeout: 10, input });
    expect(mk({ a: 'str' })).toBe('sha256:d205a8e54b5c59a8984147f1e860df54eae366a02f5c0e8f424e6559984fd30d');
    expect(mk({ a: true })).toBe('sha256:d8092c779a3180cfd6e44e8624f2f1cb3f0fb34c9aafd66f700d5d95f25938da');
  });

  it('is REFUSED on SessionEnd, where codex does not support MCP hooks', () => {
    expect(codexHookTrustHash('SessionEnd', { type: 'mcp_tool', server: 's', tool: 't' })).toBeNull();
  });

  it('is REFUSED when server or tool is empty', () => {
    expect(codexHookTrustHash('PostToolUse', { type: 'mcp_tool', server: '  ', tool: 't' })).toBeNull();
    expect(codexHookTrustHash('PostToolUse', { type: 'mcp_tool', server: 's', tool: '' })).toBeNull();
  });
});

describe('integers that cannot be hashed exactly are REFUSED, not rounded', () => {
  // `timeout` is a u64 and `additionalContextLimit` a usize; JSON.parse rounds
  // past 2^53, and the rounded value is what would be hashed. A wrong hash and a
  // missing entry both end in `untrusted`, but the refusal is deliberate and the
  // spawn-time hooks/list check names the handler. Throwing would take a
  // container down over one absurd value in one third-party plugin.
  it('refuses an unsafe timeout', () => {
    expect(codexHookTrustHash('PreToolUse', { type: 'command', command: 'x', timeout: 9007199254740993 })).toBeNull();
  });

  it('refuses an unsafe additionalContextLimit', () => {
    expect(
      codexHookTrustHash('PreToolUse', {
        type: 'command',
        command: 'x',
        timeout: 5,
        additionalContextLimit: 9007199254740993,
      }),
    ).toBeNull();
  });

  it('refuses an unsafe integer inside an mcp_tool input ONLY when it arrives pre-parsed', () => {
    // A plain number carries no literal, so `String` gives the ROUNDED value and
    // hashing it would silently claim the file said something it did not. Read
    // through `parseHooksJsonPreservingNumbers` the same value is emitted
    // exactly (see the literal tests below), so the refusal is specific to the
    // pre-parsed path, not to the magnitude.
    expect(
      codexHookTrustHash('PostToolUse', {
        type: 'mcp_tool',
        server: 's',
        tool: 't',
        input: { nested: { deep: [9007199254740993] } },
      }),
    ).toBeNull();
  });

  it('accepts the largest SAFE integer', () => {
    expect(
      codexHookTrustHash('PreToolUse', { type: 'command', command: 'x', timeout: Number.MAX_SAFE_INTEGER }),
    ).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('a handler codex skips still CONSUMES its index — measured', () => {
  it('reproduces the key and hash of the handler AFTER a skipped prompt hook', () => {
    // Measured: a PostToolUse group of [mcp_tool, mcp_tool, prompt, command]
    // yielded keys :0:0, :0:1 and :0:3. Index 2 is gone and index 3 is NOT
    // compacted to 2.
    const entries = collectCodexHookTrustEntries('/p/hooks.json', {
      PostToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            { type: 'mcp_tool', server: 'srv', tool: 'tl', timeout: 21 },
            { type: 'mcp_tool', server: 'srv2', tool: 'tl2', input: { a: 1, b: 'x' }, timeout: 22, statusMessage: 'sm' },
            { type: 'prompt' },
            { type: 'command', command: '/bin/after-skip', timeout: 23 },
          ],
        },
      ],
    });
    expect(entries.map((e) => e.key)).toEqual([
      '/p/hooks.json:post_tool_use:0:0',
      '/p/hooks.json:post_tool_use:0:1',
      '/p/hooks.json:post_tool_use:0:3',
    ]);
    expect(entries[2].hash).toBe('sha256:99a7059acafe4d99ed12981993efc0039aa53aab2a636f87c8618a068be9a8b0');
  });
});

describe('resolveDeclaredPluginHookPath — codex discards more than it accepts', () => {
  it('accepts a ./-prefixed path and returns it without the prefix', () => {
    expect(resolveDeclaredPluginHookPath('./hooks/d.json')).toEqual({
      readPath: 'hooks/d.json',
      keySuffix: 'hooks/d.json',
    });
  });

  it('REFUSES a path with no ./ prefix', () => {
    // Measured: a plugin declaring `hooks/d.json` loaded hooks/hooks.json
    // instead. Accepting it keyed a row on a file codex never reads AND
    // suppressed the fallback it does read.
    expect(resolveDeclaredPluginHookPath('hooks/d.json')).toBeNull();
  });

  it('REFUSES a parent traversal', () => {
    // Measured: `../../elsewhere.json` fell back to the conventional file. The
    // old code read and hashed a file outside the plugin directory.
    expect(resolveDeclaredPluginHookPath('../../elsewhere.json')).toBeNull();
    expect(resolveDeclaredPluginHookPath('./a/../../b.json')).toBeNull();
  });

  it('REFUSES an absolute path, an empty string and a bare ./', () => {
    expect(resolveDeclaredPluginHookPath('/etc/passwd')).toBeNull();
    expect(resolveDeclaredPluginHookPath('./')).toBeNull();
    expect(resolveDeclaredPluginHookPath('')).toBeNull();
    expect(resolveDeclaredPluginHookPath(42)).toBeNull();
  });

  it('reads the literal backslash filename but KEYS it with slashes', () => {
    // Measured: a plugin declaring `./hooks\\d.json`, with BOTH a file literally
    // named `hooks\\d.json` and a real `hooks/d.json`, loaded the backslash-named
    // one and reported the key `hooks/d.json`. On POSIX a backslash is an
    // ordinary filename byte, and only the KEY is rewritten
    // (`append_plugin_hook_file`).
    expect(resolveDeclaredPluginHookPath('./hooks\\d.json')).toEqual({
      readPath: 'hooks\\d.json',
      keySuffix: 'hooks/d.json',
    });
  });

  it('does NOT treat a backslash as a path separator for the .. check', () => {
    // codex splits on `/` alone under the POSIX convention, so this is one
    // absurdly-named file, not a traversal.
    expect(resolveDeclaredPluginHookPath('./a\\..\\b.json')).toEqual({
      readPath: 'a\\..\\b.json',
      keySuffix: 'a/../b.json',
    });
  });
});

describe('resolvePluginHookBlocks — all four manifest shapes, measured', () => {
  // Seven fixture plugins were registered into a scratch CODEX_HOME and driven
  // through `hooks/list`. The key each produced is asserted here; the fixtures
  // below are the same trees.
  const HOOK = (command: string) => ({
    SessionStart: [{ hooks: [{ type: 'command', command, timeout: 7 }] }],
  });

  function plugin(manifestHooks: unknown, files: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plugin-shape-'));
    fs.mkdirSync(path.join(dir, '.codex-plugin'), { recursive: true });
    const manifest: Record<string, unknown> = { name: 'p' };
    if (manifestHooks !== undefined) manifest.hooks = manifestHooks;
    fs.writeFileSync(path.join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify(manifest));
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), JSON.stringify(content));
    }
    return dir;
  }
  const keys = (dir: string) => resolvePluginHookBlocks(dir).map((b) => b.keySuffix);

  it('a valid ./path REPLACES the conventional file', () => {
    const dir = plugin('./hooks/d.json', {
      'hooks/d.json': { hooks: HOOK('/bin/pa-declared') },
      'hooks/hooks.json': { hooks: HOOK('/bin/pa-conventional') },
    });
    expect(keys(dir)).toEqual(['hooks/d.json']);
  });

  it('a path with NO ./ prefix falls back to the conventional file', () => {
    // codex reported `pb@…:hooks/hooks.json:…`, never hooks/d.json.
    const dir = plugin('hooks/d.json', {
      'hooks/d.json': { hooks: HOOK('/bin/pb-declared') },
      'hooks/hooks.json': { hooks: HOOK('/bin/pb-conventional') },
    });
    expect(keys(dir)).toEqual(['hooks/hooks.json']);
  });

  it('a parent-traversal path falls back to the conventional file', () => {
    const dir = plugin('../../elsewhere.json', { 'hooks/hooks.json': { hooks: HOOK('/bin/pc-conventional') } });
    expect(keys(dir)).toEqual(['hooks/hooks.json']);
  });

  it('an INLINE object is keyed plugin.json#hooks[0] and suppresses the fallback', () => {
    const dir = plugin({ hooks: HOOK('/bin/pd-inline') }, { 'hooks/hooks.json': { hooks: HOOK('/bin/pd-conv') } });
    expect(keys(dir)).toEqual(['plugin.json#hooks[0]']);
  });

  it('an INLINE list is keyed per index', () => {
    const dir = plugin([{ hooks: HOOK('/bin/pe-inline0') }, { hooks: HOOK('/bin/pe-inline1') }], {});
    expect(keys(dir)).toEqual(['plugin.json#hooks[0]', 'plugin.json#hooks[1]']);
  });

  it('an inline entry with an EMPTY hooks block is skipped but consumes its index', () => {
    const dir = plugin([{ hooks: {} }, { hooks: HOOK('/bin/second') }], {});
    expect(keys(dir)).toEqual(['plugin.json#hooks[1]']);
  });

  it('an EMPTY array resolves to nothing and falls back', () => {
    const dir = plugin([], { 'hooks/hooks.json': { hooks: HOOK('/bin/pf-conventional') } });
    expect(keys(dir)).toEqual(['hooks/hooks.json']);
  });

  it('a mixed array keeps the valid entries and does NOT fall back', () => {
    // Measured: `["bad.json", "./hooks/d.json"]` loaded only hooks/d.json.
    const dir = plugin(['bad.json', './hooks/d.json'], {
      'hooks/d.json': { hooks: HOOK('/bin/pg-declared') },
      'hooks/hooks.json': { hooks: HOOK('/bin/pg-conventional') },
    });
    expect(keys(dir)).toEqual(['hooks/d.json']);
  });

  it('a declared file with an EMPTY hooks block yields no source at all', () => {
    // `append_plugin_hook_file` returns before recording a source when the
    // parsed `hooks` is empty, so no key is ever derived from it — and because
    // the declaration DID resolve, there is no fallback either.
    const dir = plugin('./hooks/d.json', {
      'hooks/d.json': { hooks: {} },
      'hooks/hooks.json': { hooks: HOOK('/bin/conventional') },
    });
    expect(keys(dir)).toEqual([]);
  });

  it('no declaration at all takes the conventional file', () => {
    const dir = plugin(undefined, { 'hooks/hooks.json': { hooks: HOOK('/bin/conv') } });
    expect(keys(dir)).toEqual(['hooks/hooks.json']);
  });
});

describe('number LITERALS inside mcp_tool input — codex keeps the spelling', () => {
  // Every hash below was written by codex 0.154.0 for a hooks.json declaring
  // that exact literal. `JSON.parse` throws the spelling away, so these only
  // reproduce when the file is read through `parseHooksJsonPreservingNumbers`.
  const hashFor = (literal: string): string | null => {
    const doc = parseHooksJsonPreservingNumbers(
      `{"hooks":{"PostToolUse":[{"hooks":[{"type":"mcp_tool","server":"s","tool":"t","timeout":10,"input":{"a":${literal}}}]}]}}`,
    ) as { hooks: Record<string, unknown> };
    const entries = collectCodexHookTrustEntries('/k', doc.hooks);
    return entries.length === 1 ? entries[0].hash : null;
  };

  const measured: Array<[string, string]> = [
    ['1', 'sha256:8b8d20971040f3bb499bdac9084bcabc23791e7b9cc9c3c5be764d15b6a4cd14'],
    ['0', 'sha256:c484e4200531c5d951bf1230cae904b37c4c421285ffa03beb7a2e1decd537dd'],
    ['1.5', 'sha256:a1e1e1c15f03742f9cb44570d78a9fad4809fc45fa7821e463b60d1f70baa9c5'],
    // The pairs that a JS-spelling encoder gets wrong:
    ['1.0', 'sha256:38200fefd5a1875241b94d2e78cd5a78023b7cf748ed90ce8e56affb025ecfe6'],
    ['1.50', 'sha256:75069268107bf167ca055a4d14fdd9f6181e6a0e88cd13c162bdc3e3f798a714'],
    ['1e3', 'sha256:bcfd1fb165bd8f1250c76e1eb13b25647374624044cc829c2b807f5c766941a8'],
    ['1E3', 'sha256:bcfd1fb165bd8f1250c76e1eb13b25647374624044cc829c2b807f5c766941a8'],
    ['1e+3', 'sha256:bcfd1fb165bd8f1250c76e1eb13b25647374624044cc829c2b807f5c766941a8'],
    ['1e-3', 'sha256:01262af2adadf11a1847053e78a2187a761dffae981e69cb41e930c0c86fd4d9'],
    ['2.5e10', 'sha256:5e8cbb6ebb5739b62eb791a960cee48c7579aceda0601c44f0d88f6b0d9f24c8'],
    ['1000', 'sha256:c1afed8459dcac8b077b3647ade554f4618eea41521f4c36f8735cdc7d01fb9a'],
    ['-1', 'sha256:35356dedeba8e7b054479ea85207c13eda258c42dfcbe7c35f052c1fc93ef046'],
    ['-0.0', 'sha256:f429a9d339371f4681660ee279b6fb942c45a94d6278d8819d195be92c1c6181'],
    // An INTEGER negative zero loses its sign; a float one does not.
    ['-0', 'sha256:c484e4200531c5d951bf1230cae904b37c4c421285ffa03beb7a2e1decd537dd'],
  ];

  for (const [literal, expected] of measured) {
    it(`${literal} hashes as codex hashes it`, () => {
      expect(hashFor(literal)).toBe(expected);
    });
  }

  it('1.0 and 1 are DIFFERENT, which a JS-spelling encoder cannot see', () => {
    expect(hashFor('1.0')).not.toBe(hashFor('1'));
    expect(hashFor('1e3')).not.toBe(hashFor('1000'));
    expect(hashFor('1.50')).not.toBe(hashFor('1.5'));
  });

  it('an exact big integer beyond 2^53 is emitted from its literal, not rounded', () => {
    // No refusal is needed inside `input`: the literal goes in verbatim through
    // BigInt, so precision is never lost. (The refusal still applies to
    // `timeout` and `additionalContextLimit`, whose VALUES are normalized
    // arithmetically.)
    const a = hashFor('9007199254740993');
    const b = hashFor('9007199254740992');
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe('parseHooksJsonPreservingNumbers', () => {
  it('leaves non-numbers untouched and keeps the document shape', () => {
    const doc = parseHooksJsonPreservingNumbers('{"a":"s","b":true,"c":null,"d":[1,"x"]}') as Record<string, unknown>;
    expect(doc.a).toBe('s');
    expect(doc.b).toBe(true);
    expect(doc.c).toBeNull();
    expect(Array.isArray(doc.d)).toBe(true);
  });

  it('a boxed number still reads as its numeric value everywhere it is used', () => {
    const doc = parseHooksJsonPreservingNumbers(
      '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"x","timeout":7}]}]}}',
    ) as { hooks: Record<string, unknown> };
    // Same hash as the plain-object path: the timeout is consumed as a number.
    expect(collectCodexHookTrustEntries('/k', doc.hooks)[0].hash).toBe(
      codexHookTrustHash('PreToolUse', { type: 'command', command: 'x', timeout: 7 }),
    );
  });

  it('refuses a timeout literal that JSON.parse ROUNDED, exactly', () => {
    // With the source text this is exact rather than a range heuristic: the
    // literal does not round-trip through the parsed value.
    const doc = parseHooksJsonPreservingNumbers(
      '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"x","timeout":9007199254740993}]}]}}',
    ) as { hooks: Record<string, unknown> };
    expect(collectCodexHookTrustEntries('/k', doc.hooks)).toEqual([]);
  });
});
