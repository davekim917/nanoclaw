/**
 * CLAUDE.md → AGENTS.md flattener: Codex passes `@path` includes to the model as literal text, so each line that
 * starts with `@<path>` is replaced by the file's content (relative to the including file; `~` expanded).
 * Recursive, cycle-safe; a missing include becomes an inline comment marker rather than vanishing.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

export interface FlattenOptions {
  /** Container→host path prefixes for symlink targets (composeGroupClaudeMd writes e.g. `/app/CLAUDE.md`). */
  containerToHost?: Record<string, string>;
  /** Include-cycle guard; default 8. */
  maxDepth?: number;
  /**
   * Called with every resolved read target before `readFileSync`; a returned reason skips it with a marker. Callers
   * reading from a container-writable tree must pass one: an agent could plant a symlink to a FIFO, a huge file or
   * a path outside its trust boundary.
   */
  validateRead?: (realPath: string) => string | undefined;
}

const DEFAULT_MAX_DEPTH = 8;
const noopValidateRead = (): string | undefined => undefined;

function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function translateContainerPath(target: string, containerToHost: Record<string, string>): string {
  for (const [containerPrefix, hostPrefix] of Object.entries(containerToHost)) {
    if (target === containerPrefix || target.startsWith(containerPrefix + '/')) {
      return target.replace(containerPrefix, hostPrefix);
    }
  }
  return target;
}

/** The real file at the end of a symlink chain, translating container paths; null when it dangles or loops. */
function resolveSymlinkChain(start: string, containerToHost: Record<string, string>): string | null {
  let current = start;
  for (let i = 0; i < 16; i++) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return null;
    }
    if (!stat.isSymbolicLink()) {
      try {
        if (!stat.isFile()) return null;
      } catch {
        return null;
      }
      return current;
    }
    let target = fs.readlinkSync(current);
    target = translateContainerPath(target, containerToHost);
    if (!path.isAbsolute(target)) {
      target = path.resolve(path.dirname(current), target);
    }
    current = target;
  }
  return null; // too many hops — treat as cycle
}

function flattenInner(filePath: string, visited: Set<string>, depth: number, opts: Required<FlattenOptions>): string {
  if (depth > opts.maxDepth) {
    return `<!-- agents-md-flatten: max depth ${opts.maxDepth} exceeded at ${filePath} -->`;
  }

  const realPath = resolveSymlinkChain(filePath, opts.containerToHost) ?? filePath;
  if (visited.has(realPath)) {
    return `<!-- agents-md-flatten: cycle detected at ${filePath} -->`;
  }
  visited.add(realPath);

  const skipReason = opts.validateRead(realPath);
  if (skipReason !== undefined) {
    return `<!-- agents-md-flatten: skipped ${filePath} (${skipReason}) -->`;
  }

  let content: string;
  try {
    content = fs.readFileSync(realPath, 'utf-8');
  } catch (err) {
    return `<!-- agents-md-flatten: failed to read ${filePath} (${err instanceof Error ? err.message : String(err)}) -->`;
  }

  const baseDir = path.dirname(realPath);
  const out: string[] = [];

  for (const line of content.split('\n')) {
    const match = line.match(/^(\s*)@(\S.*)$/);
    if (!match) {
      out.push(line);
      continue;
    }
    // Only a path-like ref (contains / or .) with no whitespace: prose such as "the @-mention itself is the signal."
    // would otherwise splice an ENOENT marker mid-sentence.
    const ref = match[2];
    if (/\s/.test(ref) || !/[/.]/.test(ref) || /@\w+\s/.test(line)) {
      out.push(line);
      continue;
    }
    let target = expandHome(ref);
    target = translateContainerPath(target, opts.containerToHost);
    if (!path.isAbsolute(target)) {
      target = path.resolve(baseDir, target);
    }
    const inlined = flattenInner(target, visited, depth + 1, opts);
    out.push(inlined);
  }

  return out.join('\n');
}

/** Read `filePath` with every `@path` include inlined recursively. */
export function flattenClaudeMd(filePath: string, options: FlattenOptions = {}): string {
  const opts: Required<FlattenOptions> = {
    containerToHost: options.containerToHost ?? {},
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    validateRead: options.validateRead ?? noopValidateRead,
  };
  return flattenInner(filePath, new Set(), 0, opts);
}
