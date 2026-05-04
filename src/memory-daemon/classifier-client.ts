/**
 * Classifier client facade — provider-agnostic interface used by classifier.ts
 * and source-ingest.ts. Abstraction lets the daemon switch backends via the
 * MEMORY_CLASSIFIER_BACKEND env var without touching consumer code.
 *
 * Format: "<provider>:<model>:<effort>"
 *   - provider:  "anthropic" | "codex"
 *   - model:     short alias (e.g. "haiku-4-5", "sonnet-4-6", "gpt-5.5") —
 *                each backend maps the alias to its provider-specific id.
 *   - effort:    "default" | "low" | "medium" | "high"
 *
 * Defaults to "anthropic:haiku-4-5:default" (the original behavior).
 *
 * Switching procedure (operator UX):
 *   echo 'Environment="MEMORY_CLASSIFIER_BACKEND=codex:gpt-5.5:medium"' \
 *     | sudo tee /etc/systemd/system/nanoclaw-memory-daemon.service.d/backend.conf
 *   sudo systemctl daemon-reload && sudo systemctl restart nanoclaw-memory-daemon
 */

// Version constants — co-located with the schema/prompt invariants they gate.
// Bumping any of these invalidates the daemon's idempotency cache so prior
// turns get re-classified under the new contract.
export const CLASSIFIER_VERSION = 'v1';
// v2 — added GROUNDING DISCIPLINE section to CLASSIFIER_SYSTEM_PROMPT and
// EXTRACTOR_SYSTEM_PROMPT to prevent confabulation (acronym expansion,
// invented aliases, unsourced parentheticals).
export const PROMPT_VERSION = 'v2';
// v2 — same grounding-discipline addition as PROMPT_VERSION.
export const EXTRACTOR_VERSION = 'v2';

export interface ClassifierOutput {
  worth_storing: boolean;
  facts: Array<{
    content: string;
    category: 'preference' | 'decision' | 'insight' | 'fact' | 'context';
    importance: number;
    entities: string[];
    source_role: 'user' | 'assistant' | 'joint' | 'external';
  }>;
}

export class ClassifierParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClassifierParseError';
  }
}

export interface CallClassifierOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type ClassifierBackend = (
  systemPrompt: string,
  userPrompt: string,
  opts?: CallClassifierOpts,
) => Promise<ClassifierOutput>;

export type Effort = 'default' | 'low' | 'medium' | 'high';
export type Provider = 'anthropic' | 'codex';

export interface BackendConfig {
  provider: Provider;
  model: string;
  effort: Effort;
}

const VALID_PROVIDERS = new Set<Provider>(['anthropic', 'codex']);
const VALID_EFFORTS = new Set<Effort>(['default', 'low', 'medium', 'high']);
const DEFAULT_BACKEND: BackendConfig = {
  provider: 'anthropic',
  model: 'haiku-4-5',
  effort: 'default',
};

/**
 * Parse the MEMORY_CLASSIFIER_BACKEND env var (or any "<provider>:<model>:<effort>"
 * string). Throws on malformed input — operator restart-fail-loud is preferable
 * to silently falling back to a default that doesn't match operator intent.
 */
export function parseBackendConfig(envVal: string | undefined): BackendConfig {
  if (!envVal || !envVal.trim()) return DEFAULT_BACKEND;
  const parts = envVal.split(':');
  if (parts.length !== 3) {
    throw new Error(`MEMORY_CLASSIFIER_BACKEND format must be "<provider>:<model>:<effort>" — got "${envVal}"`);
  }
  const [provider, model, effort] = parts.map((s) => s.trim());
  if (!VALID_PROVIDERS.has(provider as Provider)) {
    throw new Error(`MEMORY_CLASSIFIER_BACKEND: unknown provider "${provider}" (valid: anthropic, codex)`);
  }
  if (!model) {
    throw new Error(`MEMORY_CLASSIFIER_BACKEND: model alias must be non-empty`);
  }
  if (!VALID_EFFORTS.has(effort as Effort)) {
    throw new Error(`MEMORY_CLASSIFIER_BACKEND: unknown effort "${effort}" (valid: default, low, medium, high)`);
  }
  return { provider: provider as Provider, model, effort: effort as Effort };
}

// Lazy backend init — the env var is read on first call (not at module load)
// so a daemon restart with a new env var picks up the change without recompile,
// and tests can swap the env var per-suite via setBackendForTest.
let _cachedBackend: ClassifierBackend | null = null;

/**
 * Test-only seam: override the backend factory result. Pass null to clear and
 * fall back to env-driven selection on the next callClassifier call.
 */
export function setBackendForTest(b: ClassifierBackend | null): void {
  _cachedBackend = b;
}

/**
 * Test-only seam: clear the cached backend so the next call re-reads env.
 */
export function _resetBackendForTest(): void {
  _cachedBackend = null;
}

async function loadBackend(): Promise<ClassifierBackend> {
  if (_cachedBackend) return _cachedBackend;
  const cfg = parseBackendConfig(process.env.MEMORY_CLASSIFIER_BACKEND);
  let backend: ClassifierBackend;
  if (cfg.provider === 'anthropic') {
    const { makeAnthropicBackend } = await import('./backends/anthropic.js');
    backend = makeAnthropicBackend({ model: cfg.model, effort: cfg.effort });
  } else if (cfg.provider === 'codex') {
    const { makeCodexBackend } = await import('./backends/codex.js');
    backend = makeCodexBackend({ model: cfg.model, effort: cfg.effort });
  } else {
    throw new Error(`unreachable provider: ${cfg.provider as string}`);
  }
  _cachedBackend = backend;
  return backend;
}

/**
 * Provider-agnostic classifier call. Reads MEMORY_CLASSIFIER_BACKEND on first
 * invocation to select Anthropic or Codex backend; same input/output contract
 * regardless of provider.
 */
export async function callClassifier(
  systemPrompt: string,
  userPrompt: string,
  opts?: CallClassifierOpts,
): Promise<ClassifierOutput> {
  // Strip null bytes from both prompts. Node `child_process.spawn` rejects
  // any string arg containing `\0` with TypeError [ERR_INVALID_ARG_VALUE],
  // which the codex backend hits when chat archive content (rare but real)
  // includes a null byte. Confirmed 2026-05-04: 7+ chat pairs poisoned by
  // this in axie-dev/illysium/cf39lq archives. Anthropic backend is
  // unaffected (HTTP body transmits \0 fine), but stripping at this layer
  // protects every current and future backend uniformly. Lossy by intent —
  // dropping one unprintable char is preferable to losing the whole pair.
  const safeSystem = systemPrompt.replace(/\0/g, '');
  const safeUser = userPrompt.replace(/\0/g, '');
  const backend = await loadBackend();
  return backend(safeSystem, safeUser, opts);
}

// ---- shared helpers exported for backends + tests ----

const VALID_CATEGORIES = new Set(['preference', 'decision', 'insight', 'fact', 'context']);
const VALID_SOURCE_ROLES = new Set(['user', 'assistant', 'joint', 'external']);

export function validateClassifierOutput(value: unknown): ClassifierOutput {
  if (typeof value !== 'object' || value === null) {
    throw new ClassifierParseError('Response is not an object');
  }
  const obj = value as Record<string, unknown>;

  if (typeof obj.worth_storing !== 'boolean') {
    throw new ClassifierParseError('worth_storing must be a boolean');
  }

  if (!Array.isArray(obj.facts)) {
    throw new ClassifierParseError('facts must be an array');
  }

  for (const fact of obj.facts) {
    if (typeof fact !== 'object' || fact === null) {
      throw new ClassifierParseError('Each fact must be an object');
    }
    const f = fact as Record<string, unknown>;
    if (typeof f.content !== 'string') throw new ClassifierParseError('fact.content must be a string');
    if (!VALID_CATEGORIES.has(f.category as string)) throw new ClassifierParseError('fact.category is invalid');
    if (typeof f.importance !== 'number') throw new ClassifierParseError('fact.importance must be a number');
    if (!Array.isArray(f.entities)) throw new ClassifierParseError('fact.entities must be an array');
    if (!VALID_SOURCE_ROLES.has(f.source_role as string)) throw new ClassifierParseError('fact.source_role is invalid');
  }

  return obj as unknown as ClassifierOutput;
}

/**
 * Extract the JSON payload from an LLM response that may be wrapped in a
 * markdown code fence and/or followed by free-form prose.
 *
 * Strategy:
 *   1. If the trimmed input starts with a fence, return the first fenced
 *      block's contents — anything after the closing ``` is ignored.
 *   2. If no leading fence is present, fall back to extracting the first
 *      balanced { ... } block.
 *   3. Otherwise return the trimmed input as-is.
 *
 * Production observation: Haiku 4.5 emits fenced + trailer-prose shapes
 * routinely; an earlier strict "fence at end-of-string" regex dead-lettered
 * ~52 of illysium's chat turn-pairs on the daemon's first sweep.
 */
export function stripCodeFence(s: string): string {
  const trimmed = s.trim();
  const fenceMatch = /^```(?:[a-zA-Z0-9]+)?\s*\n([\s\S]*?)\n```/.exec(trimmed);
  if (fenceMatch) return fenceMatch[1];
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = firstBrace; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (c === '\\') {
        escape = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return trimmed.slice(firstBrace, i + 1);
      }
    }
  }
  return trimmed;
}
