import { describe, it, expect, mock } from 'bun:test';

// Mock the SDK before importing claude.ts so the options handed to sdkQuery
// are observable — the resolved model/effort exist nowhere else at runtime.
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

// Spread the real module and stub only the tool-in-flight markers — bun's
// mock.module leaks across files in the same process, and a bare two-export
// mock strips getOutboundDb/transaction from later files.
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

type Sticky = { model?: string; effort?: string };
const sticky = (p: InstanceType<typeof ClaudeProvider>): Sticky =>
  (p as unknown as { stickyConfig: Sticky }).stickyConfig;

function make(
  options: ConstructorParameters<typeof ClaudeProvider>[0] = {},
): InstanceType<typeof ClaudeProvider> {
  const provider = new ClaudeProvider(options);
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  return provider;
}

/** Run one query with a controlled NANOCLAW_EFFORT_OVERRIDE and return the SDK options. */
function run(
  provider: InstanceType<typeof ClaudeProvider>,
  input: Record<string, unknown> = {},
  envOverride?: string,
): Record<string, unknown> | null {
  capturedSdkOptions = null;
  mockSdkQuery.mockClear();
  const prev = process.env.NANOCLAW_EFFORT_OVERRIDE;
  if (envOverride === undefined) delete process.env.NANOCLAW_EFFORT_OVERRIDE;
  else process.env.NANOCLAW_EFFORT_OVERRIDE = envOverride;
  try {
    provider.query({ prompt: 'hi', cwd: '/tmp', ...input });
    return capturedSdkOptions;
  } finally {
    if (prev === undefined) delete process.env.NANOCLAW_EFFORT_OVERRIDE;
    else process.env.NANOCLAW_EFFORT_OVERRIDE = prev;
  }
}

// A group whose primary provider is in a recorded outage window and whose
// `providerFallback` targets claude spawns with an EMPTY providerConfig —
// config.ts drops it, because it describes the primary provider and codex's
// `reasoning_effort` key is a fatal boot error under claude's strict schema.
// The fallback's own model/effort arrive on options.model/options.effort, and
// `onFallback` marks the spawn as the fallback path. Before this fix those two
// fields were assigned to dead private members and read nowhere, so a claude
// fallback silently ran the `opus` alias at its family-default effort.
describe('ClaudeProvider provider-fallback model/effort', () => {
  it('test_fallback_model_and_effort_reach_the_query', () => {
    const p = make({
      providerConfig: {},
      model: 'claude-fable-5-1[1m]',
      effort: 'medium',
      onFallback: true,
    });
    expect(sticky(p).model).toBe('claude-fable-5-1[1m]');
    expect(sticky(p).effort).toBe('medium');

    const opts = run(p);
    expect(opts?.model).toBe('claude-fable-5-1[1m]');
    expect(opts?.effort).toBe('medium');
  });

  it('test_fallback_effort_only_leaves_the_model_on_the_opus_alias', () => {
    const p = make({ providerConfig: {}, effort: 'low', onFallback: true });
    expect(sticky(p).model).toBeUndefined();
    expect(sticky(p).effort).toBe('low');

    const opts = run(p);
    // The bare alias, resolved by ANTHROPIC_DEFAULT_OPUS_MODEL at the CLI.
    expect(opts?.model).toBe('opus');
    expect(opts?.effort).toBe('low');
  });

  it('test_per_turn_flags_still_beat_the_fallback_declaration', () => {
    const p = make({
      providerConfig: {},
      model: 'claude-fable-5-1[1m]',
      effort: 'medium',
      onFallback: true,
    });
    const opts = run(p, { model: 'claude-opus-5[1m]', effort: 'xhigh' });
    expect(opts?.model).toBe('claude-opus-5[1m]');
    expect(opts?.effort).toBe('xhigh');
  });

  it('test_fallback_declaration_beats_the_operator_env_override', () => {
    // The fold lands in stickyConfig, which sits ABOVE
    // NANOCLAW_EFFORT_OVERRIDE in the query precedence chain. Documented here
    // so the ordering is a guarded contract, not an accident.
    const p = make({ providerConfig: {}, effort: 'low', onFallback: true });
    expect(run(p, {}, 'max')?.effort).toBe('low');
  });

  it('test_misdeclared_fallback_degrades_instead_of_throwing_at_boot', () => {
    // A `providerFallback` naming a codex model id and a codex-only effort
    // must log and fall through to family defaults. The schema is strict, so
    // a throw here would be a container crash loop, not a bad answer.
    let p!: InstanceType<typeof ClaudeProvider>;
    expect(() => {
      p = make({ providerConfig: {}, model: 'gpt-5.6-sol', effort: 'ultra', onFallback: true });
    }).not.toThrow();
    expect(sticky(p).model).toBeUndefined();
    expect(sticky(p).effort).toBeUndefined();

    const opts = run(p);
    expect(opts?.model).toBe('opus');
    expect(opts?.effort).toBe('high');
  });

  it('test_fallback_derives_family_effort_from_the_REAL_model_not_the_opus_alias', () => {
    // Round-2 Q2. The alias-vs-resolved-model gap that bites the PRIMARY path
    // (the container asks the SDK for the literal string `'opus'`, so
    // defaultEffortForModel sees 'opus' and returns 'high' no matter what
    // ANTHROPIC_DEFAULT_OPUS_MODEL points at) does NOT reach the fallback
    // path: the fold puts the fallback's REAL model id into stickyConfig, so
    // `rawModel` is that id and the family default is derived from it.
    // A fallback declaring fable with no effort must therefore get medium.
    const p = make({ providerConfig: {}, model: 'claude-fable-5-1[1m]', onFallback: true });
    const opts = run(p);
    expect(opts?.model).toBe('claude-fable-5-1[1m]');
    expect(opts?.effort).toBe('medium');
  });

  it('test_fallback_haiku_declaration_gets_no_effort_at_all', () => {
    // Haiku supports no effort at the API level; the family default is
    // undefined and the clamp keeps it undefined.
    const p = make({ providerConfig: {}, model: 'claude-haiku-4-5', onFallback: true });
    const opts = run(p);
    expect(opts?.model).toBe('claude-haiku-4-5');
    expect(opts?.effort).toBeUndefined();
  });

  it('test_fallback_sonnet_declaration_gets_xhigh', () => {
    const opts = run(make({ providerConfig: {}, model: 'claude-sonnet-5', onFallback: true }));
    expect(opts?.model).toBe('claude-sonnet-5');
    expect(opts?.effort).toBe('xhigh');
  });

  it('test_no_fallback_values_keeps_an_empty_sticky_config', () => {
    const p = make({ providerConfig: {}, onFallback: true });
    expect(sticky(p)).toEqual({});
  });
});

// The regression guard that matters most. On a PRIMARY claude spawn,
// options.model/options.effort carry container.json's own `model`/`effort`
// (config.ts: `configuredProviderModel || configuredModel`). Those values
// already reach the turn through the host spawn env
// (ANTHROPIC_DEFAULT_OPUS_MODEL / NANOCLAW_EFFORT_OVERRIDE). Folding them into
// stickyConfig as well would give them a SECOND route at higher precedence,
// changing behavior for every claude group in the fleet. The `onFallback` gate
// is what prevents that.
describe('ClaudeProvider primary path is unchanged', () => {
  it('test_primary_ignores_options_model_and_effort', () => {
    const p = make({
      providerConfig: {},
      model: 'claude-fable-5-1[1m]',
      effort: 'medium',
      // no onFallback
    });
    expect(sticky(p)).toEqual({});

    // Exactly the pre-fix behavior: the bare `opus` alias at its family
    // default. The operator's container.json values arrive via the host env
    // instead — asserted by the second half of this test.
    const opts = run(p);
    expect(opts?.model).toBe('opus');
    expect(opts?.effort).toBe('high');

    // ...and the host env route still lands below a -e flag and above the
    // family default, exactly as before.
    expect(run(p, {}, 'medium')?.effort).toBe('medium');
  });

  it('test_primary_explicit_false_is_identical_to_omitted', () => {
    const p = make({
      providerConfig: {},
      model: 'claude-fable-5-1[1m]',
      effort: 'medium',
      onFallback: false,
    });
    expect(sticky(p)).toEqual({});
  });

  it('test_primary_declared_providerConfig_is_still_authoritative', () => {
    const p = make({
      providerConfig: { model: 'claude-opus-5[1m]', effort: 'high' },
      model: 'claude-fable-5-1[1m]',
      effort: 'medium',
    });
    expect(sticky(p).model).toBe('claude-opus-5[1m]');
    expect(sticky(p).effort).toBe('high');

    const opts = run(p);
    expect(opts?.model).toBe('claude-opus-5[1m]');
    expect(opts?.effort).toBe('high');
  });

  it('test_fallback_never_overwrites_a_declared_providerConfig', () => {
    // Defensive: config.ts empties providerConfig on a fallback, so this
    // shape should be unreachable. If it ever became reachable, the declared
    // object must still win rather than being silently replaced.
    const p = make({
      providerConfig: { model: 'claude-opus-5[1m]', effort: 'high' },
      model: 'claude-fable-5-1[1m]',
      effort: 'low',
      onFallback: true,
    });
    expect(sticky(p).model).toBe('claude-opus-5[1m]');
    expect(sticky(p).effort).toBe('high');
  });
});
