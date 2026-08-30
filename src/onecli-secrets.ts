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
import { execFileSync } from 'child_process';

import { ONECLI_URL, ONECLI_API_KEY } from './config.js';
import { log } from './log.js';

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
 * Kept synchronous (curl via execFileSync) so the resolve/apply call chain
 * stays sync.
 */
function listViaApi(resource: 'agents' | 'secrets'): unknown[] {
  const base = (ONECLI_URL || 'http://127.0.0.1:10254').replace(/\/$/, '');
  const args = ['-fsS', ...CURL_TIMEOUT_ARGS, `${base}/api/${resource}?limit=10000`];
  if (ONECLI_API_KEY) args.unshift('-H', `Authorization: Bearer ${ONECLI_API_KEY}`);
  const out = execFileSync('curl', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const parsed = JSON.parse(out) as unknown;
  if (Array.isArray(parsed)) return parsed;
  const data = (parsed as { data?: unknown }).data;
  return Array.isArray(data) ? data : [];
}

/**
 * Call the OneCLI gateway synchronously. `curl -f` turns every non-2xx response
 * into an exception, preserving the fail-closed spawn behavior. No secret
 * values travel on this path; only agent and secret UUIDs are used in URLs.
 */
function requestViaApi(method: 'GET' | 'PUT' | 'DELETE', path: string): unknown {
  const base = (ONECLI_URL || 'http://127.0.0.1:10254').replace(/\/$/, '');
  const args = ['-fsS', ...CURL_TIMEOUT_ARGS, '-X', method];
  if (ONECLI_API_KEY) args.push('-H', `Authorization: Bearer ${ONECLI_API_KEY}`);
  args.push(`${base}/api/${path.replace(/^\//, '')}`);
  const out = execFileSync('curl', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  return out.trim() ? (JSON.parse(out) as unknown) : undefined;
}

/**
 * Create an agent through the current versioned API while retaining the HTTP
 * status. A concurrent creator can legitimately win after our list read, so
 * callers must be able to distinguish that 409 from every other failure.
 */
function createAgentViaApi(input: EnsureOnecliAgentInput): { status: number; body: unknown } {
  const base = (ONECLI_URL || 'http://127.0.0.1:10254').replace(/\/$/, '');
  const args = ['-sS', ...CURL_TIMEOUT_ARGS, '-X', 'POST', '-H', 'Content-Type: application/json'];
  if (ONECLI_API_KEY) args.push('-H', `Authorization: Bearer ${ONECLI_API_KEY}`);
  args.push('--data-binary', JSON.stringify(input), '-w', '\n%{http_code}', `${base}/v1/agents`);

  const out = execFileSync('curl', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
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

function getAgentGrants(agentUuid: string): OnecliAgentGrants {
  const parsed = requestViaApi('GET', `agents/${encodeURIComponent(agentUuid)}/grants`);
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

function listAgents(): OnecliAgent[] {
  return listViaApi('agents') as OnecliAgent[];
}

function listSecrets(): OnecliSecret[] {
  return listViaApi('secrets') as OnecliSecret[];
}

function refreshAgentCache(): void {
  const agents = listAgents();
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
function resolveAgentUuid(identifier: string): string {
  const cached = identifierToUuid.get(identifier);
  if (cached) return cached;

  // Cache miss — refresh and try again. We replace the whole map so
  // stale entries (agents renamed/deleted) get evicted.
  refreshAgentCache();
  const refreshed = identifierToUuid.get(identifier);
  if (!refreshed) {
    throw new Error(
      `OneCLI agent with identifier "${identifier}" not found in vault — refusing to spawn without scoped credentials`,
    );
  }
  return refreshed;
}

/**
 * Synchronously ensure a OneCLI agent exists without issuing a redundant
 * create request on every container spawn. The first cache miss refreshes the
 * full agents list; only a genuinely absent identifier is created.
 *
 * A 409 is the expected create race and counts as success only after a fresh
 * list confirms the agent. Every other response fails closed so the caller
 * cannot continue into an unscoped container configuration.
 */
export function ensureOnecliAgent(input: EnsureOnecliAgentInput): EnsureOnecliAgentResult {
  if (identifierToUuid.has(input.identifier)) return { ...input, created: false };

  refreshAgentCache();
  if (identifierToUuid.has(input.identifier)) return { ...input, created: false };

  const response = createAgentViaApi(input);
  if (response.status === 409) {
    refreshAgentCache();
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
export function resolveSecretUuids(declarations: string[]): string[] {
  if (declarations.length === 0) return [];

  const secrets = listSecrets();
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

  if (unresolved.length > 0) {
    throw new Error(
      `OneCLI secret(s) not found in vault: ${unresolved.join(', ')} — ` +
        `check spelling, that the secret exists, and that 'onecli secrets list' returns it`,
    );
  }

  return resolved;
}

/**
 * Apply a group's per-spawn OneCLI secret scoping. Does nothing when
 * `declarations` is empty or undefined.
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
export function applyOnecliSecrets(agentIdentifier: string, declarations: string[] | undefined): void {
  if (!declarations || declarations.length === 0) return;

  const agentUuid = resolveAgentUuid(agentIdentifier);
  const secretUuids = resolveSecretUuids(declarations);
  const grants = getAgentGrants(agentUuid);
  const declaredSet = new Set(secretUuids);
  const grantedSet = new Set(grants.secrets.map((secret) => secret.secretId));
  const toRemove = [...grantedSet].filter((secretUuid) => !declaredSet.has(secretUuid));
  const toAdd = [...declaredSet].filter((secretUuid) => !grantedSet.has(secretUuid));

  // Remove excess access before adding missing access. If a request fails,
  // spawn aborts instead of leaving a newly broadened partial configuration.
  for (const secretUuid of toRemove) {
    requestViaApi('DELETE', `agents/${encodeURIComponent(agentUuid)}/grants/secrets/${encodeURIComponent(secretUuid)}`);
  }
  for (const secretUuid of toAdd) {
    requestViaApi('PUT', `agents/${encodeURIComponent(agentUuid)}/grants/secrets/${encodeURIComponent(secretUuid)}`);
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
 * threads (via the proxy or the korotovsky MCP). The host withholds exactly
 * these from a session's OneCLI agent when the session is not owner-safe, so
 * teammates in a shared channel can't extract the owner's Slack through the
 * agent. See `isOwnerSafeSlackSession` + the two-tier identity in
 * container-runner.
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
}

/**
 * Internal helpers exported solely for unit tests. Production callers
 * use `applyOnecliSecrets`. Note: `resolveSecretUuids` is ALSO exported at
 * top-level (above) for use by `scripts/set-workgroup-secrets.ts` — the
 * `__test` reference here is for legacy tests that already imported via
 * this namespace and is kept for compatibility.
 */
export const __test = { isUuid, resolveAgentUuid };
