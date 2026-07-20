import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, open, opendir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, relative, resolve, sep } from 'node:path';

export type DiscoveredSourceKind = 'code' | 'document' | 'conversation' | 'structured' | 'image' | 'media';

export type DiscoveredSourceState = 'pending' | 'indexed' | 'metadata_only' | 'quarantined' | 'failed' | 'deleted';

export interface DiscoveredSource {
  id: string;
  workgroupId: string;
  relativePath: string;
  absolutePath: string;
  kind: DiscoveredSourceKind;
  bytes: number;
  mtimeMs: number;
  sha256: string;
  state: DiscoveredSourceState;
  stateReason?: string;
  metadata?: Record<string, unknown>;
}

export interface DiscoverWorkgroupOptions {
  workgroupId: string;
  root: string;
  ignoreFile?: string;
  maxFiles?: number;
  /** Cooperative cancellation for low-priority background reconciliation. */
  signal?: AbortSignal;
}

export interface DiscoverSourcePathOptions {
  workgroupId: string;
  root: string;
  /** Absolute path reported by the trusted filesystem watcher. */
  path: string;
  ignoreFile?: string;
  signal?: AbortSignal;
}

const MIB = 1024 * 1024;

const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.graphify',
  '.gitnexus',
  'node_modules',
  '.pnpm-store',
  '.yarn',
  '.npm',
  '.bun',
  '.cache',
  'cache',
  'caches',
  'vendor',
  '.venv',
  'venv',
  '.direnv',
  '__pypackages__',
  'site-packages',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.nox',
  '.gradle',
  'target',
  'dist',
  'build',
  '.next',
  'coverage',
  'allure-results',
  'allure-report',
  'playwright-report',
  'test-results',
  '.nyc_output',
  'dbt_packages',
]);

function isExcludedDirectorySegment(segment: string): boolean {
  const normalized = segment.toLowerCase();
  return (
    EXCLUDED_DIRECTORIES.has(normalized) ||
    /^(?:\.?venv)(?:[-_.].+)?$/.test(normalized) ||
    /[-_.]venv$/.test(normalized)
  );
}

/**
 * Keep filesystem watchers on the same default directory surface as corpus
 * discovery. Watching excluded package/build caches can consume hundreds of
 * thousands of inotify entries even though none of those files are indexable.
 */
export function isGraphifyDefaultExcludedPath(root: string, candidate: string): boolean {
  const relativePath = normalizeRelativePath(relative(resolve(root), resolve(candidate)));
  if (!relativePath || relativePath === '.') return false;
  if (relativePath === '..' || relativePath.startsWith('../')) return true;
  return relativePath.split('/').some(isExcludedDirectorySegment);
}

const CODE_EXTENSIONS = new Set([
  '.asm',
  '.bash',
  '.c',
  '.cc',
  '.clj',
  '.cljs',
  '.cmake',
  '.cpp',
  '.cs',
  '.css',
  '.cxx',
  '.dart',
  '.ex',
  '.exs',
  '.fs',
  '.fsx',
  '.go',
  '.graphql',
  '.groovy',
  '.h',
  '.hpp',
  '.hs',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.kts',
  '.lua',
  '.m',
  '.mm',
  '.php',
  '.pl',
  '.proto',
  '.py',
  '.r',
  '.rb',
  '.rs',
  '.scala',
  '.scss',
  '.sh',
  '.sol',
  '.sql',
  '.swift',
  '.tf',
  '.toml',
  '.ts',
  '.tsx',
  '.vue',
  '.zig',
]);

const DOCUMENT_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.md',
  '.mdx',
  '.pdf',
  '.qmd',
  '.rst',
  '.skill',
  '.txt',
  '.docx',
]);

const STRUCTURED_EXTENSIONS = new Set(['.csv', '.json', '.lkml', '.tsv', '.xlsx', '.yaml', '.yml']);

const IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.heic',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.tif',
  '.tiff',
  '.webp',
]);

const MEDIA_EXTENSIONS = new Set([
  '.aac',
  '.avi',
  '.flac',
  '.m4a',
  '.m4v',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.mpeg',
  '.mpg',
  '.oga',
  '.ogg',
  '.opus',
  '.wav',
  '.webm',
  '.wma',
  '.wmv',
]);

function normalizeRelativePath(path: string): string {
  return path.split(sep).join('/').replace(/^\.\//, '');
}

function isInsideRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function classifyPath(path: string): DiscoveredSourceKind | undefined {
  const extension = extname(path).toLowerCase();
  if (CODE_EXTENSIONS.has(extension)) return 'code';
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document';
  if (STRUCTURED_EXTENSIONS.has(extension)) return 'structured';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (MEDIA_EXTENSIONS.has(extension)) return 'media';
  return undefined;
}

function isCredentialPath(path: string): boolean {
  const name = basename(path).toLowerCase();
  return (
    name === '.env' ||
    name.startsWith('.env.') ||
    name === '.npmrc' ||
    name === '.pypirc' ||
    name.endsWith('.pem') ||
    name.endsWith('.key') ||
    name.endsWith('.kdbx') ||
    /^id_rsa(?:\..*)?$/.test(name) ||
    /^credentials.*\.json$/.test(name) ||
    /^service-account.*\.json$/.test(name)
  );
}

function maxBytesFor(path: string, kind: DiscoveredSourceKind): number {
  const extension = extname(path).toLowerCase();
  if (kind === 'media') return 250 * MIB;
  if (kind === 'image') return 25 * MIB;
  if (extension === '.pdf' || extension === '.docx' || extension === '.xlsx') return 50 * MIB;
  return 10 * MIB;
}

function abortError(signal: AbortSignal): Error {
  const error = new Error(
    typeof signal.reason === 'string' && signal.reason ? signal.reason : 'Graphify discovery aborted',
  );
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  return await new Promise<string>((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    let settled = false;
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      const error = abortError(signal!);
      stream.destroy(error);
      fail(error);
    };
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', fail);
    stream.once('end', () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveHash(hash.digest('hex'));
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
  });
}

function stableSourceId(workgroupId: string, relativePath: string): string {
  const digest = createHash('sha256').update(workgroupId).update('\0').update(relativePath).digest('hex');
  return `source_${digest}`;
}

/**
 * Re-open a discovered source without following a replacement symlink and
 * prove the bytes still match the discovery snapshot before extraction.
 */
export async function readVerifiedSource(
  source: Pick<DiscoveredSource, 'absolutePath' | 'bytes' | 'sha256' | 'relativePath'>,
  maximumBytes: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error('maximumBytes must be a positive integer');
  }
  const handle = await open(source.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) throw new Error(`source is no longer a regular file: ${source.relativePath}`);
    if (fileStat.size !== source.bytes) throw new Error(`source changed after discovery: ${source.relativePath}`);
    if (fileStat.size > maximumBytes) throw new Error(`source exceeds extraction cap: ${source.relativePath}`);
    const bytes = await handle.readFile();
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (bytes.byteLength !== source.bytes || digest !== source.sha256) {
      throw new Error(`source changed after discovery: ${source.relativePath}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function metadataFingerprint(relativePath: string, bytes: number, mtimeMs: number): string {
  return createHash('sha256')
    .update('graphify-metadata-v1')
    .update('\0')
    .update(relativePath)
    .update('\0')
    .update(String(bytes))
    .update('\0')
    .update(String(mtimeMs))
    .digest('hex');
}

function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function globToRegex(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character !== '*') {
      source += escapeRegex(character);
      continue;
    }
    if (pattern[index + 1] === '*') {
      index += 1;
      if (pattern[index + 1] === '/') {
        index += 1;
        source += '(?:.*/)?';
      } else {
        source += '.*';
      }
    } else {
      source += '[^/]*';
    }
  }
  return new RegExp(`${source}$`);
}

interface IgnoreRule {
  matches(path: string, isDirectory: boolean): boolean;
}

function parseIgnoreRules(contents: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const normalized = trimmed.replace(/^\//, '').replace(/\\/g, '/');
    const directoryRule = normalized.endsWith('/');
    const pattern = directoryRule ? normalized.slice(0, -1) : normalized;
    if (!pattern) continue;
    const regex = globToRegex(pattern);
    rules.push({
      matches(path, isDirectory) {
        if (directoryRule) {
          return regex.test(path) || path.startsWith(`${pattern}/`) || (isDirectory && regex.test(path));
        }
        return regex.test(path);
      },
    });
  }
  return rules;
}

async function loadIgnoreRules(root: string, ignoreFile?: string): Promise<IgnoreRule[]> {
  const configured = ignoreFile ? resolve(root, ignoreFile) : resolve(root, '.graphifyignore');
  if (!isInsideRoot(root, configured)) return [];
  try {
    return parseIgnoreRules(await readFile(configured, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function ignoredByRules(rules: IgnoreRule[], path: string, isDirectory: boolean): boolean {
  return rules.some((rule) => rule.matches(path, isDirectory));
}

async function discoverRegularSource(
  workgroupId: string,
  root: string,
  rules: IgnoreRule[],
  absolutePath: string,
  relativePath: string,
  signal?: AbortSignal,
): Promise<DiscoveredSource | undefined> {
  if (ignoredByRules(rules, relativePath, false)) return undefined;
  const credential = isCredentialPath(relativePath);
  const kind = classifyPath(relativePath) ?? (credential ? 'document' : undefined);
  if (!kind) return undefined;

  const resolvedPath = await realpath(absolutePath);
  if (!isInsideRoot(root, resolvedPath)) return undefined;
  const fileStat = await stat(resolvedPath);
  if (!fileStat.isFile()) return undefined;
  const cap = maxBytesFor(relativePath, kind);
  const state = credential || fileStat.size > cap ? 'metadata_only' : 'pending';
  const stateReason = credential
    ? 'Sensitive credential-shaped file: content extraction disabled'
    : fileStat.size > cap
      ? `Source exceeds the ${cap / MIB} MiB ${kind} extraction cap`
      : undefined;
  const fingerprintKind = state === 'metadata_only' ? 'metadata' : 'content';

  return {
    id: stableSourceId(workgroupId, relativePath),
    workgroupId,
    relativePath,
    absolutePath: resolvedPath,
    kind,
    bytes: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    sha256:
      state === 'metadata_only'
        ? metadataFingerprint(relativePath, fileStat.size, fileStat.mtimeMs)
        : await sha256File(resolvedPath, signal),
    state,
    ...(stateReason ? { stateReason } : {}),
    metadata: { extractionCapBytes: cap, fingerprintKind },
  };
}

/**
 * Resolve one watcher-reported path through the same safety, ignore, size, and
 * credential policy as a full workgroup discovery. Absence means the source
 * should not contribute to the graph (deleted, ignored, unsupported, or no
 * longer a regular file).
 */
export async function discoverSourcePath(options: DiscoverSourcePathOptions): Promise<DiscoveredSource | undefined> {
  throwIfAborted(options.signal);
  if (!options.workgroupId.trim()) throw new Error('workgroupId is required');
  const root = await realpath(resolve(options.root));
  const candidate = resolve(root, options.path);
  if (!isInsideRoot(root, candidate)) throw new Error('source path is outside the workgroup root');
  const relativePath = normalizeRelativePath(relative(root, candidate));
  if (!relativePath || relativePath === '.graphifyignore') return undefined;
  if (isGraphifyDefaultExcludedPath(root, candidate)) return undefined;
  const rules = await loadIgnoreRules(root, options.ignoreFile);
  let entryStat;
  try {
    entryStat = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (entryStat.isSymbolicLink() || !entryStat.isFile()) return undefined;
  return await discoverRegularSource(options.workgroupId, root, rules, candidate, relativePath, options.signal);
}

export async function discoverWorkgroup(options: DiscoverWorkgroupOptions): Promise<DiscoveredSource[]> {
  throwIfAborted(options.signal);
  if (!options.workgroupId.trim()) throw new Error('workgroupId is required');
  if (options.maxFiles !== undefined && (!Number.isInteger(options.maxFiles) || options.maxFiles < 1)) {
    throw new Error('maxFiles must be a positive integer');
  }

  const root = await realpath(resolve(options.root));
  const rules = await loadIgnoreRules(root, options.ignoreFile);
  const discovered: DiscoveredSource[] = [];

  async function walk(directory: string): Promise<void> {
    throwIfAborted(options.signal);
    if (options.maxFiles !== undefined && discovered.length >= options.maxFiles) return;
    const entries = [];
    const handle = await opendir(directory);
    for await (const entry of handle) {
      throwIfAborted(options.signal);
      entries.push(entry);
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

    for (const entry of entries) {
      throwIfAborted(options.signal);
      if (options.maxFiles !== undefined && discovered.length >= options.maxFiles) return;
      const absolutePath = resolve(directory, entry.name);
      const relativePath = normalizeRelativePath(relative(root, absolutePath));
      if (!relativePath || relativePath === '.graphifyignore') continue;

      const entryStat = await lstat(absolutePath);
      if (entryStat.isSymbolicLink()) continue;
      if (entryStat.isDirectory()) {
        if (isExcludedDirectorySegment(entry.name)) continue;
        if (ignoredByRules(rules, relativePath, true)) continue;
        const resolvedPath = await realpath(absolutePath);
        if (!isInsideRoot(root, resolvedPath)) continue;
        await walk(resolvedPath);
        continue;
      }
      if (!entryStat.isFile()) continue;
      const source = await discoverRegularSource(
        options.workgroupId,
        root,
        rules,
        absolutePath,
        relativePath,
        options.signal,
      );
      if (source) discovered.push(source);
    }
  }

  await walk(root);
  throwIfAborted(options.signal);
  return discovered.sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
  );
}
