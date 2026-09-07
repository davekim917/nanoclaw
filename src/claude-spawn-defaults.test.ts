import { describe, expect, it } from 'vitest';

import { claudeSpawnEnv, resolveClaudeSpawnDefaults } from './claude-spawn-defaults.js';
import { DEFAULT_OPUS_MODEL, resolveEffectiveModel } from './flag-parser.js';
import type { ContainerConfig } from './container-config.js';

type Cfg = Pick<ContainerConfig, 'model' | 'effort' | 'defaultModel' | 'defaultEffort'>;
const cfg = (over: Partial<Cfg> = {}): Cfg => ({ ...over }) as Cfg;

// `ncl groups config update --model/--effort` writes the container_configs DB
// row AND mirrors both into container.json's top-level `model`/`effort`
// (src/cli/resources/groups.ts). The claude spawn branch used to read only the
// hand-authored `defaultModel`/`defaultEffort` pair — which has no
// programmatic writer anywhere in the tree — so the command acked success,
// wrote both stores, and changed nothing the model ever saw.
describe('resolveClaudeSpawnDefaults', () => {
  it('test_claude_effort_reads_container_json_effort', () => {
    // The defect, at its narrowest. Before the fix this resolved to undefined
    // and no NANOCLAW_EFFORT_OVERRIDE was emitted at all.
    expect(resolveClaudeSpawnDefaults(cfg({ effort: 'medium' })).effort).toBe('medium');
  });

  it('test_claude_model_reads_container_json_model', () => {
    // Same field split on the model side: shipping the effort half alone
    // would have left the one affected group running the install-wide default
    // model at an effort its operator chose for a different model.
    const resolved = resolveClaudeSpawnDefaults(cfg({ model: 'claude-fable-5-1[1m]' }));
    expect(resolved.rawDefaultModel).toBe('claude-fable-5-1[1m]');
    expect(resolveEffectiveModel(resolved.rawDefaultModel)).toBe('claude-fable-5-1[1m]');
  });

  it('test_ncl_config_update_pair_survives_end_to_end', () => {
    // The exact shape `ncl groups config update --model claude-fable-5-1[1m]
    // --effort medium` leaves in container.json.
    const resolved = resolveClaudeSpawnDefaults(cfg({ model: 'claude-fable-5-1[1m]', effort: 'medium' }));
    expect(resolved).toEqual({ rawDefaultModel: 'claude-fable-5-1[1m]', effort: 'medium' });
  });

  it('test_channel_wiring_still_outranks_the_group_config', () => {
    const resolved = resolveClaudeSpawnDefaults(
      cfg({ model: 'claude-fable-5-1[1m]', effort: 'medium', defaultModel: 'claude-opus-5[1m]', defaultEffort: 'low' }),
      { model: 'claude-sonnet-5', effort: 'xhigh' },
    );
    expect(resolved).toEqual({ rawDefaultModel: 'claude-sonnet-5', effort: 'xhigh' });
  });

  it('test_null_channel_values_fall_through_rather_than_pinning_null', () => {
    // channelDefaults carries `null` (not undefined) for an unset wiring.
    const resolved = resolveClaudeSpawnDefaults(cfg({ model: 'claude-fable-5-1[1m]', effort: 'medium' }), {
      model: null,
      effort: null,
    });
    expect(resolved).toEqual({ rawDefaultModel: 'claude-fable-5-1[1m]', effort: 'medium' });
  });

  it('test_model_effort_outrank_the_hand_authored_default_pair', () => {
    const resolved = resolveClaudeSpawnDefaults(
      cfg({ model: 'claude-fable-5-1[1m]', effort: 'medium', defaultModel: 'claude-opus-5[1m]', defaultEffort: 'low' }),
    );
    expect(resolved).toEqual({ rawDefaultModel: 'claude-fable-5-1[1m]', effort: 'medium' });
  });

  it('test_default_pair_still_honoured_when_the_ncl_pair_is_unset', () => {
    // No behavior change for a group that only ever hand-authored the older
    // fields — the fix ADDS a layer above them, it does not replace them.
    const resolved = resolveClaudeSpawnDefaults(cfg({ defaultModel: 'claude-opus-5[1m]', defaultEffort: 'low' }));
    expect(resolved).toEqual({ rawDefaultModel: 'claude-opus-5[1m]', effort: 'low' });
  });

  it('test_unconfigured_group_is_unchanged', () => {
    // 23 of the fleet's 24 groups. No effort means the caller emits no
    // NANOCLAW_EFFORT_OVERRIDE, leaving the claude provider's per-model-family
    // default in charge.
    const resolved = resolveClaudeSpawnDefaults(cfg());
    expect(resolved).toEqual({ rawDefaultModel: DEFAULT_OPUS_MODEL, effort: undefined });
  });

  it('test_chain_matches_the_codex_branch', () => {
    // The codex branch of buildContainerArgs reads
    // `activeChannel* ?? containerConfig.model|effort ?? containerConfig.default*`.
    // This asserts the claude branch is now the same chain plus the
    // DEFAULT_OPUS_MODEL floor, rather than a second, divergent one.
    const c = cfg({
      model: 'claude-fable-5-1[1m]',
      effort: 'medium',
      defaultModel: 'claude-opus-5[1m]',
      defaultEffort: 'low',
    });
    const activeChannelModel: string | null = null;
    const activeChannelEffort: string | null = null;
    const codexModel = activeChannelModel ?? c.model ?? c.defaultModel;
    const codexEffort = activeChannelEffort ?? c.effort ?? c.defaultEffort;
    const resolved = resolveClaudeSpawnDefaults(c);
    expect(resolved.rawDefaultModel).toBe(codexModel);
    expect(resolved.effort).toBe(codexEffort);
  });
});

// The emission half. `buildContainerArgs` cannot be executed under vitest
// (live `onecli` shell calls — src/container-runner.test.ts:2069), so before
// this block the step from "resolved correctly" to "actually reached
// `docker run -e`" was covered by reading the diff and nothing else. Resolving
// a value and then dropping it on the floor is the same defect class this PR
// fixes, so it gets an executing test rather than a careful read.
//
// These assert the LITERAL strings pushed into the docker argv.
describe('claudeSpawnEnv', () => {
  const pairs = (env: string[]): Record<string, string> => {
    const out: Record<string, string> = {};
    for (let i = 0; i < env.length; i += 2) {
      expect(env[i]).toBe('-e');
      const [k, ...rest] = env[i + 1].split('=');
      out[k] = rest.join('=');
    }
    return out;
  };

  it('claude_spawn_env_emits_ncl_configured_model_and_effort', () => {
    // illysium-admiral's exact container.json shape after
    // `ncl groups config update --model claude-fable-5-1[1m] --effort medium`.
    const env = claudeSpawnEnv(cfg({ model: 'claude-fable-5-1[1m]', effort: 'medium' }));
    expect(env).toEqual([
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
    // The negative case matters as much as the positive one. An
    // unconditionally emitted NANOCLAW_EFFORT_OVERRIDE — empty-valued or with
    // a hardcoded fallback — would pin all 24 groups to one model-blind effort
    // and disable the claude provider's per-model-family defaults
    // (defaultEffortForModel: opus→high, sonnet→xhigh, fable→medium,
    // haiku→none). The variable must be ABSENT, not present-and-empty.
    const env = claudeSpawnEnv(cfg());
    expect(env.join(' ')).not.toContain('NANOCLAW_EFFORT_OVERRIDE');
    expect(pairs(env)).toEqual({
      ANTHROPIC_DEFAULT_OPUS_MODEL: DEFAULT_OPUS_MODEL,
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5-20251001',
    });
    // Every entry is a well-formed `-e KEY=VALUE` pair — no odd-length argv.
    expect(env).toHaveLength(6);
  });

  it('claude_spawn_env_matches_the_live_fleet_baseline', () => {
    // 23 of 24 groups configure neither field. `docker inspect` on the live
    // illysium and illysium-argus containers (2026-09-07) shows exactly this:
    // the three alias vars, ANTHROPIC_DEFAULT_OPUS_MODEL at the install
    // constant, and no NANOCLAW_EFFORT_OVERRIDE at all.
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
    // ensureOpus1mSuffix is applied at this consumption point; a bare
    // claude-opus-* here collapses the CLI auto-compact window to 200k.
    expect(pairs(claudeSpawnEnv(cfg({ model: 'claude-opus-5' }))).ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(
      'claude-opus-5[1m]',
    );
  });

  it('claude_spawn_env_resolves_a_bare_family_alias', () => {
    expect(pairs(claudeSpawnEnv(cfg({ defaultModel: 'sonnet' }))).ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(
      'claude-sonnet-5',
    );
  });
});
