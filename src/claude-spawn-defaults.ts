import {
  DEFAULT_HAIKU_MODEL,
  DEFAULT_OPUS_MODEL,
  DEFAULT_SONNET_MODEL,
  resolveEffectiveModel,
} from './flag-parser.js';
import type { ContainerConfig } from './container-config.js';

/**
 * The claude spawn branch's model + effort resolution, extracted so it is
 * unit-testable: `buildContainerArgs` itself makes live `onecli` shell calls
 * and cannot be executed under vitest.
 *
 * Both chains are the SAME three container.json layers the codex branch reads
 * (`src/container-runner.ts`, codex block above):
 *
 *   per-channel wiring  →  `model` / `effort`  →  `defaultModel` / `defaultEffort`
 *
 * `model`/`effort` are the pair `ncl groups config update --model/--effort`
 * writes — it updates the `container_configs` DB row AND mirrors both into
 * `container.json` (`src/cli/resources/groups.ts`). `defaultModel`/
 * `defaultEffort` are the older hand-authored container.json fields, which
 * have no programmatic writer anywhere in the tree.
 *
 * Reading only the `default*` pair here (the shape before this function
 * existed) made `ncl groups config update` a silent no-op for every claude
 * group: the command acked success and wrote both stores, and the container
 * still ran the install-wide default model at its per-model-family effort.
 * The codex branch never had the bug because it reads `model`/`effort` first;
 * opencode never had it either because its provider contribution reads
 * `container_configs.effort` straight from the DB
 * (`src/providers/opencode.ts`).
 *
 * `rawDefaultModel` is pre-`resolveEffectiveModel`: the caller maps family
 * aliases and applies `ensureOpus1mSuffix` before it lands in
 * ANTHROPIC_DEFAULT_OPUS_MODEL. `effort` is undefined when no layer sets one,
 * and the caller then emits no NANOCLAW_EFFORT_OVERRIDE at all so the claude
 * provider applies its per-model-family default.
 */
export function resolveClaudeSpawnDefaults(
  containerConfig: Pick<
    ContainerConfig,
    'model' | 'effort' | 'defaultModel' | 'defaultEffort'
  >,
  channel: { model?: string | null; effort?: string | null } = {},
): { rawDefaultModel: string; effort: string | undefined } {
  return {
    rawDefaultModel:
      channel.model ?? containerConfig.model ?? containerConfig.defaultModel ?? DEFAULT_OPUS_MODEL,
    effort: channel.effort ?? containerConfig.effort ?? containerConfig.defaultEffort,
  };
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
 * is an operator override, not a default: the claude provider applies a
 * per-model-family default when the variable is absent
 * (`defaultEffortForModel` in the agent-runner). Emitting it unconditionally —
 * with an empty value, or with a hardcoded fallback — would pin every group in
 * the fleet to one model-blind effort and silently disable those family
 * defaults. `claude_spawn_env_omits_effort_when_nothing_configured` guards it.
 *
 * The sonnet and haiku aliases are install-wide constants with no per-group
 * layer, so they are emitted verbatim; only the opus alias is operator-tunable.
 */
export function claudeSpawnEnv(
  containerConfig: Pick<ContainerConfig, 'model' | 'effort' | 'defaultModel' | 'defaultEffort'>,
  channel: { model?: string | null; effort?: string | null } = {},
): string[] {
  const resolved = resolveClaudeSpawnDefaults(containerConfig, channel);
  const env = [
    '-e',
    `ANTHROPIC_DEFAULT_OPUS_MODEL=${resolveEffectiveModel(resolved.rawDefaultModel)}`,
    '-e',
    `ANTHROPIC_DEFAULT_SONNET_MODEL=${DEFAULT_SONNET_MODEL}`,
    '-e',
    `ANTHROPIC_DEFAULT_HAIKU_MODEL=${DEFAULT_HAIKU_MODEL}`,
  ];
  if (resolved.effort) env.push('-e', `NANOCLAW_EFFORT_OVERRIDE=${resolved.effort}`);
  return env;
}
