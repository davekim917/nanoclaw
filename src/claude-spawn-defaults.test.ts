import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  CLAUDE_MAX_CONCURRENT_SUBAGENTS,
  CLAUDE_MAX_SUBAGENT_SPAWN_DEPTH,
  DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW,
  claudeSpawnEnv,
  resolveClaudeSpawnDefaults,
} from './claude-spawn-defaults.js';
import { DEFAULT_OPUS_MODEL, DEFAULT_SONNET_MODEL } from './flag-parser.js';
import type { ContainerConfig } from './container-config.js';

type Cfg = Pick<
  ContainerConfig,
  'model' | 'effort' | 'defaultModel' | 'defaultEffort' | 'providerConfig' | 'autoCompactWindow'
>;
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

  it('test_unconfigured_group_uses_the_native_claude_default', () => {
    // An unpinned native Claude group and an unpinned Codex → Claude fallback
    // reach this same configuration. No effort is emitted: the provider derives
    // Opus's medium from the resolved model at query time.
    const r = resolveClaudeSpawnDefaults(cfg());
    expect(r).toEqual({ model: DEFAULT_OPUS_MODEL, effort: undefined, drops: [] });
    expect(r.model).toBe('claude-opus-5[1m]');
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
    // Dropping is not fatal and does not skip the rest of the chain: the bad
    // model falls through to defaultModel, and the bad effort falls through to
    // the next effort layer — here there is none, so nothing is exported and
    // the container applies its own family default for claude-sonnet-5.
    const r = resolveClaudeSpawnDefaults(
      cfg({ model: 'gpt-6-astra', defaultModel: 'claude-sonnet-5', defaultEffort: 'max' }),
      { effort: 'ultra' },
    );
    expect(r.model).toBe('claude-sonnet-5');
    expect(r.effort).toBe('max');
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
    // This asserted ANTHROPIC_DEFAULT_OPUS_MODEL=claude-fable-5-1[1m] until
    // 2026-09-15 — i.e. it pinned the group's model INTO the `opus` alias,
    // which is the defect, not a contract. The group's model now rides
    // NANOCLAW_CLAUDE_MODEL and the alias stays constant.
    expect(claudeSpawnEnv(cfg({ model: 'claude-fable-5-1[1m]', effort: 'medium' }))).toEqual([
      '-e',
      'NANOCLAW_CLAUDE_MODEL=claude-fable-5-1[1m]',
      '-e',
      'ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-5[1m]',
      '-e',
      'ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-5',
      '-e',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4-5-20251001',
      '-e',
      'NANOCLAW_EFFORT_OVERRIDE=medium',
      '-e',
      'CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000',
      '-e',
      'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1',
      '-e',
      'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=3',
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
      NANOCLAW_CLAUDE_MODEL: DEFAULT_OPUS_MODEL,
      ANTHROPIC_DEFAULT_OPUS_MODEL: DEFAULT_OPUS_MODEL,
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5-20251001',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '3',
    });
    expect(env).toHaveLength(14);
  });

  it('claude_spawn_env_matches_the_live_fleet_baseline', () => {
    // This is the unpinned Claude baseline: Opus [1m], and no effort — the
    // container applies Opus's family default (medium), which is the value no
    // host-side env could express without also pinning every other group.
    expect(pairs(claudeSpawnEnv(cfg())).NANOCLAW_CLAUDE_MODEL).toBe('claude-opus-5[1m]');
    expect(claudeSpawnEnv(cfg()).includes('NANOCLAW_EFFORT_OVERRIDE=')).toBe(false);
  });

  it('claude_spawn_env_emits_a_channel_wiring_over_the_group_config', () => {
    const env = pairs(
      claudeSpawnEnv(cfg({ model: 'claude-fable-5-1[1m]', effort: 'medium' }), {
        model: 'claude-sonnet-5',
        effort: 'xhigh',
      }),
    );
    expect(env.NANOCLAW_CLAUDE_MODEL).toBe('claude-sonnet-5');
    expect(env.NANOCLAW_EFFORT_OVERRIDE).toBe('xhigh');
  });

  it('claude_spawn_env_normalises_a_bare_opus_id_to_the_1m_window', () => {
    expect(pairs(claudeSpawnEnv(cfg({ model: 'claude-opus-5' }))).NANOCLAW_CLAUDE_MODEL).toBe('claude-opus-5[1m]');
  });

  it('claude_spawn_env_resolves_a_bare_family_alias', () => {
    const env = pairs(claudeSpawnEnv(cfg({ defaultModel: 'sonnet' })));
    expect(env.NANOCLAW_CLAUDE_MODEL).toBe('claude-sonnet-5');
    // ...and no effort is invented for it. The container derives Sonnet's
    // xhigh from this very id (agent-runner defaultEffortForModel).
    expect(env.NANOCLAW_EFFORT_OVERRIDE).toBeUndefined();
  });
});

// The alias short-circuit. `ANTHROPIC_DEFAULT_<FAMILY>_MODEL` is what the CLI
// sends when anything uses the bare family WORD: a subagent's `model:`
// frontmatter, or the `"model": "opus"` pin group-init writes into every
// group's .claude-shared/settings.json (src/group-init.ts REQUIRED_SETTINGS).
//
// The opus one carried `resolved.model` until 2026-09-15, so the word meant
// "whatever this group runs" — and once the unpinned default moved to Sonnet
// in 7d0e7df3a, it meant Sonnet 5 in 8 of 9 Claude groups. Measured in a live
// container: ANTHROPIC_DEFAULT_OPUS_MODEL=claude-sonnet-5.
describe('claudeSpawnEnv — the family aliases are install constants, never the group model', () => {
  const opusAlias = (c: Cfg = cfg(), ch = {}) => pairs(claudeSpawnEnv(c, ch)).ANTHROPIC_DEFAULT_OPUS_MODEL;

  it('an unpinned group resolves `opus` to the fleet Opus id', () => {
    expect(opusAlias()).toBe(DEFAULT_OPUS_MODEL);
  });

  it('a sonnet-pinned group still resolves `opus` to the fleet Opus id', () => {
    // The `model: opus` settings pin and every `model: opus` subagent in this
    // group ran Sonnet 5 before this. The group itself keeps its pin.
    const env = pairs(claudeSpawnEnv(cfg({ model: 'claude-sonnet-5' })));
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(DEFAULT_OPUS_MODEL);
    expect(env.NANOCLAW_CLAUDE_MODEL).toBe('claude-sonnet-5');
  });

  it('no layer can retarget the alias — not the channel wiring, not either container.json field', () => {
    expect(opusAlias(cfg({ model: 'claude-haiku-4-5-20251001' }))).toBe(DEFAULT_OPUS_MODEL);
    expect(opusAlias(cfg({ defaultModel: 'claude-fable-5-1[1m]' }))).toBe(DEFAULT_OPUS_MODEL);
    expect(opusAlias(cfg({ model: 'claude-fable-5-1[1m]' }), { model: 'sonnet' })).toBe(DEFAULT_OPUS_MODEL);
  });

  it('the sonnet and haiku aliases are constants too', () => {
    const env = pairs(claudeSpawnEnv(cfg({ model: 'claude-opus-5[1m]' })));
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(DEFAULT_SONNET_MODEL);
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-4-5-20251001');
  });

  it('the group model travels in its own variable, never in an alias', () => {
    // The structural form: for a group pinned to something that is not Opus,
    // no ANTHROPIC_DEFAULT_* var may hold that pin.
    const env = pairs(claudeSpawnEnv(cfg({ model: 'claude-fable-5-1[1m]' })));
    expect(env.NANOCLAW_CLAUDE_MODEL).toBe('claude-fable-5-1[1m]');
    for (const [k, v] of Object.entries(env)) {
      if (k.startsWith('ANTHROPIC_DEFAULT_')) expect(v).not.toBe('claude-fable-5-1[1m]');
    }
  });
});

// Quota caps (docs/specs/quota-burn/plan.md §Tier 0). PR #810 round 1 (F1):
// the wiki spawn branch builds its own argv and `return`s before the ordinary
// branch's env block, so caps pushed ad hoc in that block never reached wiki
// containers — and with the settings.json pin scrubbed, their compact window
// fell to the runner's 165k fallback. The three vars therefore ride
// claudeSpawnEnv, the one helper both branches call.
describe('claudeSpawnEnv — quota caps', () => {
  const QUOTA_VARS = [
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
    'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH',
    'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS',
  ] as const;

  it('emits the fleet default window and both caps when autoCompactWindow is absent', () => {
    const env = pairs(claudeSpawnEnv(cfg()));
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(String(DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW));
    expect(env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBe(CLAUDE_MAX_SUBAGENT_SPAWN_DEPTH);
    expect(env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe(CLAUDE_MAX_CONCURRENT_SUBAGENTS);
  });

  it('emits a configured autoCompactWindow verbatim, caps unchanged', () => {
    // The plan §0.5 shape: one group's container.json → 400000.
    const env = pairs(claudeSpawnEnv(cfg({ autoCompactWindow: 400000 })));
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('400000');
    expect(env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBe('1');
    expect(env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe('3');
  });

  it('is emitted by both container-runner spawn branches and nowhere else', () => {
    // buildContainerArgs cannot execute under vitest (live `onecli` calls), so
    // the branch-coverage half is a source assertion: every `claudeSpawnEnv(`
    // call site in container-runner.ts is counted, the wiki branch's early
    // `return args` must come AFTER one of them, and no ad-hoc `-e` push of
    // any quota var may exist outside the helper — that is the exact shape
    // that lost the wiki branch in round 1.
    const runner = fs.readFileSync(path.join(import.meta.dirname, 'container-runner.ts'), 'utf-8');
    const callSites = [...runner.matchAll(/claudeSpawnEnv\(/g)].map((m) => m.index);
    expect(callSites.length).toBeGreaterThanOrEqual(2);

    const wikiReturn = runner.indexOf("'exec /app/entrypoint.sh');\n    return args;");
    expect(wikiReturn).toBeGreaterThan(0);
    const wikiBranchStart = runner.lastIndexOf('if (wikiActor', wikiReturn);
    expect(wikiBranchStart).toBeGreaterThan(0);
    expect(callSites.some((i) => i > wikiBranchStart && i < wikiReturn)).toBe(true);
    expect(callSites.some((i) => i > wikiReturn)).toBe(true);

    for (const name of QUOTA_VARS) {
      expect(runner.includes(`'${name}=`), `${name} pushed ad hoc in container-runner.ts`).toBe(false);
      expect(runner.includes(`\`${name}=`), `${name} pushed ad hoc in container-runner.ts`).toBe(false);
    }
    const helper = fs.readFileSync(path.join(import.meta.dirname, 'claude-spawn-defaults.ts'), 'utf-8');
    for (const name of QUOTA_VARS) expect(helper).toContain(`\`${name}=`);
  });
});
