import { describe, it, expect, mock } from 'bun:test';

// The SDK options are the only runtime surface that shows what we asked for —
// the CLI never logs the request body and OAuth traffic has no proxy dashboard.
let capturedSdkOptions: Record<string, unknown> | null = null;
const mockSdkQuery = mock((_args: unknown) => {
  const args = _args as { options?: Record<string, unknown> };
  capturedSdkOptions = args.options ?? null;
  const gen = (async function* () {})() as AsyncGenerator & {
    setModel: (m?: string) => Promise<void>;
    applyFlagSettings: (s: Record<string, unknown>) => Promise<void>;
  };
  gen.setModel = () => Promise.resolve();
  gen.applyFlagSettings = () => Promise.resolve();
  return gen;
});
mock.module('@anthropic-ai/claude-agent-sdk', () => ({ query: mockSdkQuery }));

const realContainerState = await import('../db/container-state.js');
mock.module('../db/container-state.js', () => ({
  ...realContainerState,
  clearContainerToolInFlight: () => {},
  setContainerToolInFlight: () => {},
}));
mock.module('../worktree-autosave.js', () => ({
  autoCommitDirtyWorktrees: async () => ({ committed: [], failed: [] }),
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

/**
 * One turn under a controlled spawn environment. `groupModel` is the concrete
 * id the host resolved for this group and exported as NANOCLAW_CLAUDE_MODEL;
 * `alias` is ANTHROPIC_DEFAULT_OPUS_MODEL, which since 2026-09-15 answers the
 * bare `opus` WORD only and is read here solely as the legacy fallback for a
 * container spawned by a host that predates NANOCLAW_CLAUDE_MODEL. `effortEnv`
 * is NANOCLAW_EFFORT_OVERRIDE, emitted only when an operator configured one.
 */
function turn(
  opts: ConstructorParameters<typeof ClaudeProvider>[0] = {},
  env: { groupModel?: string; alias?: string; effortEnv?: string } = {},
  input: Record<string, unknown> = {},
): Record<string, unknown> | null {
  const prevGroupModel = process.env.NANOCLAW_CLAUDE_MODEL;
  const prevAlias = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  const prevEffort = process.env.NANOCLAW_EFFORT_OVERRIDE;
  if (env.groupModel === undefined) delete process.env.NANOCLAW_CLAUDE_MODEL;
  else process.env.NANOCLAW_CLAUDE_MODEL = env.groupModel;
  if (env.alias === undefined) delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  else process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = env.alias;
  if (env.effortEnv === undefined) delete process.env.NANOCLAW_EFFORT_OVERRIDE;
  else process.env.NANOCLAW_EFFORT_OVERRIDE = env.effortEnv;
  try {
    const p = new ClaudeProvider(opts);
    p.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    capturedSdkOptions = null;
    mockSdkQuery.mockClear();
    p.query({ prompt: 'hi', cwd: '/tmp', ...input });
    return capturedSdkOptions;
  } finally {
    if (prevGroupModel === undefined) delete process.env.NANOCLAW_CLAUDE_MODEL;
    else process.env.NANOCLAW_CLAUDE_MODEL = prevGroupModel;
    if (prevAlias === undefined) delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
    else process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = prevAlias;
    if (prevEffort === undefined) delete process.env.NANOCLAW_EFFORT_OVERRIDE;
    else process.env.NANOCLAW_EFFORT_OVERRIDE = prevEffort;
  }
}

// `defaultEffortForModel` is the only place a family default is chosen, and it
// already sits at the point the model is finally picked. Before this change its
// argument was the literal string 'opus' whenever nothing pinned a model, so it
// answered for Opus no matter what ANTHROPIC_DEFAULT_OPUS_MODEL resolved to.
describe('family-default effort follows the RESOLVED model, not the opus alias', () => {
  it('test_sonnet_pinned_group_gets_sonnets_family_default', () => {
    // The live bug on main: a channel wiring with default_model=sonnet and no
    // default_effort. Sonnet 5's fleet default is xhigh; it was running high.
    const o = turn({}, { groupModel: 'claude-sonnet-5' });
    expect(o?.model).toBe('claude-sonnet-5');
    expect(o?.effort).toBe('xhigh');
  });

  it('test_haiku_pinned_group_sends_no_effort_at_all', () => {
    // Haiku has no effort control at the API level. The alias path sent it
    // `high` on every turn; there is no env value meaning "explicitly none",
    // so this could only ever be fixed here.
    const o = turn({}, { groupModel: 'claude-haiku-4-5-20251001' });
    expect(o?.model).toBe('claude-haiku-4-5-20251001');
    expect(o?.effort).toBeUndefined();
  });

  it('test_fable_pinned_group_gets_fables_family_default', () => {
    const o = turn({}, { groupModel: 'claude-fable-5-1[1m]' });
    expect(o?.model).toBe('claude-fable-5-1[1m]');
    expect(o?.effort).toBe('medium');
  });

  it('test_opus_default_group_gets_opus_family_default', () => {
    // Opus defaults to `medium` — the fleet baseline (operator decision 2026-09-22;
    // was `high` from 2026-09-16).
    const o = turn({}, { groupModel: 'claude-opus-5[1m]' });
    expect(o?.model).toBe('claude-opus-5[1m]');
    expect(o?.effort).toBe('medium');
  });
});

describe('every other precedence layer is untouched', () => {
  it('test_per_turn_model_still_wins', () => {
    const o = turn({}, { groupModel: 'claude-sonnet-5' }, { model: 'claude-opus-5[1m]' });
    expect(o?.model).toBe('claude-opus-5[1m]');
    expect(o?.effort).toBe('medium');
  });

  it('test_providerConfig_model_still_beats_the_host_default', () => {
    const o = turn({ providerConfig: { model: 'claude-fable-5-1[1m]' } }, { groupModel: 'claude-sonnet-5' });
    expect(o?.model).toBe('claude-fable-5-1[1m]');
    // ...and now the family default follows THAT model, which is the whole point.
    expect(o?.effort).toBe('medium');
  });

  it('test_operator_effort_override_still_beats_the_family_default', () => {
    const o = turn({}, { groupModel: 'claude-sonnet-5', effortEnv: 'low' });
    expect(o?.model).toBe('claude-sonnet-5');
    expect(o?.effort).toBe('low');
  });

  it('test_per_turn_effort_still_beats_everything', () => {
    const o = turn({}, { groupModel: 'claude-sonnet-5', effortEnv: 'low' }, { effort: 'max' });
    expect(o?.effort).toBe('max');
  });

  it('test_providerConfig_effort_still_beats_the_operator_override', () => {
    const o = turn({ providerConfig: { effort: 'medium' } }, { groupModel: 'claude-sonnet-5', effortEnv: 'low' });
    expect(o?.effort).toBe('medium');
  });

  it('test_a_bare_opus_id_from_the_host_is_still_1m_normalised', () => {
    // ensureOpus1mSuffix runs on this value exactly as it did on the alias.
    const o = turn({}, { groupModel: 'claude-opus-5' });
    expect(o?.model).toBe('claude-opus-5[1m]');
  });

  it('test_a_pre_transport_host_still_reaches_its_group_model', () => {
    // The rolling case: a container spawned by a host older than
    // NANOCLAW_CLAUDE_MODEL, where the group's resolved id is still sitting in
    // the alias var. It must keep running that model, not the install default.
    const o = turn({}, { alias: 'claude-sonnet-5' });
    expect(o?.model).toBe('claude-sonnet-5');
    expect(o?.effort).toBe('xhigh');
  });

  it('test_the_group_model_outranks_the_opus_alias_answer', () => {
    // The defect this pair exists to prevent: with both present the group's
    // own model wins, so pinning the `opus` WORD to the install's Opus
    // constant can never retarget a Sonnet group.
    const o = turn({}, { groupModel: 'claude-sonnet-5', alias: 'claude-opus-5[1m]' });
    expect(o?.model).toBe('claude-sonnet-5');
    expect(o?.effort).toBe('xhigh');
  });

  it('test_no_host_env_at_all_falls_back_to_the_bare_alias', () => {
    // A spawn that carries neither var (unit tests) keeps the last resort.
    const o = turn({}, {});
    expect(o?.model).toBe('opus');
    expect(o?.effort).toBe('medium');
  });

  it('test_clamp_still_refuses_an_unsupported_pairing', () => {
    // An operator override of `high` against a haiku-pinned group is dropped
    // by the clamp, which now sees the real model too.
    const o = turn({}, { groupModel: 'claude-haiku-4-5-20251001', effortEnv: 'high' });
    expect(o?.effort).toBeUndefined();
  });
});

/**
 * The other half of removing the scheduled-task literal.
 *
 * The poll loop now hands a pure task wake `model: undefined` rather than the
 * literal `'sonnet'`. `undefined` is only the right answer if it actually
 * lands on the GROUP's configured model — so this asserts the far end of that
 * chain, where the poll-loop tests can only assert the near end (that no
 * per-turn override was sent).
 *
 * The chain: the host resolves the group's model and exports it as
 * NANOCLAW_CLAUDE_MODEL at spawn (`claudeSpawnEnv`), and this provider
 * reads `input.model ?? stickyConfig.model ?? that env var`. Note the
 * constructor never reads `options.model`, so the env var is the ONLY route by
 * which container.json's model reaches a query.
 */
describe('an unpinned scheduled task lands on the group default, not a literal', () => {
  it('test_unpinned_task_uses_the_groups_configured_model', () => {
    // A group whose container.json sets sonnet. Pre-removal an unpinned task
    // ran the literal 'sonnet' regardless; now it runs what the group set,
    // and picks up sonnet's own family default effort rather than 'xhigh'
    // being forced alongside it.
    const o = turn({}, { groupModel: 'claude-sonnet-5' }, { model: undefined, effort: undefined });
    expect(o?.model).toBe('claude-sonnet-5');
    expect(o?.effort).toBe('xhigh');
  });

  it('test_unpinned_task_on_an_unconfigured_group_is_opus_at_medium', () => {
    // The Claude groups with no `model` in container.json. This is the
    // repricing: those groups' unpinned scheduled tasks move here on deploy.
    // Asserted so the cost claim in the PR body is a measured behaviour and
    // not a prediction.
    const o = turn({}, { groupModel: 'claude-opus-5[1m]' }, { model: undefined, effort: undefined });
    expect(o?.model).toBe('claude-opus-5[1m]');
    expect(o?.effort).toBe('medium');
  });

  it('test_a_task_pin_still_overrides_the_group_default', () => {
    // The pinned recap/digest jobs. Their stored flagIntent reaches the
    // provider as a per-turn model, which still wins over the group's.
    const o = turn({}, { groupModel: 'claude-opus-5[1m]' }, { model: 'claude-sonnet-5', effort: 'xhigh' });
    expect(o?.model).toBe('claude-sonnet-5');
    expect(o?.effort).toBe('xhigh');
  });
});
