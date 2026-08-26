import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { DATA_DIR } from '../../config.js';
import { workgroupMemoryDir } from '../workgroup/shared-dirs.js';
import {
  CONSOLIDATION_FILE_MAX_BYTES,
  GENERATED_MEMORY_MAX_BYTES,
  GENERATED_MEMORY_RELATIVE_PATH,
  generatedMemorySha,
  isCuratorOwned,
  RESERVED_TOPIC_LEAVES,
  serializeTopicFile,
  TOPIC_DIRECTORIES,
  TOPIC_FILE_PATH_PATTERN,
} from './curator-contract.js';
import {
  type IndexLink,
  mergeRootIndexMap,
  renderFolderIndex,
  titleFromStem,
  type TopicIndexEntry,
} from './memory-index.js';

const HELPER_PATH = fileURLToPath(
  new URL('../../../container/agent-runner/src/mcp-tools/memory-write-process-helper.ts', import.meta.url),
);
// Flat 10s was fine while the largest legal write was 8 MiB.
// GENERATED_MEMORY_MAX_BYTES doubled to 16 MiB (curator-contract.ts) without
// this changing, so the biggest write now gets the same wall-clock budget
// the smallest one always had — and the "memory writer helper failed (null)"
// class (16 events, empty stderr, a host event-loop stall in the preceding
// 60s every time — i.e. this SIGKILL firing under load, not a stuck helper)
// only gets easier to reproduce as writes trend toward the new, larger cap.
// Scale with the actual request size instead: a small write keeps a tight
// bound (fails fast on a genuinely stuck helper) and a max-size write gets
// proportionate room.
//
// Measured directly against real production data (busiest workgroup,
// 2026-08-24 — the same ledger GENERATED_MEMORY_MAX_BYTES's comment
// measures): copied its 6.5 MB / 6,706-fact generated/memory.md to /tmp,
// padded it with duplicated real fact lines up to the largest body that
// fits MAX_CURATOR_WRITE_REQUEST_BYTES today (~16.77 MB — see the
// HELPER_REQUEST_OVERHEAD_BYTES note below), and timed the real spawned
// helper end-to-end (hash the existing file, write, fsync, rename) three to
// five runs per size on this host:
//   ~50 KB  -> 190-405 ms   (bun cold-start dominates; near-flat with size)
//   ~1 MiB  -> 205-240 ms
//   ~4 MiB  -> 260-300 ms
//   ~8 MiB  -> 340-350 ms
//   ~12 MiB -> 425-435 ms
//   ~16 MiB -> 530-790 ms
// Roughly linear at ~25 ms/MiB on top of a ~200 ms floor. The constants below
// give >10x headroom over both the floor and the per-MiB rate at every size
// measured, so a stretch of host-load slowdown has to be an order of
// magnitude worse than anything observed before this trips again — while a
// small write's bound drops from the old flat 10s to ~3.5s, still far clear
// of the measured floor and of bun's own cold-start variance.
const HELPER_TIMEOUT_BASE_MS = 3_000;
const HELPER_TIMEOUT_PER_MIB_MS = 500;

/** Exported for direct unit testing, same as resolveBunBinary below — a pure
 *  function is cheaper and more precise to test than asserting on real
 *  spawned-process timing. */
export function helperTimeoutMs(requestBytes: number): number {
  return HELPER_TIMEOUT_BASE_MS + Math.ceil(requestBytes / (1024 * 1024)) * HELPER_TIMEOUT_PER_MIB_MS;
}

const HELPER_OUTPUT_MAX_BYTES = 16 * 1024;
// FLAGGED, NOT FIXED HERE (out of this change's scope — the matching
// constant lives in the container tree's memory-write-process-helper.ts,
// not this file): this budget assumes JSON-escaping overhead stays small,
// but it scales with newline count. A real generated/memory.md at the new
// 16 MiB cap (~972 bytes/fact average, measured on the busiest live
// workgroup) has ~17,262 fact lines, and escaping those newlines alone costs
// ~17 KB — before any quote/backslash characters inside real fact text add
// more. Measured directly: padding that workgroup's real ledger to the
// largest body MAX_CURATOR_WRITE_REQUEST_BYTES allows today produced 20,182
// bytes of overhead against this 16 KiB budget, i.e. a fully legal
// (<=16 MiB) document at typical fact density can already produce a request
// this constant rejects. The existing "keeps the Bun helper request bound
// at or above the host cap" tests in curator-write.test.ts don't catch this
// because they pad with a single repeated non-newline character, which
// carries none of this escaping cost.
const HELPER_REQUEST_OVERHEAD_BYTES = 16 * 1024;
const HISTORY_LIMIT = 20;

export interface CuratorWriteResult {
  status: 'success' | 'conflict' | 'error';
  relative_path: string;
  sha256?: string;
  error?: string;
  /**
   * Set only on a rejection that is a property of THIS path and THIS content,
   * so retrying the identical inputs can never succeed — a disallowed path, a
   * file the curator does not own, an over-cap document. Those are the ones a
   * caller may drop and move on from.
   *
   * ABSENT MEANS UNKNOWN, and unknown must be treated as retryable: a lock
   * timeout, ENOSPC, a SIGKILLed helper and an ordinary I/O error all arrive
   * as a bare `status: 'error'` with nothing to distinguish them. Dropping
   * those loses the facts behind them permanently.
   */
  permanent?: boolean;
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

  // A root-level file (`index.md`) has no subdirectory to create, and the
  // escape check below is written for a CHILD of the memory root — running it
  // against the root itself would compare the workgroup directory to the
  // memory root and always throw.
  if (path.dirname(subdirRelative) === '.') return;

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

/**
 * Read a topic file (people/domain/systems) for ownership and CAS checks.
 * `maxBytes` defaults to the generous generated-memory ceiling, NOT the
 * consolidation input cap — the write path's CAS/ownership read must still
 * be able to see enough of an oversized existing file to correctly REFUSE
 * it (an over-cap file is locked, not simply invisible). The scanner passes
 * CONSOLIDATION_INPUT_FILE_MAX_BYTES explicitly for the prompt-input read,
 * where over-cap really does mean "exclude, do not read".
 */
export function readMemoryTopicFile(
  workgroupId: string,
  relativePath: string,
  maxBytes?: number,
): { content: string; sha256: string | null } {
  const target = path.join(workgroupMemoryDir(workgroupId), relativePath);
  try {
    const content = readTrustedBoundedFile(target, workgroupMemoryDir(workgroupId), maxBytes);
    return { content, sha256: generatedMemorySha(content) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { content: '', sha256: null };
    throw error;
  }
}

/**
 * Writes ONE curator-owned topic file (people/domain/systems). Host-side
 * validation the model is never trusted to have honored itself: the path must
 * match TOPIC_FILE_PATH_PATTERN and must not be an OKF-reserved leaf, and the
 * final serialized file — the model's body under the frontmatter this stamps
 * — must fit CONSOLIDATION_FILE_MAX_BYTES. Refuses to overwrite any existing
 * file that is not curator-owned (P2-I6): a human-authored or unmarked file is
 * never a write target no matter what the model returned.
 *
 * `factsCount` is this pass's tail size, recorded as `consolidated_facts` in
 * the frontmatter — the same audit trail the legacy `<!-- consolidated:
 * facts=N -->` header carried, moved somewhere the model cannot echo back.
 * The existing file's other frontmatter keys are carried forward untouched.
 */
export async function writeMemoryTopicFile(
  workgroupId: string,
  relativePath: string,
  content: string,
  expectedSha256: string | null,
  factsCount: number,
): Promise<CuratorWriteResult> {
  if (!TOPIC_FILE_PATH_PATTERN.test(relativePath) || RESERVED_TOPIC_LEAVES.has(relativePath.split('/')[1] ?? '')) {
    return { status: 'error', relative_path: relativePath, error: 'topic file path is not allowed', permanent: true };
  }
  // Read before creating anything: a rejected write must not leave an empty
  // topic directory behind. readMemoryTopicFile treats a missing parent as
  // ENOENT, same as a missing file.
  const current = readMemoryTopicFile(workgroupId, relativePath);
  if (current.sha256 !== null && !isCuratorOwned(current.content)) {
    return {
      status: 'error',
      relative_path: relativePath,
      error: 'topic file is not owned by consolidation',
      permanent: true,
    };
  }
  // Serialized against the file actually on disk, so the size check measures
  // the real bytes — including any frontmatter key an operator or agent added
  // that validateConsolidationFiles could not see.
  const finalContent = serializeTopicFile(relativePath, content, factsCount, current.content);
  if (Buffer.byteLength(finalContent, 'utf8') > CONSOLIDATION_FILE_MAX_BYTES) {
    return {
      status: 'error',
      relative_path: relativePath,
      error: `topic file exceeds ${CONSOLIDATION_FILE_MAX_BYTES} bytes`,
      permanent: true,
    };
  }
  ensureMemorySubdirectory(workgroupId, relativePath);
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
  const requestBytes = Buffer.byteLength(body);
  if (requestBytes > GENERATED_MEMORY_MAX_BYTES + HELPER_REQUEST_OVERHEAD_BYTES) {
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
    const timer = setTimeout(() => child.kill('SIGKILL'), helperTimeoutMs(requestBytes));
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

// ── OKF index maintenance ───────────────────────────────────────────────────
// The curator writes topic files; upstream's memory system navigates by
// `index.md`. Keeping the two in step is the whole point of the curator being
// a background executor of the format rather than a second memory system.

/** Runaway rail on an index file, not a retention policy — see the topic and
 *  generated-memory caps above for the same reasoning. A folder index grows
 *  with the file count: the busiest live workgroup's 185-file `domain/` lands
 *  around 26 KB. */
export const MEMORY_INDEX_MAX_BYTES = 256 * 1024;

/** Root `index.md` and the three topic-folder indexes. Nothing else. */
const INDEX_PATH_PATTERN = new RegExp(`^(?:(?:${TOPIC_DIRECTORIES.join('|')})/)?index\\.md$`);

/**
 * Writes one index file. Unlike a topic file there is no ownership check:
 * `index.md` is co-owned by the operator, the agents and the curator, and the
 * merge in memory-index.ts is what protects hand-written content. CAS is the
 * only gate, and the write goes through the same workgroup-wide flock every
 * container write takes, so a concurrent `write_memory_file` cannot interleave.
 */
export async function writeMemoryIndexFile(
  workgroupId: string,
  relativePath: string,
  content: string,
  expectedSha256: string | null,
): Promise<CuratorWriteResult> {
  if (!INDEX_PATH_PATTERN.test(relativePath)) {
    return { status: 'error', relative_path: relativePath, error: 'index file path is not allowed', permanent: true };
  }
  if (Buffer.byteLength(content, 'utf8') > MEMORY_INDEX_MAX_BYTES) {
    return {
      status: 'error',
      relative_path: relativePath,
      error: `index file exceeds ${MEMORY_INDEX_MAX_BYTES} bytes`,
      permanent: true,
    };
  }
  ensureMemorySubdirectory(workgroupId, relativePath);
  return await invokeHelper({
    rootDir: workgroupMemoryDir(workgroupId),
    relativePath,
    content,
    expectedSha256,
  });
}

/** Attempts per index file before giving up on a losing CAS race. */
const INDEX_WRITE_ATTEMPTS = 3;

/**
 * Read-modify-write one index file. Re-reads and re-merges on conflict rather
 * than retrying the same bytes: the merge is defined against whatever is on
 * disk, so a sibling write that landed in between is merged over, never lost.
 * Returns true when the file changed.
 *
 * `merge` is handed the attempt number because re-reading the FILE is only
 * half of it. The merge is also defined against a directory listing, and a
 * listing captured before the loop is exactly as stale as the file contents
 * after a lost race — an agent that created `people/alice.md` and added its
 * own bullet mid-retry would have that bullet read as pointing at a file that
 * does not exist, and dropped. Anything derived from disk has to be
 * re-derived on `attempt > 0`.
 */
async function updateIndexFile(
  workgroupId: string,
  relativePath: string,
  merge: (existing: string, attempt: number) => string,
  dryRun = false,
): Promise<boolean> {
  for (let attempt = 0; attempt < INDEX_WRITE_ATTEMPTS; attempt += 1) {
    const current = readMemoryTopicFile(workgroupId, relativePath, MEMORY_INDEX_MAX_BYTES);
    const next = merge(current.content, attempt);
    if (next === current.content) return false;
    if (dryRun) return true;
    const write = await writeMemoryIndexFile(workgroupId, relativePath, next, current.sha256);
    if (write.status === 'success') return true;
    if (write.status !== 'conflict') {
      throw new Error(`memory index write ${write.status}: ${write.error ?? 'unknown'}`);
    }
  }
  throw new Error(`memory index write lost ${INDEX_WRITE_ATTEMPTS} CAS races: ${relativePath}`);
}

/**
 * One topic folder, split into what is THERE and what could be READ.
 *
 * `present` is POSITIVE EVIDENCE and nothing else. The map merge deletes a
 * link when its target is gone, and "gone" has to mean observed-absent, never
 * merely missing-from-a-listing-we-derived. Three bugs came out of getting
 * that wrong, all the same shape:
 *
 *   - built from successful READS, so an unreadable or over-cap file looked
 *     deleted and lost its hand-written link on every sync;
 *   - a transient `readdir` failure (EMFILE, EIO) produced an empty listing,
 *     which read as "the whole folder was deleted" and stripped every link
 *     from that folder's index in one pass;
 *   - reserved leaves were filtered out of the listing, so a hand-written link
 *     to a folder's `log.md` journal — a legitimate OKF file — read as stale.
 *
 * So: `null` means "the listing is not trustworthy, claim nothing", an empty
 * listing is treated the same way, and reserved leaves count as present.
 */
function listTopicEntries(
  workgroupId: string,
  directory: string,
): { present: Set<string> | null; entries: TopicIndexEntry[] } {
  let all: string[];
  try {
    all = fs
      .readdirSync(path.join(workgroupMemoryDir(workgroupId), directory), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name);
  } catch {
    return { present: null, entries: [] };
  }
  // An empty listing for a folder that has an index is far more likely to be a
  // failed listing than a folder someone emptied. Err toward keeping links.
  if (all.length === 0) return { present: null, entries: [] };
  const names = all
    .filter((name) => !RESERVED_TOPIC_LEAVES.has(name) && TOPIC_FILE_PATH_PATTERN.test(`${directory}/${name}`))
    .sort((a, b) => a.localeCompare(b));
  const entries: TopicIndexEntry[] = [];
  for (const name of names) {
    try {
      // Read bound is the index rail, NOT the consolidation input cap: an
      // over-cap topic file is excluded from the model's prompt but must
      // still appear on the map, or the map claims it does not exist.
      entries.push({
        name,
        content: readMemoryTopicFile(workgroupId, `${directory}/${name}`, MEMORY_INDEX_MAX_BYTES).content,
      });
    } catch {
      continue; // still `present`, just not readable — its link stays put
    }
  }
  return { present: new Set(all), entries };
}

export interface MemoryIndexSyncResult {
  /** Index paths whose bytes changed this pass. Empty is the steady state. */
  updated: string[];
}

/**
 * Bring `index.md` and the topic-folder indexes in line with what is on disk.
 *
 * `dryRun` reports exactly what a real run would change without writing —
 * the repair sweep needs it, because the index rewrite is the part of a
 * 290-file pass an operator most needs to see before consenting to it.
 *
 * Derived entirely from the filesystem rather than from the files this pass
 * happened to write, which makes it idempotent (unchanged tree → no write at
 * all) and self-healing: the first pass after this ships maps a workgroup's
 * whole existing backlog, including topic files the curator has not rewritten
 * yet — a legacy `<!-- consolidated -->` header still proves ownership, and
 * the hook is read straight out of the body.
 */
export async function syncMemoryIndexes(
  workgroupId: string,
  options: { dryRun?: boolean } = {},
): Promise<MemoryIndexSyncResult> {
  const dryRun = options.dryRun === true;
  const updated: string[] = [];
  const rootLinks: IndexLink[] = [];
  // Folders we DID list and that hold nothing to point at. That, and only
  // that, licenses removing a folder pointer from the root map — a folder
  // whose listing failed is skipped here as well as above, so its pointer is
  // neither re-rendered nor deleted.
  const retiredPointers: string[] = [];
  for (const directory of TOPIC_DIRECTORIES) {
    let listing = listTopicEntries(workgroupId, directory);
    // Listing untrustworthy: leave this folder's index exactly as it is rather
    // than rewriting a map from evidence we do not have.
    if (listing.present === null) continue;
    let owned = listing.entries.filter((entry) => isCuratorOwned(entry.content));
    const indexPath = `${directory}/index.md`;
    const hasIndex = readMemoryTopicFile(workgroupId, indexPath, MEMORY_INDEX_MAX_BYTES).sha256 !== null;
    if (owned.length === 0 && !hasIndex) {
      retiredPointers.push(indexPath);
      continue;
    }
    const changed = await updateIndexFile(
      workgroupId,
      indexPath,
      (existing, attempt) => {
        // Lost a CAS race: somebody wrote this folder between our listing and
        // our write, so the listing is as stale as the bytes we just re-read.
        if (attempt > 0) listing = listTopicEntries(workgroupId, directory);
        const present = listing.present;
        if (present === null) return existing;
        owned = listing.entries.filter((entry) => isCuratorOwned(entry.content));
        return renderFolderIndex(directory, owned, present, existing);
      },
      dryRun,
    );
    if (changed) updated.push(indexPath);
    rootLinks.push({
      target: indexPath,
      title: titleFromStem(directory),
      hook: `${owned.length} consolidated ${owned.length === 1 ? 'concept' : 'concepts'}`,
    });
  }
  // No topic folders at all: leave the root index completely alone rather
  // than stamping an empty `## Map` section into every workgroup that has
  // never had a consolidation pass.
  if (
    rootLinks.length > 0 &&
    (await updateIndexFile(
      workgroupId,
      'index.md',
      (existing) => mergeRootIndexMap(existing, rootLinks, retiredPointers),
      dryRun,
    ))
  ) {
    updated.push('index.md');
  }
  return { updated };
}
