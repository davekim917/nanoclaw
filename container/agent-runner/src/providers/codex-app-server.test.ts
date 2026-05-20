import { describe, it, expect } from 'bun:test';
import * as fs from 'fs';
import os from 'os';
import path from 'path';

import { buildCodexHooksJson, createCodexConfigOverrides, writeCodexMcpConfigToml } from './codex-app-server.js';

describe('buildCodexHooksJson', () => {
  it('emits a PreToolUse and PostToolUse entry with command type', () => {
    const data = buildCodexHooksJson();
    expect(data.hooks.PreToolUse).toHaveLength(1);
    expect(data.hooks.PostToolUse).toHaveLength(1);
    expect(data.hooks.PreToolUse[0].hooks[0].type).toBe('command');
    expect(data.hooks.PostToolUse[0].hooks[0].type).toBe('command');
  });

  it('points commands at /app/src/codex-hooks/cli.ts via bun', () => {
    const data = buildCodexHooksJson();
    expect(data.hooks.PreToolUse[0].hooks[0].command).toBe('bun /app/src/codex-hooks/cli.ts PreToolUse');
    expect(data.hooks.PostToolUse[0].hooks[0].command).toBe('bun /app/src/codex-hooks/cli.ts PostToolUse');
  });

  it('defaults PreToolUse timeout to 3600s (1h, for email-gate approval wait)', () => {
    const data = buildCodexHooksJson();
    expect(data.hooks.PreToolUse[0].hooks[0].timeout).toBe(3600);
  });

  it('honors emailGateTimeoutSec override on PreToolUse', () => {
    const data = buildCodexHooksJson({ emailGateTimeoutSec: 7200 });
    expect(data.hooks.PreToolUse[0].hooks[0].timeout).toBe(7200);
  });

  it('PostToolUse uses a short 30s timeout', () => {
    const data = buildCodexHooksJson();
    expect(data.hooks.PostToolUse[0].hooks[0].timeout).toBe(30);
  });
});

describe('createCodexConfigOverrides', () => {
  it('always sets features.steer=true so turn/steer RPC injects mid-turn input', () => {
    // Issue 2 from the Bo / Bo-codex parity report: Dave's mid-turn
    // @-mentions weren't steering Bo-codex's reasoning, only landing as
    // the next turn's input. Root cause: Codex's CLI defaults
    // `features.steer = false`, in which state the app-server rejects
    // turn/steer RPCs and our provider's catch path re-queues the
    // message. Forcing `features.steer=true` at every spawn matches
    // Dave's local Codex CLI setting.
    const overrides = createCodexConfigOverrides();
    expect(overrides).toContain('features.steer=true');
  });

  it('always sets features.goals=true and disables linux sandbox bwrap', () => {
    const overrides = createCodexConfigOverrides();
    expect(overrides).toContain('features.goals=true');
    expect(overrides).toContain('features.use_linux_sandbox_bwrap=false');
  });

  it('forces detailed reasoning summary regardless of stickyConfig', () => {
    expect(createCodexConfigOverrides()).toContain('model_reasoning_summary="detailed"');
    expect(createCodexConfigOverrides({ reasoning_effort: 'low' })).toContain('model_reasoning_summary="detailed"');
  });

  it('emits model_reasoning_effort when stickyConfig sets it, omits otherwise', () => {
    expect(createCodexConfigOverrides()).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^model_reasoning_effort=/)]),
    );
    expect(createCodexConfigOverrides({ reasoning_effort: 'xhigh' })).toContain(
      'model_reasoning_effort="xhigh"',
    );
  });
});

describe('writeCodexMcpConfigToml', () => {
  it('preserves non-MCP config blocks while replacing MCP blocks', () => {
    const prevHome = process.env.HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    try {
      process.env.HOME = home;
      const codexDir = path.join(home, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(
        path.join(codexDir, 'config.toml'),
        [
          '[plugins."github@openai-curated"]',
          'enabled = true',
          '',
          '[mcp_servers.old]',
          'type = "stdio"',
          'command = "old"',
          '',
          '[features]',
          'hooks = true',
          '',
        ].join('\n'),
      );

      writeCodexMcpConfigToml({
        nanoclaw: { command: 'bun', args: ['run', '/app/src/mcp-tools/index.ts'] },
      });

      const config = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf-8');
      expect(config).toContain('[plugins."github@openai-curated"]');
      expect(config).toContain('[features]');
      expect(config).toContain('[mcp_servers.nanoclaw]');
      expect(config).not.toContain('[mcp_servers.old]');
      expect(config).not.toContain('command = "old"');
    } finally {
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
