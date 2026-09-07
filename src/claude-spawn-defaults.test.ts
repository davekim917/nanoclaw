import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { claudeSpawnEnv, resolveClaudeSpawnDefaults } from './claude-spawn-defaults.js';
import { DEFAULT_OPUS_MODEL } from './flag-parser.js';
import type { ContainerConfig } from './container-config.js';

type Cfg = Pick<ContainerConfig, 'model' | 'effort' | 'defaultModel' | 'defaultEffort'>;
const cfg = (over: Partial<Cfg> = {}): Cfg => ({ ...over }) as Cfg;

const pairs = (env: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (let i = 0; i < env.length; i += 2) {
    expect(env[i]).toBe('-e');
    const [k, ...rest] = env[i + 1].split('=');
    out[k] = rest.join('=');
  }
  return out;
};

// `ncl groups config update --model/--effort` writes the container_configs DB
// row AND mirrors both into container.json's top-level `model`/`effort`
// (src/cli/resources/groups.ts). The claude spawn branch used to read only the
// hand-authored `defaultModel`/`defaultEffort` pair — which has no
// programmatic writer anywhere in the tree — so the command acked success,
// wrote both stores, and changed nothing the model ever saw.
describe('resolveClaudeSpawnDefaults — layer precedence', () => {
  it('test_claude_effort_reads_container_json_effort', () => {
    expect(resolveClaudeSpawnDefaults(cfg({ effort: 'medium' })).effort).toBe('medium');
  });

  it('test_claude_model_reads_container_json_model', () => {
    const r = resolveClaudeSpawnDefaults(cfg({ model: 'claude-fable-5-1[1m]' }));
    expect(r.model).toBe('claude-fable-5-1[1m]');
    expect(r.modelWasConfigured).toBe(true);
  });

  it('test_ncl_config_update_pair_survives_end_to_end', () => {
    const r = resolveClaudeSpawnDefaults(cfg({ model: 'claude-fable-5-1[1m]', effort: 'medium' }));
    expect(r.model).toBe('claude-fable-5-1[1m]');
    expect(r.effort).toBe('medium');
    expect(r.drops).toEqual([]);
  });

  it('test_channel_wiring_still_outranks_the_group_config', () => {
    const r = resolveClaudeSpawnDefaults(
      cfg({ model: 'claude-fable-5-1[1m]', effort: 'medium', defaultModel: 'claude-opus-5[1m]', defaultEffort: 'low' }),
      { model: 'claude-sonnet-5', effort: 'xhigh' },
    );
    expect(r.model).toBe('claude-sonnet-5');
    expect(r.effort).toBe('xhigh');
  });

  it('test_null_channel_values_fall_through_rather_than_pinning_null', () => {
    // channelDefaults carries `null` (not undefined) for an unset wiring.
    const r = resolveClaudeSpawnDefaults(cfg({ model: 'claude-fable-5-1[1m]', effort: 'medium' }), {
      model: null,
      effort: null,
    });
    expect(r.model).toBe('claude-fable-5-1[1m]');
    expect(r.effort).toBe('medium');
  });

  it('test_model_effort_outrank_the_hand_authored_default_pair', () => {
    const r = resolveClaudeSpawnDefaults(
      cfg({ model: 'claude-fable-5-1[1m]', effort: 'medium', defaultModel: 'claude-opus-5[1m]', defaultEffort: 'low' }),
    );
    expect(r.model).toBe('claude-fable-5-1[1m]');
    expect(r.effort).toBe('medium');
  });

  it('test_default_pair_still_honoured_when_the_ncl_pair_is_unset', () => {
    const r = resolveClaudeSpawnDefaults(cfg({ defaultModel: 'claude-opus-5[1m]', defaultEffort: 'low' }));
    expect(r.model).toBe('claude-opus-5[1m]');
    expect(r.effort).toBe('low');
  });

  it('test_unconfigured_group_is_unchanged', () => {
    // 23 of the fleet's 24 groups. No configured model means the container's
    // own alias derivation is provably right, so no effort is emitted and the
    // spawn env is byte-identical to before this seam existed.
    const r = resolveClaudeSpawnDefaults(cfg());
    expect(r).toEqual({
      model: DEFAULT_OPUS_MODEL,
      modelWasConfigured: false,
      effort: undefined,
      drops: [],
    });
  });

  it('test_chain_matches_the_codex_branch', () => {
    // The codex branch reads
    // `activeChannel* ?? containerConfig.model|effort ?? containerConfig.default*`.
    const c = cfg({
      model: 'claude-fable-5-1[1m]',
      effort: 'medium',
      defaultModel: 'claude-opus-5[1m]',
      defaultEffort: 'low',
    });
    const activeChannelModel: string | null = null;
    const activeChannelEffort: string | null = null;
    const r = resolveClaudeSpawnDefaults(c);
    expect(r.model).toBe(activeChannelModel ?? c.model ?? c.defaultModel);
    expect(r.effort).toBe(activeChannelEffort ?? c.effort ?? c.defaultEffort);
  });
});

// Round-2 P1s (codex findings 3950892215 + 3951002620). One invariant:
// anything exported into the claude spawn env is validated against the Claude
// vocabulary, and effort is derived from the RESOLVED model, never from the
// `'opus'` alias the container asks the SDK for, and never from a value
// carried across a `--provider` switch.
describe('resolveClaudeSpawnDefaults — effort derives from the RESOLVED model', () => {
  it('test_fable_model_without_effort_gets_medium_not_the_opus_default', () => {
    // The container computes defaultEffortForModel('opus') = 'high' because
    // that is the literal string it hands the SDK. Only the host knows the
    // model actually resolved to Fable, whose family default is 'medium'.
    const r = resolveClaudeSpawnDefaults(cfg({ model: 'claude-fable-5-1[1m]' }));
    expect(r.effort).toBe('medium');
    expect(pairs(claudeSpawnEnv(cfg({ model: 'claude-fable-5-1[1m]' }))).NANOCLAW_EFFORT_OVERRIDE).toBe('medium');
  });

  it('test_sonnet_model_without_effort_gets_xhigh_not_the_opus_default', () => {
    // The live case: a Discord wiring in this install pins
    // default_model=sonnet with no default_effort. Before this change those
    // turns ran at `high`.
    const r = resolveClaudeSpawnDefaults(cfg(), { model: 'sonnet' });
    expect(r.model).toBe('claude-sonnet-5');
    expect(r.effort).toBe('xhigh');
  });

  it('test_haiku_model_without_effort_emits_no_effort_variable', () => {
    // Haiku has NO effort control at the API level. Emitting the opus family
    // default at it is an error on every turn, not a wrong depth.
    const r = resolveClaudeSpawnDefaults(cfg({ model: 'claude-haiku-4-5' }));
    expect(r.effort).toBeUndefined();
    const env = claudeSpawnEnv(cfg({ model: 'claude-haiku-4-5' }));
    expect(env.join(' ')).not.toContain('NANOCLAW_EFFORT_OVERRIDE');
  });

  it('test_effort_unsupported_by_the_resolved_model_is_dropped', () => {
    // An explicit effort on haiku is refused by the same per-model matrix the
    // chat `-e` parser uses, and falls through to the family default (none).
    const r = resolveClaudeSpawnDefaults(cfg({ model: 'claude-haiku-4-5', effort: 'high' }));
    expect(r.effort).toBeUndefined();
    expect(r.drops.join(' ')).toContain('not supported by');
  });

  it('test_opus_model_still_gets_high_so_the_common_case_is_unchanged', () => {
    expect(resolveClaudeSpawnDefaults(cfg({ model: 'claude-opus-5[1m]' })).effort).toBe('high');
  });

  it('test_no_effort_is_derived_when_the_model_was_not_configured', () => {
    // The floor case must stay silent: the alias 'opus' and DEFAULT_OPUS_MODEL
    // are the same family, so the container's derivation is already correct
    // and emitting a variable here would change the mechanism for 23 groups.
    const r = resolveClaudeSpawnDefaults(cfg());
    expect(r.effort).toBeUndefined();
    expect(r.model).toBe(DEFAULT_OPUS_MODEL);
  });
});

describe('resolveClaudeSpawnDefaults — foreign vocabulary is dropped, never exported', () => {
  it('test_carried_codex_model_and_effort_are_both_dropped', () => {
    // `ncl groups config update --provider claude` alone keeps the previous
    // provider's model/effort. One group in this install carried a codex
    // model + a codex-only effort into a claude row and avoided this only
    // because the update happened to pass all three flags at once.
    // NANOCLAW_EFFORT_OVERRIDE bypasses claudeConfigSchema, so nothing
    // downstream would have rejected these.
    const r = resolveClaudeSpawnDefaults(cfg({ model: 'gpt-6-astra', effort: 'ultra' }));
    expect(r.model).toBe(DEFAULT_OPUS_MODEL);
    expect(r.modelWasConfigured).toBe(false);
    expect(r.effort).toBeUndefined();
    expect(r.drops).toHaveLength(2);
    expect(r.drops[0]).toContain('gpt-6-astra');
    expect(r.drops[1]).toContain('ultra');
  });

  it('test_ultra_is_not_a_claude_effort_level', () => {
    // `ultra` is codex-only (CODEX_VALID_EFFORT). Claude's ladder stops at max.
    expect(resolveClaudeSpawnDefaults(cfg({ effort: 'ultra' })).effort).toBeUndefined();
    expect(resolveClaudeSpawnDefaults(cfg({ effort: 'max' })).effort).toBe('max');
  });

  it('test_an_opencode_slug_is_dropped', () => {
    expect(resolveClaudeSpawnDefaults(cfg({ model: 'opencode-go/kimi-k3' })).model).toBe(DEFAULT_OPUS_MODEL);
  });

  it('test_a_dropped_layer_yields_to_the_next_one', () => {
    // Dropping is not fatal and does not skip the rest of the chain.
    const r = resolveClaudeSpawnDefaults(cfg({ model: 'gpt-6-astra', defaultModel: 'claude-sonnet-5' }), {
      effort: 'ultra',
    });
    expect(r.model).toBe('claude-sonnet-5');
    expect(r.effort).toBe('xhigh');
    expect(r.drops).toHaveLength(2);
  });

  it('test_drops_are_reported_to_the_caller_for_logging', () => {
    const seen: string[] = [];
    claudeSpawnEnv(cfg({ model: 'gpt-6-astra', effort: 'ultra' }), {}, (m) => seen.push(m));
    expect(seen).toHaveLength(2);
    expect(seen.join(' ')).toContain('is not a Claude model');
    expect(seen.join(' ')).toContain('is not a Claude effort level');
  });
});

// The emission half. `buildContainerArgs` cannot be executed under vitest
// (live `onecli` shell calls — src/container-runner.test.ts:2069), so the step
// from "resolved correctly" to "actually reached `docker run -e`" needs its
// own executing test. These assert the LITERAL strings pushed into the argv.
describe('claudeSpawnEnv', () => {
  it('claude_spawn_env_emits_ncl_configured_model_and_effort', () => {
    // The exact container.json shape left by
    // `ncl groups config update --model claude-fable-5-1[1m] --effort medium`.
    expect(claudeSpawnEnv(cfg({ model: 'claude-fable-5-1[1m]', effort: 'medium' }))).toEqual([
      '-e',
      'ANTHROPIC_DEFAULT_OPUS_MODEL=claude-fable-5-1[1m]',
      '-e',
      'ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-5',
      '-e',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4-5-20251001',
      '-e',
      'NANOCLAW_EFFORT_OVERRIDE=medium',
    ]);
  });

  it('claude_spawn_env_omits_effort_when_nothing_configured', () => {
    // An unconditionally emitted NANOCLAW_EFFORT_OVERRIDE — empty-valued or
    // with a hardcoded fallback — would pin all 24 groups to one model-blind
    // effort and disable the provider's per-model-family defaults. The
    // variable must be ABSENT, not present-and-empty.
    const env = claudeSpawnEnv(cfg());
    expect(env.join(' ')).not.toContain('NANOCLAW_EFFORT_OVERRIDE');
    expect(pairs(env)).toEqual({
      ANTHROPIC_DEFAULT_OPUS_MODEL: DEFAULT_OPUS_MODEL,
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5-20251001',
    });
    expect(env).toHaveLength(6);
  });

  it('claude_spawn_env_matches_the_live_fleet_baseline', () => {
    // 23 of 24 groups configure neither field. `docker inspect` on the live
    // claude containers (2026-09-07) shows exactly this env shape.
    expect(pairs(claudeSpawnEnv(cfg())).ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-5[1m]');
    expect(claudeSpawnEnv(cfg()).includes('NANOCLAW_EFFORT_OVERRIDE=')).toBe(false);
  });

  it('claude_spawn_env_emits_a_channel_wiring_over_the_group_config', () => {
    const env = pairs(
      claudeSpawnEnv(cfg({ model: 'claude-fable-5-1[1m]', effort: 'medium' }), {
        model: 'claude-sonnet-5',
        effort: 'xhigh',
      }),
    );
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-sonnet-5');
    expect(env.NANOCLAW_EFFORT_OVERRIDE).toBe('xhigh');
  });

  it('claude_spawn_env_normalises_a_bare_opus_id_to_the_1m_window', () => {
    expect(pairs(claudeSpawnEnv(cfg({ model: 'claude-opus-5' }))).ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(
      'claude-opus-5[1m]',
    );
  });

  it('claude_spawn_env_resolves_a_bare_family_alias', () => {
    const env = pairs(claudeSpawnEnv(cfg({ defaultModel: 'sonnet' })));
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-sonnet-5');
    // ...and the derived effort follows the RESOLVED id, not the alias.
    expect(env.NANOCLAW_EFFORT_OVERRIDE).toBe('xhigh');
  });
});

// The host mirror of the agent-runner's family-default table is a real
// duplication across a package boundary (Node host / Bun container, nothing
// importable either way). Pin it to the container source so a change on one
// side cannot silently diverge.
describe('family-default effort table stays in sync with the agent-runner', () => {
  it('test_host_family_defaults_match_container_defaultEffortForModel', () => {
    const containerSrc = fs.readFileSync(
      path.resolve(__dirname, '../container/agent-runner/src/providers/claude.ts'),
      'utf8',
    );
    const body = containerSrc.slice(
      containerSrc.indexOf('function defaultEffortForModel('),
      containerSrc.indexOf('function clampEffortForModel('),
    );
    expect(body).toContain('function defaultEffortForModel(');
    // One representative resolved id per family; the host derives the same
    // value the container would for the SAME string.
    const expectations: Array<[string, string | undefined]> = [
      ['claude-opus-5[1m]', 'high'],
      ['claude-sonnet-5', 'xhigh'],
      ['claude-fable-5-1[1m]', 'medium'],
      ['claude-haiku-4-5', undefined],
    ];
    for (const [model, want] of expectations) {
      // Host side, through the public seam: a configured model with no
      // configured effort surfaces exactly the family default.
      expect(resolveClaudeSpawnDefaults(cfg({ model })).effort).toBe(want as string);
    }
    // Container side, from its source: the four branches still return these.
    expect(body).toMatch(/claude-opus-'\)\)\s*return\s*'high'/);
    expect(body).toMatch(/claude-sonnet-'\)\)\s*return\s*'xhigh'/);
    expect(body).toMatch(/claude-fable-'\)\)\s*return\s*'medium'/);
    expect(body).toMatch(/claude-haiku-'\)\)\s*return\s*undefined/);
  });
});
