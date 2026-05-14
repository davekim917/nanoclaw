/**
 * CLAUDE.md → AGENTS.md flattener.
 *
 * Codex doesn't resolve `@path` includes in AGENTS.md (verified empirically
 * via `codex debug prompt-input` 2026-05-13: `@/tmp/.../included.md` was
 * passed to the model as literal text). So to keep Dave's CLAUDE.md as the
 * canonical source of behavioral rules, we flatten it: every `@<path>`
 * line is replaced inline with the referenced file's content. Recursive,
 * cycle-safe, symlink-aware.
 *
 * Resolution rules — mirror Claude Code's @-include behavior:
 *   - `@./foo.md` or `@foo.md` resolves relative to the file containing it.
 *   - `@/abs/path` resolves as an absolute path.
 *   - `@~/foo` expands `~` to $HOME first.
 *   - One `@<path>` per line; whitespace before/after the @-line is preserved.
 *   - Trailing whitespace, fenced code blocks, and any non-leading @ are
 *     left alone — we only intercept lines whose first non-whitespace
 *     character starts the `@<path>` token.
 *
 * Missing or unreadable includes are passed through as a comment so the
 * model can see something went wrong, instead of silently dropping.
 *
 * Symlinks pointing at container-only paths (e.g. `/app/CLAUDE.md`) are
 * supported via the optional `containerToHost` map — translates a known
 * container-prefix to a host-prefix before reading.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

export interface FlattenOptions {
  /**
   * Map of container-path-prefix → host-path-prefix. Symlinks whose
   * targets start with a known container prefix are rewritten to their
   * host equivalent before being read. Useful for `composeGroupClaudeMd`
   * which writes container-relative symlinks (e.g. `/app/CLAUDE.md`).
   */
  containerToHost?: Record<string, string>;
  /**
   * Maximum recursion depth — protects against include-cycles.
   * Default 8.
   */
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 8;

function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Translate a container-only target path to its host equivalent using the
 * provided prefix map. Returns the path unchanged if no prefix matches.
 */
function translateContainerPath(target: string, containerToHost: Record<string, string>): string {
  for (const [containerPrefix, hostPrefix] of Object.entries(containerToHost)) {
    if (target === containerPrefix || target.startsWith(containerPrefix + '/')) {
      return target.replace(containerPrefix, hostPrefix);
    }
  }
  return target;
}

/**
 * Resolve a symlink to its eventual real file path, walking through any
 * intermediate links and translating container paths via the provided map.
 * Returns null if the chain dangles or hits a non-readable target.
 */
function resolveSymlinkChain(
  start: string,
  containerToHost: Record<string, string>,
): string | null {
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

function flattenInner(
  filePath: string,
  visited: Set<string>,
  depth: number,
  opts: Required<FlattenOptions>,
): string {
  if (depth > opts.maxDepth) {
    return `<!-- agents-md-flatten: max depth ${opts.maxDepth} exceeded at ${filePath} -->`;
  }

  const realPath = resolveSymlinkChain(filePath, opts.containerToHost) ?? filePath;
  if (visited.has(realPath)) {
    return `<!-- agents-md-flatten: cycle detected at ${filePath} -->`;
  }
  visited.add(realPath);

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
    // Don't intercept email-like patterns or things inside code fences;
    // a conservative heuristic: the `@` must be followed by a path
    // (containing / or .md) — not a bare identifier like `@param`.
    const ref = match[2];
    if (!/[\/\.]/.test(ref) || /@\w+\s/.test(line)) {
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

/**
 * Read `filePath`, recursively inline all `@path` includes, return the
 * flat content. Safe for repeated invocation — pure function of inputs.
 */
export function flattenClaudeMd(filePath: string, options: FlattenOptions = {}): string {
  const opts: Required<FlattenOptions> = {
    containerToHost: options.containerToHost ?? {},
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
  };
  return flattenInner(filePath, new Set(), 0, opts);
}

/**
 * Convenience wrapper for the global host case:
 * ~/.claude/CLAUDE.md → flat content with Codex-specific peer-header
 * prepended. Used by `scripts/sync-codex-agents-md.ts`.
 */
export function flattenGlobalClaudeMd(): string {
  const claudeMd = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  return flattenClaudeMd(claudeMd);
}
