import {
  DEFAULT_HAIKU_MODEL,
  DEFAULT_OPUS_MODEL,
  DEFAULT_SONNET_MODEL,
  resolveEffectiveModel,
  vocabFor,
} from './flag-parser.js';
import type { ContainerConfig } from './container-config.js';

/**
 * Per-model-family default effort, keyed on a RESOLVED concrete model id.
 *
 * MUST stay in sync with `defaultEffortForModel` in
 * `container/agent-runner/src/providers/claude.ts` — the agent-runner is a
 * separate Bun package and nothing is importable across the boundary.
 * `claude-spawn-defaults.test.ts` parses that function out of the container
 * source and fails on drift, so this is a checked mirror rather than a
 * comment-only contract.
 *
 * `undefined` means the family has NO effort control at the API level (haiku),
 * which is different from "not configured": the caller emits no
 * NANOCLAW_EFFORT_OVERRIDE for it rather than emitting an empty value.
 */
function defaultEffortForClaudeModel(model: string): string | undefined {
  const m = model.toLowerCase();
  if (m === 'opus' || m.startsWith('claude-opus-')) return 'high';
  if (m === 'sonnet' || m.startsWith('claude-sonnet-')) return 'xhigh';
  if (m.startsWith('claude-fable-')) return 'medium';
  if (m === 'haiku' || m.startsWith('claude-haiku-')) return undefined;
  return 'high';
}

/**
 * The container.json fields the claude spawn branch reads. `providerConfig` is
 * here for what it *prevents*, not what it contributes — see the derivation
 * gate in resolveClaudeSpawnDefaults.
 */
export type ClaudeSpawnConfig = Pick<
  ContainerConfig,
  'model' | 'effort' | 'defaultModel' | 'defaultEffort' | 'providerConfig'
>;

/** What the claude spawn branch will put in the container's environment. */
export interface ClaudeSpawnDefaults {
  /**
   * The RESOLVED concrete model id that lands in ANTHROPIC_DEFAULT_OPUS_MODEL:
   * family alias mapped, pinned alias mapped, `[1m]` applied.
   */
  model: string;
  /**
   * True when a layer actually chose `model`, false when it fell through to
   * the install-wide DEFAULT_OPUS_MODEL floor. Load-bearing — see the effort
   * derivation in resolveClaudeSpawnDefaults.
   */
  modelWasConfigured: boolean;
  /** Final effort, or undefined to emit no NANOCLAW_EFFORT_OVERRIDE at all. */
  effort: string | undefined;
  /** One message per value refused, for the caller to log. */
  drops: string[];
}

/**
 * Resolve the model + effort the claude spawn branch exports, and refuse
 * anything that is not valid Claude vocabulary for the resolved model.
 *
 * ## The chains
 *
 * Both walk the SAME three layers the codex branch reads:
 *
 *   per-channel wiring  →  `model` / `effort`  →  `defaultModel` / `defaultEffort`
 *
 * `model`/`effort` are the pair `ncl groups config update --model/--effort`
 * writes — it updates the `container_configs` DB row AND mirrors both into
 * `container.json` (`src/cli/resources/groups.ts`). `defaultModel`/
 * `defaultEffort` are the older hand-authored container.json fields, which
 * have no programmatic writer anywhere in the tree. Reading only the `default*`
 * pair made `ncl groups config update` a silent no-op for every claude group.
 * The codex branch never had that bug; opencode reads `container_configs.effort`
 * straight from the DB (`src/providers/opencode.ts`).
 *
 * ## Why validation lives HERE and not at the call site
 *
 * Two invariants, one seam, because they are the same invariant:
 *
 * 1. **Effort is derived from the RESOLVED model, never from the alias.** The
 *    container asks the SDK for the literal string `'opus'` on purpose — the
 *    bare alias is what forces resolution through ANTHROPIC_DEFAULT_OPUS_MODEL
 *    instead of the CLI's frozen built-in default (`claude.ts`, `rawModel`).
 *    So when nothing upstream picks an effort, the container computes
 *    `defaultEffortForModel('opus')` = `high` — correct only while the
 *    resolved model IS opus. Pin the model to Sonnet and it silently runs at
 *    `high` instead of Sonnet's `xhigh`; pin it to Haiku, which supports no
 *    effort at all, and every turn carries one. Only the host knows the
 *    resolved id, so only the host can derive the right default: when a layer
 *    chose the model, this function derives and the caller emits. When the
 *    model falls through to DEFAULT_OPUS_MODEL, the alias and the resolved id
 *    are the same family and the container's own derivation is provably
 *    identical, so nothing is emitted and the fleet baseline is unchanged.
 *
 * 2. **A value carried across a provider switch is not Claude vocabulary.**
 *    `ncl groups config update --provider claude` alone leaves the previous
 *    provider's `model`/`effort` in place, so the chains above can offer
 *    `gpt-5.6-sol` / `ultra`. NANOCLAW_EFFORT_OVERRIDE bypasses
 *    `claudeConfigSchema` entirely (it is read raw from `process.env` at query
 *    time), so nothing downstream would reject `ultra`. Each candidate is
 *    validated against the SAME tables the chat `-m`/`-e` parser uses
 *    (`vocabFor('claude')`), including the per-model effort-support matrix,
 *    and an invalid one is DROPPED so the next layer gets its turn — never
 *    passed through, never fatal.
 */
export function resolveClaudeSpawnDefaults(
  containerConfig: ClaudeSpawnConfig,
  channel: { model?: string | null; effort?: string | null } = {},
): ClaudeSpawnDefaults {
  const vocab = vocabFor('claude');
  const drops: string[] = [];

  const modelLayers: Array<[string, string | null | undefined]> = [
    ['channel wiring', channel.model],
    ['container.json model', containerConfig.model],
    ['container.json defaultModel', containerConfig.defaultModel],
  ];
  let model = DEFAULT_OPUS_MODEL;
  let modelWasConfigured = false;
  for (const [layer, raw] of modelLayers) {
    if (!raw) continue;
    const resolved = resolveEffectiveModel(raw);
    if (!vocab.isValidModel(resolved)) {
      drops.push(`model "${raw}" from ${layer} is not a Claude model — ignored`);
      continue;
    }
    model = resolved;
    modelWasConfigured = true;
    break;
  }

  const effortLayers: Array<[string, string | null | undefined]> = [
    ['channel wiring', channel.effort],
    ['container.json effort', containerConfig.effort],
    ['container.json defaultEffort', containerConfig.defaultEffort],
  ];
  let effort: string | undefined;
  for (const [layer, raw] of effortLayers) {
    if (!raw) continue;
    const candidate = raw.trim().toLowerCase();
    if (!vocab.validEfforts.has(candidate)) {
      drops.push(`effort "${raw}" from ${layer} is not a Claude effort level — ignored`);
      continue;
    }
    // The per-model matrix is the same one `-e` is validated against. An
    // unsupported pairing (any effort on haiku) would 400 at the API.
    const support = vocab.effortSupportFor(model);
    if (support && !support.has(candidate as never)) {
      drops.push(`effort "${candidate}" from ${layer} is not supported by ${model} — ignored`);
      continue;
    }
    effort = candidate;
    break;
  }

  // Nothing configured an effort. Deriving one is an INFERENCE about which
  // model will run, and it is only safe when the host owns that choice.
  //
  // `providerConfig` is handed to the container verbatim and becomes the
  // provider's sticky config, where `providerConfig.model` OUTRANKS the env
  // alias this function feeds:
  //
  //     claude.ts:  input.model ?? this.stickyConfig.model ?? 'opus'
  //
  // So when it is set, a family default derived from OUR resolved model could
  // belong to a model that never runs — the reviewer's case was
  // `providerConfig.model=fable` + `model=sonnet` yielding Fable at Sonnet's
  // `xhigh` instead of Fable's `medium`. The host declines to infer there and
  // lets the container derive from the model it actually picked, which it
  // already does correctly (`defaultEffortForModel`).
  //
  // This is NOT a copy of the container's precedence rule, and the difference
  // matters: an explicitly CONFIGURED effort is still exported above, because
  // passing through an operator's choice requires no knowledge of which model
  // wins. Only the inference is suppressed. That keeps the host from owning a
  // second copy of an ordering that can drift — and makes the drift failure
  // safe by construction: if claude.ts ever let the env alias win, this would
  // merely over-suppress and fall back to the container deriving from its own
  // chosen model, which is always right. It can be too quiet; it cannot be
  // wrong.
  //
  // `undefined` from the derivation (haiku) stays undefined — the caller emits
  // no variable rather than an empty one.
  const stickyModel =
    typeof containerConfig.providerConfig?.model === 'string' ? containerConfig.providerConfig.model : undefined;
  const hostOwnsTheModelChoice = stickyModel === undefined;
  if (effort === undefined && modelWasConfigured && hostOwnsTheModelChoice) {
    effort = defaultEffortForClaudeModel(model);
  }

  return { model, modelWasConfigured, effort, drops };
}

/**
 * The complete `-e` block the claude spawn branch emits for model + effort,
 * built as the literal strings that reach `docker run`.
 *
 * Extracted alongside the resolution above for one reason: the emission is
 * where a resolved value gets dropped, and `buildContainerArgs` cannot be
 * executed under vitest (it makes live `onecli` shell calls — see
 * `src/container-runner.test.ts`). Resolving correctly and then failing to
 * emit is the same class of defect as reading the wrong field, and it needs
 * the same kind of executing test rather than a careful read of the diff.
 *
 * The effort entry is CONDITIONAL and must stay that way. NANOCLAW_EFFORT_OVERRIDE
 * is an operator override, not a default: with the variable absent the claude
 * provider applies its own per-model-family default. Emitting it
 * unconditionally — with an empty value, or with a hardcoded fallback — would
 * pin every group in the fleet to one model-blind effort.
 * `claude_spawn_env_omits_effort_when_nothing_configured` guards it.
 *
 * The sonnet and haiku aliases are install-wide constants with no per-group
 * layer, so they are emitted verbatim; only the opus alias is operator-tunable.
 *
 * `onDrop` receives one message per refused value. Logging lives at the call
 * site so this stays a pure function and the log line carries session context.
 */
export function claudeSpawnEnv(
  containerConfig: ClaudeSpawnConfig,
  channel: { model?: string | null; effort?: string | null } = {},
  onDrop?: (message: string) => void,
): string[] {
  const resolved = resolveClaudeSpawnDefaults(containerConfig, channel);
  if (onDrop) for (const d of resolved.drops) onDrop(d);
  const env = [
    '-e',
    `ANTHROPIC_DEFAULT_OPUS_MODEL=${resolved.model}`,
    '-e',
    `ANTHROPIC_DEFAULT_SONNET_MODEL=${DEFAULT_SONNET_MODEL}`,
    '-e',
    `ANTHROPIC_DEFAULT_HAIKU_MODEL=${DEFAULT_HAIKU_MODEL}`,
  ];
  if (resolved.effort) env.push('-e', `NANOCLAW_EFFORT_OVERRIDE=${resolved.effort}`);
  return env;
}
