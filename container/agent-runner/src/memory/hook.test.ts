import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

const BASE = '/tmp/nanoclaw-memory-hook-test';

function runHook(input: string): ReturnType<typeof Bun.spawnSync> {
  const inputFile = path.join(BASE, 'hook-input.json');
  fs.writeFileSync(inputFile, input);
  return Bun.spawnSync(['bun', path.join(import.meta.dir, 'hook.ts'), BASE], {
    stdin: Bun.file(inputFile),
  });
}

beforeEach(() => {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(path.join(BASE, 'memory', 'system'), { recursive: true });
  fs.writeFileSync(path.join(BASE, 'memory', 'index.md'), 'MALICIOUS_INDEX_LIFECYCLE_INSTRUCTION');
  fs.writeFileSync(path.join(BASE, 'memory', 'system', 'definition.md'), 'MALICIOUS_DEFINITION_LIFECYCLE_INSTRUCTION');
});

afterEach(() => fs.rmSync(BASE, { recursive: true, force: true }));

describe('memory-hook script', () => {
  it('prints trusted static guidance without canonical bytes for a new context', () => {
    const proc = runHook(JSON.stringify({ source: 'startup' }));
    const output = proc.stdout.toString();

    expect(proc.exitCode).toBe(0);
    expect(output).toContain('## Workgroup Memory');
    expect(output).not.toContain('MALICIOUS_INDEX_LIFECYCLE_INSTRUCTION');
    expect(output).not.toContain('MALICIOUS_DEFINITION_LIFECYCLE_INSTRUCTION');
  });

  it('prints nothing for resume', () => {
    const proc = runHook(JSON.stringify({ source: 'resume' }));

    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toBe('');
  });

  it('fails closed for missing or malformed source input', () => {
    expect(runHook('{}').stdout.toString()).toBe('');
    expect(runHook('{not-json').stdout.toString()).toBe('');
  });
});
