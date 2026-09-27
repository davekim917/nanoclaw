/**
 * Which provider a model id belongs to, by SHAPE, not catalog. The patterns copy the host's per-provider
 * vocabularies in src/flag-parser.ts (separate package tree, so they cannot be imported).
 *
 * Needed because under a spawn-time provider fallback a session runs on the OTHER provider, and a sticky model
 * pinned before the outage can name a model that provider cannot run.
 */
export const CODEX_MODEL_RE = /^gpt-[a-z0-9][a-z0-9.-]*$/;
export const OPENCODE_MODEL_SLUG_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/i;

/**
 * Codex family aliases. The Codex CLI has no alias mechanism, so they resolve through the host's
 * NANOCLAW_CODEX_MODEL_ALIASES map; listing the names here keeps a family pin recognised as Codex when that env
 * is missing (it then fails the `gpt-*` guard and is ignored, never sent verbatim).
 */
const CODEX_FAMILY_NAMES: ReadonlySet<string> = new Set(['sol', 'luna', 'astra', 'terra']);

function codexFamilyMap(env: Record<string, string | undefined>): Record<string, string> {
  const raw = env.NANOCLAW_CODEX_MODEL_ALIASES;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string' && CODEX_MODEL_RE.test(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export function isCodexFamilyName(model: string): boolean {
  return CODEX_FAMILY_NAMES.has(model.toLowerCase());
}

export function resolveCodexFamily(model: string, env: Record<string, string | undefined> = process.env): string {
  const key = model.toLowerCase();
  if (!CODEX_FAMILY_NAMES.has(key)) return model;
  return codexFamilyMap(env)[key] ?? model;
}

export function modelBelongsToProvider(model: string, providerName: string): boolean {
  const codex = CODEX_MODEL_RE.test(model) || CODEX_FAMILY_NAMES.has(model.toLowerCase());
  const opencode = OPENCODE_MODEL_SLUG_RE.test(model);
  if (providerName === 'codex') return codex;
  if (providerName === 'opencode') return opencode;
  return !codex && !opencode;
}

/**
 * Env vars the host sets at spawn with its resolution of each Claude family alias. Read only for alias → id; the
 * alias table lives in src/flag-parser.ts, which this Bun package cannot import, so never copy it here.
 */
export const CLAUDE_FAMILY_ALIAS_ENV: Readonly<Record<string, string>> = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
};

/** For comparing against stored ids (the operator deny list), not for sending: providers resolve on their own. */
export function resolveFamilyModel(model: string, env: Record<string, string | undefined> = process.env): string {
  const key = model.toLowerCase();
  if (CODEX_FAMILY_NAMES.has(key)) return resolveCodexFamily(key, env);
  if (Object.hasOwn(CLAUDE_FAMILY_ALIAS_ENV, key)) return env[CLAUDE_FAMILY_ALIAS_ENV[key]] || model;
  return model;
}
