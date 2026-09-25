/**
 * Which provider a model id belongs to, by SHAPE.
 *
 * Mirrors the host's per-provider flag vocabularies — separate package trees,
 * so the patterns are copied, not imported: `CODEX_VALID_MODEL_RE`,
 * `OPENCODE_VALID_MODEL_RE` and Claude's `VALID_MODEL_RE` (all in
 * src/flag-parser.ts), selected per provider by `vocabFor` (unknown
 * providers → Claude). Codex ids
 * are `gpt-*`, opencode slugs are provider-prefixed `<provider>/<id…>`, and a
 * claude id is whatever is neither. Shape, not catalog — the provider itself
 * is the authority on whether a well-formed id exists, and fails loudly on one
 * that does not.
 *
 * Why the runner needs this at all: the router resolves the provider for a
 * chat message as sessions.agent_provider → container config → the group row
 * (src/router.ts) — the PRIMARY provider, never the spawn-time
 * fallback — and validates `-m` against that vocabulary
 * (`parseMessageFlags` in src/router.ts); the pin then persists in
 * session_state as the sticky model. Under a spawn-time provider fallback the
 * same session runs on the OTHER provider, and a sticky from before the
 * outage names a model that provider cannot run.
 */
export const CODEX_MODEL_RE = /^gpt-[a-z0-9][a-z0-9.-]*$/;
export const OPENCODE_MODEL_SLUG_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/i;

/**
 * Codex FAMILY aliases (`sol`, `luna`, `astra`, `terra`). The host stores a
 * family name as typed so a pin follows the next release of that family, and
 * hands the current name → id map to every container as
 * NANOCLAW_CODEX_MODEL_ALIASES (`CODEX_FAMILY_DEFAULTS`, src/flag-parser.ts),
 * emitted by `codexFamilyAliasEnv` (src/container-runner.ts) from both
 * spawn branches (wiki and ordinary).
 * The Codex CLI has no alias mechanism, so the provider resolves through this
 * before anything reaches the app-server. The names are listed here too so a
 * family pin is still recognised as Codex when the env is missing (a container
 * spawned by an older host); it then fails the `gpt-*` guard and is ignored
 * with a log line, never sent verbatim.
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

/** A Codex family alias → its current id; anything else unchanged. */
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
