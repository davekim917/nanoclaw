/**
 * The loopback half of the login: a one-shot HTTP listener on 127.0.0.1 that
 * catches the authorization redirect.
 *
 * THE SSH SHAPE. This host is headless and the operator's browser is on their
 * laptop, so the listener is only reachable through a forwarded port:
 *
 *   ssh -L 8765:127.0.0.1:8765 <user>@<host>
 *
 * With that tunnel up, the browser's redirect to `http://127.0.0.1:8765/…`
 * leaves the laptop, crosses the tunnel, and arrives here — the operator pastes
 * nothing. Without it, their browser fails to connect, the code sits in the
 * address bar, and `ncl integrations complete --redirect-url` takes it. Both
 * paths end in the same exchange; the tunnel is a convenience, never a
 * requirement, which is why a port that will not bind degrades to a warning
 * rather than failing the login.
 *
 * ONE SHOT, AND ONLY LOOPBACK. The server binds `127.0.0.1` explicitly — never
 * `0.0.0.0` — so nothing off this host can reach it even for the minutes it is
 * up, and it closes as soon as it has a code or the deadline passes.
 */
import http from 'http';
import os from 'os';

export interface LoopbackCapture {
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

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px/1.5 system-ui;margin:4rem auto;max-width:34rem"><h1>${title}</h1><p>${body}</p></body>`;

/**
 * Start the listener. Rejects if the port cannot be bound — the caller treats
 * that as "paste-only", not as a failed login.
 */
export function startLoopbackListener(port: number, deadlineMs: number): Promise<LoopbackListener> {
  return new Promise((resolve, reject) => {
    let settle: ((c: LoopbackCapture) => void) | undefined;
    let fail: ((e: Error) => void) | undefined;
    const captured = new Promise<LoopbackCapture>((res, rej) => {
      settle = res;
      fail = rej;
    });

    const server = http.createServer((req, res) => {
      // `req.url` is a path-relative URL; the base is only there to parse it.
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
      // Nothing is awaiting `captured` yet at this point; attach a no-op so an
      // unhandled rejection cannot be raised against a promise the caller never
      // received.
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

/**
 * The exact line to paste into a second terminal, with this host's best guess
 * at its own name. `<host>` is what the operator's ssh config calls this
 * machine, which nothing here can know for certain — `os.hostname()` is the
 * closest honest answer and is usually right.
 */
export function sshTunnelCommand(port: number): string {
  const user = os.userInfo().username;
  return `ssh -L ${port}:127.0.0.1:${port} ${user}@${os.hostname()}`;
}
