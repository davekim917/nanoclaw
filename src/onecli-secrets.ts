/**
 * Per-group OneCLI secret scoping: `container.json`'s `onecliSecrets` (names or UUIDs) is resolved and the agent's
 * grants reconciled to exactly that set on every spawn. Fail-closed: an unresolvable name throws.
 *
 * Uses the gateway API directly: the SDK has no list/grant operations, and the CLI's list output caps at 20 rows
 * with no pagination.
 */
import { execFile } from 'child_process';

import { ONECLI_URL } from './config.js';
import { log } from './log.js';
import { onecliAuthConfigLine, sanitizeCurlFailure } from './onecli-curl.js';

interface OnecliAgent {
  id: string;
  identifier: string;
  name: string;
  secretMode?: string;
}

interface OnecliSecret {
  id: string;
  name: string;
  /** Where the gateway injects it; present on the list API's rows. */
  hostPattern?: string | null;
  pathPattern?: string | null;
}

interface OnecliAgentSecretGrant {
  secretId: string;
}

interface OnecliAgentGrants {
  agentId: string;
  mode: 'grants';
  connections: unknown[];
  secrets: OnecliAgentSecretGrant[];
}

export interface EnsureOnecliAgentInput {
  name: string;
  identifier: string;
}

export interface EnsureOnecliAgentResult extends EnsureOnecliAgentInput {
  created: boolean;
}

/** Agent identifier → UUID for the host's lifetime; a miss refreshes. */
const identifierToUuid = new Map<string, string>();

/** Anything not UUID-shaped is a secret NAME needing lookup. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURL_TIMEOUT_ARGS = ['--connect-timeout', '2', '--max-time', '10'] as const;

function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/**
 * Promise-wrapped `execFile('curl', …)` so gateway round trips never block the event loop; `-f` keeps non-2xx a
 * rejection. Not `fetch`: host `fetch` must never traverse the OneCLI gateway proxy.
 *
 * Neither the API key nor execFile's error (whose message embeds the whole argv) may reach argv or a log: the key
 * goes on stdin as a curl config (`-K -`), and failures are rethrown as a sanitized `OnecliCurlError`. The cost is
 * that every non-2xx reads as curl exit 22, not its status.
 */
function curl(args: string[], label: string): Promise<string> {
  const auth = onecliAuthConfigLine();
  return new Promise((resolve, reject) => {
    const child = execFile('curl', auth ? ['-K', '-', ...args] : args, { encoding: 'utf-8' }, (error, stdout) => {
      if (error) {
        reject(sanitizeCurlFailure(label, error));
        return;
      }
      resolve(typeof stdout === 'string' ? stdout : String(stdout));
    });
    if (auth) {
      // An unhandled stream 'error' is an uncaught exception; the execFile callback reports the failure anyway.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(auth);
    }
  });
}

/**
 * Vault secrets listing cache. A cached MISS is never final (`resolveSecretUuids` force-refreshes before
 * throwing). A cached HIT lasts the TTL: a renamed secret keeps resolving under its old name to the same UUID
 * until expiry. Nothing widens.
 */
const SECRETS_CACHE_TTL_MS = 60 * 1000;
let secretsCache: { at: number; secrets: OnecliSecret[] } | null = null;

/**
 * One shared in-flight listing per resource: a host restart wakes many groups with different identities at once,
 * and parallel `?limit=10000` listings can hit the curl timeout. A rejection fails every waiter and clears the
 * entry, so no caller proceeds on a listing that did not arrive.
 */
const inFlightListings = new Map<'agents' | 'secrets', Promise<unknown[]>>();

function listViaApiOnce(resource: 'agents' | 'secrets'): Promise<unknown[]> {
  const existing = inFlightListings.get(resource);
  if (existing) return existing;
  const tracked = listViaApi(resource).finally(() => {
    if (inFlightListings.get(resource) === tracked) inFlightListings.delete(resource);
  });
  inFlightListings.set(resource, tracked);
  return tracked;
}

/**
 * Serializes the read-modify-write grant reconcile per identity: two concurrent spawns with different
 * declarations could otherwise each write the union of both sets.
 */
const identityLocks = new Map<string, Promise<unknown>>();

async function withIdentityLock<T>(identity: string, fn: () => Promise<T>): Promise<T> {
  const previous = identityLocks.get(identity) ?? Promise.resolve();
  // Run whether the predecessor settled or threw, so one failure cannot wedge the next spawn.
  const run = previous.then(fn, fn);
  const guarded = run.then(
    () => undefined,
    () => undefined,
  );
  identityLocks.set(identity, guarded);
  try {
    return await run;
  } finally {
    // Drop only when nothing queued behind us.
    if (identityLocks.get(identity) === guarded) identityLocks.delete(identity);
  }
}

/** Full agents/secrets list from the gateway API (the CLI silently truncates at 20 rows, failing lookups closed). */
async function listViaApi(resource: 'agents' | 'secrets'): Promise<unknown[]> {
  const base = (ONECLI_URL || 'http://127.0.0.1:10254').replace(/\/$/, '');
  const args = ['-fsS', ...CURL_TIMEOUT_ARGS, `${base}/api/${resource}?limit=10000`];
  const out = await curl(args, `GET /api/${resource}`);
  const parsed = JSON.parse(out) as unknown;
  if (Array.isArray(parsed)) return parsed;
  const data = (parsed as { data?: unknown }).data;
  return Array.isArray(data) ? data : [];
}

/** `curl -f`: every non-2xx rejects. Only UUIDs travel in URLs, never secret values. */
async function requestViaApi(method: 'GET' | 'PUT' | 'DELETE', path: string): Promise<unknown> {
  const base = (ONECLI_URL || 'http://127.0.0.1:10254').replace(/\/$/, '');
  const args = ['-fsS', ...CURL_TIMEOUT_ARGS, '-X', method];
  args.push(`${base}/api/${path.replace(/^\//, '')}`);
  const out = await curl(args, `${method} /api/${path.replace(/^\//, '')}`);
  return out.trim() ? (JSON.parse(out) as unknown) : undefined;
}

/** Keeps the HTTP status so callers can tell a create-race 409 from every other failure. */
async function createAgentViaApi(input: EnsureOnecliAgentInput): Promise<{ status: number; body: unknown }> {
  const base = (ONECLI_URL || 'http://127.0.0.1:10254').replace(/\/$/, '');
  const args = ['-sS', ...CURL_TIMEOUT_ARGS, '-X', 'POST', '-H', 'Content-Type: application/json'];
  args.push('--data-binary', JSON.stringify(input), '-w', '\n%{http_code}', `${base}/v1/agents`);

  const out = await curl(args, 'POST /v1/agents');
  const statusSeparator = out.lastIndexOf('\n');
  if (statusSeparator < 0) {
    throw new Error('Malformed OneCLI agent create response: missing HTTP status');
  }
  const status = Number(out.slice(statusSeparator + 1).trim());
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error('Malformed OneCLI agent create response: invalid HTTP status');
  }

  const bodyText = out.slice(0, statusSeparator).trim();
  let body: unknown;
  if (bodyText) {
    try {
      body = JSON.parse(bodyText) as unknown;
    } catch (error) {
      throw new Error(`Malformed OneCLI agent create response body (HTTP ${status})`, { cause: error });
    }
  }
  return { status, body };
}

async function getAgentGrants(agentUuid: string): Promise<OnecliAgentGrants> {
  const parsed = await requestViaApi('GET', `agents/${encodeURIComponent(agentUuid)}/grants`);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Malformed OneCLI grants response for agent ${agentUuid}`);
  }

  const grants = parsed as Partial<OnecliAgentGrants>;
  if (
    grants.agentId !== agentUuid ||
    grants.mode !== 'grants' ||
    !Array.isArray(grants.connections) ||
    !Array.isArray(grants.secrets) ||
    !grants.secrets.every(
      (secret) =>
        secret !== null &&
        typeof secret === 'object' &&
        typeof (secret as Partial<OnecliAgentSecretGrant>).secretId === 'string' &&
        isUuid((secret as OnecliAgentSecretGrant).secretId),
    )
  ) {
    throw new Error(`Malformed OneCLI grants response for agent ${agentUuid}`);
  }

  return grants as OnecliAgentGrants;
}

async function listAgents(force = false): Promise<OnecliAgent[]> {
  return (await (force ? listViaApi('agents') : listViaApiOnce('agents'))) as OnecliAgent[];
}

/** `fromCache` tells the caller whether a miss is worth re-checking before failing the spawn. */
async function loadSecrets(forceRefresh: boolean): Promise<{ secrets: OnecliSecret[]; fromCache: boolean }> {
  if (!forceRefresh && secretsCache && Date.now() - secretsCache.at < SECRETS_CACHE_TTL_MS) {
    return { secrets: secretsCache.secrets, fromCache: true };
  }
  // A forced refresh must NOT join an in-flight listing: one that began before the question could predate the
  // secret and manufacture the refusal this refresh exists to prevent.
  const secrets = (await (forceRefresh ? listViaApi('secrets') : listViaApiOnce('secrets'))) as OnecliSecret[];
  secretsCache = { at: Date.now(), secrets };
  return { secrets, fromCache: false };
}

/** `force` skips the shared listing: after a 409, only a listing that began after the create contains the agent. */
async function refreshAgentCache(options?: { force?: boolean }): Promise<void> {
  const agents = await listAgents(options?.force ?? false);
  const refreshed = new Map<string, string>();
  for (const agent of agents) {
    if (
      !agent ||
      typeof agent !== 'object' ||
      typeof agent.identifier !== 'string' ||
      !agent.identifier ||
      typeof agent.id !== 'string' ||
      !isUuid(agent.id)
    ) {
      throw new Error('Malformed OneCLI agents list response');
    }
    refreshed.set(agent.identifier, agent.id);
  }
  identifierToUuid.clear();
  for (const [identifier, uuid] of refreshed) identifierToUuid.set(identifier, uuid);
}

/** Refreshes on a miss; throws (fail-closed) when the identifier is still absent. */
async function resolveAgentUuid(identifier: string): Promise<string> {
  const cached = identifierToUuid.get(identifier);
  if (cached) return cached;

  // Replace the whole map so renamed/deleted agents are evicted.
  await refreshAgentCache();
  const refreshed = identifierToUuid.get(identifier);
  if (!refreshed) {
    throw new Error(
      `OneCLI agent with identifier "${identifier}" not found in vault — refusing to spawn without scoped credentials`,
    );
  }
  return refreshed;
}

/**
 * Create the agent only when a fresh list lacks it. A 409 counts as success only after a fresh list confirms the
 * agent; every other response fails closed. Serialized per identity.
 */
export function ensureOnecliAgent(input: EnsureOnecliAgentInput): Promise<EnsureOnecliAgentResult> {
  return withIdentityLock(input.identifier, () => ensureOnecliAgentLocked(input));
}

async function ensureOnecliAgentLocked(input: EnsureOnecliAgentInput): Promise<EnsureOnecliAgentResult> {
  if (identifierToUuid.has(input.identifier)) return { ...input, created: false };

  await refreshAgentCache();
  if (identifierToUuid.has(input.identifier)) return { ...input, created: false };

  const response = await createAgentViaApi(input);
  if (response.status === 409) {
    await refreshAgentCache({ force: true });
    if (!identifierToUuid.has(input.identifier)) {
      throw new Error(
        `OneCLI agent create returned HTTP 409 but identifier "${input.identifier}" was not found after refresh`,
      );
    }
    return { ...input, created: false };
  }
  if (response.status !== 201) {
    throw new Error(`OneCLI agent create failed with HTTP ${response.status}`);
  }

  const created = response.body as Partial<OnecliAgent> | undefined;
  if (!created || created.identifier !== input.identifier || typeof created.id !== 'string' || !isUuid(created.id)) {
    throw new Error(`Malformed OneCLI agent create response for identifier "${input.identifier}"`);
  }
  identifierToUuid.set(input.identifier, created.id);
  return { ...input, created: true };
}

/** Names (case-sensitive) or UUIDs (presence-checked) → UUIDs. Any unresolved declaration throws. */
export async function resolveSecretUuids(declarations: string[]): Promise<string[]> {
  if (declarations.length === 0) return [];

  const first = await loadSecrets(false);
  let match = matchDeclarations(first.secrets, declarations);

  // A miss against the cache may be a newly added secret: re-read before refusing.
  if (match.unresolved.length > 0 && first.fromCache) {
    const fresh = await loadSecrets(true);
    match = matchDeclarations(fresh.secrets, declarations);
  }

  if (match.unresolved.length > 0) {
    throw new Error(
      `OneCLI secret(s) not found in vault: ${match.unresolved.join(', ')} — ` +
        `check spelling, that the secret exists, and that 'onecli secrets list' returns it`,
    );
  }

  return match.resolved;
}

function matchDeclarations(
  secrets: OnecliSecret[],
  declarations: string[],
): { resolved: string[]; unresolved: string[] } {
  const nameToId = new Map(secrets.map((s) => [s.name, s.id] as const));
  const idSet = new Set(secrets.map((s) => s.id));

  const resolved: string[] = [];
  const unresolved: string[] = [];

  for (const decl of declarations) {
    if (isUuid(decl)) {
      if (idSet.has(decl)) {
        resolved.push(decl);
      } else {
        unresolved.push(decl);
      }
      continue;
    }
    const id = nameToId.get(decl);
    if (id) {
      resolved.push(id);
    } else {
      unresolved.push(decl);
    }
  }

  return { resolved, unresolved };
}

/**
 * Reconcile the agent's secret grants to `declarations` (no-op when empty). Spawn callers MUST await it (tripwire
 * in `onecli-secrets.test.ts`). Connection grants are left untouched.
 */
export function applyOnecliSecrets(agentIdentifier: string, declarations: string[] | undefined): Promise<void> {
  if (!declarations || declarations.length === 0) return Promise.resolve();
  return withIdentityLock(agentIdentifier, () => applyOnecliSecretsLocked(agentIdentifier, declarations));
}

async function applyOnecliSecretsLocked(agentIdentifier: string, declarations: string[]): Promise<void> {
  const agentUuid = await resolveAgentUuid(agentIdentifier);
  const secretUuids = await resolveSecretUuids(declarations);
  const grants = await getAgentGrants(agentUuid);
  const declaredSet = new Set(secretUuids);
  const grantedSet = new Set(grants.secrets.map((secret) => secret.secretId));
  const toRemove = [...grantedSet].filter((secretUuid) => !declaredSet.has(secretUuid));
  const toAdd = [...declaredSet].filter((secretUuid) => !grantedSet.has(secretUuid));

  // Remove before adding: a failed request aborts the spawn instead of leaving a broadened partial state.
  for (const secretUuid of toRemove) {
    await requestViaApi(
      'DELETE',
      `agents/${encodeURIComponent(agentUuid)}/grants/secrets/${encodeURIComponent(secretUuid)}`,
    );
  }
  for (const secretUuid of toAdd) {
    await requestViaApi(
      'PUT',
      `agents/${encodeURIComponent(agentUuid)}/grants/secrets/${encodeURIComponent(secretUuid)}`,
    );
  }

  log.info('OneCLI secrets applied', {
    agentIdentifier,
    agentUuid,
    declared: declarations.length,
    resolved: secretUuids.length,
    added: toAdd.length,
    removed: toRemove.length,
  });
}

/** Workgroup secrets first, then per-group additions. Union only: neither list can subtract from the other. */
export function mergeWorkgroupAndGroupSecrets(
  workgroupSecrets: string[] | undefined,
  groupSecrets: string[] | undefined,
): string[] {
  const set = new Set<string>();
  const ordered: string[] = [];
  for (const s of workgroupSecrets ?? []) {
    if (!set.has(s)) {
      set.add(s);
      ordered.push(s);
    }
  }
  for (const s of groupSecrets ?? []) {
    if (!set.has(s)) {
      set.add(s);
      ordered.push(s);
    }
  }
  return ordered;
}

/**
 * The OneCLI secrets granting Slack USER-token access (the owner's DMs), withheld from sessions that are not
 * owner-safe (`isOwnerSafeSlackSession`). `explicitNames` is authoritative when given (case-insensitive
 * intersection); otherwise names containing both "slack" and "user", which excludes bot tokens. Returns names as
 * spelled in `secrets`.
 */
export function slackUserTokenSecrets(secrets: string[], explicitNames?: string[]): string[] {
  if (explicitNames && explicitNames.length > 0) {
    const wanted = new Set(explicitNames.map((n) => n.toLowerCase()));
    return secrets.filter((s) => wanted.has(s.toLowerCase()));
  }
  return secrets.filter((s) => {
    const lower = s.toLowerCase();
    return lower.includes('slack') && lower.includes('user');
  });
}

/**
 * Declared secrets injected into direct REST calls (not `mcp.*` hosts or `/mcp` paths), with the host they apply
 * to. Per-turn path, so it never blocks: reads the spawn cache and refreshes a stale one in the background; a cold
 * or failed cache yields [].
 */
export function gatewayRestHosts(declarations: string[]): Array<{ name: string; host: string }> {
  if (declarations.length === 0) return [];
  if (!secretsCache || Date.now() - secretsCache.at >= SECRETS_CACHE_TTL_MS) {
    void loadSecrets(false).catch(() => undefined);
  }
  // Cached rows are unvalidated; skip malformed ones rather than throw on the per-turn path.
  const secrets = (Array.isArray(secretsCache?.secrets) ? secretsCache.secrets : []).filter(
    (secret): secret is OnecliSecret =>
      typeof secret === 'object' && secret !== null && typeof secret.id === 'string' && typeof secret.name === 'string',
  );
  const byName = new Map(secrets.map((secret) => [secret.name, secret] as const));
  const byId = new Map(secrets.map((secret) => [secret.id, secret] as const));
  const out: Array<{ name: string; host: string }> = [];
  for (const decl of declarations) {
    const secret = isUuid(decl) ? byId.get(decl) : byName.get(decl);
    const host = typeof secret?.hostPattern === 'string' ? secret.hostPattern.trim() : '';
    if (!secret || !host) continue;
    const path = typeof secret.pathPattern === 'string' ? secret.pathPattern : '';
    if (/^mcp[.-]/i.test(host) || /(^|\/)mcp(\/|$)/i.test(path)) continue;
    out.push({ name: secret.name, host });
  }
  return out;
}

const TYPESAFE_HOST = 'api.typesafe.ai';

/**
 * Placeholder `TYPESAFE_API_KEY` for a Claude container granted `api.typesafe.ai` (the real key is injected at the
 * proxy; the fast-jev-compaction plugin only refuses an empty one). Gated on the grant, which is the clearance to
 * send that group's text to TypeSafe. Reads the cache `applyOnecliSecrets` just warmed; cold yields no key.
 */
export function typesafeKeyPlaceholderEnv(provider: string, grantedSecrets: string[]): string[] {
  if (provider !== 'claude') return [];
  if (!gatewayRestHosts(grantedSecrets).some((h) => h.host === TYPESAFE_HOST)) return [];
  return ['-e', 'TYPESAFE_API_KEY=onecli-gateway-injected'];
}

export function __setSecretsCacheForTest(secrets: OnecliSecret[]): void {
  secretsCache = { at: Date.now(), secrets };
}

export function __resetCachesForTest(): void {
  identifierToUuid.clear();
  secretsCache = null;
  identityLocks.clear();
  inFlightListings.clear();
}

export const __test = { isUuid, resolveAgentUuid };
