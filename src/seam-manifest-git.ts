import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

/** sha256 of each path's content at `upstreamSha`, via `git show`, keyed by path in sorted order. */
export function hashFilesAtGitSha(
  label: string,
  repoRoot: string,
  upstreamSha: string,
  relPaths: readonly string[],
): Record<string, string> {
  const files: Record<string, string> = {};
  for (const relPath of relPaths) {
    let content: Buffer;
    try {
      content = execFileSync('git', ['show', `${upstreamSha}:${relPath}`], {
        cwd: repoRoot,
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (err) {
      throw new Error(
        `${label}: ${relPath} not found at upstream ${upstreamSha} (git show failed): ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    }
    files[relPath] = createHash('sha256').update(content).digest('hex');
  }
  return Object.fromEntries(
    Object.keys(files)
      .sort()
      .map((key) => [key, files[key]]),
  );
}
