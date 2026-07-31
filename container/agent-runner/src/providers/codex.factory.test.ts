import * as fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { createProvider } from './factory.js';
import {
  CodexProvider,
  augmentWithProxyEnv,
  copyRolloutToFallback,
  classifyCodexError,
  extractImageGenerationPath,
  findNewestRolloutAcrossHomes,
  findRolloutFile,
  formatCodexCollaborationProgress,
  isCodexNotificationForActiveTurn,
  materializeRawImageGeneration,
  mirrorCodexAgentsToHome,
  refreshCodexAuthFromHost,
  resolveQueryModel,
  resolveQueryEffort,
} from './codex.js';

describe('isCodexNotificationForActiveTurn', () => {
  it('accepts the active root thread and turn', () => {
    expect(
      isCodexNotificationForActiveTurn(
        'item/started',
        { threadId: 'root-1', turnId: 'turn-1' },
        'root-1',
        'turn-1',
      ),
    ).toBe(true);
  });

  it('rejects child threads and stale turns from the same root thread', () => {
    expect(
      isCodexNotificationForActiveTurn(
        'item/started',
        { threadId: 'child-1', turnId: 'child-turn-1' },
        'root-1',
        'turn-1',
      ),
    ).toBe(false);
    expect(
      isCodexNotificationForActiveTurn(
        'turn/completed',
        { threadId: 'root-1', turn: { id: 'turn-older' } },
        'root-1',
        'turn-1',
      ),
    ).toBe(false);
  });

  it('rejects malformed lifecycle notifications that omit required scope identifiers', () => {
    expect(isCodexNotificationForActiveTurn('item/started', {}, 'root-1', 'turn-1')).toBe(false);
    expect(
      isCodexNotificationForActiveTurn(
        'turn/completed',
        { threadId: 'root-1', turn: { status: 'completed' } },
        'root-1',
        'turn-1',
      ),
    ).toBe(false);
  });

  it('accepts root thread notifications that are not scoped to one turn', () => {
    expect(
      isCodexNotificationForActiveTurn(
        'thread/status/changed',
        { threadId: 'root-1', status: { type: 'active' } },
        'root-1',
        'turn-1',
      ),
    ).toBe(true);
    expect(
      isCodexNotificationForActiveTurn(
        'thread/started',
        { thread: { id: 'root-1' } },
        'root-1',
        null,
      ),
    ).toBe(true);
  });
});

describe('createProvider (codex)', () => {
  it('returns CodexProvider for codex', () => {
    expect(createProvider('codex')).toBeInstanceOf(CodexProvider);
  });

  it('flags stale thread errors as session-invalid', () => {
    const p = new CodexProvider();
    expect(p.isSessionInvalid(new Error('thread not found'))).toBe(true);
    expect(p.isSessionInvalid(new Error('unknown thread 123'))).toBe(true);
    expect(p.isSessionInvalid(new Error('No such thread: abc'))).toBe(true);
  });

  it('does not flag unrelated errors as session-invalid', () => {
    const p = new CodexProvider();
    expect(p.isSessionInvalid(new Error('rate limit exceeded'))).toBe(false);
    expect(p.isSessionInvalid(new Error('connection reset'))).toBe(false);
    expect(p.isSessionInvalid(new Error('codex app-server exited: code=1'))).toBe(false);
  });

  it('declares no native slash command support', () => {
    const p = new CodexProvider();
    expect(p.supportsNativeSlashCommands).toBe(false);
  });

  it('keeps HTTP MCP servers native by default', () => {
    const p = new CodexProvider({
      mcpServers: {
        exa: { type: 'http', url: 'https://mcp.exa.ai/mcp' },
        custom: {
          type: 'http',
          url: 'https://example.test/mcp',
          headers: { Authorization: 'Bearer placeholder' },
        },
      },
    }) as unknown as {
      mcpServers: Record<
        string,
        { type?: string; url?: string; headers?: Record<string, string>; command?: string; args?: string[] }
      >;
    };

    expect(p.mcpServers.exa).toEqual({ type: 'http', url: 'https://mcp.exa.ai/mcp' });
    expect(p.mcpServers.custom).toEqual({
      type: 'http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer placeholder' },
    });
    expect(p.mcpServers.exa.command).toBeUndefined();
    expect(p.mcpServers.exa.args).toBeUndefined();
  });

  it('rejects deprecated SSE MCP servers', () => {
    expect(
      () => new CodexProvider({ mcpServers: { legacy: { type: 'sse', url: 'https://example.test/sse' } } }),
    ).toThrow(/deprecated SSE transport/);
  });

  it('uses the HTTP bridge only when the explicit fallback flag is enabled', () => {
    const previous = process.env.NANOCLAW_CODEX_MCP_HTTP_BRIDGE_FALLBACK;
    try {
      process.env.NANOCLAW_CODEX_MCP_HTTP_BRIDGE_FALLBACK = '1';
      const p = new CodexProvider({
        mcpServers: {
          exa: { type: 'http', url: 'https://mcp.exa.ai/mcp' },
          custom: {
            type: 'http',
            url: 'https://example.test/mcp',
            headers: { Authorization: 'Bearer placeholder' },
          },
        },
      }) as unknown as {
        mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
      };

      expect(p.mcpServers.exa.command).toBe('bun');
      expect(p.mcpServers.exa.args).toEqual(['/app/src/remote-mcp-bridge.ts', 'https://mcp.exa.ai/mcp']);
      expect(p.mcpServers.exa.env?.REMOTE_MCP_NAME).toBe('exa');
      expect(p.mcpServers.custom.env?.REMOTE_MCP_AUTHORIZATION).toBe('Bearer placeholder');
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CODEX_MCP_HTTP_BRIDGE_FALLBACK;
      else process.env.NANOCLAW_CODEX_MCP_HTTP_BRIDGE_FALLBACK = previous;
    }
  });

  // Issue 3 from the Example Assistant / Example Assistant Codex parity report: Codex's app-server writes
  // stdio MCP env blocks to ~/.codex/config.toml and passes ONLY that block to
  // spawned subprocesses; host env doesn't propagate the way it does for
  // Claude's SDK-spawned stdio MCPs. Stdio MCPs and the explicit HTTP bridge
  // fallback both need proxy/CA env propagation. Native HTTP MCP servers do not
  // spawn a child process, so they do not carry an env block.
  describe('MCP proxy env propagation', () => {
    // Tests touch process.env — snapshot + restore so neighbours stay clean.
    function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
      const snapshot: Record<string, string | undefined> = {};
      for (const key of Object.keys(overrides)) snapshot[key] = process.env[key];
      try {
        for (const [k, v] of Object.entries(overrides)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        return fn();
      } finally {
        for (const [k, v] of Object.entries(snapshot)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    }

    it('augments HTTP bridge fallback env block with HTTPS_PROXY + NODE_EXTRA_CA_CERTS from container env', () => {
      withEnv(
        {
          NANOCLAW_CODEX_MCP_HTTP_BRIDGE_FALLBACK: '1',
          HTTPS_PROXY: 'http://x:secret@host.docker.internal:10255',
          NODE_EXTRA_CA_CERTS: '/tmp/onecli-gateway-ca.pem',
        },
        () => {
          const p = new CodexProvider({
            mcpServers: { exa: { type: 'http', url: 'https://mcp.exa.ai/mcp' } },
          }) as unknown as {
            mcpServers: Record<string, { env?: Record<string, string> }>;
          };
          expect(p.mcpServers.exa.env?.HTTPS_PROXY).toBe('http://x:secret@host.docker.internal:10255');
          expect(p.mcpServers.exa.env?.NODE_EXTRA_CA_CERTS).toBe('/tmp/onecli-gateway-ca.pem');
          expect(p.mcpServers.exa.env?.REMOTE_MCP_NAME).toBe('exa');
        },
      );
    });

    it('augments stdio MCP env block too — not just HTTP-bridged ones', () => {
      withEnv({ HTTPS_PROXY: 'http://proxy:10255', SSL_CERT_FILE: '/tmp/ca.pem' }, () => {
        const p = new CodexProvider({
          mcpServers: {
            local: { type: 'stdio', command: 'bun', args: ['/app/src/local-mcp.ts'], env: { LOCAL_FLAG: 'on' } },
          },
        }) as unknown as { mcpServers: Record<string, { env?: Record<string, string> }> };
        expect(p.mcpServers.local.env?.LOCAL_FLAG).toBe('on');
        expect(p.mcpServers.local.env?.HTTPS_PROXY).toBe('http://proxy:10255');
        expect(p.mcpServers.local.env?.SSL_CERT_FILE).toBe('/tmp/ca.pem');
      });
    });

    it('does not overwrite an HTTP bridge fallback env block that already sets a proxy var', () => {
      withEnv({ NANOCLAW_CODEX_MCP_HTTP_BRIDGE_FALLBACK: '1', HTTPS_PROXY: 'http://host-default:10255' }, () => {
        const p = new CodexProvider({
          mcpServers: {
            custom: {
              type: 'http',
              url: 'https://example.test/mcp',
              headers: { Authorization: 'Bearer placeholder' },
            },
          },
        }) as unknown as { mcpServers: Record<string, { env?: Record<string, string> }> };
        // Env starts with REMOTE_MCP_NAME + REMOTE_MCP_AUTHORIZATION (set by
        // the provider, not by augment). Host HTTPS_PROXY then fills in.
        expect(p.mcpServers.custom.env?.HTTPS_PROXY).toBe('http://host-default:10255');
      });
    });

    it('omits proxy keys that are not set in process.env', () => {
      withEnv(
        {
          NANOCLAW_CODEX_MCP_HTTP_BRIDGE_FALLBACK: '1',
          HTTPS_PROXY: 'http://proxy:10255',
          HTTP_PROXY: undefined,
          NO_PROXY: undefined,
          NODE_EXTRA_CA_CERTS: undefined,
        },
        () => {
          const p = new CodexProvider({
            mcpServers: { exa: { type: 'http', url: 'https://mcp.exa.ai/mcp' } },
          }) as unknown as { mcpServers: Record<string, { env?: Record<string, string> }> };
          expect(p.mcpServers.exa.env?.HTTPS_PROXY).toBe('http://proxy:10255');
          expect(p.mcpServers.exa.env?.HTTP_PROXY).toBeUndefined();
          expect(p.mcpServers.exa.env?.NO_PROXY).toBeUndefined();
          expect(p.mcpServers.exa.env?.NODE_EXTRA_CA_CERTS).toBeUndefined();
        },
      );
    });
  });

  describe('augmentWithProxyEnv (unit)', () => {
    it('returns a copy — does not mutate input', () => {
      const orig: Record<string, string> = { LOCAL: 'x' };
      const snapshot = process.env.HTTPS_PROXY;
      try {
        process.env.HTTPS_PROXY = 'http://proxy:10255';
        const out = augmentWithProxyEnv(orig);
        expect(out).not.toBe(orig);
        expect(orig.HTTPS_PROXY).toBeUndefined();
        expect(out.HTTPS_PROXY).toBe('http://proxy:10255');
        expect(out.LOCAL).toBe('x');
      } finally {
        if (snapshot === undefined) delete process.env.HTTPS_PROXY;
        else process.env.HTTPS_PROXY = snapshot;
      }
    });

    it('respects existing keys in baseEnv — host env does not clobber explicit MCP env', () => {
      const snapshot = process.env.HTTPS_PROXY;
      try {
        process.env.HTTPS_PROXY = 'http://host:10255';
        const out = augmentWithProxyEnv({ HTTPS_PROXY: 'http://mcp-explicit:9999' });
        expect(out.HTTPS_PROXY).toBe('http://mcp-explicit:9999');
      } finally {
        if (snapshot === undefined) delete process.env.HTTPS_PROXY;
        else process.env.HTTPS_PROXY = snapshot;
      }
    });

    it('skips empty-string proxy values (treats as unset)', () => {
      const snapshot = process.env.HTTPS_PROXY;
      try {
        process.env.HTTPS_PROXY = '';
        const out = augmentWithProxyEnv({});
        expect(out.HTTPS_PROXY).toBeUndefined();
      } finally {
        if (snapshot === undefined) delete process.env.HTTPS_PROXY;
        else process.env.HTTPS_PROXY = snapshot;
      }
    });
  });
});

describe('formatCodexCollaborationProgress', () => {
  it('renders current subAgentActivity lifecycle events with the agent path', () => {
    const emittedIds = new Set<string>();

    expect(
      formatCodexCollaborationProgress(
        {
          type: 'subAgentActivity',
          id: 'call-start',
          agentPath: '/root/researcher',
          agentThreadId: 'thread-1',
          kind: 'started',
        },
        emittedIds,
      ),
    ).toBe('🌱 subagent: started (/root/researcher)');
    expect(
      formatCodexCollaborationProgress(
        {
          type: 'subAgentActivity',
          id: 'call-interact',
          agentPath: '/root/researcher',
          agentThreadId: 'thread-1',
          kind: 'interacted',
        },
        emittedIds,
      ),
    ).toBe('📨 subagent: interacted (/root/researcher)');
    expect(
      formatCodexCollaborationProgress(
        {
          type: 'subAgentActivity',
          id: 'call-interrupt',
          agentPath: '/root/researcher',
          agentThreadId: 'thread-1',
          kind: 'interrupted',
        },
        emittedIds,
      ),
    ).toBe('🛑 subagent: interrupted (/root/researcher)');
  });

  it('preserves legacy collabAgentToolCall progress rendering', () => {
    expect(
      formatCodexCollaborationProgress(
        {
          type: 'collabAgentToolCall',
          id: 'call-spawn',
          tool: 'spawnAgent',
          receiverThreadIds: ['thread-1'],
        },
        new Set(),
      ),
    ).toBe('🌱 subagent: spawned (1 agent)');
  });

  it('deduplicates legacy and current event shapes sharing a protocol item id', () => {
    const emittedIds = new Set<string>();
    const legacy = {
      type: 'collabAgentToolCall',
      id: 'call-shared',
      tool: 'spawnAgent',
      receiverThreadIds: ['thread-1'],
    };
    const current = {
      type: 'subAgentActivity',
      id: 'call-shared',
      agentPath: '/root/researcher',
      agentThreadId: 'thread-1',
      kind: 'started',
    };

    expect(formatCodexCollaborationProgress(legacy, emittedIds)).not.toBeNull();
    expect(formatCodexCollaborationProgress(current, emittedIds)).toBeNull();

    const reverseOrderIds = new Set<string>();
    expect(formatCodexCollaborationProgress(current, reverseOrderIds)).not.toBeNull();
    expect(formatCodexCollaborationProgress(legacy, reverseOrderIds)).toBeNull();
  });

  it('ignores unrelated and malformed collaboration items', () => {
    const emittedIds = new Set<string>();
    expect(formatCodexCollaborationProgress({ type: 'reasoning', id: 'reasoning-1' }, emittedIds)).toBeNull();
    expect(
      formatCodexCollaborationProgress(
        {
          type: 'subAgentActivity',
          id: 'call-unknown',
          agentPath: '/root/researcher',
          agentThreadId: 'thread-1',
          kind: 'finished',
        },
        emittedIds,
      ),
    ).toBeNull();
  });
});

describe('extractImageGenerationPath', () => {
  it('accepts completed imageGeneration items with savedPath', () => {
    expect(
      extractImageGenerationPath({
        type: 'imageGeneration',
        status: 'completed',
        savedPath: '/home/node/.codex/generated_images/session/image.png',
      }),
    ).toBe('/home/node/.codex/generated_images/session/image.png');
  });

  it('accepts snake_case saved_path from raw app-server payloads', () => {
    expect(
      extractImageGenerationPath({
        type: 'imageGeneration',
        status: 'succeeded',
        saved_path: '/home/node/.codex/generated_images/session/image.png',
      }),
    ).toBe('/home/node/.codex/generated_images/session/image.png');
  });

  it('accepts a saved path even when Codex reports a nonterminal status label', () => {
    expect(
      extractImageGenerationPath({
        type: 'imageGeneration',
        status: 'generating',
        savedPath: '/home/node/.codex/generated_images/session/image.png',
      }),
    ).toBe('/home/node/.codex/generated_images/session/image.png');
  });

  it('ignores failed and non-image items', () => {
    expect(
      extractImageGenerationPath({
        type: 'imageGeneration',
        status: 'failed',
        savedPath: '/home/node/.codex/generated_images/session/image.png',
      }),
    ).toBeNull();
    expect(extractImageGenerationPath({ type: 'agentMessage', savedPath: '/tmp/nope.png' })).toBeNull();
  });
});

describe('materializeRawImageGeneration', () => {
  it('writes raw image_generation_call bytes to a generated image file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-raw-image-'));
    const out = materializeRawImageGeneration(
      {
        type: 'image_generation_call',
        id: 'ig/test:path',
        status: 'generating',
        result: Buffer.from('png-bytes').toString('base64'),
      },
      root,
    );

    expect(out).toBe(path.join(root, 'ig_test_path.png'));
    expect(fs.readFileSync(out!, 'utf-8')).toBe('png-bytes');
  });

  it('ignores failed raw image_generation_call items', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-raw-image-'));
    const out = materializeRawImageGeneration(
      {
        type: 'image_generation_call',
        id: 'ig_failed',
        status: 'failed',
        result: Buffer.from('png-bytes').toString('base64'),
      },
      root,
    );

    expect(out).toBeNull();
    expect(fs.readdirSync(root)).toHaveLength(0);
  });
});

describe('codex gen() self-heals on hard turn errors (Layer-2 fix)', () => {
  // Background: when a codex turn hits TURN_TIMEOUT_MS, the provider yields
  // `{type:'error', retryable:false}` and runOneTurn returns — but the
  // outer `while (!aborted)` used to continue with `yield* runOneTurn(...)`,
  // and the codex app-server's internal turn state stayed wedged. There's
  // no `turn/cancel` RPC in the protocol (only `turn/start`/`turn/steer`),
  // so subsequent startCodexTurn calls re-timed-out the same way every
  // 5 min. Without the early return, the only recovery was host-sweep at
  // ABSOLUTE_CEILING_MS (30 min). The fix: re-yield events explicitly and
  // return from gen() on a `retryable:false` so the outer finally runs
  // killCodexAppServer; the next poll-loop iteration spawns a fresh
  // app-server within seconds.
  //
  // Source-anchored guard (matches the F4 done-flag regression-guard
  // pattern in poll-loop.test.ts). A behavior-level test would need a
  // live app-server fake at the JSON-RPC boundary — out of scope for the
  // factory test bundle; the F4 anchor pattern is the established way to
  // freeze this invariant in this tree.
  it('gen() returns on `retryable:false` so the app-server gets killed', () => {
    const src = fs.readFileSync(new URL('./codex.ts', import.meta.url), 'utf8');

    // The runOneTurn for-await is the anchor. Slice from there to the
    // matching outer finally (where killCodexAppServer fires) so the
    // assertion covers the whole inner-loop body regardless of how much
    // rotation logic lives between the iterator and the terminal return.
    const runOneTurnIdx = src.search(/^\s+for await \(const ev of runOneTurn\(/m);
    expect(runOneTurnIdx).toBeGreaterThan(-1);
    const finallyIdx = src.indexOf('} finally {', runOneTurnIdx);
    expect(finallyIdx).toBeGreaterThan(runOneTurnIdx);
    const window = src.slice(runOneTurnIdx, finallyIdx);
    // Strip line comments + block comments so explanatory prose can mention
    // "retryable===false" without satisfying the check.
    const codeOnly = window
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => {
        const i = l.indexOf('//');
        return i >= 0 ? l.slice(0, i) : l;
      })
      .join('\n');

    // We must inspect-and-re-yield (not bare `yield*`), branch on
    // retryable===false, and have a terminal return for non-rotatable
    // errors. The rotation path also re-yields progress events but the
    // structural invariants below must still hold.
    expect(codeOnly).toContain('yield ev');
    expect(codeOnly).toMatch(/retryable\s*===\s*false/);
    expect(codeOnly).toContain('return');

    // And the file's finally block still kills the app-server — that's
    // what makes the return actually recover.
    expect(src).toMatch(/finally\s*\{[\s\S]*killCodexAppServer\(server\)/);
  });

  it('gen() does NOT use bare `yield*` for runOneTurn — that path is silent on hard error', () => {
    const src = fs.readFileSync(new URL('./codex.ts', import.meta.url), 'utf8');
    // Strip line and block comments so a comment explaining the prohibited
    // pattern doesn't trip the assertion.
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => {
        const i = l.indexOf('//');
        return i >= 0 ? l.slice(0, i) : l;
      })
      .join('\n');
    expect(codeOnly).not.toMatch(/yield\*\s+runOneTurn\(/);
  });
});

describe('codex turn watchdog is health-based, not wall-clock', () => {
  it('declares bounded control-plane probe settings, not a total-turn threshold', () => {
    const src = fs.readFileSync(new URL('./codex.ts', import.meta.url), 'utf8');
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => {
        const i = l.indexOf('//');
        return i >= 0 ? l.slice(0, i) : l;
      })
      .join('\n');
    expect(codeOnly).not.toMatch(/\bTURN_TIMEOUT_MS\b/);
    expect(codeOnly).not.toMatch(/\bTURN_IDLE_TIMEOUT_MS\b/);
    expect(codeOnly).toContain('CODEX_HEALTH_PROBE_QUIET_MS');
    expect(codeOnly).toContain('CODEX_HEALTH_PROBE_INTERVAL_MS');
    expect(codeOnly).toContain('CODEX_HEALTH_PROBE_TIMEOUT_MS');
    expect(codeOnly).toContain('CODEX_HEALTH_PROBE_FAILURE_LIMIT');
  });

  it('tracks every notification and item identity through CodexTurnLiveness', () => {
    const src = fs.readFileSync(new URL('./codex.ts', import.meta.url), 'utf8');
    const handlerStart = src.indexOf('const handler = (n: JsonRpcNotification)');
    expect(handlerStart).toBeGreaterThan(-1);
    const switchStart = src.indexOf('switch (method)', handlerStart);
    expect(switchStart).toBeGreaterThan(-1);
    const handlerPreamble = src.slice(handlerStart, switchStart);
    expect(handlerPreamble).toContain('liveness.noteItemStarted(params.item)');
    expect(handlerPreamble).toContain('liveness.noteItemCompleted(params.item)');
    expect(handlerPreamble).toContain('liveness.noteNotification()');
  });

  it('starts health probes before turn dispatch and clears them in finally', () => {
    const src = fs.readFileSync(new URL('./codex.ts', import.meta.url), 'utf8');
    const startCodexTurnIdx = src.indexOf('await startCodexTurn(server,');
    expect(startCodexTurnIdx).toBeGreaterThan(-1);
    const preStart = src.slice(0, startCodexTurnIdx);
    expect(preStart).toContain('healthTimer = setInterval');
    expect(src).toMatch(/finally\s*\{[\s\S]*clearInterval\(healthTimer\)/);
  });

  it('successful protocol probes emit activity instead of terminating a quiet turn', () => {
    const src = fs.readFileSync(new URL('./codex.ts', import.meta.url), 'utf8');
    const probeStart = src.indexOf('const runHealthProbe');
    expect(probeStart).toBeGreaterThan(-1);
    const probeBody = src.slice(probeStart, src.indexOf('const handler', probeStart));
    expect(probeBody).toContain('probeCodexThreadHealth');
    expect(probeBody).toContain("buffer.push({ type: 'activity' })");
    expect(probeBody).toContain('finishForLivenessFailure(decision.classification, decision.reason)');
  });

  it('does not retain the blanket inFlightItems watchdog suppression', () => {
    const src = fs.readFileSync(new URL('./codex.ts', import.meta.url), 'utf8');
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(codeOnly).not.toMatch(/let\s+inFlightItems\s*=\s*0/);
    expect(codeOnly).toContain('new CodexTurnLiveness');
  });

  it('publishes the whole turn to the host as a bounded catastrophic backstop', () => {
    const src = fs.readFileSync(new URL('./codex.ts', import.meta.url), 'utf8');
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => {
        const i = l.indexOf('//');
        return i >= 0 ? l.slice(0, i) : l;
      })
      .join('\n');

    const decl = codeOnly.match(/const\s+CODEX_IN_FLIGHT_ITEM_TIMEOUT_MS\s*=\s*([^;]+);/);
    expect(decl).not.toBeNull();
    const ms = Function(`'use strict'; return (${decl![1]});`)() as number;
    expect(ms).toBe(60 * 60 * 1000);

    expect(codeOnly).toContain("setContainerToolInFlight('CodexItem', CODEX_IN_FLIGHT_ITEM_TIMEOUT_MS)");
    expect(codeOnly).toMatch(/finally\s*\{[\s\S]{0,500}clearContainerToolInFlight\(\)/);
  });
});

describe('codex turn-failure classification (systemError + turn/completed:failed)', () => {
  // Background (2026-05-21): a Example Retail codex session hit its ChatGPT
  // weekly usage cap mid-turn. The codex app-server emitted a
  // `thread/status/changed` with status `systemError`, then no follow-up
  // `turn/completed` arrived (codex-cli 0.130.0). The container sat for
  // 30 min until host-sweep's ABSOLUTE_CEILING_MS killed it.
  //
  // Root causes:
  //   1. systemError was treated as a generic progress label, not a turn
  //      end — runOneTurn kept waiting.
  //   2. turn/completed had no branch for status='failed' or an `error`
  //      payload — every turn/completed was treated as success.
  //
  // Both are source-anchored so the invariants stay frozen even if the
  // surrounding handler grows new cases.

  it('thread/status/changed: systemError ends the turn (not just a progress label)', () => {
    const src = fs.readFileSync(new URL('./codex.ts', import.meta.url), 'utf8');
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => {
        const i = l.indexOf('//');
        return i >= 0 ? l.slice(0, i) : l;
      })
      .join('\n');

    // The handler must detect `label === 'systemError'` and set turnDone.
    // We anchor on the literal so an unrelated `systemError` mention in
    // comments doesn't satisfy the assertion (comments are stripped).
    const m = codeOnly.match(/label\s*===\s*['"]systemError['"][\s\S]{0,500}/);
    expect(m).not.toBeNull();
    const window = m![0];
    // Within the systemError branch, both turnState.error and turnDone
    // must be set. Ordering doesn't matter; presence does.
    expect(window).toMatch(/turnState\.error\s*=\s*new\s+Error/);
    expect(window).toMatch(/turnDone\s*=\s*true/);
  });

  it('completed-turn handler handles status=failed + carries codexErrorInfo.type into turnState.errorKind', () => {
    const src = fs.readFileSync(new URL('./codex.ts', import.meta.url), 'utf8');
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => {
        const i = l.indexOf('//');
        return i >= 0 ? l.slice(0, i) : l;
      })
      .join('\n');

    // Completion is asynchronous because an empty notification snapshot may
    // need a thread/read backfill. Anchor on that handler rather than the
    // notification dispatch branch.
    const handlerIdx = codeOnly.indexOf('const completeTurn = async');
    expect(handlerIdx).toBeGreaterThan(-1);
    const window = codeOnly.slice(handlerIdx, handlerIdx + 2400);

    // status==='failed' OR error-presence path
    expect(window).toMatch(/p\.status\s*===\s*['"]failed['"]|status\s*===\s*['"]failed['"]/);
    // structured error type captured into turnState.errorKind
    expect(window).toMatch(/codexErrorInfo[\s\S]{0,200}type/);
    expect(window).toMatch(/turnState\.errorKind\s*=/);
  });

  it('turnState carries an errorKind field for structured Codex error classification', () => {
    const src = fs.readFileSync(new URL('./codex.ts', import.meta.url), 'utf8');
    // Declaration must include errorKind alongside error.
    expect(src).toMatch(/const\s+turnState\s*:\s*\{[^}]*errorKind[^}]*\}/);
  });

  it('turn/failed branch also captures errorKind (parity with turn/completed:failed)', () => {
    const src = fs.readFileSync(new URL('./codex.ts', import.meta.url), 'utf8');
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => {
        const i = l.indexOf('//');
        return i >= 0 ? l.slice(0, i) : l;
      })
      .join('\n');
    const caseIdx = codeOnly.indexOf("case 'turn/failed'");
    expect(caseIdx).toBeGreaterThan(-1);
    const window = codeOnly.slice(caseIdx, caseIdx + 500);
    expect(window).toMatch(/codexErrorInfo[\s\S]{0,200}type/);
    expect(window).toMatch(/turnState\.errorKind\s*=/);
  });
});

describe('codex OAuth fallback — rotation primitives', () => {
  // Helpers for building a fake CODEX_HOME layout. Codex writes rollouts
  // to `${CODEX_HOME}/sessions/YYYY/MM/DD/rollout-<ISO>-<threadId>.jsonl`.

  function makeHome(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-rotation-'));
  }

  function writeRollout(home: string, dateSubpath: string, threadId: string, content = 'meta\nturn1\n'): string {
    const dir = path.join(home, 'sessions', dateSubpath);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-05-21T03-15-00-${threadId}.jsonl`);
    fs.writeFileSync(file, content);
    return file;
  }

  describe('findRolloutFile', () => {
    it('returns null when sessions dir does not exist', () => {
      const home = makeHome();
      expect(findRolloutFile('019dd6dc-ad2c-7071-a95f-08d8dcd11dc8', home)).toBeNull();
    });

    it('finds the rollout matching the threadId suffix', () => {
      const home = makeHome();
      const tid = '019dd6dc-ad2c-7071-a95f-08d8dcd11dc8';
      const written = writeRollout(home, '2026/05/21', tid);
      const found = findRolloutFile(tid, home);
      expect(found).toBe(written);
    });

    it('returns null when threadId is not present in any filename', () => {
      const home = makeHome();
      writeRollout(home, '2026/05/21', 'aaaaaaaa-aaaa-7071-a95f-aaaaaaaaaaaa');
      expect(findRolloutFile('bbbbbbbb-bbbb-7071-a95f-bbbbbbbbbbbb', home)).toBeNull();
    });

    it('matches case-insensitively', () => {
      const home = makeHome();
      const written = writeRollout(home, '2026/05/21', 'ABCDEF12-ABCD-7071-A95F-ABCDEF123456');
      const found = findRolloutFile('abcdef12-abcd-7071-a95f-abcdef123456', home);
      expect(found).toBe(written);
    });

    it('walks the year/month/day tree to depth 3', () => {
      const home = makeHome();
      const tid = '019dd6dc-deep-7071-a95f-08d8dcd11dc8';
      const written = writeRollout(home, '2026/05/21', tid);
      expect(findRolloutFile(tid, home)).toBe(written);
    });
  });

  describe('copyRolloutToFallback', () => {
    it('copies the rollout to the matching path under the fallback home', () => {
      const src = makeHome();
      const dst = makeHome();
      const tid = '019dd6dc-ad2c-7071-a95f-08d8dcd11dc8';
      const srcFile = writeRollout(src, '2026/05/21', tid, 'src-content\n');

      const result = copyRolloutToFallback(srcFile, src, dst);
      expect(result).not.toBeNull();
      expect(result!).toBe(path.join(dst, 'sessions', '2026/05/21', path.basename(srcFile)));
      expect(fs.readFileSync(result!, 'utf-8')).toBe('src-content\n');
    });

    it('creates the destination date subdirectory if missing', () => {
      const src = makeHome();
      const dst = makeHome();
      const tid = '019dd6dc-ad2c-7071-a95f-08d8dcd11dc8';
      const srcFile = writeRollout(src, '2026/05/21', tid);
      // dst's sessions/2026/05/21/ doesn't exist yet
      expect(fs.existsSync(path.join(dst, 'sessions', '2026/05/21'))).toBe(false);
      copyRolloutToFallback(srcFile, src, dst);
      expect(fs.existsSync(path.join(dst, 'sessions', '2026/05/21'))).toBe(true);
    });

    it('returns null when the source is outside the sessions root', () => {
      const src = makeHome();
      const dst = makeHome();
      // File OUTSIDE sessions/ — must be rejected, not silently copied
      // somewhere weird.
      const bogus = path.join(src, 'rollout-not-in-sessions.jsonl');
      fs.writeFileSync(bogus, 'x');
      expect(copyRolloutToFallback(bogus, src, dst)).toBeNull();
    });

    it('overwrites an existing destination (idempotent)', () => {
      const src = makeHome();
      const dst = makeHome();
      const tid = '019dd6dc-ad2c-7071-a95f-08d8dcd11dc8';
      const srcFile = writeRollout(src, '2026/05/21', tid, 'new-content\n');
      // Pre-existing destination with stale content
      const stalePath = path.join(dst, 'sessions', '2026/05/21', path.basename(srcFile));
      fs.mkdirSync(path.dirname(stalePath), { recursive: true });
      fs.writeFileSync(stalePath, 'stale-content\n');

      copyRolloutToFallback(srcFile, src, dst);
      expect(fs.readFileSync(stalePath, 'utf-8')).toBe('new-content\n');
    });
  });

  describe('refreshCodexAuthFromHost', () => {
    it('copies changed host auth into the active CODEX_HOME', () => {
      const active = makeHome();
      const host = makeHome();
      fs.writeFileSync(path.join(active, 'auth.json'), '{"token":"old"}');
      fs.writeFileSync(path.join(host, 'auth.json'), '{"token":"new"}');

      expect(refreshCodexAuthFromHost(active, host)).toBe(true);
      expect(fs.readFileSync(path.join(active, 'auth.json'), 'utf-8')).toBe('{"token":"new"}');
    });

    it('returns false when host auth is identical or absent', () => {
      const active = makeHome();
      const host = makeHome();
      fs.writeFileSync(path.join(active, 'auth.json'), '{"token":"same"}');
      fs.writeFileSync(path.join(host, 'auth.json'), '{"token":"same"}');

      expect(refreshCodexAuthFromHost(active, host)).toBe(false);
      expect(refreshCodexAuthFromHost(active, undefined)).toBe(false);
      expect(refreshCodexAuthFromHost(active, makeHome())).toBe(false);
    });
  });

  describe('CodexProvider fallback cursor', () => {
    function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
      const prev: Record<string, string | undefined> = {};
      for (const k of Object.keys(env)) {
        prev[k] = process.env[k];
        if (env[k] === undefined) delete process.env[k];
        else process.env[k] = env[k];
      }
      try {
        return fn();
      } finally {
        for (const k of Object.keys(prev)) {
          if (prev[k] === undefined) delete process.env[k];
          else process.env[k] = prev[k];
        }
      }
    }

    it('parses CODEX_FALLBACK_HOMES into an ordered list', () => {
      withEnv({ CODEX_FALLBACK_HOMES: '/home/node/.codex-fallback-1:/home/node/.codex-fallback-2' }, () => {
        const p = new CodexProvider();
        expect(p.fallbackHomes).toEqual(['/home/node/.codex-fallback-1', '/home/node/.codex-fallback-2']);
      });
    });

    it('returns empty fallbackHomes when CODEX_FALLBACK_HOMES is unset or blank', () => {
      withEnv({ CODEX_FALLBACK_HOMES: undefined }, () => {
        expect(new CodexProvider().fallbackHomes).toEqual([]);
      });
      withEnv({ CODEX_FALLBACK_HOMES: '' }, () => {
        expect(new CodexProvider().fallbackHomes).toEqual([]);
      });
      withEnv({ CODEX_FALLBACK_HOMES: '  ' }, () => {
        expect(new CodexProvider().fallbackHomes).toEqual([]);
      });
    });

    it('rotateCodexHome walks through fallbacks and returns null when exhausted', () => {
      withEnv({ CODEX_FALLBACK_HOMES: '/a:/b:/c' }, () => {
        const p = new CodexProvider();
        expect(p.rotateCodexHome()).toBe('/a');
        expect(p.rotateCodexHome()).toBe('/b');
        expect(p.rotateCodexHome()).toBe('/c');
        expect(p.rotateCodexHome()).toBeNull();
        // Position sticks once exhausted — does not loop.
        expect(p.rotateCodexHome()).toBeNull();
      });
    });

    it('rotateCodexHome returns null immediately when no fallbacks configured', () => {
      withEnv({ CODEX_FALLBACK_HOMES: undefined }, () => {
        expect(new CodexProvider().rotateCodexHome()).toBeNull();
      });
    });
  });

  describe('runOneTurn error → ProviderEvent classification mapping', () => {
    // The mapping now lives in the exported `classifyCodexError` helper — test
    // it behaviorally (stronger than the prior source-anchored grep). Fuller
    // coverage, incl. the idle_timeout path, is in codex.classify.test.ts.
    it('UsageLimitExceeded → classification "quota"', () => {
      expect(classifyCodexError('any message', 'UsageLimitExceeded')).toBe('quota');
    });

    it('ServerOverloaded → classification "overloaded"', () => {
      expect(classifyCodexError('any message', 'ServerOverloaded')).toBe('overloaded');
    });

    it('codex_system_error → classification "system_error"', () => {
      expect(classifyCodexError('codex_system_error: detail', null)).toBe('system_error');
    });
  });

  describe('findNewestRolloutAcrossHomes', () => {
    // Cross-container repair selector: scan multiple CODEX_HOMEs for a
    // rollout matching the threadId, pick the freshest by (mtime DESC,
    // size DESC). Size is the tiebreaker because mtimes can be near-equal
    // after the in-session rotation's copyFileSync — codex rollouts are
    // append-only so the larger file has more turns.

    function makeHome(): string {
      return fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-newest-'));
    }

    function writeRollout(
      home: string,
      dateSubpath: string,
      threadId: string,
      content: string,
      mtimeMs?: number,
    ): string {
      const dir = path.join(home, 'sessions', dateSubpath);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `rollout-2026-05-21T03-15-00-${threadId}.jsonl`);
      fs.writeFileSync(file, content);
      if (mtimeMs !== undefined) {
        const t = mtimeMs / 1000;
        fs.utimesSync(file, t, t);
      }
      return file;
    }

    it('returns null when threadId is not present in any home', () => {
      const h1 = makeHome();
      const h2 = makeHome();
      expect(findNewestRolloutAcrossHomes('019dd6dc-aaaa-bbbb-cccc-deadbeef0001', [h1, h2])).toBeNull();
    });

    it('returns null gracefully when sessions dirs are missing entirely', () => {
      // Brand-new CODEX_HOMEs with no sessions/ subtree yet — common for
      // fallback dirs that haven't been written to.
      const h1 = makeHome();
      // do NOT create sessions/ — verify we don't throw
      expect(findNewestRolloutAcrossHomes('019dd6dc-ad2c-7071-a95f-08d8dcd11dc8', [h1])).toBeNull();
    });

    it('handles empty homes array', () => {
      expect(findNewestRolloutAcrossHomes('019dd6dc-ad2c-7071-a95f-08d8dcd11dc8', [])).toBeNull();
    });

    it('returns the only home that has the rollout when others lack it', () => {
      const primary = makeHome();
      const fallback = makeHome();
      const tid = '019dd6dc-ad2c-7071-a95f-08d8dcd11dc8';
      const file = writeRollout(primary, '2026/05/21', tid, 'meta\nturn1\n');
      const result = findNewestRolloutAcrossHomes(tid, [primary, fallback]);
      expect(result).not.toBeNull();
      expect(result!.home).toBe(primary);
      expect(result!.path).toBe(file);
    });

    it('picks fallback when its mtime is newer than primary', () => {
      const primary = makeHome();
      const fallback = makeHome();
      const tid = '019dd6dc-ad2c-7071-a95f-08d8dcd11dc8';
      writeRollout(primary, '2026/05/21', tid, 'pre-rotation\n', 1_000_000);
      writeRollout(fallback, '2026/05/21', tid, 'post-rotation\nturn2\n', 2_000_000);
      const result = findNewestRolloutAcrossHomes(tid, [primary, fallback]);
      expect(result!.home).toBe(fallback);
    });

    it('tiebreaker: when mtimes are equal, larger size wins', () => {
      const primary = makeHome();
      const fallback = makeHome();
      const tid = '019dd6dc-ad2c-7071-a95f-08d8dcd11dc8';
      writeRollout(primary, '2026/05/21', tid, 'short\n', 1_500_000);
      writeRollout(fallback, '2026/05/21', tid, 'meta\nturn1\nturn2\nturn3\nturn4\n', 1_500_000);
      const result = findNewestRolloutAcrossHomes(tid, [primary, fallback]);
      // Same mtime, fallback has more bytes (more appended turns) → fallback wins
      expect(result!.home).toBe(fallback);
      expect(result!.size).toBeGreaterThan(result!.mtimeMs > 0 ? 6 : 0);
    });

    it('matches threadId case-insensitively', () => {
      const home = makeHome();
      const written = writeRollout(home, '2026/05/21', 'ABCDEF12-ABCD-7071-A95F-ABCDEF123456', 'x\n');
      const result = findNewestRolloutAcrossHomes('abcdef12-abcd-7071-a95f-abcdef123456', [home]);
      expect(result!.path).toBe(written);
    });

    it('walks the year/month/day tree across multiple subdirs', () => {
      const home = makeHome();
      const tid = '019dd6dc-deep-7071-a95f-08d8dcd11dc8';
      const written = writeRollout(home, '2026/05/18', tid, 'multi-day-session\n');
      // even though we look at "today" 2026/05/21, the rollout lives at its
      // creation-date subdir 2026/05/18 — must still find it
      expect(findNewestRolloutAcrossHomes(tid, [home])!.path).toBe(written);
    });
  });

  describe('gen() cross-container rollout repair (source-anchored)', () => {
    // Source-anchored to keep the resume-time repair pass invariant. The
    // call must:
    //   1. Live in gen() before startOrResumeCodexThread, so the resumed
    //      thread sees the freshest history.
    //   2. Be gated on self.fallbackHomes.length > 0 — zero-cost fast path
    //      for installs without OAuth fallback.
    //   3. Be gated on threadId being defined — fresh threads have nothing
    //      to repair.
    //   4. Copy via copyRolloutToFallback when the winner is in a non-
    //      active home.
    it('repair pass exists at gen() resume time with the required gates', () => {
      const src = fs.readFileSync(new URL('./codex.ts', import.meta.url), 'utf8');
      const codeOnly = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((l) => {
          const i = l.indexOf('//');
          return i >= 0 ? l.slice(0, i) : l;
        })
        .join('\n');

      // findNewestRolloutAcrossHomes is invoked from gen()
      expect(codeOnly).toContain('findNewestRolloutAcrossHomes(');
      // Gated on threadId + fallbacks (zero-cost fast path)
      expect(codeOnly).toMatch(/threadId\s*&&\s*self\.fallbackHomes\.length\s*>\s*0/);
      // The repair copy uses copyRolloutToFallback (reuses the rotation primitive)
      expect(codeOnly).toMatch(/copyRolloutToFallback\([^)]*candidate\.path[^)]*candidate\.home[^)]*currentCodexHome/);
      // The repair happens BEFORE startOrResumeCodexThread, not after
      const repairIdx = codeOnly.indexOf('findNewestRolloutAcrossHomes(');
      const resumeIdx = codeOnly.indexOf('await startOrResumeCodexThread(server, threadId, threadParams)');
      expect(repairIdx).toBeGreaterThan(-1);
      expect(resumeIdx).toBeGreaterThan(-1);
      expect(repairIdx).toBeLessThan(resumeIdx);
    });
  });

  describe('gen() primary auth refresh (source-anchored)', () => {
    it('refreshes copied primary auth before fallback rotation or surfacing a system_error', () => {
      const src = fs.readFileSync(new URL('./codex.ts', import.meta.url), 'utf8');
      const codeOnly = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((l) => {
          const i = l.indexOf('//');
          return i >= 0 ? l.slice(0, i) : l;
        })
        .join('\n');

      const refreshIdx = codeOnly.indexOf('refreshCodexAuthFromHost(currentCodexHome, primaryHostCodexHome)');
      const fallbackIdx = codeOnly.indexOf('if (eligible && self.nextFallback < self.fallbackHomes.length)');
      const surfaceIdx = codeOnly.indexOf('yield ev;');
      expect(refreshIdx).toBeGreaterThan(-1);
      expect(fallbackIdx).toBeGreaterThan(refreshIdx);
      expect(surfaceIdx).toBeGreaterThan(fallbackIdx);
      expect(codeOnly).toContain('process.env.CODEX_PRIMARY_HOST_HOME');
      expect(codeOnly).toContain('primaryAuthRefreshAttempted = true');
    });
  });
});

describe('per-query model/effort overrides (-m/-e flags)', () => {
  // The poll-loop delivers host-parsed flag values via QueryInput.model and
  // QueryInput.effort. Before 2026-06, the codex provider ignored both —
  // observed live (example-market-codex): `-m fable` was acked by the host and
  // stored as sticky_model=claude-fable-5[1m], while the session silently
  // kept running gpt-5.5. These resolvers are the validation boundary.

  describe('resolveQueryModel', () => {
    it('passes through a codex-shaped model override', () => {
      expect(resolveQueryModel('gpt-5.2-codex', 'gpt-5.5')).toBe('gpt-5.2-codex');
    });

    it('falls back to the configured model when no override is requested', () => {
      expect(resolveQueryModel(undefined, 'gpt-5.5')).toBe('gpt-5.5');
      expect(resolveQueryModel('', 'gpt-5.5')).toBe('gpt-5.5');
    });

    it('ignores a claude id (poisoned pre-provider-aware sticky_model)', () => {
      expect(resolveQueryModel('claude-fable-5[1m]', 'gpt-5.5')).toBe('gpt-5.5');
      expect(resolveQueryModel('opus', 'gpt-5.5')).toBe('gpt-5.5');
    });

    it('ignores malformed gpt-ish values', () => {
      expect(resolveQueryModel('gpt-', 'gpt-5.5')).toBe('gpt-5.5');
      expect(resolveQueryModel('GPT-5.5', 'gpt-5.5')).toBe('gpt-5.5');
    });
  });

  describe('resolveQueryEffort', () => {
    const sticky = { reasoning_effort: 'xhigh' as const };

    it('folds a valid codex effort into the sticky config', () => {
      expect(resolveQueryEffort('medium', sticky).reasoning_effort).toBe('medium');
      expect(resolveQueryEffort('max', sticky).reasoning_effort).toBe('max');
      expect(resolveQueryEffort('ultra', sticky).reasoning_effort).toBe('ultra');
    });

    it('does not mutate the original sticky config', () => {
      resolveQueryEffort('low', sticky);
      expect(sticky.reasoning_effort).toBe('xhigh');
    });

    it('keeps the sticky effort when no override is requested', () => {
      expect(resolveQueryEffort(undefined, sticky).reasoning_effort).toBe('xhigh');
      expect(resolveQueryEffort('', sticky).reasoning_effort).toBe('xhigh');
    });

    it('ignores unsupported or provider-specific values', () => {
      expect(resolveQueryEffort('none', sticky).reasoning_effort).toBe('xhigh');
      expect(resolveQueryEffort('minimal', sticky).reasoning_effort).toBe('xhigh');
      expect(resolveQueryEffort('ultracode', sticky).reasoning_effort).toBe('xhigh');
    });
  });

  // Source-anchored wiring guards (same pattern as the Layer-2 self-heal
  // tests above): gen() must consume the resolved values, not self.model /
  // self.stickyConfig, or flags regress to acked-but-ignored.
  describe('gen() wiring', () => {
    const src = fs.readFileSync(new URL('./codex.ts', import.meta.url), 'utf8');
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => {
        const i = l.indexOf('//');
        return i >= 0 ? l.slice(0, i) : l;
      })
      .join('\n');

    it('resolves overrides from QueryInput before gen()', () => {
      expect(codeOnly).toMatch(/resolveQueryModel\(input\.model,\s*this\.model\)/);
      expect(codeOnly).toMatch(/resolveQueryEffort\(input\.effort,\s*this\.stickyConfig\)/);
      expect(codeOnly).toMatch(/effectiveFast\s*=\s*input\.fast\s*===\s*true/);
    });

    it('thread params and per-turn model use the resolved model', () => {
      expect(codeOnly).toMatch(/model:\s*effectiveModel/);
      expect(codeOnly).not.toMatch(/model:\s*self\.model/);
      expect(codeOnly).not.toMatch(/runOneTurn\(\s*server,\s*threadId!,\s*text,\s*self\.model/);
    });

    it('every app-server spawn uses the effort-folded config and per-query fast mode', () => {
      const spawns = codeOnly.match(/spawnCodexAppServer\(createCodexConfigOverrides\(([^)]*)\)\)/g) ?? [];
      expect(spawns.length).toBeGreaterThanOrEqual(2);
      for (const s of spawns) {
        expect(s).toContain('effectiveConfig');
        expect(s).toContain('effectiveFast');
      }
    });
  });
});

describe('mirrorCodexAgentsToHome (codex #126)', () => {
  let primary: string;
  let fallback: string;
  beforeEach(() => {
    primary = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-primary-'));
    fallback = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fallback-'));
  });
  afterEach(() => {
    fs.rmSync(primary, { recursive: true, force: true });
    fs.rmSync(fallback, { recursive: true, force: true });
  });

  it('copies the primary agents/ role definitions into the fallback home', () => {
    // The agents/ tree is bind-mounted only at the primary; a rotated fallback
    // would otherwise lose every named subagent role.
    fs.mkdirSync(path.join(primary, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(primary, 'agents', 'architecture-advisor.toml'), 'name = "arch"\n');
    fs.writeFileSync(path.join(primary, 'agents', 'security-reviewer.toml'), 'name = "sec"\n');

    expect(mirrorCodexAgentsToHome(primary, fallback)).toBe(true);
    expect(fs.existsSync(path.join(fallback, 'agents', 'architecture-advisor.toml'))).toBe(true);
    expect(fs.readFileSync(path.join(fallback, 'agents', 'security-reviewer.toml'), 'utf-8')).toContain('sec');
  });

  it('is a no-op when src==dst or the primary has no agents/ tree', () => {
    // No agents/ at primary → nothing to mirror, returns false (not an error).
    expect(mirrorCodexAgentsToHome(primary, fallback)).toBe(false);
    expect(fs.existsSync(path.join(fallback, 'agents'))).toBe(false);
    // src == dst → no self-copy.
    fs.mkdirSync(path.join(primary, 'agents'), { recursive: true });
    expect(mirrorCodexAgentsToHome(primary, primary)).toBe(false);
  });
});
