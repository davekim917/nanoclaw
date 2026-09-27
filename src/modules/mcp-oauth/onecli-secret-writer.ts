/**
 * The write side of the OneCLI vault. Verified against onecli@1.4.1:
 *
 *   POST   /api/secrets            → 201 `{id, name, …, preview}`
 *   PATCH  /api/secrets/{id}       → 200; a body with only `value` leaves
 *                                    hostPattern, pathPattern and
 *                                    injectionConfig untouched
 *   DELETE /api/secrets/{id}       → 204
 *   PUT    /api/secrets/{id}       → 404
 *
 * Not the `onecli secrets update` CLI: the value would sit in the process
 * table. `curl` rather than `fetch`: host `fetch` must never traverse the
 * gateway proxy. Nothing reads a value back — the API has no such route.
 */
import { execFile } from 'child_process';

import { ONECLI_URL } from '../../config.js';
import { curlConfigEscape, onecliAuthConfigLine, sanitizeCurlFailure } from '../../onecli-curl.js';

const CURL_CONNECT_TIMEOUT_SECONDS = 2;
const CURL_MAX_TIME_SECONDS = 10;

export interface OnecliSecretRef {
  id: string;
  name: string;
}

export interface OnecliInjectionSpec {
  name: string;
  hostPattern: string;
  pathPattern?: string | null;
  headerName: string;
  /** `{value}` is substituted by the gateway. */
  valueFormat: string;
}

function base(): string {
  return (ONECLI_URL || 'http://127.0.0.1:10254').replace(/\/$/, '');
}

/**
 * The whole request as a curl CONFIG FILE on stdin (`curl -K -`). NOTHING
 * SENSITIVE IS IN ARGV: `/proc/<pid>/cmdline` is world-readable, and Node puts
 * the full argv in an `execFile` error's message, which callers write to the DB
 * and logs. The body is in the config too, since only one of `-K -` and
 * `--data-binary @-` can have stdin.
 */
function curlConfig(method: 'POST' | 'PATCH' | 'DELETE' | 'GET', url: string, body?: unknown): string {
  const lines = [
    '--silent',
    '--show-error',
    `--connect-timeout ${CURL_CONNECT_TIMEOUT_SECONDS}`,
    `--max-time ${CURL_MAX_TIME_SECONDS}`,
    `--request ${method}`,
    `--url "${curlConfigEscape(url)}"`,
  ];
  const auth = onecliAuthConfigLine();
  if (auth) lines.push(auth.trimEnd());
  if (body !== undefined) {
    lines.push('--header "Content-Type: application/json"');
    lines.push(`--data-binary "${curlConfigEscape(JSON.stringify(body))}"`);
  }
  lines.push('--write-out "\\n%{http_code}"');
  return `${lines.join('\n')}\n`;
}

/**
 * No `-f`: the caller needs the status code (appended by `-w`) to tell a
 * conflict from a failure. The response body is never logged — a create
 * response carries a masked `preview` of the value.
 */
function curlJson(
  method: 'POST' | 'PATCH' | 'DELETE' | 'GET',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const label = `${method} /api/${path.replace(/^\//, '')}`;
  const config = curlConfig(method, `${base()}/api/${path.replace(/^\//, '')}`, body);

  return new Promise((resolve, reject) => {
    const child = execFile('curl', ['-K', '-'], { encoding: 'utf-8' }, (error, stdout) => {
      if (error) {
        // Sanitized: never `error.message`, which is `Command failed: <argv>`.
        reject(sanitizeCurlFailure(label, error));
        return;
      }
      const out = typeof stdout === 'string' ? stdout : String(stdout);
      const sep = out.lastIndexOf('\n');
      if (sep < 0) {
        reject(new Error(`Malformed OneCLI response for ${label}: missing HTTP status`));
        return;
      }
      const status = Number(out.slice(sep + 1).trim());
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        reject(new Error(`Malformed OneCLI response for ${label}: invalid HTTP status`));
        return;
      }
      const text = out.slice(0, sep).trim();
      let parsed: unknown;
      if (text) {
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          parsed = undefined;
        }
      }
      resolve({ status, body: parsed });
    });
    // A curl exiting before reading its config makes this write EPIPE; an
    // unhandled stream 'error' is an uncaught exception.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(config);
  });
}

/** Metadata-only listing — the same route `src/onecli-secrets.ts` reads. */
export async function findOnecliSecretByName(name: string): Promise<OnecliSecretRef | undefined> {
  const { status, body } = await curlJson('GET', 'secrets?limit=10000');
  if (status !== 200) throw new Error(`OneCLI secrets list failed with HTTP ${status}`);
  const rows = Array.isArray(body)
    ? body
    : Array.isArray((body as { data?: unknown })?.data)
      ? (body as { data: unknown[] }).data
      : [];
  for (const row of rows) {
    const r = row as { id?: unknown; name?: unknown };
    if (typeof r.name === 'string' && r.name === name && typeof r.id === 'string') return { id: r.id, name: r.name };
  }
  return undefined;
}

/**
 * Create the bearer secret, or update the value of the one already carrying
 * this name — adopting a hand-made secret the group already declares, rather
 * than leaving the agent granted a dead one. The injection shape is sent only
 * on CREATE, so an adopted secret keeps the matching rule it already serves.
 */
export async function putOnecliBearerSecret(spec: OnecliInjectionSpec, value: string): Promise<OnecliSecretRef> {
  const existing = await findOnecliSecretByName(spec.name);
  if (existing) {
    const { status } = await curlJson('PATCH', `secrets/${encodeURIComponent(existing.id)}`, { value });
    if (status !== 200) throw new Error(`OneCLI secret update failed with HTTP ${status} for "${spec.name}"`);
    return existing;
  }

  const { status, body } = await curlJson('POST', 'secrets', {
    name: spec.name,
    type: 'generic',
    value,
    hostPattern: spec.hostPattern,
    ...(spec.pathPattern ? { pathPattern: spec.pathPattern } : {}),
    injectionConfig: { headerName: spec.headerName, valueFormat: spec.valueFormat },
  });
  if (status !== 201) throw new Error(`OneCLI secret create failed with HTTP ${status} for "${spec.name}"`);
  const created = body as { id?: unknown; name?: unknown };
  if (typeof created.id !== 'string' || typeof created.name !== 'string') {
    throw new Error(`Malformed OneCLI secret create response for "${spec.name}"`);
  }
  return { id: created.id, name: created.name };
}

/** Returns false when the secret was already gone. */
export async function deleteOnecliSecret(id: string): Promise<boolean> {
  const { status } = await curlJson('DELETE', `secrets/${encodeURIComponent(id)}`);
  if (status === 204 || status === 200) return true;
  if (status === 404) return false;
  throw new Error(`OneCLI secret delete failed with HTTP ${status}`);
}
