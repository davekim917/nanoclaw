/**
 * Shared OneCLI `curl` plumbing: the gateway key travels on STDIN as a curl config (never argv, which is visible in
 * `/proc/<pid>/cmdline`), and every failure becomes an OnecliCurlError carrying nothing from argv, stderr or the
 * body (Node's execFile error message embeds the whole argv). `curl`, not `fetch`: host `fetch` must never traverse
 * the gateway proxy.
 */
import { ONECLI_API_KEY } from './config.js';

/**
 * Escape for a double-quoted curl config value: backslash FIRST, then quote, or the quote pass's backslashes get
 * escaped twice. JSON bodies survive (JSON.stringify emits no literal newline).
 */
export function curlConfigEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** The `Authorization` curl config line, or undefined when no key is configured; a function so config stubs apply. */
export function onecliAuthConfigLine(): string | undefined {
  return ONECLI_API_KEY ? `header = "Authorization: Bearer ${curlConfigEscape(ONECLI_API_KEY)}"\n` : undefined;
}

const CURL_EXIT_MEANINGS: Record<number, string> = {
  3: 'malformed URL',
  6: 'could not resolve host',
  7: 'could not connect',
  22: 'HTTP error response',
  28: 'timed out',
  35: 'TLS handshake failed',
  52: 'empty reply from server',
  56: 'failure receiving data',
};

/** `label` is the operation (`GET /api/secrets`), never a URL with query parameters or anything from argv. */
export class OnecliCurlError extends Error {
  constructor(
    readonly label: string,
    readonly detail: string,
  ) {
    super(`OneCLI ${label} failed: ${detail}`);
    this.name = 'OnecliCurlError';
  }
}

/**
 * Reads ONLY `code` and `signal`: `message` and `stderr` are never consulted (not reading beats scrubbing), and
 * `cause` is dropped because loggers print it and this error lands in a DB column `ncl integrations list` shows.
 */
export function sanitizeCurlFailure(label: string, error: unknown): OnecliCurlError {
  const e = (error ?? {}) as { code?: unknown; signal?: unknown };
  if (typeof e.signal === 'string' && e.signal) return new OnecliCurlError(label, `curl killed by ${e.signal}`);
  if (typeof e.code === 'number') {
    const meaning = CURL_EXIT_MEANINGS[e.code];
    return new OnecliCurlError(label, `curl exit code ${e.code}${meaning ? ` (${meaning})` : ''}`);
  }
  // A string `code` is Node's own (ENOENT, EPIPE): a fixed identifier, not text.
  if (typeof e.code === 'string' && e.code) return new OnecliCurlError(label, `curl could not be run (${e.code})`);
  return new OnecliCurlError(label, 'curl failed');
}
