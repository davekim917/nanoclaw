import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT, TEST_WORKGROUP } = vi.hoisted(() => ({
  // The real sibling writer deliberately accepts generated memory only below
  // this checkout's canonical data/workgroups root. Derive the checkout at
  // runtime so CI never depends on a developer's absolute path.
  TEST_ROOT: `${process.cwd()}/data`,
  TEST_WORKGROUP: `test-curator-${process.pid}`,
}));
const LEGACY_HISTORY_TARGET = path.join('/tmp', `${TEST_WORKGROUP}-legacy-history`);
const GENERATED_ESCAPE_TARGET = path.join('/tmp', `${TEST_WORKGROUP}-generated-escape`);

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: TEST_ROOT,
}));

import {
  listGeneratedMemorySnapshots,
  readGeneratedMemory,
  resolveBunBinary,
  restoreGeneratedMemorySnapshot,
  writeGeneratedMemory,
} from './curator-write.js';

const content = [
  '# Generated workgroup memory',
  '',
  '- Durable fact. <!-- nanoclaw-memory:id=mem_aaaaaaaaaaaaaaaa;evidence=msg-1;captured=2026-07-26T00:00:00.000Z -->',
  '',
].join('\n');
const HELPER = path.resolve('container/agent-runner/src/mcp-tools/memory-write-process-helper.ts');

function invokeSiblingWriter(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', [HELPER], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`sibling writer failed (${code}): ${Buffer.concat(stderr).toString('utf8')}`));
        return;
      }
      resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')) as Record<string, unknown>);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

beforeEach(() => {
  fs.rmSync(path.join(TEST_ROOT, 'workgroups', TEST_WORKGROUP), { recursive: true, force: true });
  fs.rmSync(path.join(TEST_ROOT, 'memory-curator-history', TEST_WORKGROUP), { recursive: true, force: true });
  fs.rmSync(LEGACY_HISTORY_TARGET, { recursive: true, force: true });
  fs.rmSync(GENERATED_ESCAPE_TARGET, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'workgroups', TEST_WORKGROUP, 'memory', 'generated'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(path.join(TEST_ROOT, 'workgroups', TEST_WORKGROUP), { recursive: true, force: true });
  fs.rmSync(path.join(TEST_ROOT, 'memory-curator-history', TEST_WORKGROUP), { recursive: true, force: true });
  fs.rmSync(LEGACY_HISTORY_TARGET, { recursive: true, force: true });
  fs.rmSync(GENERATED_ESCAPE_TARGET, { recursive: true, force: true });
});

describe('host generated-memory writer', () => {
  it('resolves Bun from the service HOME even when systemd PATH omits it', () => {
    const serviceHome = path.join('/tmp', `${TEST_WORKGROUP}-service-home`);
    const bun = path.join(serviceHome, '.bun', 'bin', 'bun');
    fs.mkdirSync(path.dirname(bun), { recursive: true });
    fs.writeFileSync(bun, '#!/bin/sh\n');
    fs.chmodSync(bun, 0o700);
    try {
      expect(resolveBunBinary({ HOME: serviceHome, PATH: '/usr/local/bin:/usr/bin:/bin' })).toBe(bun);
    } finally {
      fs.rmSync(serviceHome, { recursive: true, force: true });
    }
  });

  it('safely creates the generated directory on the first accepted capture', async () => {
    fs.rmSync(path.join(TEST_ROOT, 'workgroups', TEST_WORKGROUP, 'memory', 'generated'), {
      recursive: true,
      force: true,
    });
    await expect(writeGeneratedMemory(TEST_WORKGROUP, content, null)).resolves.toMatchObject({
      status: 'success',
    });
    const generatedDir = path.join(TEST_ROOT, 'workgroups', TEST_WORKGROUP, 'memory', 'generated');
    expect(fs.lstatSync(generatedDir).isDirectory()).toBe(true);
    expect(fs.lstatSync(generatedDir).isSymbolicLink()).toBe(false);
    expect(readGeneratedMemory(TEST_WORKGROUP).content).toBe(content);
  });

  it('refuses a generated-directory symlink without writing outside the canon', async () => {
    const generatedDir = path.join(TEST_ROOT, 'workgroups', TEST_WORKGROUP, 'memory', 'generated');
    fs.rmSync(generatedDir, { recursive: true, force: true });
    fs.mkdirSync(GENERATED_ESCAPE_TARGET, { recursive: true });
    fs.symlinkSync(GENERATED_ESCAPE_TARGET, generatedDir);

    await expect(writeGeneratedMemory(TEST_WORKGROUP, content, null)).rejects.toThrow(/ordinary directory/);
    expect(fs.readdirSync(GENERATED_ESCAPE_TARGET)).toEqual([]);
  });

  it('creates and updates through the shared Bun CAS writer and snapshots the prior version', async () => {
    expect(readGeneratedMemory(TEST_WORKGROUP)).toEqual({ content: '', sha256: null });
    const created = await writeGeneratedMemory(TEST_WORKGROUP, content, null, { nowMs: 1 });
    expect(created.status).toBe('success');
    const current = readGeneratedMemory(TEST_WORKGROUP);
    expect(current.content).toBe(content);
    const next = content.replace('Durable fact.', 'Corrected durable fact.');
    const updated = await writeGeneratedMemory(TEST_WORKGROUP, next, current.sha256, { nowMs: 2 });
    expect(updated.status).toBe('success');
    expect(readGeneratedMemory(TEST_WORKGROUP).content).toBe(next);
    expect(listGeneratedMemorySnapshots(TEST_WORKGROUP)).toHaveLength(1);
  });

  it('writes a generated canon larger than the per-file recall default through the bounded helper', async () => {
    const large = `${content}${'x'.repeat(70 * 1024)}\n`;
    expect(Buffer.byteLength(large)).toBeGreaterThan(64 * 1024);
    await expect(writeGeneratedMemory(TEST_WORKGROUP, large, null)).resolves.toMatchObject({
      status: 'success',
    });
    expect(readGeneratedMemory(TEST_WORKGROUP).content).toBe(large);
  });

  it('returns conflict before spawning when the expected hash is stale', async () => {
    await writeGeneratedMemory(TEST_WORKGROUP, content, null);
    await expect(writeGeneratedMemory(TEST_WORKGROUP, `${content}\n`, null)).resolves.toMatchObject({
      status: 'conflict',
    });
    expect(readGeneratedMemory(TEST_WORKGROUP).content).toBe(content);
  });

  it('restores a host-only snapshot through the same compare-and-swap writer', async () => {
    await writeGeneratedMemory(TEST_WORKGROUP, content, null, { nowMs: 1 });
    const original = readGeneratedMemory(TEST_WORKGROUP);
    const corrected = content.replace('Durable fact.', 'Corrected durable fact.');
    await writeGeneratedMemory(TEST_WORKGROUP, corrected, original.sha256, { nowMs: 2 });
    const current = readGeneratedMemory(TEST_WORKGROUP);
    const [snapshot] = listGeneratedMemorySnapshots(TEST_WORKGROUP);

    await expect(
      restoreGeneratedMemorySnapshot(TEST_WORKGROUP, snapshot!, current.sha256!, { nowMs: 3 }),
    ).resolves.toMatchObject({ status: 'success' });
    expect(readGeneratedMemory(TEST_WORKGROUP).content).toBe(content);
    await expect(
      restoreGeneratedMemorySnapshot(TEST_WORKGROUP, path.join(TEST_ROOT, 'outside.md'), original.sha256!),
    ).rejects.toThrow(/outside the host history directory/);
  });

  it('ignores a sibling-adjacent legacy history symlink and snapshots only in host state', async () => {
    const legacyHistory = path.join(TEST_ROOT, 'workgroups', TEST_WORKGROUP, '.memory-curator-history');
    fs.mkdirSync(LEGACY_HISTORY_TARGET, { recursive: true });
    fs.symlinkSync(LEGACY_HISTORY_TARGET, legacyHistory);
    await writeGeneratedMemory(TEST_WORKGROUP, content, null, { nowMs: 1 });
    const current = readGeneratedMemory(TEST_WORKGROUP);
    await writeGeneratedMemory(
      TEST_WORKGROUP,
      content.replace('Durable fact.', 'Corrected durable fact.'),
      current.sha256,
      { nowMs: 2 },
    );

    expect(fs.readdirSync(LEGACY_HISTORY_TARGET)).toEqual([]);
    expect(listGeneratedMemorySnapshots(TEST_WORKGROUP)).toHaveLength(1);
  });

  it('serializes a host generated write with a real sibling process without touching manual or imported memory', async () => {
    const memoryRoot = path.join(TEST_ROOT, 'workgroups', TEST_WORKGROUP, 'memory');
    fs.mkdirSync(path.join(memoryRoot, 'imports', 'claude'), { recursive: true });
    fs.writeFileSync(path.join(memoryRoot, 'manual.md'), 'manual bytes\n');
    fs.writeFileSync(path.join(memoryRoot, 'imports', 'claude', 'legacy.md'), 'import bytes\n');

    const [generated, sibling] = await Promise.all([
      writeGeneratedMemory(TEST_WORKGROUP, content, null),
      invokeSiblingWriter({
        rootDir: memoryRoot,
        relativePath: 'index.md',
        content: '# Canon\nSibling foreground edit.\n',
        expectedSha256: null,
      }),
    ]);

    expect(generated.status).toBe('success');
    expect(sibling).toMatchObject({ status: 'success', relative_path: 'index.md' });
    expect(readGeneratedMemory(TEST_WORKGROUP).content).toBe(content);
    expect(fs.readFileSync(path.join(memoryRoot, 'index.md'), 'utf8')).toBe('# Canon\nSibling foreground edit.\n');
    expect(fs.readFileSync(path.join(memoryRoot, 'manual.md'), 'utf8')).toBe('manual bytes\n');
    expect(fs.readFileSync(path.join(memoryRoot, 'imports', 'claude', 'legacy.md'), 'utf8')).toBe('import bytes\n');
  });
});
