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
  helperTimeoutMs,
  listGeneratedMemorySnapshots,
  readGeneratedMemory,
  readMemoryTopicFile,
  resolveBunBinary,
  restoreGeneratedMemorySnapshot,
  syncMemoryIndexes,
  writeGeneratedMemory,
  writeMemoryTopicFile,
} from './curator-write.js';
import { GENERATED_MEMORY_MAX_BYTES } from './curator-contract.js';

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

  it('keeps the Bun helper request bound at or above the host generated-memory cap', () => {
    // The helper lives in the container tree and cannot import the host constant,
    // so the two are mirrored by hand. When only the host side was raised, writes
    // succeeded until the document passed the stale helper bound and then failed
    // forever. This asserts the mirror, so the next cap change cannot half-land.
    const helper = fs.readFileSync(
      path.join(process.cwd(), 'container/agent-runner/src/mcp-tools/memory-write-process-helper.ts'),
      'utf8',
    );
    const declared = /MAX_CURATOR_WRITE_REQUEST_BYTES\s*=\s*([0-9_]+)\s*\*\s*1024/.exec(helper);
    expect(declared).not.toBeNull();
    const helperBytes = Number(declared![1]!.replace(/_/g, '')) * 1024;
    expect(helperBytes).toBeGreaterThanOrEqual(GENERATED_MEMORY_MAX_BYTES + 16 * 1024);
  });

  it('scales the write-helper timeout with request size: small stays tight, max-size gets proportionate room', () => {
    // ~50 KB request, representative of a routine curator write.
    const small = helperTimeoutMs(50_000);
    // The largest request that today's bound (GENERATED_MEMORY_MAX_BYTES +
    // HELPER_REQUEST_OVERHEAD_BYTES) actually admits.
    const maxRequestBytes = GENERATED_MEMORY_MAX_BYTES + 16 * 1024;
    const max = helperTimeoutMs(maxRequestBytes);
    // Small stays a tight bound, well under the old flat 10s.
    expect(small).toBeLessThan(4_000);
    // Max-size gets proportionately more room than small, and at least as
    // much as the old flat value — now genuinely earned by request size
    // rather than a blanket allowance for every write regardless of size.
    expect(max).toBeGreaterThan(small);
    expect(max).toBeGreaterThanOrEqual(10_000);
  });

  it('a generated-memory write at the host maximum still fits the helper request bound', () => {
    // Goes beyond comparing the two bare constants above: builds the actual
    // wire request invokeHelper sends (curator-write.ts), at content sized to
    // the real new maximum, and checks it against the helper's own declared
    // bound parsed from source. If the helper constant is not raised in
    // lockstep, this fails with the exact byte count that would make every
    // ledger write at the new cap start hitting "bounded write request is
    // required" again.
    const helper = fs.readFileSync(
      path.join(process.cwd(), 'container/agent-runner/src/mcp-tools/memory-write-process-helper.ts'),
      'utf8',
    );
    const declared = /MAX_CURATOR_WRITE_REQUEST_BYTES\s*=\s*([0-9_]+)\s*\*\s*1024/.exec(helper);
    expect(declared).not.toBeNull();
    const helperBytes = Number(declared![1]!.replace(/_/g, '')) * 1024;

    const request = {
      rootDir: '/data/workgroups/example-long-workgroup-id/memory',
      relativePath: 'generated/memory.md',
      content: 'x'.repeat(GENERATED_MEMORY_MAX_BYTES),
      expectedSha256: 'a'.repeat(64),
      allowGeneratedMemory: true,
    };
    const bodyBytes = Buffer.byteLength(JSON.stringify(request));
    expect(bodyBytes).toBeLessThanOrEqual(helperBytes);
  });
});

describe('host topic-file writer', () => {
  // P2-AC3. Each forbidden path class asserted independently — a batch test
  // that only checks the first violation would miss a regression on any
  // later case.
  it('writeMemoryTopicFile rejects each forbidden path class independently', async () => {
    const forbidden = [
      '../escape.md',
      'generated/memory.md',
      'preferences/p.md',
      'system/x.md',
      'people/a/b.md',
      '/people/absolute.md',
      'People/X.md',
    ];
    for (const relativePath of forbidden) {
      const result = await writeMemoryTopicFile(TEST_WORKGROUP, relativePath, '# X\n', null, 1);
      expect(result.status).toBe('error');
    }
    expect(fs.readdirSync(path.join(TEST_ROOT, 'workgroups', TEST_WORKGROUP, 'memory'))).toEqual(['generated']);
  });

  // P2-AC10. Ownership is the header-pattern check (P2-I6): an existing file
  // with no header is never a write target, but a new path in the same
  // directory is unaffected.
  it('writeMemoryTopicFile refuses to overwrite a file lacking the ownership header', async () => {
    const peopleDir = path.join(TEST_ROOT, 'workgroups', TEST_WORKGROUP, 'memory', 'people');
    fs.mkdirSync(peopleDir, { recursive: true });
    fs.writeFileSync(path.join(peopleDir, 'roster.md'), '# Human-authored roster\n\nMaya - liaison.\n');

    const overwrite = await writeMemoryTopicFile(TEST_WORKGROUP, 'people/roster.md', '# Roster\n', null, 1);
    expect(overwrite.status).toBe('error');
    expect(fs.readFileSync(path.join(peopleDir, 'roster.md'), 'utf8')).toBe(
      '# Human-authored roster\n\nMaya - liaison.\n',
    );

    const created = await writeMemoryTopicFile(TEST_WORKGROUP, 'people/new-entity.md', '# New\n', null, 1);
    expect(created.status).toBe('success');
    expect(readMemoryTopicFile(TEST_WORKGROUP, 'people/new-entity.md').content).toBe(
      '---\ntype: person\nconsolidated_facts: 1\n---\n\n# New\n',
    );
  });

  it('creates the topic directory on first write and stamps OKF frontmatter', async () => {
    expect(fs.existsSync(path.join(TEST_ROOT, 'workgroups', TEST_WORKGROUP, 'memory', 'domain'))).toBe(false);
    const created = await writeMemoryTopicFile(TEST_WORKGROUP, 'domain/pricing.md', '# Pricing\n', null, 3);
    expect(created.status).toBe('success');
    const domainDir = path.join(TEST_ROOT, 'workgroups', TEST_WORKGROUP, 'memory', 'domain');
    expect(fs.lstatSync(domainDir).isDirectory()).toBe(true);
    expect(readMemoryTopicFile(TEST_WORKGROUP, 'domain/pricing.md').content).toBe(
      '---\ntype: domain\nconsolidated_facts: 3\n---\n\n# Pricing\n',
    );
  });

  it('CAS-protects an owned topic file update the same way as generated memory', async () => {
    await writeMemoryTopicFile(TEST_WORKGROUP, 'systems/pipeline.md', '# Pipeline v1\n', null, 1);
    const current = readMemoryTopicFile(TEST_WORKGROUP, 'systems/pipeline.md');
    const stale = await writeMemoryTopicFile(TEST_WORKGROUP, 'systems/pipeline.md', '# Pipeline stale\n', null, 2);
    expect(stale.status).toBe('conflict');
    const updated = await writeMemoryTopicFile(
      TEST_WORKGROUP,
      'systems/pipeline.md',
      '# Pipeline v2\n',
      current.sha256,
      2,
    );
    expect(updated.status).toBe('success');
    expect(readMemoryTopicFile(TEST_WORKGROUP, 'systems/pipeline.md').content).toBe(
      '---\ntype: system\nconsolidated_facts: 2\n---\n\n# Pipeline v2\n',
    );
  });
});

describe('OKF index maintenance', () => {
  const memoryDir = (): string => path.join(TEST_ROOT, 'workgroups', TEST_WORKGROUP, 'memory');

  // The whole-loop version of the stacked-header regression, through the real
  // writer and the real filesystem: a model that returns the file it was
  // shown, twice.
  it('a model echoing the file back never stacks a second header', async () => {
    await writeMemoryTopicFile(TEST_WORKGROUP, 'people/james.md', 'James owns the release train.', null, 9);
    const first = readMemoryTopicFile(TEST_WORKGROUP, 'people/james.md');
    const echoed = await writeMemoryTopicFile(TEST_WORKGROUP, 'people/james.md', first.content, first.sha256, 9);
    expect(echoed.status).toBe('success');
    const second = readMemoryTopicFile(TEST_WORKGROUP, 'people/james.md');
    expect(second.content).toBe(first.content);
    expect(second.content.match(/^---$/gm)).toHaveLength(2);
    expect(second.content).not.toContain('<!-- consolidated');
  });

  it('accepts a legacy-header file as owned and replaces the header with frontmatter', async () => {
    const peopleDir = path.join(memoryDir(), 'people');
    fs.mkdirSync(peopleDir, { recursive: true });
    const legacy = '<!-- consolidated: facts=4 -->\n<!-- consolidated -->\nOld body.\n';
    fs.writeFileSync(path.join(peopleDir, 'legacy.md'), legacy);
    const current = readMemoryTopicFile(TEST_WORKGROUP, 'people/legacy.md');
    const write = await writeMemoryTopicFile(TEST_WORKGROUP, 'people/legacy.md', 'New body.', current.sha256, 7);
    expect(write.status).toBe('success');
    expect(readMemoryTopicFile(TEST_WORKGROUP, 'people/legacy.md').content).toBe(
      '---\ntype: person\nconsolidated_facts: 7\n---\n\nNew body.\n',
    );
  });

  it('refuses an OKF-reserved index leaf as a topic-file write target', async () => {
    const result = await writeMemoryTopicFile(TEST_WORKGROUP, 'people/index.md', 'Map.', null, 1);
    expect(result.status).toBe('error');
    expect(fs.existsSync(path.join(memoryDir(), 'people', 'index.md'))).toBe(false);
  });

  it('writes folder indexes and points the root Map at them, preserving Core Memory', async () => {
    fs.writeFileSync(
      path.join(memoryDir(), 'index.md'),
      [
        '---',
        'okf_version: "0.1"',
        '---',
        '',
        '# Memory Index',
        '',
        '## Core Memory',
        '',
        '- The user is Dave Kim.',
        '',
        '## Map',
        '',
        '- [Memory system definition](system/definition.md) - how this memory works',
        '',
      ].join('\n'),
    );
    await writeMemoryTopicFile(TEST_WORKGROUP, 'people/james.md', 'James owns the release train.', null, 9);
    await writeMemoryTopicFile(TEST_WORKGROUP, 'domain/acme.md', 'Acme is on a renewal cycle.', null, 9);
    // A human-authored file in a topic folder: mapped by nobody, clobbered by
    // nobody.
    fs.writeFileSync(path.join(memoryDir(), 'people', 'roster.md'), '# Human roster\n');

    const sync = await syncMemoryIndexes(TEST_WORKGROUP);
    expect(sync.updated.sort()).toEqual(['domain/index.md', 'index.md', 'people/index.md']);

    const root = readMemoryTopicFile(TEST_WORKGROUP, 'index.md').content;
    expect(root).toContain('okf_version: "0.1"');
    expect(root).toContain('- The user is Dave Kim.');
    expect(root).toContain('- [Memory system definition](system/definition.md) - how this memory works');
    expect(root).toContain('- [People](people/index.md) - 1 consolidated concept');
    expect(root).toContain('- [Domain](domain/index.md) - 1 consolidated concept');
    expect(root).not.toContain('systems/index.md');

    const people = readMemoryTopicFile(TEST_WORKGROUP, 'people/index.md').content;
    expect(people).toContain('- [James](james.md) - James owns the release train.');
    expect(people).not.toContain('roster.md');
    expect(readMemoryTopicFile(TEST_WORKGROUP, 'people/roster.md').content).toBe('# Human roster\n');
  });

  // Idempotency at the level the brief asks for: run the curator's index pass
  // twice over an unchanged tree and the second run must write nothing.
  it('a second sync over an unchanged tree writes nothing', async () => {
    await writeMemoryTopicFile(TEST_WORKGROUP, 'people/james.md', 'James owns the release train.', null, 9);
    await syncMemoryIndexes(TEST_WORKGROUP);
    const before = readMemoryTopicFile(TEST_WORKGROUP, 'people/index.md');
    expect(await syncMemoryIndexes(TEST_WORKGROUP)).toEqual({ updated: [] });
    expect(readMemoryTopicFile(TEST_WORKGROUP, 'people/index.md').sha256).toBe(before.sha256);
  });

  it('maps a legacy-header topic file the curator has not rewritten yet', async () => {
    const peopleDir = path.join(memoryDir(), 'people');
    fs.mkdirSync(peopleDir, { recursive: true });
    fs.writeFileSync(path.join(peopleDir, 'legacy.md'), '<!-- consolidated: facts=4 -->\nLegacy lead line.\n');
    await syncMemoryIndexes(TEST_WORKGROUP);
    expect(readMemoryTopicFile(TEST_WORKGROUP, 'people/index.md').content).toContain(
      '- [Legacy](legacy.md) - Legacy lead line.',
    );
  });

  it('leaves a workgroup with no topic folders completely alone', async () => {
    fs.writeFileSync(path.join(memoryDir(), 'index.md'), '# Memory Index\n\n## Core Memory\n\n- Only this.\n');
    expect(await syncMemoryIndexes(TEST_WORKGROUP)).toEqual({ updated: [] });
    expect(readMemoryTopicFile(TEST_WORKGROUP, 'index.md').content).toBe(
      '# Memory Index\n\n## Core Memory\n\n- Only this.\n',
    );
  });
});
