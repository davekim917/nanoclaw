/**
 * Universal OneCLI secrets — credentials auto-assigned to every agent group
 * regardless of their selective allow-list. Configured via
 * `NANOCLAW_UNIVERSAL_SECRETS=<name1>,<name2>,...` in `.env`.
 *
 * OneCLI itself has only two secret modes (`all` / `selective`) and no concept
 * of a globally-assigned secret. This module layers that on top by topping up
 * each agent's per-agent allow-list with a configured set of universals.
 *
 * Names that don't resolve in OneCLI are logged-and-skipped, not fatal — this
 * lets operators pre-declare future universals (e.g. Exa, Pocket) before the
 * underlying secret exists in the vault.
 *
 * Runs on every `ensureAgent` call (cheap idempotent merge) plus a startup
 * backfill across all existing agents so adding a new universal doesn't
 * require spawning a session per agent to take effect.
 */

import { NANOCLAW_UNIVERSAL_SECRETS, ONECLI_API_KEY, ONECLI_URL } from './config.js';
import { log } from './log.js';

const DEFAULT_ONECLI_URL = 'http://127.0.0.1:10254';
const SECRETS_CACHE_TTL_MS = 30_000;

interface OneCLISecret {
  id: string;
  name: string;
  hostPattern: string | null;
}

interface OneCLIAgent {
  id: string;
  name: string;
  identifier: string | null;
}

function baseUrl(): string {
  return (ONECLI_URL || DEFAULT_ONECLI_URL).replace(/\/+$/, '');
}

function parseUniversalNames(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * OneCLI's admin API accepts unauthed requests on 127.0.0.1 — `ONECLI_API_KEY`
 * is optional. Mirror the @onecli-sh/sdk behavior: only send the Authorization
 * header when a key is configured.
 */
function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  if (ONECLI_API_KEY) return { Authorization: `Bearer ${ONECLI_API_KEY}`, ...extra };
  return { ...extra };
}

async function oneCLIGet<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OneCLI GET ${path} ${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

async function oneCLIPut(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OneCLI PUT ${path} ${res.status}: ${text}`);
  }
}

/**
 * Resolve configured universal-secret names to secret records. Missing names
 * and ambiguous (multiple-match) names are logged and filtered out — NOT
 * thrown — so one misconfigured name never blocks the rest.
 *
 * Pure apart from logging; exported for unit tests.
 */
export function resolveUniversalSecrets(configuredNames: string[], allSecrets: OneCLISecret[]): OneCLISecret[] {
  if (configuredNames.length === 0) return [];
  const byName = new Map<string, OneCLISecret[]>();
  for (const s of allSecrets) {
    const bucket = byName.get(s.name);
    if (bucket) bucket.push(s);
    else byName.set(s.name, [s]);
  }
  const resolved: OneCLISecret[] = [];
  for (const name of configuredNames) {
    const matches = byName.get(name);
    if (!matches || matches.length === 0) {
      log.warn('Universal secret not found in OneCLI — skipping', { name });
      continue;
    }
    if (matches.length > 1) {
      log.warn('Universal secret name is ambiguous — using first match', {
        name,
        candidates: matches.map((m) => m.id),
        chosen: matches[0].id,
      });
    }
    resolved.push(matches[0]);
  }
  return resolved;
}

/**
 * Given an agent's current secret-id assignment and the set of universal
 * secret ids we want present, return the merged assignment — or `null` when
 * every universal is already assigned (no-op, skip the PUT).
 *
 * Pure; exported for unit tests.
 */
export function computeMerge(currentAssignment: readonly string[], universalIds: readonly string[]): string[] | null {
  const current = new Set(currentAssignment);
  const missing = universalIds.filter((id) => !current.has(id));
  if (missing.length === 0) return null;
  return [...currentAssignment, ...missing];
}

interface Cached<T> {
  at: number;
  promise: Promise<T>;
}

let cachedSecrets: Cached<OneCLISecret[]> | null = null;
let cachedAgents: Cached<OneCLIAgent[]> | null = null;

function getCached<T>(
  slot: Cached<T> | null,
  fetcher: () => Promise<T>,
  onEvict: (replacement: Cached<T> | null) => void,
): Promise<T> {
  const now = Date.now();
  if (slot && now - slot.at < SECRETS_CACHE_TTL_MS) {
    return slot.promise;
  }
  const promise = fetcher();
  const fresh: Cached<T> = { at: now, promise };
  onEvict(fresh);
  // If the request errors, evict so the next call retries instead of serving
  // the rejected promise for the cache TTL.
  promise.catch(() => onEvict(null));
  return promise;
}

function getAllSecrets(): Promise<OneCLISecret[]> {
  return getCached(
    cachedSecrets,
    () => oneCLIGet<OneCLISecret[]>('/api/secrets'),
    (next) => {
      cachedSecrets = next;
    },
  );
}

function getAllAgents(): Promise<OneCLIAgent[]> {
  return getCached(
    cachedAgents,
    () => oneCLIGet<OneCLIAgent[]>('/api/agents'),
    (next) => {
      cachedAgents = next;
    },
  );
}

async function resolveAgentIdByIdentifier(identifier: string): Promise<string | null> {
  const agents = await getAllAgents();
  const match = agents.find((a) => a.identifier === identifier);
  return match ? match.id : null;
}

/**
 * Reset in-module caches. Tests only.
 */
export function __resetUniversalSecretsCache(): void {
  cachedSecrets = null;
  cachedAgents = null;
}

/**
 * Core: top up one agent's allow-list by OneCLI UUID.
 */
async function syncAgentById(agentId: string, displayName: string | null = null): Promise<void> {
  try {
    const names = parseUniversalNames(NANOCLAW_UNIVERSAL_SECRETS);
    if (names.length === 0) return;
    const allSecrets = await getAllSecrets();
    const resolved = resolveUniversalSecrets(names, allSecrets);
    if (resolved.length === 0) return;
    // GET returns a bare `string[]` (secret ids), NOT an envelope object —
    // verified against OneCLI 1.1.0 on 2026-04-24. The companion PUT below
    // does use `{secretIds: [...]}`, so the asymmetry is deliberate API
    // shape, not an oversight here.
    const current = await oneCLIGet<string[]>(`/api/agents/${encodeURIComponent(agentId)}/secrets`);
    const merged = computeMerge(
      current,
      resolved.map((s) => s.id),
    );
    if (!merged) return;
    await oneCLIPut(`/api/agents/${encodeURIComponent(agentId)}/secrets`, { secretIds: merged });
    const currentSet = new Set(current);
    const added = resolved.filter((r) => !currentSet.has(r.id)).map((r) => r.name);
    log.info('Assigned universal secrets to agent', { agentId, displayName, added });
  } catch (err) {
    log.warn('Failed to sync universal secrets — continuing', { agentId, displayName, err });
  }
}

/**
 * Top up a single agent's secret allow-list by external identifier (the
 * agent-group id NanoClaw passes to `ensureAgent`). Resolves identifier →
 * OneCLI UUID via the agents list.
 *
 * No-op when `NANOCLAW_UNIVERSAL_SECRETS` is empty or when OneCLI isn't
 * configured. Errors are logged and swallowed — must not block the caller.
 */
export async function syncAgentUniversalSecretsByIdentifier(identifier: string): Promise<void> {
  if (!parseUniversalNames(NANOCLAW_UNIVERSAL_SECRETS).length) return;
  try {
    const agentId = await resolveAgentIdByIdentifier(identifier);
    if (!agentId) {
      log.warn('Universal-secrets sync: no OneCLI agent for identifier', { identifier });
      return;
    }
    await syncAgentById(agentId, identifier);
  } catch (err) {
    log.warn('Failed to sync universal secrets — continuing', { identifier, err });
  }
}

/**
 * Backfill universals across every OneCLI agent at host startup. Runs
 * sequentially to keep the log readable; each agent's error is contained.
 */
export async function syncAllAgentsUniversalSecrets(): Promise<void> {
  const names = parseUniversalNames(NANOCLAW_UNIVERSAL_SECRETS);
  if (names.length === 0) return;
  try {
    const agents = await getAllAgents();
    for (const agent of agents) {
      await syncAgentById(agent.id, agent.identifier ?? agent.name);
    }
  } catch (err) {
    log.warn('Startup universal-secrets backfill failed', { err });
  }
}
