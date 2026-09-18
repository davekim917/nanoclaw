/**
 * Per-group OneCLI secret scoping.
 *
 * Declarative model: each group's `container.json` may carry an
 * `onecliSecrets: string[]` field listing the secrets it should have
 * access to (by NAME or UUID). On every container spawn, the host
 * resolves names → UUIDs and reconciles the agent's OneCLI secret grants
 * so it gets exactly that set — no more, no less.
 *
 * Closes the parity gap surfaced by the earlier audit: previously
 * `ensureAgent` left every new agent in `selective` mode with NOTHING
 * assigned (401 on credentialed calls), and a few operator-flipped
 * `mode all` agents could cross-tenant grab any secret whose host
 * pattern matched the URL — e.g. `helper-codex` hitting example-retail's
 * Atlassian endpoint would attach example-retail's Atlassian secret.
 *
 * Fail-closed: any declared name that doesn't resolve to a vault
 * secret throws — sweep retries and the operator gets a loud signal,
 * matching the codebase's posture throughout (spawn failures, approval
 * errors, etc.).
 *
 * SDK-bypass rationale: the `@onecli-sh/sdk@0.5.0` only exposes
 * `getGatewaySkill`, `getContainerConfig`, `applyContainerConfig`,
 * `createAgent`, `ensureAgent`, `provisionUser`, and
 * `configureManualApproval`. OneCLI v1.44 replaced the legacy agent secret
 * mode/assignment commands with grants, so reads and mutations go straight
 * to the gateway API. List operations also bypass the CLI because its list
 * output caps at 20 rows with no pagination.
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

/**
 * In-memory cache mapping agent identifier → UUID. Cuts the per-spawn
 * `onecli agents list` round-trip down to one for the lifetime of the
 * host process; cache miss triggers a refresh.
 *
 * Cleared by `__resetCachesForTest` so each test gets a clean slate.
 */
const identifierToUuid = new Map<string, string>();

/**
 * UUID format — matches the `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
 * shape OneCLI emits. Anything that doesn't match is treated as a
 * secret NAME requiring lookup.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURL_TIMEOUT_ARGS = ['--connect-timeout', '2', '--max-time', '10'] as const;

function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/**
 * Promise-wrapped `execFile('curl', …)`.
 *
 * The whole point of this module's #315 fix: every gateway round trip yields
 * to the event loop instead of parking it. `curl -f` still turns a non-2xx
 * response into a rejection, so callers keep their fail-closed behavior
 * unchanged — only the blocking changes, not the outcomes.
 *
 * `curl` rather than `fetch`: host `fetch` must never traverse the OneCLI
 * gateway proxy (`NODE_USE_ENV_PROXY` was stripped from the daemon env after
 * it broke every spawn on 2026-09-02), and curl's behavior here is proven.
 *
 * TWO THINGS NEVER CROSS ARGV, and both are why the callers below pass a
 * `label` instead of building their own error text:
 *
 *   - the gateway API key. It goes on stdin as a curl config file
 *     (`-K -`, `src/onecli-curl.ts`), so it is not in `/proc/<pid>/cmdline`.
 *   - `execFile`'s error. Node composes its `.message` as
 *     `Command failed: <the whole argv>`, which is how a key in argv reaches
 *     every log line and DB column a caller writes. Failures are rethrown as a
 *     sanitized `OnecliCurlError` naming the operation and curl's exit code.
 *
 * The cost of (2) is the HTTP status: `-f` collapses every non-2xx into exit
 * 22, so a failure reads "HTTP error response" rather than "500". The gateway's
 * own log has the status; a credential in this host's log does not go away.
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
      // An unhandled 'error' on this stream is an uncaught exception; the
      // execFile callback reports the failure either way.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(auth);
    }
  });
}

/**
 * Cached vault secrets listing.
 *
 * `/api/secrets?limit=10000` used to run on EVERY spawn (the largest single
 * contributor to the #315 stalls).
 *
 * The guarantee is one-directional, and the direction matters:
 *
 *   - A cached MISS is never final. `resolveSecretUuids` force-refreshes and
 *     re-resolves before it throws, so the cache can never turn a name that
 *     exists in the vault into a spawn refusal.
 *   - A cached HIT is only as fresh as the TTL. If an operator RENAMES a vault
 *     secret, a declaration carrying the old name keeps resolving — to that
 *     same secret's unchanged UUID — until the entry expires, and only then
 *     starts failing closed. Revalidating positive hits means re-listing on
 *     every spawn, which is the stall this PR exists to remove; the window is
 *     bounded by the TTL below instead. Nothing widens: the UUID handed back is
 *     the one the operator's own declaration resolved to on the previous spawn.
 *
 * Cleared by `__resetCachesForTest`.
 */
const SECRETS_CACHE_TTL_MS = 60 * 1000;
let secretsCache: { at: number; secrets: OnecliSecret[] } | null = null;

/**
 * One in-flight listing per resource, shared by every caller that arrives
 * while it is running.
 *
 * A host restart wakes many agent groups at once, and the per-identity lock
 * does not serialize them because they hold different identities. Without
 * this, each one sees the same empty cache and starts its own
 * `?limit=10000` listing — with a 24-container admission limit, dozens of
 * heavyweight gateway requests at once, which can hit the 10 s curl ceiling
 * and defer spawns that would otherwise have succeeded.
 *
 * Rejection is shared too, and the entry is cleared either way, so a failed
 * listing fails every waiter that was already committed to it and the next
 * caller retries from scratch. That preserves fail-closed: no caller ever
 * proceeds on a listing that did not arrive.
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
 * Serializes the read-modify-write grant reconcile per OneCLI identity.
 *
 * `execFileSync` used to make resolve → grants-read → mutate atomic with
 * respect to every other spawn for free. Awaiting reintroduces interleaving,
 * and two concurrent spawns of the same identity whose declarations differ
 * (an operator edits `container.json` mid-flight) could each read the same
 * pre-state and write the UNION of both sets — a silently broadened grant
 * list. Chaining per identity restores last-writer-wins.
 */
const identityLocks = new Map<string, Promise<unknown>>();

async function withIdentityLock<T>(identity: string, fn: () => Promise<T>): Promise<T> {
  const previous = identityLocks.get(identity) ?? Promise.resolve();
  // Run regardless of whether the predecessor settled or threw — one spawn's
  // failure must not wedge the next spawn of the same group.
  const run = previous.then(fn, fn);
  const guarded = run.then(
    () => undefined,
    () => undefined,
  );
  identityLocks.set(identity, guarded);
  try {
    return await run;
  } finally {
    // Drop the entry only when nothing queued behind us, so the map does not
    // grow one entry per identity for the life of the host process.
    if (identityLocks.get(identity) === guarded) identityLocks.delete(identity);
  }
}

/**
 * Fetch a FULL list (agents or secrets) from the OneCLI gateway API.
 *
 * Why not `onecli <resource> list`: the CLI hard-caps its output at 20 rows
 * with no pagination flag (verified against the gateway: `--limit` is ignored).
 * Once the vault holds >20 agents/secrets it silently drops the rest, which
 * fail-closes the lookups below for anything past the first page — the bug that
 * took primaries offline after the opencode rollout pushed the agent count to
 * 28. The SDK exposes no list op, so we hit the gateway API directly with a
 * high limit. Localhost gateway (ONECLI_URL), auth'd with the same key the SDK
 * uses; the API returns the full set (a bare array, or `{data:[...]}`).
 *
 * Runs asynchronously (promise-wrapped `execFile`). It used to be
 * `execFileSync`, purely so the resolve/apply call chain could stay sync; that
 * blocked the host event loop for the full round trip on EVERY container spawn
 * (issue #315). `curl` is retained rather than `fetch` because host `fetch`
 * must never traverse the gateway proxy.
 */
async function listViaApi(resource: 'agents' | 'secrets'): Promise<unknown[]> {
  const base = (ONECLI_URL || 'http://127.0.0.1:10254').replace(/\/$/, '');
  const args = ['-fsS', ...CURL_TIMEOUT_ARGS, `${base}/api/${resource}?limit=10000`];
  const out = await curl(args, `GET /api/${resource}`);
  const parsed = JSON.parse(out) as unknown;
  if (Array.isArray(parsed)) return parsed;
  const data = (parsed as { data?: unknown }).data;
  return Array.isArray(data) ? data : [];
}

/**
 * Call the OneCLI gateway. `curl -f` turns every non-2xx response into a
 * rejected promise, preserving the fail-closed spawn behavior. No secret
 * values travel on this path; only agent and secret UUIDs are used in URLs.
 */
async function requestViaApi(method: 'GET' | 'PUT' | 'DELETE', path: string): Promise<unknown> {
  const base = (ONECLI_URL || 'http://127.0.0.1:10254').replace(/\/$/, '');
  const args = ['-fsS', ...CURL_TIMEOUT_ARGS, '-X', method];
  args.push(`${base}/api/${path.replace(/^\//, '')}`);
  const out = await curl(args, `${method} /api/${path.replace(/^\//, '')}`);
  return out.trim() ? (JSON.parse(out) as unknown) : undefined;
}

/**
 * Create an agent through the current versioned API while retaining the HTTP
 * status. A concurrent creator can legitimately win after our list read, so
 * callers must be able to distinguish that 409 from every other failure.
 */
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

/**
 * Read the vault secrets list, serving a fresh-enough cache when one exists.
 * `fromCache` tells the caller whether a miss is worth re-checking against the
 * gateway before failing the spawn.
 */
async function loadSecrets(forceRefresh: boolean): Promise<{ secrets: OnecliSecret[]; fromCache: boolean }> {
  if (!forceRefresh && secretsCache && Date.now() - secretsCache.at < SECRETS_CACHE_TTL_MS) {
    return { secrets: secretsCache.secrets, fromCache: true };
  }
  // A forced refresh deliberately does NOT join an in-flight listing. It runs
  // only when a declaration missed against the cache, and its whole job is to
  // answer "does this secret exist NOW" before refusing a spawn. Joining a
  // listing that began before that question was asked could return data from
  // before the secret was added, which would manufacture exactly the refusal
  // this refresh exists to prevent.
  const secrets = (await (forceRefresh ? listViaApi('secrets') : listViaApiOnce('secrets'))) as OnecliSecret[];
  secretsCache = { at: Date.now(), secrets };
  return { secrets, fromCache: false };
}

/**
 * `force` skips the shared in-flight listing. Used only after a create
 * returned 409, where the caller needs a listing that began AFTER the create
 * — an earlier one would not contain the agent and would turn a won race into
 * a spurious failure.
 */
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

/**
 * Look up the UUID for an agent by its `identifier`. Refreshes the
 * cache on a miss — agents created via `ensureAgent` between cache
 * loads will be picked up on the first miss after their creation.
 *
 * Throws when the identifier doesn't exist after a fresh load (treats
 * a missing agent as a fail-closed condition rather than silently
 * proceeding without applying secrets).
 */
async function resolveAgentUuid(identifier: string): Promise<string> {
  const cached = identifierToUuid.get(identifier);
  if (cached) return cached;

  // Cache miss — refresh and try again. We replace the whole map so
  // stale entries (agents renamed/deleted) get evicted.
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
 * Ensure a OneCLI agent exists without issuing a redundant create request on
 * every container spawn. The first cache miss refreshes the full agents list;
 * only a genuinely absent identifier is created.
 *
 * A 409 is the expected create race and counts as success only after a fresh
 * list confirms the agent. Every other response fails closed so the caller
 * cannot continue into an unscoped container configuration.
 *
 * Async since #315 — the spawn path awaits it rather than blocking the host
 * event loop for the gateway round trip. Serialized per identity so two
 * concurrent spawns of the same group cannot both take the create branch.
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

/**
 * Resolve a list of declarations (names or UUIDs) to vault secret
 * UUIDs. Each declaration is either:
 *   - a UUID — passes through after a presence check
 *   - a NAME — looked up case-sensitively against `secrets list`
 *
 * Any unresolvable declaration throws — partial application would
 * leave the agent in an under-credentialed state without a clear
 * error signal.
 */
export async function resolveSecretUuids(declarations: string[]): Promise<string[]> {
  if (declarations.length === 0) return [];

  const first = await loadSecrets(false);
  let match = matchDeclarations(first.secrets, declarations);

  // A miss against a cached listing is not yet a failure: the secret may have
  // been added to the vault since the cache was filled. Re-read before
  // refusing, so caching can never manufacture a spawn refusal.
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
 * Apply a group's per-spawn OneCLI secret scoping. Does nothing when
 * `declarations` is empty or undefined. Async since #315; callers in the spawn
 * path MUST await it (see the tripwire in `onecli-secrets.test.ts`).
 *
 * Steps when declarations are present:
 *   1. Resolve agent identifier → UUID (cached, with miss refresh).
 *   2. Resolve declared names/UUIDs → vault UUIDs (hard-fail on
 *      any unresolved).
 *   3. Read its current secret grants.
 *   4. Detach undeclared grants, then attach missing grants. Connection grants
 *      are deliberately untouched. OneCLI's grants-only model has no mutable
 *      all/selective mode.
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

  // Remove excess access before adding missing access. If a request fails,
  // spawn aborts instead of leaving a newly broadened partial configuration.
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

/**
 * Merge workgroup-level and per-group OneCLI secret declarations into a
 * single ordered, deduplicated list. Workgroup secrets come first (baseline);
 * per-group secrets are appended additively. Neither list can subtract from
 * the other — the merge is union-only.
 *
 * This implements the workgroup-baseline-∪-group-additive model from the
 * workgroup-scoped-data-layer design: workgroups.onecli_secrets provides a
 * shared floor that every member inherits, and container.json.onecliSecrets
 * can extend but not restrict.
 */
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
 * Identify which of the given OneCLI secret names back Slack USER-token
 * access — the credentials that let an agent read the owner's Slack DMs/
 * threads (`curl https://slack.com/api/*` through the proxy). The host
 * withholds exactly these from a session's OneCLI agent when the session is
 * not owner-safe, so teammates in a shared channel can't extract the owner's
 * Slack through the agent. See `isOwnerSafeSlackSession`
 * (src/modules/permissions/slack-user-token-gate.ts:108) and the two-tier identity (src/container-runner.ts:6941).
 *
 * Resolution:
 *   - If `explicitNames` is provided (from `slack_user_token.onecli_secret_names`),
 *     it is authoritative: return the intersection of it with `secrets`
 *     (case-insensitive). No convention guessing.
 *   - Otherwise fall back to the naming convention: a secret whose name
 *     contains BOTH "slack" and "user" (case-insensitive) — matches
 *     `Slack-User-Token-*` while excluding bot-token secrets like
 *     `Slack-Bot-Token-*` (bot tokens can't read arbitrary DMs, so they
 *     aren't owner-Slack-sensitive in the same way).
 *
 * Returns the matching names AS THEY APPEAR in `secrets` (so callers can
 * filter the merged list by identity).
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

/** Test hook — clears the in-memory caches so each test starts clean. */
export function __resetCachesForTest(): void {
  identifierToUuid.clear();
  secretsCache = null;
  identityLocks.clear();
  inFlightListings.clear();
}

/**
 * Internal helpers exported solely for unit tests. Production callers
 * use `applyOnecliSecrets`. Note: `resolveSecretUuids` is ALSO exported at
 * top-level (above) for use by `scripts/set-workgroup-secrets.ts` — the
 * `__test` reference here is for legacy tests that already imported via
 * this namespace and is kept for compatibility.
 */
export const __test = { isUuid, resolveAgentUuid };
