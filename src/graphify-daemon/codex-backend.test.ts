import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodexSemanticBackend } from './codex-backend.js';

const roots: string[] = [];
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'graphify-codex-output-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('CodexSemanticBackend output boundary', () => {
  it('writes a Codex-compatible strict output schema', async () => {
    const processRun = vi.fn(async (_command: string, args: string[]) => {
      const schema = JSON.parse(readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8')) as Record<
        string,
        unknown
      >;
      const assertStrictObjects = (value: unknown): void => {
        if (!value || typeof value !== 'object') return;
        const record = value as Record<string, unknown>;
        if (record.type === 'object') {
          expect(record.additionalProperties).toBe(false);
          const properties = (record.properties ?? {}) as Record<string, unknown>;
          expect(new Set(record.required as string[])).toEqual(new Set(Object.keys(properties)));
        }
        if ('const' in record) expect(record.type).toBeDefined();
        for (const child of Object.values(record)) assertStrictObjects(child);
      };
      assertStrictObjects(schema);
      writeFileSync(
        args[args.indexOf('--output-last-message') + 1],
        JSON.stringify({ sources: [{ sourceId: 's', nodes: [], edges: [], hyperedges: [] }] }),
      );
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const backend = new CodexSemanticBackend({ processRun, tempRoot: temp() });
    await backend.extract(
      { id: 's', workgroupId: 'wg', kind: 'document', relativePath: 'brief.md', contentHash: 'h' },
      ['safe'],
    );
    expect(processRun).toHaveBeenCalledTimes(1);
  });

  it('uses a private writable home with only inherited auth linked in', async () => {
    const inherited = temp();
    mkdirSync(inherited, { recursive: true });
    writeFileSync(join(inherited, 'auth.json'), '{}');
    let childHome = '';
    let childCodexHome = '';
    let authTarget = '';
    const processRun = vi.fn(async (_command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      childHome = options?.env?.HOME ?? '';
      childCodexHome = options?.env?.CODEX_HOME ?? '';
      const auth = join(childCodexHome, 'auth.json');
      authTarget = readlinkSync(auth);
      expect(lstatSync(auth).isSymbolicLink()).toBe(true);
      writeFileSync(
        args[args.indexOf('--output-last-message') + 1],
        JSON.stringify({ sources: [{ sourceId: 's', nodes: [], edges: [], hyperedges: [] }] }),
      );
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const backend = new CodexSemanticBackend({ processRun, tempRoot: temp(), inheritedCodexHome: inherited });
    await backend.extract(
      { id: 's', workgroupId: 'wg', kind: 'document', relativePath: 'brief.md', contentHash: 'h' },
      ['safe'],
    );
    expect(childHome).not.toBe(process.env.HOME);
    expect(childCodexHome).toBe(join(childHome, '.codex'));
    expect(authTarget).toBe(join(inherited, 'auth.json'));
  });

  it('passes one raw JSON encoding inside the randomized untrusted boundary', async () => {
    let prompt = '';
    let args: string[] = [];
    const processRun = vi.fn(async (_command: string, commandArgs: string[], options?: { stdin?: string }) => {
      args = commandArgs;
      prompt = options?.stdin ?? '';
      writeFileSync(
        commandArgs[commandArgs.indexOf('--output-last-message') + 1],
        JSON.stringify({ sources: [{ sourceId: 's', nodes: [], edges: [], hyperedges: [] }] }),
      );
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const backend = new CodexSemanticBackend({ processRun, tempRoot: temp() });
    await backend.extract(
      { id: 's', workgroupId: 'wg', kind: 'document', relativePath: 'brief.md', contentHash: 'h' },
      ['safe'],
    );
    expect(prompt).toContain('[{"sourceId":"s","relativePath":"brief.md","content":"safe"}]');
    expect(prompt).not.toContain('"[{\\"sourceId\\"');
    // The payload must reach codex over stdin. Linux caps a single argv entry at
    // 128 KiB while a batch may carry 256 KiB, so passing it as an argument
    // spawn-failed with E2BIG for exactly the largest batches.
    expect(args.at(-1)).toBe('-');
    expect(args.some((arg) => arg.includes('sourceId'))).toBe(false);
  });

  it('keeps a maximum-size batch out of argv entirely', async () => {
    let stdinBytes = 0;
    let argvBytes = 0;
    const processRun = vi.fn(async (_command: string, args: string[], options?: { stdin?: string }) => {
      stdinBytes = Buffer.byteLength(options?.stdin ?? '');
      argvBytes = Math.max(...args.map((arg) => Buffer.byteLength(arg)));
      writeFileSync(
        args[args.indexOf('--output-last-message') + 1],
        JSON.stringify({ sources: [{ sourceId: 's', nodes: [], edges: [], hyperedges: [] }] }),
      );
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const backend = new CodexSemanticBackend({ processRun, tempRoot: temp() });
    // Just under the backend's 256 KiB input ceiling, and well over the 128 KiB
    // per-argument kernel limit that produced `spawn E2BIG` in production.
    await backend.extract(
      { id: 's', workgroupId: 'wg', kind: 'document', relativePath: 'brief.md', contentHash: 'h' },
      ['x'.repeat(200 * 1024)],
    );
    expect(stdinBytes).toBeGreaterThan(128 * 1024);
    expect(argvBytes).toBeLessThan(128 * 1024);
  });

  it('rejects an output artifact larger than four MiB before parsing it', async () => {
    const processRun = vi.fn(async (_command: string, args: string[]) => {
      writeFileSync(args[args.indexOf('--output-last-message') + 1], Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const backend = new CodexSemanticBackend({ processRun, tempRoot: temp() });
    await expect(
      backend.extract({ id: 's', workgroupId: 'wg', kind: 'document', relativePath: 'brief.md', contentHash: 'h' }, [
        'safe',
      ]),
    ).rejects.toThrow(/exceeds 4194304 bytes/);
    expect(processRun).toHaveBeenCalledTimes(2);
  });
});
