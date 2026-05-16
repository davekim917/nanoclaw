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
