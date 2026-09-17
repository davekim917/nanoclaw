/**
 * The write side of the OneCLI vault: create a header-injection secret, and
 * replace its value in place.
 *
 * VERIFIED against the live gateway on 2026-09-17 (onecli@1.4.1), because none
 * of it is documented anywhere in this repo:
 *
 *   POST   /api/secrets            → 201 `{id, name, …, preview}`
 *   PATCH  /api/secrets/{id}       → 200 `{"success":true}`; a body carrying
 *                                    only `value` leaves hostPattern,
 *                                    pathPattern and injectionConfig untouched
 *   DELETE /api/secrets/{id}       → 204
 *   PUT    /api/secrets/{id}       → 404 (the CLI's `secrets update` is PATCH)
 *
 * `onecli secrets update --id <uuid> --value <token>` does the same thing, and
 * is NOT used: the value would sit in this host's process table for the life of
 * the call. The gateway API takes it on stdin instead.
 *
 * `curl` rather than `fetch`, for the same reason `src/onecli-secrets.ts:95`
 * gives: host `fetch` must never traverse the gateway proxy.
 *
 * NOTHING HERE READS A VALUE BACK — the API has no such route (see the note in
 * `store.ts`). Callers that need to know what the current token is keep their
 * own copy; this module is fire-and-confirm.
 */
import { execFile } from 'child_process';

import { ONECLI_URL, ONECLI_API_KEY } from '../../config.js';

const CURL_TIMEOUT_ARGS = ['--connect-timeout', '2', '--max-time', '10'] as const;

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
 * Run curl with the request body on STDIN. The body is the only place a token
 * ever appears, and stdin is not visible in `/proc/<pid>/cmdline`.
 *
 * `-f` is deliberately NOT used: the caller needs the status code to tell a
 * 409-style conflict from a real failure, and `-f` collapses every non-2xx into
 * exit code 22. The status is appended by `-w` instead. The response body is
 * returned to the caller but never logged by it — a create response carries a
 * masked `preview` of the value, which is still more than belongs in a log.
 */
function curlJson(
  method: 'POST' | 'PATCH' | 'DELETE' | 'GET',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const args = ['-sS', ...CURL_TIMEOUT_ARGS, '-X', method];
  if (ONECLI_API_KEY) args.push('-H', `Authorization: Bearer ${ONECLI_API_KEY}`);
  if (body !== undefined) {
    args.push('-H', 'Content-Type: application/json', '--data-binary', '@-');
  }
  args.push('-w', '\n%{http_code}', `${base()}/api/${path.replace(/^\//, '')}`);

  return new Promise((resolve, reject) => {
    const child = execFile('curl', args, { encoding: 'utf-8' }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      const out = typeof stdout === 'string' ? stdout : String(stdout);
      const sep = out.lastIndexOf('\n');
      if (sep < 0) {
        reject(new Error(`Malformed OneCLI response for ${method} ${path}: missing HTTP status`));
        return;
      }
      const status = Number(out.slice(sep + 1).trim());
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        reject(new Error(`Malformed OneCLI response for ${method} ${path}: invalid HTTP status`));
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
    if (body !== undefined) {
      child.stdin?.end(JSON.stringify(body));
    }
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
 * this name.
 *
 * Adopting an existing name rather than failing is the whole point: a server
 * that was wired up before this existed already has a hand-made bearer secret,
 * already listed in that group's `container.json`, so a login has to be able to
 * take ownership of it in place. Creating a second secret under a generated name
 * would leave the group's agent still granted the dead one.
 *
 * Injection shape is only sent on CREATE. A PATCH carrying `value` alone leaves
 * hostPattern/pathPattern/injectionConfig as they were (verified above), which
 * is what an adopted secret wants: the operator's existing matching rule is the
 * one the gateway has been using, and silently rewriting it could stop the
 * secret matching the requests it currently serves.
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
