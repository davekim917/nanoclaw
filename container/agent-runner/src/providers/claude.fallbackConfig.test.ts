import { describe, it, expect, mock } from 'bun:test';

// A claude PROVIDER FALLBACK, end to end: the host resolves the group's
// declared providerFallback into the spawn env, and the provider reads it.
//
// There is deliberately no container-side "fold" of the fallback declaration
// into stickyConfig any more. There was one, and it drew three consecutive
// review findings (a too-broad regex, a stray /i, and validating before
// resolving aliases) — all of them defects in a mirror of the host's model
// vocabulary that only existed to carry a value the host already sends.
// Since the provider reads NANOCLAW_CLAUDE_MODEL directly, the
// declaration arrives resolved and validated by the host's own tables, and
// the mirror is gone. These tests pin that the arrival still happens.
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

const { claudeSpawnEnv } = await import('../../../../src/claude-spawn-defaults.ts');
const { ClaudeProvider } = await import('./claude.js');
const { parseRawConfig } = await import('../config.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

/**
 * One fallback spawn, host seam included.
 *
 * `container-runner.ts` sets `containerConfig.model`/`.effort` to the declared
 * fallback's values before building the env (the `providerDecision` block), so
 * the host seam sees exactly this shape. The env is restored afterwards: bun
 * runs every file in ONE process and the provider reads
 * NANOCLAW_CLAUDE_MODEL at query time.
 */
function fallbackSpawn(declared: { model?: string; effort?: string }) {
  const env = claudeSpawnEnv({ model: declared.model, effort: declared.effort } as never, {});
  const kv: Record<string, string> = {};
  for (let i = 0; i < env.length; i += 2) {
    const [k, ...rest] = env[i + 1].split('=');
    kv[k] = rest.join('=');
  }
  const prevGroupModel = process.env.NANOCLAW_CLAUDE_MODEL;
  const prevAlias = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  const prevEffort = process.env.NANOCLAW_EFFORT_OVERRIDE;
  const prevProvider = process.env.NANOCLAW_PROVIDER_OVERRIDE;
  try {
    process.env.NANOCLAW_CLAUDE_MODEL = kv.NANOCLAW_CLAUDE_MODEL;
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = kv.ANTHROPIC_DEFAULT_OPUS_MODEL;
    if (kv.NANOCLAW_EFFORT_OVERRIDE === undefined) delete process.env.NANOCLAW_EFFORT_OVERRIDE;
    else process.env.NANOCLAW_EFFORT_OVERRIDE = kv.NANOCLAW_EFFORT_OVERRIDE;
    // config.ts empties providerConfig on a fallback — the primary's sticky
    // config is the wrong provider's, and codex's `reasoning_effort` key is a
    // fatal boot error under claude's strict schema.
    process.env.NANOCLAW_PROVIDER_OVERRIDE = 'claude';
    const runner = parseRawConfig({ provider: 'codex', providerConfig: { reasoning_effort: 'high' } });
    expect(runner.providerConfig).toEqual({});
    const p = new ClaudeProvider({ providerConfig: runner.providerConfig });
    p.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    capturedSdkOptions = null;
    mockSdkQuery.mockClear();
    p.query({ prompt: 'hi', cwd: '/tmp' });
    return { env: kv, model: capturedSdkOptions?.model, effort: capturedSdkOptions?.effort };
  } finally {
    if (prevGroupModel === undefined) delete process.env.NANOCLAW_CLAUDE_MODEL;
    else process.env.NANOCLAW_CLAUDE_MODEL = prevGroupModel;
    if (prevAlias === undefined) delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
    else process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = prevAlias;
    if (prevEffort === undefined) delete process.env.NANOCLAW_EFFORT_OVERRIDE;
    else process.env.NANOCLAW_EFFORT_OVERRIDE = prevEffort;
    if (prevProvider === undefined) delete process.env.NANOCLAW_PROVIDER_OVERRIDE;
    else process.env.NANOCLAW_PROVIDER_OVERRIDE = prevProvider;
  }
}

describe('a claude provider fallback reaches the provider without a container-side fold', () => {
  it('test_fallback_concrete_id', () => {
    const r = fallbackSpawn({ model: 'claude-opus-5[1m]', effort: 'high' });
    expect(r.model).toBe('claude-opus-5[1m]');
    expect(r.effort).toBe('high');
  });

  it('test_fallback_pinned_alias_is_resolved_by_the_host', () => {
    // The exact case the deleted mirror got wrong: it validated the RAW string
    // and rejected every pinned alias, because the host validates only AFTER
    // resolving. The host now resolves before emitting, so there is nothing
    // left to get wrong.
    expect(fallbackSpawn({ model: 'fable' }).model).toBe('claude-fable-5-1[1m]');
    expect(fallbackSpawn({ model: 'sonnet5' }).model).toBe('claude-sonnet-5');
    expect(fallbackSpawn({ model: 'haiku45' }).model).toBe('claude-haiku-4-5');
    expect(fallbackSpawn({ model: 'opus5' }).model).toBe('claude-opus-5[1m]');
  });

  it('test_fallback_family_effort_follows_the_declared_model', () => {
    expect(fallbackSpawn({ model: 'fable' }).effort).toBe('high');
    expect(fallbackSpawn({ model: 'sonnet5' }).effort).toBe('xhigh');
    expect(fallbackSpawn({ model: 'claude-opus-5[1m]' }).effort).toBe('high');
  });

  it('test_fallback_haiku_declaration_gets_no_effort_at_all', () => {
    const r = fallbackSpawn({ model: 'haiku' });
    expect(r.model).toBe('claude-haiku-4-5-20251001');
    expect(r.effort).toBeUndefined();
  });

  it('test_fallback_declared_effort_beats_the_family_default', () => {
    expect(fallbackSpawn({ model: 'fable', effort: 'max' }).effort).toBe('max');
  });

  it('test_misdeclared_fallback_degrades_at_the_host_instead_of_reaching_the_api', () => {
    // A codex model id or a codex-only effort on a claude fallback. The host's
    // own vocabulary refuses both, so the container never sees them — and a
    // boot-time crash loop is impossible because nothing is parsed there.
    const r = fallbackSpawn({ model: 'gpt-5.6-sol', effort: 'ultra' });
    expect(r.model).toBe('claude-opus-5-5[1m]');
    expect(r.effort).toBe('high');
  });

  it('test_a_fallback_with_no_declaration_runs_the_install_default', () => {
    const r = fallbackSpawn({});
    expect(r.model).toBe('claude-opus-5-5[1m]');
    expect(r.effort).toBe('high');
  });
});

describe('the primary path is unchanged by the removal', () => {
  it('test_primary_providerConfig_is_still_authoritative', () => {
    const prev = process.env.NANOCLAW_CLAUDE_MODEL;
    try {
      process.env.NANOCLAW_CLAUDE_MODEL = 'claude-sonnet-5';
      const p = new ClaudeProvider({ providerConfig: { model: 'claude-opus-5[1m]', effort: 'low' } });
      p.registerMemorySessionHook(MEMORY_SESSION_HOOK);
      capturedSdkOptions = null;
      p.query({ prompt: 'hi', cwd: '/tmp' });
      expect(capturedSdkOptions?.model).toBe('claude-opus-5[1m]');
      expect(capturedSdkOptions?.effort).toBe('low');
    } finally {
      if (prev === undefined) delete process.env.NANOCLAW_CLAUDE_MODEL;
      else process.env.NANOCLAW_CLAUDE_MODEL = prev;
    }
  });
});
