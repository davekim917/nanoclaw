/**
 * Lightweight Haiku calls for host-side utility tasks (thread titles,
 * topic classification, search reranking).
 *
 * Uses the host's Claude CLI (`claude -p --model haiku`). This is the
 * same binary you use interactively; auth goes through the host's
 * OneCLI-configured credentials. Per-session persistence is disabled
 * so concurrent callers (e.g. two thread-title gens racing) don't
 * stomp on each other's session state.
 *
 * Ported from v1's src/llm.ts. Kept the subprocess approach rather
 * than calling the Anthropic SDK directly — means we don't need an
 * additional dependency and OneCLI's proxy handles auth transparently
 * via the host's shell env. If v2's host ever runs in a pure-server
 * context without a local `claude` binary, swap this for a direct
 * SDK call.
 */
import { execFile } from 'child_process';

export function callHaiku(prompt: string, timeoutMs = 15_000): Promise<string> {
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
        resolve(stdout.toString().trim());
      },
    );
    proc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    proc.stdin?.write(prompt);
    proc.stdin?.end();
  });
}
