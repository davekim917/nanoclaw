import { describe, it, expect } from 'bun:test';
import * as fs from 'fs';
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

  it('wraps remote HTTP bridges so Codex MCP children source proxy env before Bun starts', () => {
    const prevHome = process.env.HOME;
    const prevHttpsProxy = process.env.HTTPS_PROXY;
    const childEnvPath = '/tmp/nanoclaw-codex-mcp-env.sh';
    const hadChildEnv = fs.existsSync(childEnvPath);
    const prevChildEnv = hadChildEnv ? fs.readFileSync(childEnvPath, 'utf-8') : null;
    const prevChildEnvMode = hadChildEnv ? fs.statSync(childEnvPath).mode & 0o777 : null;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    try {
      process.env.HOME = home;
      process.env.HTTPS_PROXY = 'http://proxy.example.test:10255';

      writeCodexMcpConfigToml({
        dropbox: {
          command: 'bun',
          args: ['/app/src/remote-mcp-bridge.ts', 'https://mcp.dropbox.com/mcp'],
          env: {
            REMOTE_MCP_NAME: 'dropbox',
            REMOTE_MCP_AUTHORIZATION: 'Bearer onecli-managed',
          },
        },
      });

      const config = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf-8');
      expect(config).toContain('command = "/bin/sh"');
      expect(config).toContain('/tmp/nanoclaw-codex-mcp-env.sh');
      expect(config).toContain('export REMOTE_MCP_NAME=');
      expect(config).toContain('export REMOTE_MCP_AUTHORIZATION=');
      expect(config).toContain('exec /usr/local/bin/bun /app/src/remote-mcp-bridge.ts');
      expect(config).not.toContain('[mcp_servers.dropbox.env]');

      const childEnv = fs.readFileSync(childEnvPath, 'utf-8');
      expect(childEnv).toContain("export HTTPS_PROXY='http://proxy.example.test:10255'");
      expect(fs.statSync(childEnvPath).mode & 0o777).toBe(0o600);
    } finally {
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
      if (prevHttpsProxy === undefined) {
        delete process.env.HTTPS_PROXY;
      } else {
        process.env.HTTPS_PROXY = prevHttpsProxy;
      }
      if (hadChildEnv && prevChildEnv !== null && prevChildEnvMode !== null) {
        fs.writeFileSync(childEnvPath, prevChildEnv, { mode: prevChildEnvMode });
        fs.chmodSync(childEnvPath, prevChildEnvMode);
      } else {
        fs.rmSync(childEnvPath, { force: true });
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
