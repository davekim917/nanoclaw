import { describe, it, expect } from 'bun:test';
import * as fs from 'fs';
import os from 'os';
import path from 'path';

import {
  type AppServer,
  buildCodexHooksJson,
  createCodexConfigOverrides,
  interruptCodexTurn,
  probeCodexThreadHealth,
  readCodexTurnSnapshot,
  writeCodexHooksJson,
  writeCodexMcpConfigToml,
} from './codex-app-server.js';

interface RecordedRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

function fakeAppServer(
  respond: (request: RecordedRequest) => { result?: unknown; error?: { code: number; message: string } } | null,
): { server: AppServer; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
  const server = {
    process: {
      stdin: {
        write(line: string) {
          const request = JSON.parse(line) as RecordedRequest;
          requests.push(request);
          const response = respond(request);
          if (response) {
            queueMicrotask(() => {
              const handler = pending.get(request.id);
              pending.delete(request.id);
              handler?.resolve({ id: request.id, ...response } as never);
            });
          }
          return true;
        },
      },
      kill() {
        return true;
      },
    },
    readline: { close() {} },
    pending,
    notificationHandlers: [],
    serverRequestHandlers: [],
  } as unknown as AppServer;
  return { server, requests };
}

describe('Codex app-server liveness RPCs', () => {
  it('reloads one completed turn from persisted thread state', async () => {
    const { server, requests } = fakeAppServer((request) => ({
      result: {
        thread: {
          turns: [
            { id: 'turn-older', items: [] },
            { id: 'turn-1', status: 'completed', items: [{ id: 'command-1', status: 'completed' }] },
          ],
        },
      },
    }));

    await expect(readCodexTurnSnapshot(server, 'root-1', 'turn-1', 50)).resolves.toMatchObject({
      id: 'turn-1',
      status: 'completed',
      items: [{ id: 'command-1', status: 'completed' }],
    });
    expect(requests[0]).toMatchObject({
      method: 'thread/read',
      params: { threadId: 'root-1', includeTurns: true },
    });
  });

  it('fails closed when persisted thread state omits the requested turn', async () => {
    const { server } = fakeAppServer(() => ({ result: { thread: { turns: [] } } }));
    await expect(readCodexTurnSnapshot(server, 'root-1', 'turn-missing', 50)).rejects.toThrow(
      'thread/read turn backfill response missing turn turn-missing',
    );
  });

  it('reads the root and all descendants without mutating the thread', async () => {
    const { server, requests } = fakeAppServer((request) => {
      if (request.method === 'thread/read') return { result: { thread: { status: { type: 'idle' } } } };
      if (request.method === 'thread/list') {
        return { result: { data: [{ status: { type: 'active' } }, { status: { type: 'idle' } }] } };
      }
      return { error: { code: -32601, message: 'unexpected method' } };
    });

    await expect(probeCodexThreadHealth(server, 'root-1', 50)).resolves.toEqual({
      rootStatus: { type: 'idle' },
      descendantStatuses: [{ type: 'active' }, { type: 'idle' }],
    });
    expect(requests.map((request) => request.method)).toEqual(['thread/read', 'thread/list']);
    expect(requests[1]?.params).toMatchObject({ ancestorThreadId: 'root-1', limit: 100 });
  });

  it('rejects when the control plane does not answer before the probe deadline', async () => {
    const { server } = fakeAppServer(() => null);
    await expect(probeCodexThreadHealth(server, 'root-1', 5)).rejects.toThrow(
      'Timeout waiting for thread/read response',
    );
  });

  it('interrupts a responsive in-flight turn before replacement', async () => {
    const { server, requests } = fakeAppServer(() => ({ result: {} }));
    await interruptCodexTurn(server, { threadId: 'thread-1', turnId: 'turn-1' }, 50);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });
  });
});

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

  it('writes to an explicit codexHome before environment fallbacks', () => {
    const previousHome = process.env.HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hooks-home-'));
    const explicitHome = path.join(root, 'explicit');
    const environmentHome = path.join(root, 'environment');
    const home = path.join(root, 'home');
    try {
      process.env.HOME = home;
      process.env.CODEX_HOME = environmentHome;

      writeCodexHooksJson({ codexHome: explicitHome, emailGateTimeoutSec: 7200 });

      const hooks = JSON.parse(fs.readFileSync(path.join(explicitHome, 'hooks.json'), 'utf-8')) as {
        hooks: { PreToolUse: Array<{ hooks: Array<{ command: string; timeout: number }> }> };
      };
      expect(hooks.hooks.PreToolUse[0].hooks[0]).toEqual({
        type: 'command',
        command: 'bun /app/src/codex-hooks/cli.ts PreToolUse',
        timeout: 7200,
      });
      expect(fs.existsSync(path.join(environmentHome, 'hooks.json'))).toBe(false);
      expect(fs.existsSync(path.join(home, '.codex', 'hooks.json'))).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('createCodexConfigOverrides', () => {
  it('always sets features.steer=true so turn/steer RPC injects mid-turn input', () => {
    // Issue 2 from the Example Assistant / Example Assistant Codex parity report: Operator's mid-turn
    // @-mentions weren't steering Example Assistant Codex's reasoning, only landing as
    // the next turn's input. Root cause: Codex's CLI defaults
    // `features.steer = false`, in which state the app-server rejects
    // turn/steer RPCs and our provider's catch path re-queues the
    // message. Forcing `features.steer=true` at every spawn matches
    // Operator's local Codex CLI setting.
    const overrides = createCodexConfigOverrides();
    expect(overrides).toContain('features.steer=true');
  });

  it('always sets features.goals=true and disables linux sandbox bwrap', () => {
    const overrides = createCodexConfigOverrides();
    expect(overrides).toContain('features.goals=true');
    expect(overrides).toContain('features.use_linux_sandbox_bwrap=false');
  });

  it('always enables the native fast-mode feature', () => {
    expect(createCodexConfigOverrides()).toContain('features.fast_mode=true');
  });

  it("always raises project_doc_max_bytes above Codex's 32KB default", () => {
    // 32KB default (`project_doc_max_bytes`) truncated whole behavioral
    // sections of the group AGENTS.md silently. Tripwire: this must not
    // regress back to Codex's default on a future refactor.
    expect(createCodexConfigOverrides()).toContain('project_doc_max_bytes=262144');
    expect(createCodexConfigOverrides({ reasoning_effort: 'xhigh' })).toContain('project_doc_max_bytes=262144');
    expect(createCodexConfigOverrides(undefined, true)).toContain('project_doc_max_bytes=262144');
  });

  it('bounds native subagent concurrency with a safe fleet default', () => {
    const overrides = createCodexConfigOverrides();
    expect(overrides).toContain('features.multi_agent_v2=true');
    expect(overrides).toContain('features.multi_agent_v2.max_concurrent_threads_per_session=7');
  });

  it('honors the validated per-group native subagent concurrency override', () => {
    expect(createCodexConfigOverrides({ max_concurrent_threads_per_session: 5 })).toContain(
      'features.multi_agent_v2.max_concurrent_threads_per_session=5',
    );
  });

  it('sets the fast service tier only when requested', () => {
    expect(createCodexConfigOverrides(undefined, true)).toContain('service_tier="fast"');
    expect(createCodexConfigOverrides(undefined, false)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^service_tier=/)]),
    );
    expect(createCodexConfigOverrides()).not.toEqual(expect.arrayContaining([expect.stringMatching(/^service_tier=/)]));
  });

  it('disables Codex opaque memories so canonical Markdown remains the retrieval layer', () => {
    const overrides = createCodexConfigOverrides();
    expect(overrides).toContain('memories.generate_memories=false');
    expect(overrides).toContain('memories.use_memories=false');
  });

  it('forces detailed reasoning summary regardless of stickyConfig', () => {
    expect(createCodexConfigOverrides()).toContain('model_reasoning_summary="detailed"');
    expect(createCodexConfigOverrides({ reasoning_effort: 'low' })).toContain('model_reasoning_summary="detailed"');
  });

  it('emits model_reasoning_effort when stickyConfig sets it, omits otherwise', () => {
    expect(createCodexConfigOverrides()).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^model_reasoning_effort=/)]),
    );
    expect(createCodexConfigOverrides({ reasoning_effort: 'xhigh' })).toContain('model_reasoning_effort="xhigh"');
    expect(createCodexConfigOverrides({ reasoning_effort: 'max' })).toContain('model_reasoning_effort="max"');
    expect(createCodexConfigOverrides({ reasoning_effort: 'ultra' })).toContain('model_reasoning_effort="ultra"');
  });
});

describe('writeCodexMcpConfigToml', () => {
  it('preserves non-MCP config blocks while replacing MCP blocks', () => {
    const prevHome = process.env.HOME;
    const prevCodexHome = process.env.CODEX_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    try {
      process.env.HOME = home;
      delete process.env.CODEX_HOME; // exercise the $HOME/.codex default path deterministically
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
      if (prevCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = prevCodexHome;
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes native HTTP MCP entries with url and http_headers', () => {
    const prevHome = process.env.HOME;
    const prevCodexHome = process.env.CODEX_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    try {
      process.env.HOME = home;
      delete process.env.CODEX_HOME;

      writeCodexMcpConfigToml({
        exa: {
          type: 'http',
          url: 'https://mcp.exa.ai/mcp',
          headers: { Authorization: 'Bearer placeholder' },
        },
      });

      const config = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf-8');
      expect(config).toContain('[mcp_servers.exa]');
      expect(config).toContain('url = "https://mcp.exa.ai/mcp"');
      expect(config).toContain('http_headers = { "Authorization" = "Bearer placeholder" }');
      expect(config).not.toContain('type = "http"');
      expect(config).not.toContain('type = "stdio"');
      expect(config).not.toContain('remote-mcp-bridge');
      expect(config).not.toContain('command = "bun"');
    } finally {
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
      if (prevCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = prevCodexHome;
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not accumulate the runtime-MCP marker comment across repeated writes', () => {
    // stripExistingMcpServers only dropped [mcp_servers.*] blocks, not the
    // marker comment above them — every spawn appended a fresh marker,
    // so a long-lived $HOME/.codex/config.toml grew one duplicate per run.
    const prevHome = process.env.HOME;
    const prevCodexHome = process.env.CODEX_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    try {
      process.env.HOME = home;
      delete process.env.CODEX_HOME;
      // Marker only appears once there's non-MCP base content to append after
      // (an empty/mcp-only file strips down to an empty base and no marker).
      const codexDir = path.join(home, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(path.join(codexDir, 'config.toml'), '[features]\nhooks = true\n');

      writeCodexMcpConfigToml({ nanoclaw: { command: 'bun', args: ['run', 'x'] } });
      writeCodexMcpConfigToml({ nanoclaw: { command: 'bun', args: ['run', 'x'] } });

      const config = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf-8');
      const markerCount = config.split('# --- nanoclaw runtime MCP servers ---').length - 1;
      expect(markerCount).toBe(1);
      expect(config).toContain('[features]');
      expect(config).toContain('[mcp_servers.nanoclaw]');
    } finally {
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
      if (prevCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = prevCodexHome;
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes config.toml + hooks.json to CODEX_HOME, not $HOME/.codex (codex #126 rotation)', () => {
    // On OAuth rotation the provider sets CODEX_HOME to a fallback dir; the writers
    // must target it (else the rotated app-server runs with stale config and — for
    // hooks.json — NO destructive guard).
    const prevHome = process.env.HOME;
    const prevCodexHome = process.env.CODEX_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    const fallback = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fallback-'));
    try {
      process.env.HOME = home;
      process.env.CODEX_HOME = fallback; // simulate post-rotation

      writeCodexMcpConfigToml({ nanoclaw: { command: 'bun', args: ['x'] } });
      writeCodexHooksJson();

      // Both land in the fallback (CODEX_HOME), NOT $HOME/.codex.
      expect(fs.existsSync(path.join(fallback, 'config.toml'))).toBe(true);
      expect(fs.existsSync(path.join(fallback, 'hooks.json'))).toBe(true);
      expect(fs.existsSync(path.join(home, '.codex', 'config.toml'))).toBe(false);
      expect(fs.existsSync(path.join(home, '.codex', 'hooks.json'))).toBe(false);
    } finally {
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
      if (prevCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = prevCodexHome;
      }
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(fallback, { recursive: true, force: true });
    }
  });
});
