/**
 * Model/effort flag parser. Called at the router boundary; the result is
 * attached to inbound content as structured metadata, so downstream code
 * never re-parses text.
 *
 * Flag vocabulary:
 *   -m   <value>   sticky model (persists across turns)
 *   -m1  <value>   one-turn model override
 *   -e   <value>   sticky effort
 *   -e1  <value>   one-turn effort override
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
 * Model alias → concrete id. Bare aliases (`opus`, `sonnet`, `haiku`) are
 * SDK-native "current default in family"; the pinned aliases (`opus4-7`,
 * etc.) force a specific version regardless of SDK default drift.
 */
const MODEL_ALIAS_MAP: Record<string, string> = {
  opus46: 'claude-opus-4-6[1m]',
  'opus4-6': 'claude-opus-4-6[1m]',
  opus47: 'claude-opus-4-7',
  'opus4-7': 'claude-opus-4-7',
  sonnet46: 'claude-sonnet-4-6',
  'sonnet4-6': 'claude-sonnet-4-6',
  sonnet47: 'claude-sonnet-4-7',
  'sonnet4-7': 'claude-sonnet-4-7',
  haiku45: 'claude-haiku-4-5',
  'haiku4-5': 'claude-haiku-4-5',
};

const VALID_MODEL_RE = /^(?:opus|sonnet|haiku|default|claude-(?:opus|sonnet|haiku)-\d+-\d+(?:\[\dm\])?)$/;

function resolveModelAlias(raw: string): string {
  return MODEL_ALIAS_MAP[raw.toLowerCase()] ?? raw;
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
  // Sonnet 4.6 supports low | medium | high | max (no xhigh).
  sonnet: new Set(['low', 'medium', 'high', 'max']),
  'claude-sonnet-4-6': new Set(['low', 'medium', 'high', 'max']),
  'claude-sonnet-4-7': new Set(['low', 'medium', 'high', 'max']),
  // Opus 4.6: low | medium | high | max.
  'claude-opus-4-6[1m]': new Set(['low', 'medium', 'high', 'max']),
  'claude-opus-4-6': new Set(['low', 'medium', 'high', 'max']),
  // Opus 4.7: adds xhigh.
  opus: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  'claude-opus-4-7': new Set(['low', 'medium', 'high', 'xhigh', 'max']),
};

/** Structured representation of a parsed flag set. Empty object = no flags. */
export interface FlagIntent {
  stickyModel?: string;
  clearStickyModel?: boolean;
  turnModel?: string;
  stickyEffort?: string;
  clearStickyEffort?: boolean;
  turnEffort?: string;
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
const FLAG_TOKEN_RE = /^\s*(-[me]1?)\s+("([^"]*)"|'([^']*)'|(\S*))\s*/;

/**
 * Parse mention + flags from the front of the message text. Always returns a
 * result — callers inspect `intent`, `warnings`, `errors` to decide behavior.
 */
export function parseMessageFlags(rawText: string): FlagParseResult {
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
          const resolved = resolveModelAlias(rawValue);
          if (VALID_MODEL_RE.test(resolved)) intent.stickyModel = resolved;
          else errors.push(`unknown model: ${rawValue}`);
        }
        break;
      }
      case '-m1': {
        if (rawValue === '') {
          errors.push(`-m1 requires a value (use -m '' to clear sticky)`);
        } else {
          const resolved = resolveModelAlias(rawValue);
          if (VALID_MODEL_RE.test(resolved)) intent.turnModel = resolved;
          else errors.push(`unknown model: ${rawValue}`);
        }
        break;
      }
      case '-e': {
        if (rawValue === '') {
          intent.clearStickyEffort = true;
        } else if (VALID_EFFORT.has(rawValue)) {
          intent.stickyEffort = rawValue;
        } else {
          errors.push(`unknown effort level: ${rawValue} (expected low|medium|high|xhigh|max)`);
        }
        break;
      }
      case '-e1': {
        if (rawValue === '') {
          errors.push(`-e1 requires a value (use -e '' to clear sticky)`);
        } else if (VALID_EFFORT.has(rawValue)) {
          intent.turnEffort = rawValue;
        } else {
          errors.push(`unknown effort level: ${rawValue}`);
        }
        break;
      }
    }
  }

  const modelForValidation = intent.turnModel ?? intent.stickyModel;
  const effortForValidation = intent.turnEffort ?? intent.stickyEffort;
  if (modelForValidation && effortForValidation) {
    const supported = MODEL_EFFORT_SUPPORT[modelForValidation];
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
    }
  }

  const hasIntent =
    intent.stickyModel !== undefined ||
    intent.turnModel !== undefined ||
    intent.stickyEffort !== undefined ||
    intent.turnEffort !== undefined ||
    intent.clearStickyModel === true ||
    intent.clearStickyEffort === true;

  return {
    intent: hasIntent ? intent : undefined,
    cleanedText: cursor,
    warnings,
    errors,
  };
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
    parts.push(`model → ${intent.stickyModel}`);
  }
  if (intent.turnModel) {
    parts.push(`model (this turn) → ${intent.turnModel}`);
  }
  if (intent.clearStickyEffort) {
    parts.push('sticky effort cleared');
  } else if (intent.stickyEffort) {
    parts.push(`effort → ${intent.stickyEffort}`);
  }
  if (intent.turnEffort) {
    parts.push(`effort (this turn) → ${intent.turnEffort}`);
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
