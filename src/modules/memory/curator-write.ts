import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { DATA_DIR } from '../../config.js';
import { workgroupMemoryDir } from '../workgroup/shared-dirs.js';
import {
  CONSOLIDATION_FILE_MAX_BYTES,
  CONSOLIDATION_HEADER_PATTERN,
  consolidationHeader,
  GENERATED_MEMORY_MAX_BYTES,
  GENERATED_MEMORY_RELATIVE_PATH,
  generatedMemorySha,
  TOPIC_FILE_PATH_PATTERN,
} from './curator-contract.js';

const HELPER_PATH = fileURLToPath(
  new URL('../../../container/agent-runner/src/mcp-tools/memory-write-process-helper.ts', import.meta.url),
);
const HELPER_TIMEOUT_MS = 10_000;
const HELPER_OUTPUT_MAX_BYTES = 16 * 1024;
const HELPER_REQUEST_OVERHEAD_BYTES = 16 * 1024;
const HISTORY_LIMIT = 20;

export interface CuratorWriteResult {
  status: 'success' | 'conflict' | 'error';
  relative_path: string;
  sha256?: string;
  error?: string;
}

export function resolveBunBinary(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.BUN_BIN?.trim();
  const candidates = [
    explicit || null,
    env.HOME ? path.join(env.HOME, '.bun', 'bin', 'bun') : null,
    ...(env.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, 'bun')),
  ].filter((candidate): candidate is string => candidate !== null);
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EACCES' || (error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw error;
    }
  }
  throw new Error('memory writer requires an executable Bun runtime');
}

function generatedPath(workgroupId: string): string {
  return path.join(workgroupMemoryDir(workgroupId), GENERATED_MEMORY_RELATIVE_PATH);
}

/**
 * Create `<memory root>/<subdirRelative first segment>` if absent, with the
 * same symlink/canonical-path discipline `generated/` has always used.
 * Shared by the generated-memory writer and the topic-file writer (P2.7 step
 * 3: "same symlink checks as ensureGeneratedDirectory").
 */
function ensureMemorySubdirectory(workgroupId: string, subdirRelative: string): void {
  const memoryRoot = workgroupMemoryDir(workgroupId);
  const workgroupRoot = path.dirname(memoryRoot);
  const memoryStat = fs.lstatSync(memoryRoot);
  const workgroupStat = fs.lstatSync(workgroupRoot);
  if (
    memoryStat.isSymbolicLink() ||
    !memoryStat.isDirectory() ||
    workgroupStat.isSymbolicLink() ||
    !workgroupStat.isDirectory()
  ) {
    throw new Error('memory write requires an ordinary canonical workgroup memory directory');
  }
  const canonicalWorkgroupRoot = fs.realpathSync(workgroupRoot);
  const canonicalMemoryRoot = fs.realpathSync(memoryRoot);
  if (path.dirname(canonicalMemoryRoot) !== canonicalWorkgroupRoot) {
    throw new Error('memory root escapes the canonical workgroup directory');
  }

  const subdir = path.join(memoryRoot, path.dirname(subdirRelative));
  try {
    fs.mkdirSync(subdir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const subdirStat = fs.lstatSync(subdir);
  if (subdirStat.isSymbolicLink() || !subdirStat.isDirectory()) {
    throw new Error('memory write parent must be an ordinary directory');
  }
  if (path.dirname(fs.realpathSync(subdir)) !== canonicalMemoryRoot) {
    throw new Error('memory write parent escapes the canonical memory root');
  }
}

function readTrustedBoundedFile(target: string, trustedRoot: string, maxBytes = GENERATED_MEMORY_MAX_BYTES): string {
  const canonicalRoot = fs.realpathSync(trustedRoot);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > maxBytes) {
      throw new Error('memory file must be a bounded regular file');
    }
    const resolved = fs.realpathSync(target);
    const relative = path.relative(canonicalRoot, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('memory file escapes its trusted root');
    }
    const resolvedStat = fs.statSync(resolved);
    if (opened.dev !== resolvedStat.dev || opened.ino !== resolvedStat.ino) {
      throw new Error('memory file changed while it was opened');
    }
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function readGeneratedMemory(workgroupId: string): { content: string; sha256: string | null } {
  const target = generatedPath(workgroupId);
  try {
    const content = readTrustedBoundedFile(target, workgroupMemoryDir(workgroupId));
    return { content, sha256: generatedMemorySha(content) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { content: '', sha256: null };
    throw error;
  }
}

/** Read a topic file (people/domain/systems) for ownership and CAS checks. */
export function readMemoryTopicFile(
  workgroupId: string,
  relativePath: string,
): { content: string; sha256: string | null } {
  const target = path.join(workgroupMemoryDir(workgroupId), relativePath);
  try {
    const content = readTrustedBoundedFile(target, workgroupMemoryDir(workgroupId));
    return { content, sha256: generatedMemorySha(content) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { content: '', sha256: null };
    throw error;
  }
}

/**
 * Writes ONE curator-owned topic file (people/domain/systems). Host-side
 * validation the model is never trusted to have honored itself: the path
 * must match TOPIC_FILE_PATH_PATTERN, and the final serialized content —
 * `content` header-prepended, since the header is appended BEFORE this check
 * (P2.4 item 7) — must fit CONSOLIDATION_FILE_MAX_BYTES. Refuses to overwrite
 * any existing file whose first line does not carry the consolidation header
 * (P2-I6): a human-authored or unmarked file is never a write target no
 * matter what the model returned. `factsCount` is this pass's tail size,
 * stamped into the header as its own audit trail.
 */
export async function writeMemoryTopicFile(
  workgroupId: string,
  relativePath: string,
  content: string,
  expectedSha256: string | null,
  factsCount: number,
): Promise<CuratorWriteResult> {
  if (!TOPIC_FILE_PATH_PATTERN.test(relativePath)) {
    return { status: 'error', relative_path: relativePath, error: 'topic file path is not allowed' };
  }
  const finalContent = `${consolidationHeader(factsCount)}\n${content}`;
  if (Buffer.byteLength(finalContent, 'utf8') > CONSOLIDATION_FILE_MAX_BYTES) {
    return {
      status: 'error',
      relative_path: relativePath,
      error: `topic file exceeds ${CONSOLIDATION_FILE_MAX_BYTES} bytes`,
    };
  }
  ensureMemorySubdirectory(workgroupId, relativePath);
  const current = readMemoryTopicFile(workgroupId, relativePath);
  if (current.sha256 !== null && !CONSOLIDATION_HEADER_PATTERN.test(current.content.split('\n', 1)[0] ?? '')) {
    return { status: 'error', relative_path: relativePath, error: 'topic file is not owned by consolidation' };
  }
  if (current.sha256 !== expectedSha256) {
    return {
      status: 'conflict',
      relative_path: relativePath,
      error: 'expected_sha256 does not match the current file',
    };
  }
  return await invokeHelper({
    rootDir: workgroupMemoryDir(workgroupId),
    relativePath,
    content: finalContent,
    expectedSha256,
  });
}

function historyDir(workgroupId: string): string {
  return path.join(DATA_DIR, 'memory-curator-history', workgroupId);
}

function snapshotCurrent(
  workgroupId: string,
  current: { content: string; sha256: string | null },
  nowMs: number,
): void {
  if (current.sha256 === null) return;
  const directory = historyDir(workgroupId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error('memory curator history must be a host directory');
  }
  const stamp = new Date(nowMs).toISOString().replaceAll(':', '-');
  const snapshot = path.join(directory, `${stamp}-${current.sha256}.md`);
  const fd = fs.openSync(snapshot, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeFileSync(fd, current.content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
  for (const stale of entries.slice(0, Math.max(0, entries.length - HISTORY_LIMIT))) {
    fs.unlinkSync(path.join(directory, stale));
  }
  const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    fs.fsyncSync(directoryFd);
  } finally {
    fs.closeSync(directoryFd);
  }
}

async function invokeHelper(request: Record<string, unknown>): Promise<CuratorWriteResult> {
  const body = JSON.stringify(request);
  if (Buffer.byteLength(body) > GENERATED_MEMORY_MAX_BYTES + HELPER_REQUEST_OVERHEAD_BYTES) {
    throw new Error('curator write request exceeds its bounded maximum');
  }
  const bunBinary = resolveBunBinary();
  return await new Promise((resolve, reject) => {
    const child = spawn(bunBinary, [HELPER_PATH], {
      cwd: path.dirname(HELPER_PATH),
      env: { PATH: process.env.PATH ?? '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), HELPER_TIMEOUT_MS);
    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > HELPER_OUTPUT_MAX_BYTES) child.kill('SIGKILL');
      else target.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(`memory writer helper failed (${code}): ${Buffer.concat(stderr).toString('utf8').slice(-1000)}`),
        );
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')) as CuratorWriteResult);
      } catch {
        reject(new Error('memory writer helper returned invalid JSON'));
      }
    });
    child.stdin.end(body);
  });
}

export async function writeGeneratedMemory(
  workgroupId: string,
  content: string,
  expectedSha256: string | null,
  options: { nowMs?: number } = {},
): Promise<CuratorWriteResult> {
  if (Buffer.byteLength(content, 'utf8') > GENERATED_MEMORY_MAX_BYTES) {
    throw new Error(`generated memory exceeds ${GENERATED_MEMORY_MAX_BYTES} bytes`);
  }
  ensureMemorySubdirectory(workgroupId, GENERATED_MEMORY_RELATIVE_PATH);
  const current = readGeneratedMemory(workgroupId);
  if (current.sha256 !== expectedSha256) {
    return {
      status: 'conflict',
      relative_path: GENERATED_MEMORY_RELATIVE_PATH,
      error: 'expected_sha256 does not match the current file',
    };
  }
  snapshotCurrent(workgroupId, current, options.nowMs ?? Date.now());
  return await invokeHelper({
    rootDir: workgroupMemoryDir(workgroupId),
    relativePath: GENERATED_MEMORY_RELATIVE_PATH,
    content,
    expectedSha256,
    allowGeneratedMemory: true,
  });
}

export function listGeneratedMemorySnapshots(workgroupId: string): string[] {
  const directory = historyDir(workgroupId);
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => path.join(directory, entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function restoreGeneratedMemorySnapshot(
  workgroupId: string,
  snapshotPath: string,
  expectedCurrentSha256: string,
  options: { nowMs?: number } = {},
): Promise<CuratorWriteResult> {
  const directory = historyDir(workgroupId);
  const resolvedSnapshot = path.resolve(snapshotPath);
  if (path.dirname(resolvedSnapshot) !== path.resolve(directory) || !resolvedSnapshot.endsWith('.md')) {
    throw new Error('memory curator snapshot is outside the host history directory');
  }
  const content = readTrustedBoundedFile(resolvedSnapshot, directory);
  return await writeGeneratedMemory(workgroupId, content, expectedCurrentSha256, options);
}
