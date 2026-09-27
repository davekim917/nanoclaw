/**
 * Model/effort/fast-mode flag parser, run at the router boundary; the result rides inbound content as structured
 * metadata so downstream code never re-parses text.
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
 * Inline prefix (`-m haiku <prompt>`) strips the flags; standalone (`/switch -m haiku`) has no prompt.
 */

type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const VALID_EFFORT: ReadonlySet<string> = new Set<EffortLevel>(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * NOT an SDK effort level: a session flag (xhigh plus standing dynamic-workflow orchestration) accepted as a `-e`
 * pseudo-value and translated to `effort=xhigh` plus a separate `ultracode` boolean. Claude-only.
 */
const ULTRACODE = 'ultracode';

/** Pinned aliases force a version; bare family words are FAMILY_DEFAULTS, resolved at use. */
const MODEL_ALIAS_MAP: Record<string, string> = {
  opus46: 'claude-opus-4-6[1m]',
  'opus4-6': 'claude-opus-4-6[1m]',
  opus47: 'claude-opus-4-7[1m]',
  'opus4-7': 'claude-opus-4-7[1m]',
  opus48: 'claude-opus-4-8[1m]',
  'opus4-8': 'claude-opus-4-8[1m]',
  // `[1m]` pinned even though 1M is the default: the CLI grants the 1M compact window only when the id carries it.
  opus5: 'claude-opus-5[1m]',
  'opus-5': 'claude-opus-5[1m]',
  // Needs claude-code >= 2.1.280.
  opus55: 'claude-opus-5-5[1m]',
  'opus5-5': 'claude-opus-5-5[1m]',
  'opus-5-5': 'claude-opus-5-5[1m]',
  // $10/$50 per MTok: opt-in via flag, never a default.
  fable51: 'claude-fable-5-1[1m]',
  'fable5-1': 'claude-fable-5-1[1m]',
  'fable-5-1': 'claude-fable-5-1[1m]',
  fable5: 'claude-fable-5[1m]',
  'fable-5': 'claude-fable-5[1m]',
  // Always 1M on the API with no [1m] variant, so no suffix.
  sonnet5: 'claude-sonnet-5',
  'sonnet-5': 'claude-sonnet-5',
  haiku45: 'claude-haiku-4-5',
  'haiku4-5': 'claude-haiku-4-5',
};

// Single source of truth for what `opus`/`sonnet`/`haiku` mean: the spawn env (ANTHROPIC_DEFAULT_*_MODEL) and the
// chat ack both read these. Per-channel, per-group and per-session layers override on top.
export const DEFAULT_OPUS_MODEL = 'claude-opus-5-5[1m]';
export const DEFAULT_SONNET_MODEL = 'claude-sonnet-5';
export const DEFAULT_HAIKU_MODEL = 'claude-haiku-4-5-20251001';
export const DEFAULT_FABLE_MODEL = 'claude-fable-5-1[1m]';

/**
 * Deliberately NOT in MODEL_ALIAS_MAP: a stored `opus` tracks the family default across bumps, `opus5` freezes.
 * Resolved at USE (spawn env, chat ack), never at storage.
 */
const FAMILY_DEFAULTS: Record<string, string> = {
  opus: DEFAULT_OPUS_MODEL,
  sonnet: DEFAULT_SONNET_MODEL,
  haiku: DEFAULT_HAIKU_MODEL,
  fable: DEFAULT_FABLE_MODEL,
};

/**
 * Codex family aliases → newest model of that family, resolved at use like the Claude families. Codex has no
 * alias mechanism, so the runner receives this map as NANOCLAW_CODEX_MODEL_ALIASES.
 */
export const CODEX_FAMILY_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  sol: 'gpt-6-sol',
  luna: 'gpt-6-luna',
  astra: 'gpt-6-astra',
  terra: 'gpt-5.6-terra',
});

/**
 * Family alias of either provider → install default, pinned alias → its id, bare opus id → [1m]. Other
 * non-Claude values pass through untouched.
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
  // Haiku ids carry an optional date segment: DEFAULT_HAIKU_MODEL is dated, and rejecting it silently ran Opus.
  /^(?:opus|sonnet|haiku|fable|default|claude-opus-\d+(?:-\d+)?(?:\[\dm\])?|claude-haiku-\d+-\d+(?:-\d+)?(?:\[\dm\])?|claude-sonnet-\d+(?:\[\dm\])?|claude-fable-\d+(?:-\d+)?(?:\[\dm\])?)$/;

/**
 * Append `[1m]` to a bare opus/fable id. Load-bearing: the CLI grants the 1M auto-compact window unconditionally
 * only when the id carries `[1m]`; under proxy auth (OneCLI) a bare id collapses to 200k and force-compacts.
 */
export function ensureOpus1mSuffix(model: string): string {
  return /^claude-(?:opus-\d+(?:-\d+)?|fable-\d+(?:-\d+)?)$/i.test(model) ? `${model}[1m]` : model;
}

export function resolveModelAlias(raw: string): string {
  const mapped = MODEL_ALIAS_MAP[raw.toLowerCase()] ?? raw;
  return ensureOpus1mSuffix(mapped);
}

/**
 * Per-model effort support (Anthropic effort docs plus SDK ModelInfo.supportedEffortLevels); update when a model
 * ships. Keyed on both family alias and concrete id so `-m haiku` and `-m claude-haiku-4-5` validate alike.
 */
const MODEL_EFFORT_SUPPORT: Record<string, ReadonlySet<EffortLevel>> = {
  haiku: new Set(),
  'claude-haiku-4-5': new Set(),
  // Keyed explicitly: a lookup miss means "do not clamp", the opposite of Haiku's empty set.
  'claude-haiku-4-5-20251001': new Set(),
  sonnet: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  'claude-sonnet-5': new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  'claude-opus-4-6[1m]': new Set(['low', 'medium', 'high', 'max']),
  opus: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  'claude-opus-4-7[1m]': new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  'claude-opus-4-8[1m]': new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  'claude-opus-5[1m]': new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  'claude-opus-5-5[1m]': new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  fable: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  // Fable: adaptive thinking is always on (`disabled` is rejected), so effort is the only depth control.
  'claude-fable-5[1m]': new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  'claude-fable-5-1[1m]': new Set(['low', 'medium', 'high', 'xhigh', 'max']),
};

// `-m`/`-e` vocabulary is per provider: a codex group must accept gpt-* and reject claude ids, and vice versa.

/** Mirrors `codexConfigSchema` in the agent-runner. */
const CODEX_VALID_EFFORT: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

const CODEX_MODEL_ALIAS_MAP: Record<string, string> = {
  'gpt5.5': 'gpt-5.5',
  'gpt5.2-codex': 'gpt-5.2-codex',
  'gpt5.6-sol': 'gpt-5.6-sol',
  'gpt5.6-terra': 'gpt-5.6-terra',
  'gpt5.6-luna': 'gpt-5.6-luna',
  'gpt6-astra': 'gpt-6-astra',
  'gpt6-sol': 'gpt-6-sol',
  'gpt6-luna': 'gpt-6-luna',
  // Bare family names are stored as typed and resolved at use (CODEX_FAMILY_DEFAULTS).
};

/** Shape only: the codex app-server is the authority; this catches cross-provider mistakes, not the catalog. */
const CODEX_VALID_MODEL_RE = /^gpt-[a-z0-9][a-z0-9.-]*$/;

export interface ProviderFlagVocab {
  resolveModel(raw: string): string;
  isValidModel(resolved: string): boolean;
  modelHint: string;
  validEfforts: ReadonlySet<string>;
  effortHint: string;
  allowsUltracode: boolean;
  allowsFast: boolean;
  effortSupportFor(model: string): ReadonlySet<EffortLevel> | undefined;
}

const CLAUDE_VOCAB: ProviderFlagVocab = {
  resolveModel: (raw) => {
    const key = raw.toLowerCase();
    return Object.hasOwn(FAMILY_DEFAULTS, key) ? key : resolveModelAlias(raw);
  },
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
 * OpenCode reasoning variants. `max` is accepted though some models 400 on it: failing loudly upstream beats
 * making it unreachable on the models that support it.
 */
const OPENCODE_VALID_EFFORT: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'max']);

/**
 * `<provider>/<id…>`: the prefix is required (the container routes on it) and rejects claude/codex ids. Shape
 * only; the opencode server fails loudly on a nonexistent slug.
 */
const OPENCODE_VALID_MODEL_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/i;

/** Also used by `change_model`: an unprefixed id would derive the wrong provider and fail to resolve. */
export function isOpenCodeModelSlug(slug: string): boolean {
  return OPENCODE_VALID_MODEL_RE.test(slug.trim());
}

const OPENCODE_VOCAB: ProviderFlagVocab = {
  resolveModel: (raw) => raw.trim(),
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
 * A provider's flag vocabulary; unknown providers get Claude's. The spawn path validates against the same tables
 * so a model id carried across a provider switch cannot reach the wrong API.
 */
export function vocabFor(provider: string): ProviderFlagVocab {
  if (provider === 'codex') return CODEX_VOCAB;
  if (provider === 'opencode') return OPENCODE_VOCAB;
  return CLAUDE_VOCAB;
}

export interface FlagIntent {
  stickyModel?: string;
  clearStickyModel?: boolean;
  turnModel?: string;
  stickyEffort?: string;
  clearStickyEffort?: boolean;
  turnEffort?: string;
  /**
   * `-e ultracode`: rides alongside effort (forced to xhigh). `false` comes from a plain `-e <level>`;
   * `clearStickyUltracode` from `-e ''`. Claude-only.
   */
  stickyUltracode?: boolean;
  clearStickyUltracode?: boolean;
  turnUltracode?: boolean;
  /** False is explicit and must remain distinguishable from unset. */
  stickyFast?: boolean;
  turnFast?: boolean;
}

export interface FlagParseResult {
  intent?: FlagIntent;
  /** Mention prefix and recognized flags stripped; empty means the message was flags only (valid). */
  cleanedText: string;
  warnings: string[];
  /** Fatal: the caller should reject the flag. */
  errors: string[];
}

const MENTION_PREFIX_RE = /^\s*(?:<@!?[^>]+>|@[\w.-]+)\s*/;
const SWITCH_COMMAND_RE = /^\s*\/switch(?:\s+|$)/i;
const FLAG_TOKEN_RE = /^\s*(-[mef]1?)\s+("([^"]*)"|'([^']*)'|(\S*))\s*/;

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
            intent.stickyEffort = 'xhigh';
            intent.stickyUltracode = true;
          } else {
            errors.push(`ultracode is Claude-only — this is a ${provider} agent (expected ${vocab.effortHint})`);
          }
        } else if (vocab.validEfforts.has(rawValue)) {
          intent.stickyEffort = rawValue;
          // A plain effort change turns ultracode off (inferred container-side from stickyEffort alone).
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
      // ultracode needs xhigh; a model that can't do it drops ultracode too.
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

/** A stored family alias resolved to the id it runs as, naming the alias so "pinned" and "tracks default" differ. */
function describeModel(stored: string): string {
  const effective = resolveEffectiveModel(stored);
  return effective === stored ? effective : `${effective} (via ${stored})`;
}

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
