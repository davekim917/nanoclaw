/**
 * Model/effort/fast-mode flag parser. Called at the router boundary; the result is
 * attached to inbound content as structured metadata, so downstream code
 * never re-parses text.
 *
 * Flag vocabulary:
 *   -m   <value>   sticky model (persists across turns)
 *   -m1  <value>   one-turn model override
 *   -e   <value>   sticky effort
 *   -e1  <value>   one-turn effort override
 *   -f   on|off    sticky Codex fast mode
 *   -f1  on|off    one-turn Codex fast-mode override
 *   -m   ''        clear sticky model
 *   -e   ''        clear sticky effort
 *
 * Invocation shapes:
 *   Inline prefix: `-m haiku <prompt>` — flags stripped, prompt flows on.
 *   Standalone:    `/switch -m haiku`  — no prompt; caller emits the
 *                                        confirmation directly.
 */

/** Normalized effort values accepted by the SDK's Options.effort. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const VALID_EFFORT: ReadonlySet<string> = new Set<EffortLevel>(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * `ultracode` is NOT an effort level — the SDK's EffortLevel enum has no such
 * value. It's a separate session-scoped flag setting (`Settings.ultracode`,
 * enabled via the Agent SDK `applyFlagSettings` control request) that turns on
 * xhigh effort PLUS standing dynamic-workflow orchestration. We accept it as a
 * pseudo-value of `-e`/`-e1` for ergonomics (mirrors Claude Code's
 * `/effort ultracode`), then translate it to `effort=xhigh` + a separate
 * `ultracode` boolean that rides alongside the effort fields — never into the
 * effort enum itself. Claude-only; requires an xhigh-capable model.
 */
const ULTRACODE = 'ultracode';

/**
 * Model alias → concrete id. Bare aliases (`opus`, `sonnet`, `haiku`) are
 * SDK-native "current default in family"; the pinned aliases (`opus4-7`,
 * etc.) force a specific version regardless of SDK default drift.
 */
const MODEL_ALIAS_MAP: Record<string, string> = {
  opus46: 'claude-opus-4-6[1m]',
  'opus4-6': 'claude-opus-4-6[1m]',
  opus47: 'claude-opus-4-7[1m]',
  'opus4-7': 'claude-opus-4-7[1m]',
  opus48: 'claude-opus-4-8[1m]',
  'opus4-8': 'claude-opus-4-8[1m]',
  // Opus 5 (GA 2026-07-24): single-digit version scheme (claude-opus-5, not
  // -5-0), like fable/sonnet. 1M context is the model's default AND maximum,
  // but we still pin `[1m]` — the CLI only grants the 1M auto-compact window
  // unconditionally when the id literally carries the tag (see
  // ensureOpus1mSuffix). Same $5/$25 per MTok as Opus 4.8.
  opus5: 'claude-opus-5[1m]',
  'opus-5': 'claude-opus-5[1m]',
  // Opus 5.5: two-segment version scheme again (claude-opus-5-5). Needs
  // claude-code >= 2.1.280 — 2.1.278's binary has no reference to the id.
  // This is what the bare `opus` alias resolves to (DEFAULT_OPUS_MODEL below).
  opus55: 'claude-opus-5-5[1m]',
  'opus5-5': 'claude-opus-5-5[1m]',
  'opus-5-5': 'claude-opus-5-5[1m]',
  // Fable 5.1 (GA 2026-09-01): two-segment version scheme (claude-fable-5-1),
  // like opus-4-8. 1M-context-only in this fork, same policy as opus. NOTE:
  // $10/$50 per MTok — 2x Opus 4.8; opt-in via flag, never a default. Bare
  // `fable` is a FAMILY alias (FAMILY_DEFAULTS below), not an entry here, so
  // a stored `fable` tracks DEFAULT_FABLE_MODEL across bumps. Fable 5
  // (claude-fable-5, single-digit version scheme) is still served and stays
  // pinned below.
  fable51: 'claude-fable-5-1[1m]',
  'fable5-1': 'claude-fable-5-1[1m]',
  'fable-5-1': 'claude-fable-5-1[1m]',
  fable5: 'claude-fable-5[1m]',
  'fable-5': 'claude-fable-5[1m]',
  // Sonnet 5 (GA): single-digit version scheme (claude-sonnet-5, not -5-0),
  // same as fable. This is what the bare `sonnet` alias resolves to in
  // containers (DEFAULT_SONNET_MODEL in container-runner.ts). Unlike opus/fable,
  // Sonnet 5 ALWAYS runs at 1M on the Anthropic API — there's no 200K variant
  // and no [1m] suffix to select — so the opus-style [1m] window pin doesn't
  // apply (the global CLAUDE_CODE_AUTO_COMPACT_WINDOW=600000 handles compaction
  // sizing). The pre-5 Sonnet 4.x aliases were dropped — this fork only runs
  // Sonnet 5.
  sonnet5: 'claude-sonnet-5',
  'sonnet-5': 'claude-sonnet-5',
  haiku45: 'claude-haiku-4-5',
  'haiku4-5': 'claude-haiku-4-5',
};

// Default model per family. SINGLE source of truth for what `opus` / `sonnet`
// / `haiku` mean in this install — both for the spawn env (container-runner
// pushes these as ANTHROPIC_DEFAULT_*_MODEL) and for the chat ack, so what the
// user is told is exactly what will run.
//
// To change the install-wide default, edit these constants. Per-channel
// (messaging_group_agents.default_model/effort) and per-group
// (container.json defaultModel/defaultEffort) layers can still override.
// Per-session flags (-m / -e) and sticky config override on top of those.
export const DEFAULT_OPUS_MODEL = 'claude-opus-5-5[1m]';
export const DEFAULT_SONNET_MODEL = 'claude-sonnet-5';
export const DEFAULT_HAIKU_MODEL = 'claude-haiku-4-5-20251001';
export const DEFAULT_FABLE_MODEL = 'claude-fable-5-1[1m]';

/**
 * Bare FAMILY aliases. Deliberately NOT in MODEL_ALIAS_MAP: storing `opus`
 * keeps a sticky choice tracking the family default across future bumps,
 * whereas `opus5` freezes to that version. Resolution happens at the point of
 * USE (spawn env, chat ack), not at the point of storage. Inside the
 * container the CLI resolves each bare family word through
 * ANTHROPIC_DEFAULT_<FAMILY>_MODEL (claudeSpawnEnv), so a per-turn `fable`
 * reaches the API as DEFAULT_FABLE_MODEL too.
 */
const FAMILY_DEFAULTS: Record<string, string> = {
  opus: DEFAULT_OPUS_MODEL,
  sonnet: DEFAULT_SONNET_MODEL,
  haiku: DEFAULT_HAIKU_MODEL,
  fable: DEFAULT_FABLE_MODEL,
};

/**
 * Codex FAMILY aliases: each names the newest model of that family (GPT-6
 * Sol/Luna/Astra GA 2026-09-22; Terra has no GPT-6 release). Like the Claude
 * families they are stored as typed and resolved at USE, so a pin on `sol`
 * follows the next Sol release with no repin. The Codex CLI has no alias
 * mechanism of its own, so the host hands this map to every container as
 * NANOCLAW_CODEX_MODEL_ALIASES and the Codex provider resolves through it
 * (container/agent-runner/src/providers/model-vocabulary.ts).
 */
export const CODEX_FAMILY_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  sol: 'gpt-6-sol',
  luna: 'gpt-6-luna',
  astra: 'gpt-6-astra',
  terra: 'gpt-5.6-terra',
});

/**
 * The concrete model a raw `-m` value / stored default actually runs as:
 * family alias → install default, pinned alias → its id, bare opus id → [1m].
 * Non-Claude values (codex `gpt-*`, opencode slugs) pass through untouched —
 * no family key collides with them.
 */
export function resolveEffectiveModel(raw: string): string {
  const key = raw.toLowerCase();
  const family = Object.hasOwn(FAMILY_DEFAULTS, key)
    ? FAMILY_DEFAULTS[key]
    : Object.hasOwn(CODEX_FAMILY_DEFAULTS, key)
      ? CODEX_FAMILY_DEFAULTS[key]
      : undefined;
  return resolveModelAlias(family ?? raw);
}

const VALID_MODEL_RE =
  // The haiku branch carries an OPTIONAL trailing date segment: Anthropic
  // ships haiku ids dated (`claude-haiku-4-5-20251001`) and DEFAULT_HAIKU_MODEL
  // above IS that dated form. Without it this regex rejected the fork's own
  // constant — so `-m haiku`, which resolveEffectiveModel maps to that id,
  // failed validation and fell through to the opus default at the spawn seam,
  // silently running Opus for a group that asked for Haiku.
  /^(?:opus|sonnet|haiku|fable|default|claude-opus-\d+(?:-\d+)?(?:\[\dm\])?|claude-haiku-\d+-\d+(?:-\d+)?(?:\[\dm\])?|claude-sonnet-\d+(?:\[\dm\])?|claude-fable-\d+(?:-\d+)?(?:\[\dm\])?)$/;

/**
 * Opus is only supported in its 1M-context form in this fork. Auto-append
 * `[1m]` to a bare `claude-opus-X-Y` id. This is load-bearing for the
 * compaction window: the Claude Code CLI grants the 1M auto-compact window
 * deterministically only when the model id literally carries `[1m]`
 * (`PG(model) = /\[1m\]/.test(model)` in the bundle). The bare-id fallback
 * routes through a `firstParty && ANTHROPIC_BASE_URL===api.anthropic.com`
 * gate (`Ee`/`S1`); under proxy auth (OneCLI gateway) that gate is false, so a
 * bare opus id silently collapses to a 200k window and force-compacts long
 * sessions (observed: an opus session auto-compacted at 372k instead of ~784k).
 * Appending `[1m]` makes the 1M window unconditional regardless of auth path.
 * No-op for aliases (`opus`), non-opus ids, or ids that already carry a
 * `[Nm]` suffix.
 */
export function ensureOpus1mSuffix(model: string): string {
  // Fable shares the opus 1M-only policy and now spans both version schemes
  // too: claude-fable-5 (single-digit) and claude-fable-5-1 (two-segment).
  // Opus itself spans both version schemes: claude-opus-4-8 and claude-opus-5.
  return /^claude-(?:opus-\d+(?:-\d+)?|fable-\d+(?:-\d+)?)$/i.test(model) ? `${model}[1m]` : model;
}

export function resolveModelAlias(raw: string): string {
  const mapped = MODEL_ALIAS_MAP[raw.toLowerCase()] ?? raw;
  return ensureOpus1mSuffix(mapped);
}

/**
 * Per-model effort support matrix. Derived from the Anthropic effort docs
 * (https://platform.claude.com/docs/en/build-with-claude/effort) plus the
 * SDK's own ModelInfo.supportedEffortLevels. Update when a new model ships.
 *
 * The matrix deliberately keys on family alias AND on the full concrete id
 * so both `-m haiku` and `-m claude-haiku-4-5` validate identically.
 */
const MODEL_EFFORT_SUPPORT: Record<string, ReadonlySet<EffortLevel>> = {
  // Haiku: no effort control at the API level (effort is a no-op for this family).
  haiku: new Set(),
  'claude-haiku-4-5': new Set(),
  // The DATED id `haiku` resolves to (DEFAULT_HAIKU_MODEL). Keyed explicitly:
  // a lookup miss returns undefined, which callers read as "no matrix for this
  // model, do not clamp" — the opposite of Haiku's actual empty set, and the
  // difference between refusing an effort and sending one to a model that has
  // no effort control at all.
  'claude-haiku-4-5-20251001': new Set(),
  // Bare `sonnet` resolves to Sonnet 5 (DEFAULT_SONNET_MODEL) — full surface
  // incl. xhigh. (Sonnet 4.x is not used in this fork.)
  sonnet: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  'claude-sonnet-5': new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  // Opus 4.6: low | medium | high | max. Only the 1M-context variant is
  // supported in this fork — bare `claude-opus-4-6` gets auto-promoted to
  // `[1m]` in resolveModelAlias.
  'claude-opus-4-6[1m]': new Set(['low', 'medium', 'high', 'max']),
  // Opus 4.7: adds xhigh. Same 1M-only policy as 4.6.
  opus: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  'claude-opus-4-7[1m]': new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  // Opus 4.8: same effort surface as 4.7 (xhigh from 4.7+, max from 4.6+).
  // Same 1M-only policy. Bare `opus` resolves here once DEFAULT_OPUS_MODEL
  // points at 4.8 (container-runner.ts).
  'claude-opus-4-8[1m]': new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  // Opus 5: full effort ladder (low | medium | high | xhigh | max).
  'claude-opus-5[1m]': new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  // Opus 5.5: same full ladder. Bare `opus` resolves here (DEFAULT_OPUS_MODEL).
  'claude-opus-5-5[1m]': new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  // Bare `fable` resolves to DEFAULT_FABLE_MODEL (Fable 5.1) — same surface.
  fable: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  // Fable 5: full effort surface (docs/en/build-with-claude/effort, verified
  // 2026-06-09). Adaptive thinking is ALWAYS ON for fable — `disabled` is
  // rejected by the API — so effort is the only depth control.
  'claude-fable-5[1m]': new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  // Fable 5.1 (GA 2026-09-01): same effort surface as Fable 5 — adaptive
  // thinking is always on, effort is the only depth control.
  'claude-fable-5-1[1m]': new Set(['low', 'medium', 'high', 'xhigh', 'max']),
};

// ── Per-provider flag vocabulary ────────────────────────────────────────────
// `-m`/`-e` values are provider-specific: a codex group must accept gpt-5.5
// and reject claude-fable-5, and vice versa. Before this table existed the
// parser was Claude-only, which produced two bugs on codex groups (observed
// live 2026-06-10, example-market-codex): `-m fable` was acked and stored as
// sticky_model — then silently ignored by the codex provider — while
// `-m gpt-5.5` (the model actually running) was rejected as unknown.

/** Current Codex reasoning-effort surface — mirrors `codexConfigSchema` in the agent-runner. */
const CODEX_VALID_EFFORT: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

/** Convenience aliases for codex model ids (typo-tolerant dot forms). */
const CODEX_MODEL_ALIAS_MAP: Record<string, string> = {
  'gpt5.5': 'gpt-5.5',
  'gpt5.2-codex': 'gpt-5.2-codex',
  'gpt5.6-sol': 'gpt-5.6-sol',
  'gpt5.6-terra': 'gpt-5.6-terra',
  'gpt5.6-luna': 'gpt-5.6-luna',
  'gpt6-astra': 'gpt-6-astra',
  'gpt6-sol': 'gpt-6-sol',
  'gpt6-luna': 'gpt-6-luna',
  // The bare family names (sol, luna, astra, terra) are NOT here: they are
  // stored as typed and resolved at use (CODEX_FAMILY_DEFAULTS above).
};

/**
 * Codex model ids are pattern-validated (`gpt-*`), not allowlisted: OpenAI
 * ships new ids frequently and the codex app-server is the real authority —
 * a well-formed-but-nonexistent id fails loudly at turn/start. The pattern
 * exists to catch cross-provider mistakes (claude ids on a codex group),
 * not to track OpenAI's catalog.
 */
const CODEX_VALID_MODEL_RE = /^gpt-[a-z0-9][a-z0-9.-]*$/;

export interface ProviderFlagVocab {
  resolveModel(raw: string): string;
  isValidModel(resolved: string): boolean;
  /** Appended to the unknown-model error so the user learns the right shape. */
  modelHint: string;
  validEfforts: ReadonlySet<string>;
  /** The `(expected …)` list in the unknown-effort error. */
  effortHint: string;
  /** ultracode is a Claude Agent SDK feature; other providers reject it. */
  allowsUltracode: boolean;
  /** Fast mode is a Codex service tier; other providers reject it. */
  allowsFast: boolean;
  /** Per-model effort matrix, or undefined when the provider has none. */
  effortSupportFor(model: string): ReadonlySet<EffortLevel> | undefined;
}

const CLAUDE_VOCAB: ProviderFlagVocab = {
  resolveModel: (raw) => resolveModelAlias(raw),
  isValidModel: (resolved) => VALID_MODEL_RE.test(resolved),
  modelHint: '',
  validEfforts: VALID_EFFORT,
  effortHint: 'low|medium|high|xhigh|max|ultracode',
  allowsUltracode: true,
  allowsFast: false,
  effortSupportFor: (model) => MODEL_EFFORT_SUPPORT[model],
};

const CODEX_VOCAB: ProviderFlagVocab = {
  resolveModel: (raw) => CODEX_MODEL_ALIAS_MAP[raw.toLowerCase()] ?? raw.toLowerCase(),
  isValidModel: (resolved) => CODEX_VALID_MODEL_RE.test(resolved) || Object.hasOwn(CODEX_FAMILY_DEFAULTS, resolved),
  modelHint: ' (codex models look like gpt-6-sol, gpt-5.5; family aliases that follow bumps: luna|terra|sol|astra)',
  validEfforts: CODEX_VALID_EFFORT,
  effortHint: 'low|medium|high|xhigh|max|ultra',
  allowsUltracode: false,
  allowsFast: true,
  effortSupportFor: () => undefined,
};

/**
 * OpenCode effort enum: `low | medium | high | max`. These are the reasoning
 * variants OpenCode itself exposes (its model-variant picker offers exactly
 * Default/low/medium/high/max). `max` is real and supported by some models
 * (e.g. DeepSeek V4 Pro/Flash); it is NOT universally supported (Kimi/GLM and
 * others 400 on it), but — like model slugs — we accept the shape and let the
 * upstream fail loudly on a model that doesn't support it, rather than silently
 * downgrading and making `max` unreachable on the models that DO support it.
 * `xhigh`/`none`/`minimal` are NOT OpenCode levels and are rejected.
 */
const OPENCODE_VALID_EFFORT: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'max']);

/**
 * OpenCode model slugs are `<provider>/<id…>` (e.g. `opencode-go/kimi-k2.7-code`,
 * `opencode/gpt-5.5`, `nvidia/meta/llama-3.3-70b-instruct`). The provider
 * prefix is REQUIRED — the container derives the routing provider from it, and
 * the `/` cleanly rejects claude aliases (`opus`) and codex ids (`gpt-5.5`)
 * mistakenly aimed at an opencode group. The live catalog is huge and only
 * enumerable in-container (`opencode models` / the `list_models` MCP tool), so
 * — exactly like codex — we shape-validate here and let the opencode server
 * fail loudly on a well-formed-but-nonexistent slug. The pattern catches
 * cross-provider mistakes, it does not track the catalog.
 */
const OPENCODE_VALID_MODEL_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/i;

/**
 * Shape check for an opencode model slug (provider-prefixed `<provider>/<id…>`).
 * Exported so the `change_model` self-mod path can reject a bare/malformed slug
 * (e.g. `kimi-k2.7-code`) before persisting it — the host would otherwise derive
 * `provider='opencode-go'` for an unprefixed id and the restarted container
 * couldn't resolve the model. Same regex the `-m` flag path validates against,
 * keeping one source of truth.
 */
export function isOpenCodeModelSlug(slug: string): boolean {
  return OPENCODE_VALID_MODEL_RE.test(slug.trim());
}

const OPENCODE_VOCAB: ProviderFlagVocab = {
  resolveModel: (raw) => raw.trim(),
  // Delegate to isOpenCodeModelSlug so the `-m` flag path and the change_model
  // self-mod path share ONE shape predicate (not just the bare regex constant).
  isValidModel: (resolved) => isOpenCodeModelSlug(resolved),
  modelHint:
    ' (opencode slugs are provider-prefixed, e.g. opencode-go/kimi-k2.7-code or nvidia/meta/llama-3.3-70b-instruct — ask the agent to run list_models for exact ids)',
  validEfforts: OPENCODE_VALID_EFFORT,
  effortHint: 'low|medium|high|max',
  allowsUltracode: false,
  allowsFast: false,
  effortSupportFor: () => undefined,
};

/**
 * Vocabulary lookup. Each agent harness validates `-m`/`-e` against its own
 * model ids and effort enum; unknown providers fall back to the Claude
 * vocabulary (the safe pre-provider-aware default). OpenCode validates slug
 * SHAPE only (the live model list lives in-container; see list_models MCP).
 */
/**
 * The flag vocabulary for a provider — model alias resolution, model/effort
 * validity, and the per-model effort-support matrix.
 *
 * Exported so the spawn path can validate what it exports into a provider's
 * container env against the SAME tables the chat `-m`/`-e` parser uses. Two
 * parallel notions of "a valid claude model" is exactly how a codex model id
 * carried across a `--provider` switch reaches the Anthropic API.
 */
export function vocabFor(provider: string): ProviderFlagVocab {
  if (provider === 'codex') return CODEX_VOCAB;
  if (provider === 'opencode') return OPENCODE_VOCAB;
  return CLAUDE_VOCAB;
}

/** Structured representation of a parsed flag set. Empty object = no flags. */
export interface FlagIntent {
  stickyModel?: string;
  clearStickyModel?: boolean;
  turnModel?: string;
  stickyEffort?: string;
  clearStickyEffort?: boolean;
  turnEffort?: string;
  /**
   * Ultracode (xhigh + standing dynamic-workflow orchestration), set via
   * `-e ultracode` / `-e1 ultracode`. Rides alongside effort (which is forced
   * to xhigh), NOT inside it. `stickyUltracode=false` is emitted by a normal
   * `-e <level>` to explicitly turn ultracode off; `clearStickyUltracode` by
   * `-e ''`. Claude-only — other providers ignore it.
   */
  stickyUltracode?: boolean;
  clearStickyUltracode?: boolean;
  turnUltracode?: boolean;
  /** Codex fast service tier. False is explicit and must remain distinguishable from unset. */
  stickyFast?: boolean;
  turnFast?: boolean;
}

export interface FlagParseResult {
  /** Structured flag intent, or undefined if the text contained no flags. */
  intent?: FlagIntent;
  /**
   * Message text with the mention prefix and every recognized flag stripped.
   * Empty string means the user's whole message was flags only (valid — this
   * is what a `/switch` invocation or a bare `-m haiku` looks like).
   */
  cleanedText: string;
  /** Human-readable warnings (e.g. model/effort mismatch). Not fatal. */
  warnings: string[];
  /** Fatal errors (e.g. invalid model id). The caller should reject the flag. */
  errors: string[];
}

const MENTION_PREFIX_RE = /^\s*(?:<@!?[^>]+>|@[\w.-]+)\s*/;
const SWITCH_COMMAND_RE = /^\s*\/switch(?:\s+|$)/i;
const FLAG_TOKEN_RE = /^\s*(-[mef]1?)\s+("([^"]*)"|'([^']*)'|(\S*))\s*/;

/**
 * Parse mention + flags from the front of the message text. Always returns a
 * result — callers inspect `intent`, `warnings`, `errors` to decide behavior.
 *
 * `provider` selects the flag vocabulary (model ids, effort enum, ultracode
 * availability) for the agent group the message targets. Defaults to claude
 * — the safe choice for every pre-existing call site.
 */
export function parseMessageFlags(rawText: string, provider: string = 'claude'): FlagParseResult {
  const vocab = vocabFor(provider);
  let cursor = rawText.replace(MENTION_PREFIX_RE, '').replace(SWITCH_COMMAND_RE, '');

  const intent: FlagIntent = {};
  const warnings: string[] = [];
  const errors: string[] = [];

  for (;;) {
    const m = cursor.match(FLAG_TOKEN_RE);
    if (!m) break;
    const flag = m[1];
    // m[3] = double-quoted value, m[4] = single-quoted, m[5] = unquoted
    const rawValue = m[3] ?? m[4] ?? m[5] ?? '';
    cursor = cursor.slice(m[0].length);

    switch (flag) {
      case '-m': {
        if (rawValue === '') {
          intent.clearStickyModel = true;
        } else {
          const resolved = vocab.resolveModel(rawValue);
          if (vocab.isValidModel(resolved)) intent.stickyModel = resolved;
          else errors.push(`unknown model: ${rawValue}${vocab.modelHint}`);
        }
        break;
      }
      case '-m1': {
        if (rawValue === '') {
          errors.push(`-m1 requires a value (use -m '' to clear sticky)`);
        } else {
          const resolved = vocab.resolveModel(rawValue);
          if (vocab.isValidModel(resolved)) intent.turnModel = resolved;
          else errors.push(`unknown model: ${rawValue}${vocab.modelHint}`);
        }
        break;
      }
      case '-e': {
        if (rawValue === '') {
          intent.clearStickyEffort = true;
          intent.clearStickyUltracode = true;
        } else if (rawValue.toLowerCase() === ULTRACODE) {
          if (vocab.allowsUltracode) {
            // ultracode = xhigh effort + dynamic-workflow orchestration. Force
            // effort to xhigh and flip the separate ultracode flag on.
            intent.stickyEffort = 'xhigh';
            intent.stickyUltracode = true;
          } else {
            errors.push(`ultracode is Claude-only — this is a ${provider} agent (expected ${vocab.effortHint})`);
          }
        } else if (vocab.validEfforts.has(rawValue)) {
          intent.stickyEffort = rawValue;
          // No ultracode field emitted here — a plain effort change implicitly
          // turns ultracode off, inferred container-side from stickyEffort being
          // set without stickyUltracode. Keeps the intent minimal.
        } else {
          errors.push(`unknown effort level: ${rawValue} (expected ${vocab.effortHint})`);
        }
        break;
      }
      case '-e1': {
        if (rawValue === '') {
          errors.push(`-e1 requires a value (use -e '' to clear sticky)`);
        } else if (rawValue.toLowerCase() === ULTRACODE) {
          if (vocab.allowsUltracode) {
            intent.turnEffort = 'xhigh';
            intent.turnUltracode = true;
          } else {
            errors.push(`ultracode is Claude-only — this is a ${provider} agent (expected ${vocab.effortHint})`);
          }
        } else if (vocab.validEfforts.has(rawValue)) {
          intent.turnEffort = rawValue;
        } else {
          errors.push(`unknown effort level: ${rawValue} (expected ${vocab.effortHint})`);
        }
        break;
      }
      case '-f':
      case '-f1': {
        if (!vocab.allowsFast) {
          errors.push(`fast mode is Codex-only — this is a ${provider} agent`);
          break;
        }
        const normalized = rawValue.toLowerCase();
        if (normalized !== 'on' && normalized !== 'off') {
          errors.push(`${flag} expects on|off`);
          break;
        }
        const enabled = normalized === 'on';
        if (flag === '-f') intent.stickyFast = enabled;
        else intent.turnFast = enabled;
        break;
      }
    }
  }

  const modelForValidation = intent.turnModel ?? intent.stickyModel;
  const effortForValidation = intent.turnEffort ?? intent.stickyEffort;
  if (modelForValidation && effortForValidation) {
    const supported = vocab.effortSupportFor(modelForValidation);
    if (supported && !supported.has(effortForValidation as EffortLevel)) {
      if (supported.size === 0) {
        warnings.push(`${modelForValidation} doesn't support effort — applied model, skipped effort`);
      } else {
        warnings.push(
          `${modelForValidation} doesn't support effort=${effortForValidation} (supported: ${[...supported].join(', ')}) — skipped effort`,
        );
      }
      delete intent.stickyEffort;
      delete intent.turnEffort;
      delete intent.clearStickyEffort;
      // ultracode requires an xhigh-capable model; if the chosen model can't
      // do the (xhigh) effort, ultracode can't apply either — drop it too.
      if (intent.stickyUltracode || intent.turnUltracode) {
        warnings.push(`ultracode needs an xhigh-capable model (e.g. opus) — skipped`);
        delete intent.stickyUltracode;
        delete intent.turnUltracode;
      }
    }
  }

  const hasIntent =
    intent.stickyModel !== undefined ||
    intent.turnModel !== undefined ||
    intent.stickyEffort !== undefined ||
    intent.turnEffort !== undefined ||
    intent.stickyUltracode !== undefined ||
    intent.turnUltracode !== undefined ||
    intent.stickyFast !== undefined ||
    intent.turnFast !== undefined ||
    intent.clearStickyModel === true ||
    intent.clearStickyEffort === true ||
    intent.clearStickyUltracode === true;

  return {
    intent: hasIntent ? intent : undefined,
    cleanedText: cursor,
    warnings,
    errors,
  };
}

/**
 * Render a stored model value as the fully-qualified id it will actually run
 * as. A bare family alias (`opus`) is stored unresolved on purpose so it keeps
 * tracking the install default, but echoing it back tells the user nothing
 * about which model they got — so resolve it here and name the alias that
 * produced it, keeping "pinned to a version" visibly distinct from "tracks the
 * family default".
 */
function describeModel(stored: string): string {
  const effective = resolveEffectiveModel(stored);
  return effective === stored ? effective : `${effective} (via ${stored})`;
}

/**
 * Format a structured FlagIntent + warnings/errors into the chat-visible
 * confirmation line. Called by the router to emit an immediate reply.
 */
export function formatFlagConfirmation(intent: FlagIntent, warnings: string[], errors: string[]): string {
  const parts: string[] = [];

  if (intent.clearStickyModel) {
    parts.push('sticky model cleared');
  } else if (intent.stickyModel) {
    parts.push(`model → ${describeModel(intent.stickyModel)}`);
  }
  if (intent.turnModel) {
    parts.push(`model (this turn) → ${describeModel(intent.turnModel)}`);
  }
  if (intent.clearStickyEffort) {
    parts.push('sticky effort cleared');
  } else if (intent.stickyUltracode) {
    // ultracode subsumes effort (it forces xhigh) — show it instead of "effort → xhigh".
    parts.push('ultracode ON (xhigh + dynamic workflows)');
  } else if (intent.stickyEffort) {
    parts.push(`effort → ${intent.stickyEffort}`);
  }
  if (intent.turnUltracode) {
    parts.push('ultracode this turn (xhigh + dynamic workflows)');
  } else if (intent.turnEffort) {
    parts.push(`effort (this turn) → ${intent.turnEffort}`);
  }
  if (intent.stickyFast !== undefined) {
    parts.push(`fast mode → ${intent.stickyFast ? 'ON' : 'OFF'}`);
  }
  if (intent.turnFast !== undefined) {
    parts.push(`fast mode (this turn) → ${intent.turnFast ? 'ON' : 'OFF'}`);
  }

  const suffix: string[] = [];
  for (const w of warnings) suffix.push(`⚠️ ${w}`);
  for (const e of errors) suffix.push(`❌ ${e}`);

  const prefix = parts.length > 0 ? `⚙️ ${parts.join(', ')}` : '';
  if (prefix && suffix.length > 0) return [prefix, ...suffix].join('\n');
  if (prefix) return prefix;
  if (suffix.length > 0) return suffix.join('\n');
  return '';
}
