/**
 * Per-group OneCLI secret scoping.
 *
 * Declarative model: each group's `container.json` may carry an
 * `onecliSecrets: string[]` field listing the secrets it should have
 * access to (by NAME or UUID). On every container spawn, the host
 * resolves names → UUIDs and calls `onecli agents set-secrets` so the
 * agent gets exactly that set — no more, no less — and forces mode
 * `selective` so an operator who flipped to `all` via the UI doesn't
 * silently override the declarative config.
 *
 * Closes the parity gap surfaced by the earlier audit: previously
 * `ensureAgent` left every new agent in `selective` mode with NOTHING
 * assigned (401 on credentialed calls), and a few operator-flipped
 * `mode all` agents could cross-tenant grab any secret whose host
 * pattern matched the URL — e.g. `illie-codex` hitting Madison-Reed's
 * Atlassian endpoint would attach Madison-Reed's Atlassian secret.
 *
 * Fail-closed: any declared name that doesn't resolve to a vault
 * secret throws — sweep retries and the operator gets a loud signal,
 * matching the codebase's posture throughout (spawn failures, approval
 * errors, etc.).
 *
 * SDK-bypass rationale: the `@onecli-sh/sdk@0.5.0` only exposes
 * `getGatewaySkill`, `getContainerConfig`, `applyContainerConfig`,
 * `createAgent`, `ensureAgent`, `provisionUser`, and
 * `configureManualApproval`. List/set operations on agents and secrets
 * are CLI-only, so this module follows the shell-out pattern from
 * `setup/auth.ts:80-113`.
 */
import { execFileSync } from 'child_process';

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

function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

function runOnecli(args: string[]): string {
  // No shell interpolation — `execFileSync` passes args directly to the
  // binary. Important: secret VALUES are never on this path (we only
  // pass NAMES and UUIDs), but treat the argv as untrusted-content-free
  // anyway to keep the invariant simple.
  return execFileSync('onecli', args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function listAgents(): OnecliAgent[] {
  const out = runOnecli(['agents', 'list']);
  const parsed = JSON.parse(out) as { data?: unknown };
  return Array.isArray(parsed.data) ? (parsed.data as OnecliAgent[]) : [];
}

function listSecrets(): OnecliSecret[] {
  const out = runOnecli(['secrets', 'list']);
  const parsed = JSON.parse(out) as { data?: unknown };
  return Array.isArray(parsed.data) ? (parsed.data as OnecliSecret[]) : [];
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
  const agents = listAgents();
  identifierToUuid.clear();
  for (const a of agents) {
    if (a.identifier) identifierToUuid.set(a.identifier, a.id);
  }
  const refreshed = identifierToUuid.get(identifier);
  if (!refreshed) {
    throw new Error(
      `OneCLI agent with identifier "${identifier}" not found in vault — refusing to spawn without scoped credentials`,
    );
  }
  return refreshed;
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
function resolveSecretUuids(declarations: string[]): string[] {
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
 *   3. Force agent mode to `selective` — defensive against an
 *      operator who flipped to `all` via the UI, ensuring the
 *      declarative model is authoritative.
 *   4. `onecli agents set-secrets --id <uuid> --secret-ids <ids>` —
 *      this is a SET, not an APPEND. Any prior assignment is
 *      replaced by exactly the declared list.
 */
export function applyOnecliSecrets(agentIdentifier: string, declarations: string[] | undefined): void {
  if (!declarations || declarations.length === 0) return;

  const agentUuid = resolveAgentUuid(agentIdentifier);
  const secretUuids = resolveSecretUuids(declarations);

  // Defensive mode lock — the CLI is idempotent if the mode is already
  // `selective`. We run it unconditionally so the post-condition is
  // always "this agent is in selective mode with exactly the declared
  // secrets" regardless of what state it was in.
  runOnecli(['agents', 'set-secret-mode', '--id', agentUuid, '--mode', 'selective']);

  runOnecli(['agents', 'set-secrets', '--id', agentUuid, '--secret-ids', secretUuids.join(',')]);

  log.info('OneCLI secrets applied', {
    agentIdentifier,
    agentUuid,
    declared: declarations.length,
    resolved: secretUuids.length,
  });
}

/** Test hook — clears the in-memory caches so each test starts clean. */
export function __resetCachesForTest(): void {
  identifierToUuid.clear();
}

/**
 * Internal helpers exported solely for unit tests. Production callers
 * use `applyOnecliSecrets`.
 */
export const __test = { isUuid, resolveSecretUuids, resolveAgentUuid };
