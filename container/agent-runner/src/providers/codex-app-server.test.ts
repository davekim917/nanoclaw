import { describe, it, expect } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildCodexHooksJson, writeCodexMcpConfigToml } from './codex-app-server.js';

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
