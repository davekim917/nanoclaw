/**
 * The opt-in loopback half of the login: a one-shot listener on 127.0.0.1 that
 * catches the authorization redirect through an operator's
 * `ssh -L 8765:127.0.0.1:8765` tunnel. Without the tunnel the paste path
 * finishes the login, so a port that will not bind is only a warning. Binds
 * `127.0.0.1` explicitly, never `0.0.0.0`, and closes on the first code or the deadline.
 */
import http from 'http';
import os from 'os';

interface LoopbackCapture {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

export interface LoopbackListener {
  port: number;
  /** Resolves on the first redirect, or rejects when the deadline passes. */
  captured: Promise<LoopbackCapture>;
  close(): void;
}

/**
 * `error` and `error_description` come off the redirect query string, i.e.
 * from anyone who can point the operator's browser at this port. Unescaped,
 * they would run script on a page with same-origin access to this port.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
  `<body style="font:16px/1.5 system-ui;margin:4rem auto;max-width:34rem"><h1>${escapeHtml(title)}</h1>` +
  `<p>${escapeHtml(body)}</p></body>`;

/** Start the listener. A bind failure means "paste-only", not a failed login. */
export function startLoopbackListener(port: number, deadlineMs: number): Promise<LoopbackListener> {
  return new Promise((resolve, reject) => {
    let settle: ((c: LoopbackCapture) => void) | undefined;
    let fail: ((e: Error) => void) | undefined;
    const captured = new Promise<LoopbackCapture>((res, rej) => {
      settle = res;
      fail = rej;
    });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const capture: LoopbackCapture = {
        code: url.searchParams.get('code') ?? undefined,
        state: url.searchParams.get('state') ?? undefined,
        error: url.searchParams.get('error') ?? undefined,
        errorDescription: url.searchParams.get('error_description') ?? undefined,
      };
      // A browser asking for /favicon.ico must not be mistaken for the redirect.
      if (!capture.code && !capture.error) {
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE('Nothing here', 'This port is waiting for an OAuth redirect.'));
        return;
      }
      res.writeHead(capture.error ? 400 : 200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        capture.error
          ? PAGE(
              'Authorization refused',
              `${capture.error}${capture.errorDescription ? ` — ${capture.errorDescription}` : ''}`,
            )
          : PAGE('Connected', 'You can close this tab and go back to your terminal.'),
      );
      settle?.(capture);
      close();
    });

    const timer = setTimeout(() => {
      fail?.(new Error(`No redirect reached 127.0.0.1:${port} within ${Math.round(deadlineMs / 1000)}s`));
      close();
    }, deadlineMs);
    // The daemon must still be able to exit while a login is outstanding.
    timer.unref?.();

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      server.close();
    };

    server.once('error', (err) => {
      clearTimeout(timer);
      // Nothing awaits `captured` yet; a no-op catch avoids an unhandled rejection.
      captured.catch(() => undefined);
      fail?.(err instanceof Error ? err : new Error(String(err)));
      reject(err);
    });

    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const bound = typeof address === 'object' && address ? address.port : port;
      resolve({ port: bound, captured, close });
    });
  });
}

/** The line to paste into a second terminal; `os.hostname()` is a best guess at the operator's name for this host. */
export function sshTunnelCommand(port: number): string {
  const user = os.userInfo().username;
  return `ssh -L ${port}:127.0.0.1:${port} ${user}@${os.hostname()}`;
}
