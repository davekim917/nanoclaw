/**
 * The two things every OneCLI `curl` call has to get right, in one place.
 *
 * WHY THIS EXISTS. Two modules shell out to `curl` against the gateway API
 * (`src/onecli-secrets.ts` and `src/modules/mcp-oauth/onecli-secret-writer.ts`),
 * and both used to do the same two unsafe things:
 *
 *   1. `-H "Authorization: Bearer ${ONECLI_API_KEY}"` in ARGV, which puts the
 *      gateway's master key in `/proc/<pid>/cmdline` for the life of the call.
 *   2. Rethrow `execFile`'s error verbatim. Node builds that error's `.message`
 *      as `Command failed: <the whole argv>\n<stderr>` — so the key in (1) came
 *      back out through every sink the caller had. For the MCP OAuth refresher
 *      those sinks are `mcp_oauth_integrations.status_detail` (a DB column
 *      rendered verbatim by `ncl integrations list/get`) and a `log.warn`.
 *
 * So: the key travels on STDIN as a curl config file, and every failure is
 * rethrown as an {@link OnecliCurlError} naming only the operation label and
 * how curl died. Nothing derived from argv, stderr or the response body is ever
 * put in an error message here.
 *
 * `curl` rather than `fetch` is not negotiable on this path: host `fetch` must
 * never traverse the gateway proxy (`src/onecli-secrets.ts`).
 */
import { ONECLI_API_KEY } from './config.js';

/**
 * Escape a value for a double-quoted curl config parameter.
 *
 * curl's config parser understands `\\`, `\"`, `\t`, `\n`, `\r`, `\v` inside a
 * quoted value, so backslash and quote are the two characters that must be
 * doubled — and backslash FIRST, or the backslashes introduced by the quote
 * pass would be escaped a second time.
 *
 * A JSON body is safe to pass through this: `JSON.stringify` never emits a
 * literal newline, and the two-character `\n` it does emit survives because
 * this turns it into `\\n`, which the parser hands back as `\n`. Verified
 * against curl 8.5.0 with a body containing both a quote and a backslash.
 */
export function curlConfigEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * The `Authorization` header as a curl config line, or undefined when no key is
 * configured (in which case the caller must not pass `-K -` at all — a curl
 * that is told to read a config from stdin and gets nothing is fine, but the
 * extra plumbing buys nothing).
 *
 * Read through a function rather than a constant so a test that stubs
 * `config.js` sees its stub.
 */
export function onecliAuthConfigLine(): string | undefined {
  return ONECLI_API_KEY ? `header = "Authorization: Bearer ${curlConfigEscape(ONECLI_API_KEY)}"\n` : undefined;
}

/** Common curl exit codes, so a sanitized error is still diagnosable. */
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

/**
 * The error every OneCLI curl failure becomes.
 *
 * `label` is the operation (`GET /api/secrets`), never a URL with query
 * parameters and never anything the process was invoked with.
 */
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
 * Turn whatever `execFile` handed back into a message that carries no argv.
 *
 * Deliberately reads ONLY `code` and `signal`. `message` and `stderr` are not
 * consulted at all — not summarized, not truncated, not regex-scrubbed. A
 * scrubber is a list of things someone remembered; not reading the field is a
 * guarantee.
 *
 * `cause` is dropped for the same reason: `JSON.stringify` skips it, but
 * structured loggers and `util.inspect` do not, and this error is written to a
 * DB column that `ncl integrations list` prints.
 */
export function sanitizeCurlFailure(label: string, error: unknown): OnecliCurlError {
  const e = (error ?? {}) as { code?: unknown; signal?: unknown };
  if (typeof e.signal === 'string' && e.signal) return new OnecliCurlError(label, `curl killed by ${e.signal}`);
  if (typeof e.code === 'number') {
    const meaning = CURL_EXIT_MEANINGS[e.code];
    return new OnecliCurlError(label, `curl exit code ${e.code}${meaning ? ` (${meaning})` : ''}`);
  }
  // A string `code` here is Node's own (ENOENT when curl is not installed,
  // EPIPE when it died before reading stdin) — a fixed identifier, not text.
  if (typeof e.code === 'string' && e.code) return new OnecliCurlError(label, `curl could not be run (${e.code})`);
  return new OnecliCurlError(label, 'curl failed');
}
