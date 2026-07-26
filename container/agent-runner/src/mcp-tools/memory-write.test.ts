import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { memoryLockPath, sha256Text, writeMemoryFile, writeMemoryFileTool } from './memory-write.js';

let workgroupRoot: string;
let root: string;

beforeEach(() => {
  workgroupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-write-'));
  root = path.join(workgroupRoot, 'memory');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, 'notes'));
});

afterEach(() => {
  fs.rmSync(workgroupRoot, { recursive: true, force: true });
});

function generatedWriteResidue(directory: string): string[] {
  const residue: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name.includes('.tmp.') || entry.name.includes('.memory-write-')) {
        residue.push(path.relative(directory, absolute));
      }
    }
  };
  walk(directory);
  return residue.sort();
}

interface ProcessWriteRequest {
  rootDir: string;
  relativePath: string;
  content: string;
  expectedSha256: string | null;
  lockWaitMs?: number;
  retryDelayMs?: number;
  pauseSignalPath?: string;
  resumeSignalPath?: string;
}

function spawnWrite(request: ProcessWriteRequest): ReturnType<typeof Bun.spawn> {
  const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64url');
  return Bun.spawn([process.execPath, path.join(import.meta.dir, 'memory-write-process-helper.ts'), encoded], {
    cwd: import.meta.dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function waitForPath(
  filePath: string,
  processHandle: ReturnType<typeof Bun.spawn>,
  watchdogMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + watchdogMs;
  while (Date.now() <= deadline) {
    if (fs.existsSync(filePath)) return;
    if (processHandle.exitCode !== null) {
      throw new Error(`write helper exited ${processHandle.exitCode} before signaling ${filePath}`);
    }
    await Bun.sleep(2);
  }
  processHandle.kill('SIGKILL');
  await processHandle.exited;
  throw new Error(`timed out waiting for ${filePath}`);
}

async function processResult(
  processHandle: ReturnType<typeof Bun.spawn>,
): Promise<Awaited<ReturnType<typeof writeMemoryFile>>> {
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`write helper exited ${exitCode}: ${stderr}`);
  return JSON.parse(stdout.trim()) as Awaited<ReturnType<typeof writeMemoryFile>>;
}

describe('write_memory_file', () => {
  it('reserves generated memory from foreground and non-canonical callers', async () => {
    fs.mkdirSync(path.join(root, 'generated'));
    expect(
      await writeMemoryFile(
        { relative_path: 'generated/memory.md', content: 'foreground', expected_sha256: null },
        { rootDir: root },
      ),
    ).toMatchObject({ status: 'error', error: expect.stringContaining('reserved for the host curator') });
    expect(
      await writeMemoryFile(
        { relative_path: 'generated/memory.md', content: 'spoofed host', expected_sha256: null },
        { rootDir: root, allowGeneratedMemory: true },
      ),
    ).toMatchObject({ status: 'error', error: expect.stringContaining('canonical host workgroup root') });
  });

  it('test_expected_hash_update_is_atomic_and_visible', async () => {
    const target = path.join(root, 'index.md');
    fs.writeFileSync(target, 'old');

    const result = await writeMemoryFile(
      { relative_path: 'index.md', content: 'new 😀', expected_sha256: sha256Text('old') },
      { rootDir: root },
    );

    expect(result).toEqual({
      status: 'success',
      relative_path: 'index.md',
      sha256: sha256Text('new 😀'),
    });
    expect(fs.readFileSync(target, 'utf8')).toBe('new 😀');
    expect(generatedWriteResidue(root)).toEqual([]);
  });

  it('test_concurrent_stale_writer_returns_conflict', async () => {
    const target = path.join(root, 'index.md');
    fs.writeFileSync(target, 'v1');
    const v1 = sha256Text('v1');
    let releaseFirst!: () => void;
    const firstMayRename = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstValidated!: () => void;
    const firstHasLock = new Promise<void>((resolve) => {
      firstValidated = resolve;
    });

    const first = writeMemoryFile(
      { relative_path: 'index.md', content: 'v2', expected_sha256: v1 },
      {
        rootDir: root,
        beforeRename: async () => {
          firstValidated();
          await firstMayRename;
        },
      },
    );
    await firstHasLock;
    const stale = writeMemoryFile(
      { relative_path: 'index.md', content: 'stale', expected_sha256: v1 },
      { rootDir: root, lockWaitMs: 1_000, retryDelayMs: 2 },
    );
    releaseFirst();

    expect((await first).status).toBe('success');
    expect(await stale).toEqual({
      status: 'conflict',
      relative_path: 'index.md',
      error: 'expected_sha256 does not match the current file',
    });
    expect(fs.readFileSync(target, 'utf8')).toBe('v2');
  });

  it('never lets two separate processes publish from the same expected hash', async () => {
    const target = path.join(root, 'index.md');
    fs.writeFileSync(target, 'v1');
    const v1 = sha256Text('v1');
    const pauseSignalPath = path.join(workgroupRoot, 'writer-a-paused');
    const resumeSignalPath = path.join(workgroupRoot, 'writer-a-resume');
    const writerA = spawnWrite({
      rootDir: root,
      relativePath: 'index.md',
      content: 'writer-a',
      expectedSha256: v1,
      pauseSignalPath,
      resumeSignalPath,
    });
    await waitForPath(pauseSignalPath, writerA);

    const writerB = spawnWrite({
      rootDir: root,
      relativePath: 'index.md',
      content: 'writer-b',
      expectedSha256: v1,
    });
    // Long enough for the previous token/time lease implementation to steal
    // both its stale file lock and commit fence while writer A is paused.
    await Bun.sleep(1_500);
    fs.writeFileSync(resumeSignalPath, 'resume', { flag: 'wx' });

    const [resultA, resultB] = await Promise.all([processResult(writerA), processResult(writerB)]);
    expect(resultA.status).toBe('success');
    expect(resultB).toEqual({
      status: 'conflict',
      relative_path: 'index.md',
      error: 'expected_sha256 does not match the current file',
    });
    expect(fs.readFileSync(target, 'utf8')).toBe('writer-a');
    expect(generatedWriteResidue(root)).toEqual([]);
  });

  it('releases kernel authority on process death and cleans its abandoned temp on the next write', async () => {
    const target = path.join(root, 'index.md');
    fs.writeFileSync(target, 'stable');
    const pauseSignalPath = path.join(workgroupRoot, 'crashed-writer-paused');
    const resumeSignalPath = path.join(workgroupRoot, 'never-resume');
    const crashedWriter = spawnWrite({
      rootDir: root,
      relativePath: 'index.md',
      content: 'never-published',
      expectedSha256: sha256Text('stable'),
      pauseSignalPath,
      resumeSignalPath,
    });
    await waitForPath(pauseSignalPath, crashedWriter);
    crashedWriter.kill('SIGKILL');
    await crashedWriter.exited;

    const recovered = await writeMemoryFile(
      { relative_path: 'index.md', content: 'recovered', expected_sha256: sha256Text('stable') },
      { rootDir: root },
    );
    expect(recovered.status).toBe('success');
    expect(fs.readFileSync(target, 'utf8')).toBe('recovered');
    expect(generatedWriteResidue(root)).toEqual([]);
  });

  it('anchors the final rename if the target parent is swapped to an outside symlink', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-parent-swap-'));
    const originalParent = path.join(root, 'notes');
    const movedParent = path.join(root, 'notes-before-swap');
    const outsideTarget = path.join(outside, 'index.md');
    let swapped = false;
    fs.writeFileSync(path.join(originalParent, 'index.md'), 'inside-stable');
    fs.writeFileSync(outsideTarget, 'outside-stable');
    try {
      const result = await writeMemoryFile(
        {
          relative_path: 'notes/index.md',
          content: 'must-not-escape',
          expected_sha256: sha256Text('inside-stable'),
        },
        {
          rootDir: root,
          beforeAtomicRename: () => {
            swapped = true;
            fs.renameSync(originalParent, movedParent);
            fs.symlinkSync(outside, originalParent);
          },
        },
      );

      expect(swapped).toBe(true);
      expect(result).toMatchObject({ status: 'success', relative_path: 'notes/index.md' });
      expect(fs.readFileSync(outsideTarget, 'utf8')).toBe('outside-stable');
      expect(fs.readFileSync(path.join(movedParent, 'index.md'), 'utf8')).toBe('must-not-escape');
      expect(generatedWriteResidue(root)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('returns conflict for create collisions and hash mismatches', async () => {
    fs.writeFileSync(path.join(root, 'notes', 'same.md'), 'existing');

    expect(
      await writeMemoryFile(
        { relative_path: 'notes/same.md', content: 'replace', expected_sha256: null },
        { rootDir: root },
      ),
    ).toMatchObject({ status: 'conflict' });
    expect(
      await writeMemoryFile(
        { relative_path: 'notes/same.md', content: 'replace', expected_sha256: '0'.repeat(64) },
        { rootDir: root },
      ),
    ).toMatchObject({ status: 'conflict' });
    expect(fs.readFileSync(path.join(root, 'notes', 'same.md'), 'utf8')).toBe('existing');
  });

  it('rejects traversal, absolute paths, non-Markdown, and symlinks without writes outside root', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-outside-'));
    fs.writeFileSync(path.join(outside, 'kept.md'), 'kept');
    fs.symlinkSync(outside, path.join(root, 'linked'));
    try {
      for (const relative_path of ['../escape.md', '/tmp/escape.md', 'notes/plain.txt', 'linked/kept.md']) {
        const result = await writeMemoryFile(
          { relative_path, content: 'bad', expected_sha256: null },
          { rootDir: root },
        );
        expect(result.status).toBe('error');
      }
      expect(fs.readFileSync(path.join(outside, 'kept.md'), 'utf8')).toBe('kept');
      expect(fs.existsSync(path.join(path.dirname(root), 'escape.md'))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('times out while a live writer holds the kernel lock', async () => {
    const target = path.join(root, 'index.md');
    fs.writeFileSync(target, 'stable');
    let releaseLiveWriter!: () => void;
    const liveWriterMayRename = new Promise<void>((resolve) => {
      releaseLiveWriter = resolve;
    });
    let signalLiveWriter!: () => void;
    const liveWriterHasLock = new Promise<void>((resolve) => {
      signalLiveWriter = resolve;
    });

    // This holder does not need process isolation: a separately opened file
    // descriptor contends on the same flock inode. Keeping the holder in this
    // process removes unrelated Bun child-startup scheduling from the timeout
    // assertion while preserving the actual kernel-lock path under test.
    const liveWriter = writeMemoryFile(
      {
        relative_path: 'index.md',
        content: 'live-writer',
        expected_sha256: sha256Text('stable'),
      },
      {
        rootDir: root,
        beforeRename: async () => {
          signalLiveWriter();
          await liveWriterMayRename;
        },
      },
    );
    await liveWriterHasLock;

    const timeout = await writeMemoryFile(
      { relative_path: 'notes/locked.md', content: 'x', expected_sha256: null },
      { rootDir: root, lockWaitMs: 15, retryDelayMs: 2 },
    );
    expect(timeout).toMatchObject({ status: 'error', error: 'timed out acquiring memory file lock' });

    releaseLiveWriter();
    expect((await liveWriter).status).toBe('success');
  });

  it('rejects a symlink at the stable workgroup lock sidecar', async () => {
    const outside = path.join(workgroupRoot, 'outside-lock-target');
    fs.writeFileSync(outside, 'untouched');
    fs.symlinkSync(outside, memoryLockPath(path.join(root, 'index.md'), root));

    const result = await writeMemoryFile(
      { relative_path: 'index.md', content: 'blocked', expected_sha256: null },
      { rootDir: root },
    );
    expect(result).toMatchObject({ status: 'error', error: 'memory lock must not be a symlink' });
    expect(fs.readFileSync(outside, 'utf8')).toBe('untouched');
    expect(fs.existsSync(path.join(root, 'index.md'))).toBe(false);
  });

  it('removes a crash temp and leaves the canonical file unchanged', async () => {
    const target = path.join(root, 'index.md');
    fs.writeFileSync(target, 'stable');

    const result = await writeMemoryFile(
      { relative_path: 'index.md', content: 'partial', expected_sha256: sha256Text('stable') },
      {
        rootDir: root,
        beforeRename: async () => {
          throw new Error('simulated crash');
        },
      },
    );

    expect(result).toMatchObject({ status: 'error', error: 'simulated crash' });
    expect(fs.readFileSync(target, 'utf8')).toBe('stable');
    expect(generatedWriteResidue(root)).toEqual([]);
  });

  it('exposes one provider-neutral structured tool', async () => {
    expect(writeMemoryFileTool.tool.name).toBe('write_memory_file');
    const response = await writeMemoryFileTool.handler({
      relative_path: '/absolute/tool.md',
      content: 'hello',
      expected_sha256: null,
    });
    const payload = JSON.parse(response.content[0]?.type === 'text' ? response.content[0].text : '{}');
    expect(payload).toMatchObject({ status: 'error' });
  });
});
