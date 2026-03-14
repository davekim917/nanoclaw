import { execFile } from 'child_process';

/**
 * Call Haiku via the Claude CLI for lightweight tasks (thread titles,
 * topic classification, search reranking). Uses the host's Claude Code
 * auth (OAuth/Max subscription) so no separate API key is needed.
 *
 * --no-session-persistence is required: multiple concurrent callers
 * (thread naming, reranking, classification) would race on session state
 * without it.
 */
export function callHaiku(prompt: string, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const stderrChunks: Buffer[] = [];
    const proc = execFile(
      'claude',
      ['-p', '--model', 'haiku', '--no-session-persistence'],
      { timeout: timeoutMs },
      (err, stdout) => {
        if (err) {
          const stderr = Buffer.concat(stderrChunks).toString().trim();
          if (stderr) (err as Error & { stderr?: string }).stderr = stderr;
          return reject(err);
        }
        resolve(stdout.trim());
      },
    );
    proc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    proc.stdin?.write(prompt);
    proc.stdin?.end();
  });
}
