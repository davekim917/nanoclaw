import { describe, it, expect, mock } from 'bun:test';
let cap: Record<string, unknown> | null = null;
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (a: unknown) => {
    cap = (a as { options?: Record<string, unknown> }).options ?? null;
    const g = (async function* () {})() as AsyncGenerator & {
      setModel: (m?: string) => Promise<void>;
      applyFlagSettings: (s: Record<string, unknown>) => Promise<void>;
    };
    g.setModel = () => Promise.resolve();
    g.applyFlagSettings = () => Promise.resolve();
    return g;
  },
}));
const rcs = await import('../db/container-state.js');
mock.module('../db/container-state.js', () => ({
  ...rcs,
  clearContainerToolInFlight: () => {},
  setContainerToolInFlight: () => {},
}));
const { claudeSpawnEnv } = await import('../../../../src/claude-spawn-defaults.ts');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');
const { ClaudeProvider } = await import('./claude.js');

/**
 * Host seam -> real spawn env -> real provider. No step reasoned about.
 *
 * The env is restored before returning. bun:test shares ONE process across
 * files, and NANOCLAW_CLAUDE_MODEL is read at query time (#540 in the var it
 * then had), so leaking it here silently rewrites the model in every later
 * file — six unrelated failures in claude.configSchema.test.ts, observed.
 */
function spawn(cfg: Record<string, unknown>, channel: { model?: string | null; effort?: string | null } = {}) {
  const env = claudeSpawnEnv(cfg as never, channel);
  const kv: Record<string, string> = {};
  for (let i = 0; i < env.length; i += 2) {
    const [k, ...r] = env[i + 1].split('=');
    kv[k] = r.join('=');
  }
  const prevGroupModel = process.env.NANOCLAW_CLAUDE_MODEL;
  const prevAlias = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  const prevEffort = process.env.NANOCLAW_EFFORT_OVERRIDE;
  try {
    process.env.NANOCLAW_CLAUDE_MODEL = kv.NANOCLAW_CLAUDE_MODEL;
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = kv.ANTHROPIC_DEFAULT_OPUS_MODEL;
    if (kv.NANOCLAW_EFFORT_OVERRIDE === undefined) delete process.env.NANOCLAW_EFFORT_OVERRIDE;
    else process.env.NANOCLAW_EFFORT_OVERRIDE = kv.NANOCLAW_EFFORT_OVERRIDE;
    const p = new ClaudeProvider({ providerConfig: (cfg.providerConfig ?? {}) as Record<string, unknown> });
    p.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    cap = null;
    p.query({ prompt: 'x', cwd: '/tmp' });
    return { env: kv, model: cap?.model, effort: cap?.effort, systemPrompt: cap?.systemPrompt };
  } finally {
    if (prevGroupModel === undefined) delete process.env.NANOCLAW_CLAUDE_MODEL;
    else process.env.NANOCLAW_CLAUDE_MODEL = prevGroupModel;
    if (prevAlias === undefined) delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
    else process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = prevAlias;
    if (prevEffort === undefined) delete process.env.NANOCLAW_EFFORT_OVERRIDE;
    else process.env.NANOCLAW_EFFORT_OVERRIDE = prevEffort;
  }
}

describe('END-TO-END after the deletion', () => {
  it('round-5 P1: a haiku group sends NO effort, and the container is what refuses it', () => {
    const r = spawn({ model: 'haiku' });
    console.log('  haiku group  env=', JSON.stringify(r.env), ' -> model=', r.model, ' effort=', r.effort);
    expect(r.env.NANOCLAW_CLAUDE_MODEL).toBe('claude-haiku-4-5-20251001');
    // ...and the group's model does NOT become what the word `opus` means:
    // a `model: opus` subagent in a haiku group still gets Opus.
    expect(r.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-5-5[1m]');
    expect(r.env.NANOCLAW_EFFORT_OVERRIDE).toBeUndefined();
    expect(r.model).toBe('claude-haiku-4-5-20251001');
    expect(r.effort).toBeUndefined();
  });

  it('round-6 P2: an explicit effort the host no longer clamps is clamped by the container', () => {
    const r = spawn({ model: 'haiku', effort: 'high' });
    console.log('  haiku+high   env=', JSON.stringify(r.env), ' -> model=', r.model, ' effort=', r.effort);
    expect(r.env.NANOCLAW_EFFORT_OVERRIDE).toBe('high'); // host passes it through
    expect(r.effort).toBeUndefined(); // container clamps it
  });

  it('round-6 P2 shape: providerConfig.model wins and the operator effort SURVIVES', () => {
    const r = spawn({ model: 'haiku', effort: 'high', providerConfig: { model: 'claude-fable-5-1[1m]' } });
    console.log('  pc=fable m=haiku e=high -> model=', r.model, ' effort=', r.effort);
    expect(r.model).toBe('claude-fable-5-1[1m]');
    expect(r.effort).toBe('high'); // was silently dropped before
  });

  it('sonnet wiring: family default now comes from the container', () => {
    const r = spawn({}, { model: 'sonnet' });
    console.log('  sonnet wiring -> model=', r.model, ' effort=', r.effort);
    expect(r.env.NANOCLAW_EFFORT_OVERRIDE).toBeUndefined();
    expect(r.effort).toBe('xhigh');
    expect(r.systemPrompt).toMatchObject({
      type: 'preset',
      preset: 'claude_code',
      append: expect.stringContaining('provider "claude", model "claude-sonnet-5", and reasoning effort "xhigh"'),
    });
  });

  it('the ncl-configured pair still lands', () => {
    const r = spawn({ model: 'claude-fable-5-1[1m]', effort: 'medium' });
    console.log('  configured pair -> model=', r.model, ' effort=', r.effort);
    expect(r.model).toBe('claude-fable-5-1[1m]');
    expect(r.effort).toBe('medium');
  });

  it('the unconfigured fleet baseline resolves to Opus [1m] / high', () => {
    const r = spawn({});
    console.log('  baseline      -> model=', r.model, ' effort=', r.effort);
    expect(r.model).toBe('claude-opus-5-5[1m]');
    expect(r.effort).toBe('high');
  });

  it('a `model: opus` group pin resolves to Opus even where the group runs Sonnet', () => {
    // group-init writes `"model": "opus"` into every group's
    // .claude-shared/settings.json, and a subagent's `model:` frontmatter uses
    // the same word. Both resolve through ANTHROPIC_DEFAULT_OPUS_MODEL, which
    // carried the GROUP's model until 2026-09-15 — so in this Sonnet group the
    // word meant Sonnet 5, and every `model: opus` subagent silently ran it.
    const r = spawn({ model: 'claude-sonnet-5' });
    expect(r.env.NANOCLAW_CLAUDE_MODEL).toBe('claude-sonnet-5');
    expect(r.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-5-5[1m]');
    expect(r.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('claude-sonnet-5');
    // ...and the group still runs the model it pinned.
    expect(r.model).toBe('claude-sonnet-5');
    expect(r.effort).toBe('xhigh');
  });

  it('a carried codex model + ultra are still refused at the host', () => {
    const r = spawn({ model: 'gpt-6-astra', effort: 'ultra' });
    console.log('  codex residue -> model=', r.model, ' effort=', r.effort);
    expect(r.model).toBe('claude-opus-5-5[1m]');
    expect(r.effort).toBe('high');
  });
});
