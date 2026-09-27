import {
  DEFAULT_FABLE_MODEL,
  DEFAULT_HAIKU_MODEL,
  DEFAULT_OPUS_MODEL,
  DEFAULT_SONNET_MODEL,
  resolveEffectiveModel,
  vocabFor,
} from './flag-parser.js';
import type { ContainerConfig } from './container-config.js';

export type ClaudeSpawnConfig = Pick<
  ContainerConfig,
  'model' | 'effort' | 'defaultModel' | 'defaultEffort' | 'autoCompactWindow'
>;

/**
 * Quota caps every Claude container receives, emitted by `claudeSpawnEnv` for both spawn branches and mirrored
 * into each group's settings.json by group-init.ts `REQUIRED_ENV`, so a settings pin can't disagree with the `-e`.
 * Subagent concurrency is session-wide, not per-parent (the CLI shares one counter across nesting), so depth 2
 * does not square it.
 */
export const DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW = 600_000;
export const CLAUDE_MAX_SUBAGENT_SPAWN_DEPTH = '2';
export const CLAUDE_MAX_CONCURRENT_SUBAGENTS = '5';

export interface ClaudeSpawnDefaults {
  /** Resolved concrete id for NANOCLAW_CLAUDE_MODEL; never lands in ANTHROPIC_DEFAULT_OPUS_MODEL. */
  model: string;
  /** The operator's explicitly configured effort, or undefined to emit no NANOCLAW_EFFORT_OVERRIDE; never inferred. */
  effort: string | undefined;
  drops: string[];
}

/**
 * Layers: channel wiring → `model`/`effort` (what `ncl groups config update` writes) → `defaultModel`/`defaultEffort`.
 *
 * The host makes no inference about which model runs: `providerConfig.model` is parsed container-side and beats
 * this env, so family-default effort and per-model clamping live in the container. Only vocabulary is checked
 * here, because a provider switch leaves the old provider's model/effort in place and NANOCLAW_EFFORT_OVERRIDE
 * bypasses the container's schema; a non-Claude value is dropped so the next layer gets its turn.
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
  // Also the target of an unpinned Codex → Claude fallback.
  let model = DEFAULT_OPUS_MODEL;
  for (const [layer, raw] of modelLayers) {
    if (!raw) continue;
    const resolved = resolveEffectiveModel(raw);
    if (!vocab.isValidModel(resolved)) {
      drops.push(`model "${raw}" from ${layer} is not a Claude model — ignored`);
      continue;
    }
    model = resolved;
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
    effort = candidate;
    break;
  }

  return { model, effort, drops };
}

/**
 * The literal `-e` strings the claude spawn branch passes to `docker run`.
 *
 * NANOCLAW_EFFORT_OVERRIDE must stay conditional: absent, the provider applies its per-model default; emitting it
 * always would pin the whole fleet to one model-blind effort.
 *
 * The four `ANTHROPIC_DEFAULT_<FAMILY>_MODEL` vars are install-wide alias answers (what a bare `opus` or a
 * `model: opus` subagent resolves to), never the group's model, which travels in NANOCLAW_CLAUDE_MODEL. Putting
 * the group's model in the opus alias made every `model: opus` pin silently run the group's model. Don't reunite.
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
    `NANOCLAW_CLAUDE_MODEL=${resolved.model}`,
    '-e',
    `ANTHROPIC_DEFAULT_OPUS_MODEL=${DEFAULT_OPUS_MODEL}`,
    '-e',
    `ANTHROPIC_DEFAULT_SONNET_MODEL=${DEFAULT_SONNET_MODEL}`,
    '-e',
    `ANTHROPIC_DEFAULT_HAIKU_MODEL=${DEFAULT_HAIKU_MODEL}`,
    '-e',
    `ANTHROPIC_DEFAULT_FABLE_MODEL=${DEFAULT_FABLE_MODEL}`,
  ];
  if (resolved.effort) env.push('-e', `NANOCLAW_EFFORT_OVERRIDE=${resolved.effort}`);
  env.push(
    '-e',
    `CLAUDE_CODE_AUTO_COMPACT_WINDOW=${containerConfig.autoCompactWindow ?? DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW}`,
    '-e',
    `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=${CLAUDE_MAX_SUBAGENT_SPAWN_DEPTH}`,
    '-e',
    `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=${CLAUDE_MAX_CONCURRENT_SUBAGENTS}`,
    '-e',
    'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1',
  );
  return env;
}
