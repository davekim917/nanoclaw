/**
 * Model/effort flag parser — single source of truth.
 *
 * Replaces the sync-burden of parallel regex-based parsers in router.ts and
 * container/agent-runner. Called once at the router boundary; the result is
 * attached to the inbound message as structured metadata so no downstream
 * code has to re-parse text.
 *
 * Supports two invocation shapes:
 *   1. Inline prefix: `-m haiku -e low <prompt>` — flags strip away, prompt
 *      flows to the agent with clean text.
 *   2. Standalone `/switch` command: `/switch -m haiku -e low` — no prompt,
 *      host emits a canned confirmation directly, no agent turn runs.
 *
 * Flag vocabulary (matches prior parseModelEffortFlags behavior):
 *   -m   <value>   sticky model (persists across turns in this session)
 *   -m1  <value>   one-turn model (overrides sticky for this turn only)
 *   -e   <value>   sticky effort
 *   -e1  <value>   one-turn effort
 *   -m   ''         clear sticky model (explicit empty value)
 *   -e   ''         clear sticky effort
 *
 * Platform mentions are stripped before parsing so Discord `<@BOTID>`,
 * Discord nickname `<@!BOTID>`, raw-Slack `<@UID>`, and chat-sdk-stripped
 * `@UID` all behave the same.
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

const VALID_MODEL_RE =
  /^(?:opus|sonnet|haiku|default|claude-(?:opus|sonnet|haiku)-\d+-\d+(?:\[\dm\])?)$/;

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
  // Strip any leading platform mention token. Mentions never carry semantic
  // flag info; keeping them would re-introduce the ^-anchor fragility.
  let cursor = rawText.replace(MENTION_PREFIX_RE, '');
  // Accept an optional `/switch` prefix so the same parser drives both the
  // inline form (`-m haiku <prompt>`) and the standalone form
  // (`/switch -m haiku`). Stripping it here means downstream code doesn't
  // need a separate command-dispatch path.
  cursor = cursor.replace(SWITCH_COMMAND_RE, '');

  const intent: FlagIntent = {};
  const warnings: string[] = [];
  const errors: string[] = [];

  // Consume flags greedily until the next non-flag token.
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

  // Validate compatibility: haiku doesn't support effort. If the user asked
  // for model=haiku + effort=anything, drop the effort and warn.
  const modelForValidation = intent.turnModel ?? intent.stickyModel;
  const effortForValidation = intent.turnEffort ?? intent.stickyEffort;
  if (modelForValidation && effortForValidation) {
    const supported = MODEL_EFFORT_SUPPORT[modelForValidation];
    if (supported && !supported.has(effortForValidation as EffortLevel)) {
      if (supported.size === 0) {
        warnings.push(
          `${modelForValidation} doesn't support effort — applied model, skipped effort`,
        );
      } else {
        warnings.push(
          `${modelForValidation} doesn't support effort=${effortForValidation} (supported: ${[...supported].join(', ')}) — skipped effort`,
        );
      }
      // Drop the effort directive so downstream doesn't try to apply it.
      delete intent.stickyEffort;
      delete intent.turnEffort;
      delete intent.clearStickyEffort;
    }
  }

  // Empty-intent check: if nothing was actually set, return undefined so
  // the caller skips all the flag-handling plumbing.
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
