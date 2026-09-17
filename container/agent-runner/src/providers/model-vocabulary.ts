/**
 * Which provider a model id belongs to, by SHAPE.
 *
 * Mirrors the host's per-provider flag vocabularies — separate package trees,
 * so the patterns are copied, not imported: `CODEX_VALID_MODEL_RE`
 * (src/flag-parser.ts:233), `OPENCODE_VALID_MODEL_RE` (src/flag-parser.ts:296)
 * and Claude's `VALID_MODEL_RE` (src/flag-parser.ts:118), selected per provider
 * by `vocabFor` (src/flag-parser.ts:339, unknown providers → Claude). Codex ids
 * are `gpt-*`, opencode slugs are provider-prefixed `<provider>/<id…>`, and a
 * claude id is whatever is neither. Shape, not catalog — the provider itself
 * is the authority on whether a well-formed id exists, and fails loudly on one
 * that does not.
 *
 * Why the runner needs this at all: the router resolves the provider for a
 * chat message as sessions.agent_provider → container config → the group row
 * (src/router.ts:1470-1473) — the PRIMARY provider, never the spawn-time
 * fallback — and validates `-m` against that vocabulary
 * (src/router.ts:1474 `parseMessageFlags`); the pin then persists in
 * session_state as the sticky model. Under a spawn-time provider fallback the
 * same session runs on the OTHER provider, and a sticky from before the
 * outage names a model that provider cannot run.
 */
export const CODEX_MODEL_RE = /^gpt-[a-z0-9][a-z0-9.-]*$/;
export const OPENCODE_MODEL_SLUG_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/i;

export function modelBelongsToProvider(model: string, providerName: string): boolean {
  const codex = CODEX_MODEL_RE.test(model);
  const opencode = OPENCODE_MODEL_SLUG_RE.test(model);
  if (providerName === 'codex') return codex;
  if (providerName === 'opencode') return opencode;
  return !codex && !opencode;
}
