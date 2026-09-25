/**
 * Browser-open helper for channel setup flows.
 *
 * `openUrl` is best-effort — silent on failure, so headless/SSH/WSL
 * environments where `open`/`xdg-open` isn't wired up don't crash the
 * setup. The URL should always be visible in the clack note that calls
 * this so the user can copy-paste if the auto-open doesn't land.
 */
import { spawn } from 'child_process';

/** Best-effort open of a URL in the user's default browser. Silent on failure. */
export function openUrl(url: string): void {
  try {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {
      // Headless / no browser / unknown command — URL is printed in the
      // calling note so the user can copy-paste.
    });
    child.unref();
  } catch {
    // swallow — URL is visible in the note.
  }
}
