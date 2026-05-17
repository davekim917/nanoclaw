import * as fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect } from 'bun:test';

import { createProvider } from './factory.js';
import { CodexProvider, extractImageGenerationPath, materializeRawImageGeneration, resolveClaudeImports } from './codex.js';

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

  it('bridges HTTP MCP servers and filters SSE servers', () => {
    const p = new CodexProvider({
      mcpServers: {
        exa: { type: 'http', url: 'https://mcp.exa.ai/mcp' },
        custom: {
          type: 'http',
          url: 'https://example.test/mcp',
          headers: { Authorization: 'Bearer placeholder' },
        },
        legacy: { type: 'sse', url: 'https://example.test/sse' },
      },
    }) as unknown as {
      mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
    };

    expect(p.mcpServers.exa).toEqual({
      command: 'bun',
      args: ['/app/src/remote-mcp-bridge.ts', 'https://mcp.exa.ai/mcp'],
      env: { REMOTE_MCP_NAME: 'exa' },
    });
    expect(p.mcpServers.custom.env?.REMOTE_MCP_AUTHORIZATION).toBe('Bearer placeholder');
    expect(p.mcpServers.legacy).toBeUndefined();
  });
});

describe('resolveClaudeImports', () => {
  function scratchDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-imports-'));
  }

  it('inlines a single relative import', () => {
    const dir = scratchDir();
    fs.writeFileSync(path.join(dir, 'fragment.md'), 'FRAGMENT CONTENT');
    const resolved = resolveClaudeImports('before\n@./fragment.md\nafter', dir);
    expect(resolved).toContain('FRAGMENT CONTENT');
    expect(resolved).not.toContain('@./fragment.md');
    expect(resolved).toMatch(/before[\s\S]*FRAGMENT CONTENT[\s\S]*after/);
  });

  it('expands nested imports relative to the parent file', () => {
    const dir = scratchDir();
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'inner.md'), 'INNER');
    fs.writeFileSync(path.join(dir, 'sub', 'outer.md'), '@./inner.md');
    const resolved = resolveClaudeImports('@./sub/outer.md', dir);
    expect(resolved).toBe('INNER');
  });

  it('drops missing imports to empty text rather than leaving raw @path', () => {
    const dir = scratchDir();
    const resolved = resolveClaudeImports('before\n@./does-not-exist.md\nafter', dir);
    expect(resolved).not.toContain('@./does-not-exist.md');
    expect(resolved).toContain('before');
    expect(resolved).toContain('after');
  });

  it('breaks cycles', () => {
    const dir = scratchDir();
    fs.writeFileSync(path.join(dir, 'a.md'), '@./b.md');
    fs.writeFileSync(path.join(dir, 'b.md'), '@./a.md');
    // Just needs to terminate without a stack overflow.
    const resolved = resolveClaudeImports('@./a.md', dir);
    expect(typeof resolved).toBe('string');
  });

  it('leaves non-import @ mentions alone (only line-anchored @<path> is imported)', () => {
    const dir = scratchDir();
    const resolved = resolveClaudeImports('email @someone for details', dir);
    expect(resolved).toBe('email @someone for details');
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
    const lines = src.split('\n');

    // The runOneTurn call is the anchor. Confirm we iterate-and-re-yield
    // rather than blind `yield*` — blind delegation can't inspect events
    // and so can't trigger the early return on a hard error.
    const runOneTurnIdx = lines.findIndex((l) => /^\s+for await \(const ev of runOneTurn\(/.test(l));
    expect(runOneTurnIdx).toBeGreaterThan(-1);

    // The lines after the runOneTurn anchor are the inner consumption
    // loop (the runOneTurn signature itself spans ~11 args, then the body
    // is 4-5 more lines). Widen the window to comfortably include the
    // `return` statement and its enclosing `if`.
    const window = lines.slice(runOneTurnIdx, runOneTurnIdx + 20).join('\n');
    // Strip line comments before pattern matching so explanatory prose
    // can mention "retryable===false" without satisfying the check.
    const codeOnly = window
      .split('\n')
      .map((l) => {
        const i = l.indexOf('//');
        return i >= 0 ? l.slice(0, i) : l;
      })
      .join('\n');

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
