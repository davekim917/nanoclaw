import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
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
    const processRun = vi.fn(async (_command: string, args: string[]) => {
      prompt = args.at(-1)!;
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
    expect(prompt).toContain('[{"sourceId":"s","relativePath":"brief.md","content":"safe"}]');
    expect(prompt).not.toContain('"[{\\"sourceId\\"');
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
