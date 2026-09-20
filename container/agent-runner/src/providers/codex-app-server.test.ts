import { describe, it, expect } from 'bun:test';
import * as fs from 'fs';
import os from 'os';
import path from 'path';

import {
  type AppServer,
  buildCodexHooksJson,
  createCodexConfigOverrides,
  interruptCodexTurn,
  listCodexHooks,
  steerCodexTurn,
  parseTomlTableHeader,
  probeCodexThreadHealth,
  readCodexAccountRateLimits,
  readCodexTurnSnapshot,
  writeCodexHooksJson,
  writeCodexMcpConfigToml,
} from './codex-app-server.js';

interface RecordedRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

function fakeAppServer(
  respond: (request: RecordedRequest) => { result?: unknown; error?: { code: number; message: string } } | null,
): { server: AppServer; requests: RecordedRequest[]; lines: string[] } {
  const requests: RecordedRequest[] = [];
  /** Raw JSON-RPC text as written to the server's stdin — the actual wire shape. */
  const lines: string[] = [];
  const pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
  const server = {
    process: {
      stdin: {
        write(line: string) {
          lines.push(line);
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
  return { server, requests, lines };
}

describe('Codex app-server liveness RPCs', () => {
  it('steers an active turn with its expected id without a feature toggle', async () => {
    const { server, requests } = fakeAppServer(() => ({ result: { turnId: 'turn-active' } }));
    await expect(
      steerCodexTurn(server, { threadId: 'thread-1', expectedTurnId: 'turn-active', inputText: 'Focus on the tests' }),
    ).resolves.toEqual({ turnId: 'turn-active' });
    expect(requests[0]).toMatchObject({
      method: 'turn/steer',
      params: {
        threadId: 'thread-1',
        expectedTurnId: 'turn-active',
        input: [{ type: 'text', text: 'Focus on the tests' }],
      },
    });
  });

  it('surfaces steering rejection so the provider can queue the input', async () => {
    const { server } = fakeAppServer(() => ({ error: { code: -32600, message: 'no active turn' } }));
    await expect(
      steerCodexTurn(server, { threadId: 'thread-1', expectedTurnId: 'turn-ended', inputText: 'Follow-up' }),
    ).rejects.toThrow('turn/steer failed: no active turn');
  });

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

  it('reads the account rate-limit snapshot as a background usage poll', async () => {
    const { server, requests } = fakeAppServer(() => ({
      result: {
        rateLimits: {
          primary: { usedPercent: 12, windowDurationMins: 300 },
          secondary: { usedPercent: 91, windowDurationMins: 10080 },
        },
        rateLimitsByLimitId: { codex: { primary: { usedPercent: 12 } } },
        accountId: 'acct-1',
      },
    }));
    await expect(readCodexAccountRateLimits(server, 50)).resolves.toEqual({
      rateLimits: {
        primary: { usedPercent: 12, windowDurationMins: 300 },
        secondary: { usedPercent: 91, windowDurationMins: 10080 },
      },
      rateLimitsByLimitId: { codex: { primary: { usedPercent: 12 } } },
      accountId: 'acct-1',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'account/rateLimits/read' });
  });

  // codex 0.153.4 deserializes this method's params as unit and rejects a
  // params map carrying fields with `Invalid request: invalid type: map,
  // expected unit`, before any account lookup — which is what production logged
  // on every bind-time read while the container pinned it (#817). The container
  // now pins 0.154.0 (ARG CODEX_VERSION, container/Dockerfile:41), which would
  // accept the map; the no-params shape is retained deliberately because it is
  // the one BOTH versions accept, and the field it dropped was never read.
  // Assert the WIRE TEXT here rather than a shape mirrored from the code, so
  // restoring `{ excludeResetCreditDetails: true }` fails this test.
  it('sends the rate-limit read with no params key at all, the one shape both pinned and host codex accept', async () => {
    const { server, requests, lines } = fakeAppServer(() => ({
      result: { rateLimits: { primary: { usedPercent: 3, windowDurationMins: 300 } } },
    }));
    await readCodexAccountRateLimits(server, 50);

    expect(lines).toHaveLength(1);
    const raw = lines[0]!;
    // Wire text: no `"params"` member, in any form — not a map, not `null`.
    expect(raw).not.toContain('"params"');
    expect(raw).not.toContain('excludeResetCreditDetails');
    expect(JSON.parse(raw)).toEqual({ id: expect.any(Number), method: 'account/rateLimits/read' });
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['id', 'method']);
    expect('params' in requests[0]!).toBe(false);
  });

  it('surfaces a rate-limit read the server rejects or answers malformed, so the caller logs and skips the sample', async () => {
    const rejected = fakeAppServer(() => ({ error: { code: -32601, message: 'method not found' } }));
    await expect(readCodexAccountRateLimits(rejected.server, 50)).rejects.toThrow(
      'account/rateLimits/read failed: method not found',
    );
    const malformed = fakeAppServer(() => ({ result: { accountId: 'acct-1' } }));
    await expect(readCodexAccountRateLimits(malformed.server, 50)).rejects.toThrow(
      'account/rateLimits/read response missing rateLimits',
    );
    const silent = fakeAppServer(() => null);
    await expect(readCodexAccountRateLimits(silent.server, 5)).rejects.toThrow(
      'Timeout waiting for account/rateLimits/read response',
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
  it('omits the removed steering toggle', () => {
    expect(createCodexConfigOverrides().some((value) => value.startsWith('features.steer='))).toBe(false);
  });

  it('always sets features.goals=true and disables linux sandbox bwrap', () => {
    const overrides = createCodexConfigOverrides();
    expect(overrides).toContain('features.goals=true');
    expect(overrides).toContain('features.use_linux_sandbox_bwrap=false');
  });

  it('disables the native fast-mode feature', () => {
    expect(createCodexConfigOverrides()).toContain('features.fast_mode=false');
  });

  it("always raises project_doc_max_bytes above Codex's 32KB default", () => {
    // 32KB default (`project_doc_max_bytes`) truncated whole behavioral
    // sections of the group AGENTS.md silently. Tripwire: this must not
    // regress back to Codex's default on a future refactor.
    expect(createCodexConfigOverrides()).toContain('project_doc_max_bytes=262144');
    expect(createCodexConfigOverrides({ reasoning_effort: 'xhigh' })).toContain('project_doc_max_bytes=262144');
    expect(createCodexConfigOverrides(undefined, true)).toContain('project_doc_max_bytes=262144');
  });

  it('keeps context limits on CLI overrides through fallback-home rotation', () => {
    const overrides = createCodexConfigOverrides();
    expect(overrides).toContain('model_context_window=400000');
    expect(overrides).toContain('model_auto_compact_token_limit=360000');
  });

  it('uses the configured native subagent concurrency default', () => {
    const overrides = createCodexConfigOverrides();
    expect(overrides).toContain('features.multi_agent=true');
    expect(overrides).toContain('agents.max_concurrent_threads_per_session=5');
  });

  it('honors the validated per-group native subagent concurrency override', () => {
    // NOT the default value. This asserted 5 while the default was 4, so when
    // the default moved to 5 it kept passing — and would keep passing if the
    // override were ignored entirely. A test whose expectation equals the
    // fallback cannot observe the behaviour it names.
    expect(createCodexConfigOverrides({ max_concurrent_threads_per_session: 7 })).toContain(
      'agents.max_concurrent_threads_per_session=7',
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
  it('THROWS rather than truncating the file when config.toml is unreadable but writable', () => {
    // The live shape, and the reason this writer had to change: it read under
    // `catch { base = '' }`, so a mode-0200 config.toml was read as EMPTY and
    // the file then rewritten to MCP tables only — dropping the
    // `[hooks.state.*]` trust rows and the `[plugins.*]` / `[marketplaces.*]`
    // tables. It runs immediately BEFORE writeCodexHooksAndTrust on every
    // spawn, so it got there first: the trust writer's own read guard aborted
    // that query, but the damage was already on disk and the NEXT query wrote
    // valid trust rows over a base that had lost everything else.
    const prevCodexHome = process.env.CODEX_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-unreadable-'));
    const configPath = path.join(home, 'config.toml');
    const original = [
      '[features]',
      'hooks = true',
      '',
      '[marketplaces.mkt]',
      'source_type = "local"',
      '',
      '[hooks.state."/h/hooks.json:pre_tool_use:0:0"]',
      'trusted_hash = "sha256:deadbeef"',
      '',
    ].join('\n');
    try {
      process.env.CODEX_HOME = home;
      fs.writeFileSync(configPath, original);
      fs.chmodSync(configPath, 0o200);
      expect(() => writeCodexMcpConfigToml({ nanoclaw: { command: 'bun' } })).toThrow(/could not read Codex config/i);
      fs.chmodSync(configPath, 0o600);
      // Untouched: not truncated, not rewritten, every load-bearing table still there.
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(original);
    } finally {
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('commits by rename, so a failed write leaves the last valid config standing', () => {
    // `fs.writeFileSync` truncates in place: an ENOSPC after the open leaves
    // the file empty or partial, and the next spawn reads the damage as its
    // base. A leftover read-only temp file stands in for that failure here.
    const prevCodexHome = process.env.CODEX_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-commit-'));
    const configPath = path.join(home, 'config.toml');
    const original = '[features]\nhooks = true\n';
    try {
      process.env.CODEX_HOME = home;
      fs.writeFileSync(configPath, original);
      fs.writeFileSync(`${configPath}.tmp`, 'leftover');
      fs.chmodSync(`${configPath}.tmp`, 0o400);
      expect(() => writeCodexMcpConfigToml({ nanoclaw: { command: 'bun' } })).toThrow(/could not write Codex config/i);
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(original);
    } finally {
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

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

  it('quotes non-bare names and keys so one dotted server cannot eat the others (upstream 2e97ab046)', () => {
    // Emitted bare, `acme.tools` re-nests itself as a table under a phantom
    // `acme` server, and a name carrying `]` or `"` can close the header and
    // open its own [mcp_servers.*] table with a command nobody approved.
    const prevHome = process.env.HOME;
    const prevCodexHome = process.env.CODEX_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    try {
      process.env.HOME = home;
      delete process.env.CODEX_HOME;

      writeCodexMcpConfigToml({
        'acme.tools': { command: 'bun', args: ['run', 'acme.ts'], env: { 'x.y': 'z' } },
        good: { command: 'bun', args: ['run', 'good.ts'] },
      });

      const config = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf-8');
      const parsed = Bun.TOML.parse(config) as {
        mcp_servers: Record<string, { args?: string[]; env?: Record<string, string> }>;
      };

      // One server named `acme.tools` — not a table nested under `acme`.
      expect(Object.keys(parsed.mcp_servers).sort()).toEqual(['acme.tools', 'good']);
      expect(parsed.mcp_servers['acme.tools'].args).toEqual(['run', 'acme.ts']);
      expect(parsed.mcp_servers['acme.tools'].env).toEqual({ 'x.y': 'z' });
      // The unrelated server survives intact — that is the regression that matters.
      expect(parsed.mcp_servers.good.args).toEqual(['run', 'good.ts']);
      // Bare-safe names stay byte-identical, so no live config churns.
      expect(config).toContain('[mcp_servers.good]');
      expect(config).toContain('[mcp_servers."acme.tools".env]');
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

  it('escapes a control byte instead of emitting it raw, keeping the other servers (upstream 05860324c)', () => {
    // A raw C0 byte is forbidden in a TOML basic string, so codex rejected the
    // WHOLE file and the group lost every MCP server, not just this one.
    // Oracle is JSON.parse, not Bun.TOML.parse: TOML basic-string escapes are
    // JSON-compatible here, and Bun's TOML parser does not implement \uXXXX.
    const prevHome = process.env.HOME;
    const prevCodexHome = process.env.CODEX_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    try {
      process.env.HOME = home;
      delete process.env.CODEX_HOME;

      const bell = String.fromCharCode(7);
      writeCodexMcpConfigToml({
        tainted: { command: 'bun', env: { TOKEN: `tok${bell}en` } },
        good: { command: 'bun', args: ['run', 'good.ts'] },
      });

      const config = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf-8');
      expect(config).not.toContain(bell);
      expect(config).toContain('TOKEN = "tok\\u0007en"');
      const emitted = config.split('TOKEN = ')[1].split('\n')[0];
      expect(JSON.parse(emitted)).toBe(`tok${bell}en`);
      // The unrelated server is still there and still parses.
      expect(config).toContain('[mcp_servers.good]');
      expect(config).toContain('args = ["run", "good.ts"]');
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

  it('re-strips a quoted server name containing a bracket instead of duplicating its table', () => {
    // tomlKey emits `[mcp_servers."a]b"]` for a hostile name. A header scanner
    // that stops at the FIRST `]` does not recognize that line, keeps the whole
    // stale table as base config, and appends a second copy on the next spawn —
    // duplicate-table TOML that codex refuses, growing by one table per spawn.
    const prevHome = process.env.HOME;
    const prevCodexHome = process.env.CODEX_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    try {
      process.env.HOME = home;
      delete process.env.CODEX_HOME;
      const codexDir = path.join(home, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(path.join(codexDir, 'config.toml'), '[features]\nhooks = true\n');

      const servers = { 'a]b': { command: 'bun', args: ['x'] } };
      writeCodexMcpConfigToml(servers);
      writeCodexMcpConfigToml(servers);
      writeCodexMcpConfigToml(servers);

      const config = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf-8');
      expect(config.split('[mcp_servers.').length - 1).toBe(1);
      expect(config).toContain('[mcp_servers."a]b"]');
      // Non-MCP base config still survives the round trip.
      expect(config).toContain('[features]');
      expect(config).toContain('hooks = true');
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

  it('emits stdio cwd above the env sub-table and omits it when undeclared (upstream 5e15069da)', () => {
    const prevHome = process.env.HOME;
    const prevCodexHome = process.env.CODEX_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    try {
      process.env.HOME = home;
      delete process.env.CODEX_HOME;

      writeCodexMcpConfigToml({
        probe: {
          command: '/workspace/plugins/sdr/run.js',
          args: ['--flag'],
          env: { FOO: 'bar' },
          cwd: '/workspace/plugin-data/sdr',
        },
        plain: { command: 'bun' },
      });

      const config = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf-8');
      // Ordering is load-bearing: below the [.env] header TOML re-parents cwd
      // into the env table and codex launches in the wrong directory.
      expect(config).toContain(
        'command = "/workspace/plugins/sdr/run.js"\n' +
          'cwd = "/workspace/plugin-data/sdr"\n' +
          'args = ["--flag"]\n' +
          '[mcp_servers.probe.env]',
      );
      const parsed = Bun.TOML.parse(config) as {
        mcp_servers: Record<string, { cwd?: string; env?: Record<string, string> }>;
      };
      expect(parsed.mcp_servers.probe.cwd).toBe('/workspace/plugin-data/sdr');
      expect(parsed.mcp_servers.probe.env).toEqual({ FOO: 'bar' });
      expect(parsed.mcp_servers.plain.cwd).toBeUndefined();
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

describe('listCodexHooks', () => {
  /**
   * Response shape captured from codex-cli 0.154.0 against a scratch
   * CODEX_HOME: `data` is one group PER CWD (project-local hook files are
   * discovered per working directory), each carrying its own `hooks`,
   * `warnings` and `errors`.
   */
  const group = (cwd: string, keys: string[]) => ({
    cwd,
    hooks: keys.map((key) => ({ key, enabled: true, trustStatus: 'trusted', sourcePath: '/h/hooks.json' })),
    warnings: [],
    errors: [],
  });

  it('sends params as {} — codex REFUSES the request with no params member', () => {
    // Measured: omitting `params` is answered
    // `Invalid request: missing field \`params\`` (-32600). The opposite of
    // account/rateLimits/read above, whose params deserialize as unit.
    const { server, requests, lines } = fakeAppServer(() => ({ result: { data: [] } }));
    return listCodexHooks(server).then(() => {
      expect(requests[0].method).toBe('hooks/list');
      expect(requests[0].params).toEqual({});
      expect(lines[0]).toContain('"params":{}');
    });
  });

  it('flattens handlers across every cwd group', async () => {
    const { server } = fakeAppServer(() => ({
      result: { data: [group('/workspace/agent', ['a', 'b']), group('/tmp', ['c'])] },
    }));
    const listed = await listCodexHooks(server);
    expect(listed.entries.map((e) => e.key)).toEqual(['a', 'b', 'c']);
  });

  it('collects per-group warnings and errors', async () => {
    const { server } = fakeAppServer(() => ({
      result: { data: [{ cwd: '/x', hooks: [], warnings: ['w1'], errors: ['e1'] }] },
    }));
    const listed = await listCodexHooks(server);
    expect(listed.warnings).toEqual(['w1']);
    expect(listed.errors).toEqual(['e1']);
  });

  it('throws on an RPC error and on a malformed result', async () => {
    const rejected = fakeAppServer(() => ({ error: { code: -32601, message: 'method not found' } }));
    await expect(listCodexHooks(rejected.server)).rejects.toThrow(/method not found/);
    const malformed = fakeAppServer(() => ({ result: { hooks: [] } }));
    await expect(listCodexHooks(malformed.server)).rejects.toThrow(/missing data array/);
  });

  it('tolerates a group with no hooks array and drops non-object rows', async () => {
    const { server } = fakeAppServer(() => ({ result: { data: [{ cwd: '/x' }, { cwd: '/y', hooks: [null, 'x'] }] } }));
    const listed = await listCodexHooks(server);
    expect(listed.entries).toEqual([]);
  });
});
