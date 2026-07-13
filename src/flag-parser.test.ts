import { describe, it, expect } from 'vitest';

import { parseMessageFlags, formatFlagConfirmation, ensureOpus1mSuffix, isOpenCodeModelSlug } from './flag-parser.js';

describe('ensureOpus1mSuffix', () => {
  it('appends [1m] to a bare claude-opus id (1M auto-compact window guard)', () => {
    expect(ensureOpus1mSuffix('claude-opus-4-8')).toBe('claude-opus-4-8[1m]');
    expect(ensureOpus1mSuffix('claude-opus-4-7')).toBe('claude-opus-4-7[1m]');
  });

  it('is a no-op when the [1m] suffix is already present', () => {
    expect(ensureOpus1mSuffix('claude-opus-4-8[1m]')).toBe('claude-opus-4-8[1m]');
  });

  it('leaves family aliases and non-opus models untouched', () => {
    expect(ensureOpus1mSuffix('opus')).toBe('opus');
    expect(ensureOpus1mSuffix('claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(ensureOpus1mSuffix('claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });
});

describe('parseMessageFlags', () => {
  describe('no flags', () => {
    it('returns undefined intent for plain text', () => {
      const r = parseMessageFlags('hello, how are you?');
      expect(r.intent).toBeUndefined();
      expect(r.cleanedText).toBe('hello, how are you?');
      expect(r.errors).toEqual([]);
      expect(r.warnings).toEqual([]);
    });

    it('strips a mention even when no flags follow', () => {
      expect(parseMessageFlags('<@BOTID123> hi').cleanedText).toBe('hi');
      expect(parseMessageFlags('@U0AKALV5HRP hi').cleanedText).toBe('hi');
      expect(parseMessageFlags('<@!nicknameBot> hi').cleanedText).toBe('hi');
    });
  });

  describe('inline prefix', () => {
    it('parses sticky model with prompt', () => {
      const r = parseMessageFlags('-m haiku write a haiku');
      expect(r.intent).toEqual({ stickyModel: 'haiku' });
      expect(r.cleanedText).toBe('write a haiku');
    });

    it('parses sticky model + sticky effort with prompt', () => {
      const r = parseMessageFlags('-m opus -e high what do you know about me?');
      expect(r.intent).toEqual({ stickyModel: 'opus', stickyEffort: 'high' });
      expect(r.cleanedText).toBe('what do you know about me?');
    });

    it('parses turn-only overrides', () => {
      const r = parseMessageFlags('-m1 sonnet -e1 low quick answer please');
      expect(r.intent).toEqual({ turnModel: 'sonnet', turnEffort: 'low' });
      expect(r.cleanedText).toBe('quick answer please');
    });

    it('resolves pinned aliases to concrete ids', () => {
      const r = parseMessageFlags('-m sonnet5 hi');
      expect(r.intent).toEqual({ stickyModel: 'claude-sonnet-5' });
    });

    it('accepts full concrete model ids', () => {
      const r = parseMessageFlags('-m claude-sonnet-5 hi');
      expect(r.intent).toEqual({ stickyModel: 'claude-sonnet-5' });
    });

    it('auto-appends [1m] to bare opus ids (1M-context only in this fork)', () => {
      const r = parseMessageFlags('-m claude-opus-4-7 hi');
      expect(r.intent).toEqual({ stickyModel: 'claude-opus-4-7[1m]' });
    });

    it('leaves bare alias unresolved (SDK handles current-default lookup)', () => {
      const r = parseMessageFlags('-m opus hi');
      expect(r.intent).toEqual({ stickyModel: 'opus' });
    });

    it('resolves opus48 / opus4-8 aliases to claude-opus-4-8[1m]', () => {
      expect(parseMessageFlags('-m opus48 hi').intent).toEqual({ stickyModel: 'claude-opus-4-8[1m]' });
      expect(parseMessageFlags('-m opus4-8 hi').intent).toEqual({ stickyModel: 'claude-opus-4-8[1m]' });
    });

    it('auto-appends [1m] to bare claude-opus-4-8 id', () => {
      const r = parseMessageFlags('-m claude-opus-4-8 hi');
      expect(r.intent).toEqual({ stickyModel: 'claude-opus-4-8[1m]' });
    });

    it('accepts xhigh effort on opus 4.8 (effort matrix knows the new id)', () => {
      const r = parseMessageFlags('-m opus48 -e xhigh hi');
      expect(r.intent).toEqual({ stickyModel: 'claude-opus-4-8[1m]', stickyEffort: 'xhigh' });
      expect(r.warnings).toEqual([]);
    });

    it('resolves fable / fable5 / fable-5 aliases to claude-fable-5[1m]', () => {
      expect(parseMessageFlags('-m fable hi').intent).toEqual({ stickyModel: 'claude-fable-5[1m]' });
      expect(parseMessageFlags('-m fable5 hi').intent).toEqual({ stickyModel: 'claude-fable-5[1m]' });
      expect(parseMessageFlags('-m fable-5 hi').intent).toEqual({ stickyModel: 'claude-fable-5[1m]' });
    });

    it('auto-appends [1m] to bare claude-fable-5 id (single-digit version scheme)', () => {
      const r = parseMessageFlags('-m claude-fable-5 hi');
      expect(r.intent).toEqual({ stickyModel: 'claude-fable-5[1m]' });
    });

    it('accepts the full effort surface on fable 5 (incl. xhigh and max)', () => {
      const xhigh = parseMessageFlags('-m fable -e xhigh hi');
      expect(xhigh.intent).toEqual({ stickyModel: 'claude-fable-5[1m]', stickyEffort: 'xhigh' });
      expect(xhigh.warnings).toEqual([]);
      const max = parseMessageFlags('-m fable -e max hi');
      expect(max.intent).toEqual({ stickyModel: 'claude-fable-5[1m]', stickyEffort: 'max' });
      expect(max.warnings).toEqual([]);
    });
  });

  describe('mention prefix before flags', () => {
    it('strips Discord <@BOTID>', () => {
      const r = parseMessageFlags('<@1478986205319135302> -m haiku write about autumn');
      expect(r.intent).toEqual({ stickyModel: 'haiku' });
      expect(r.cleanedText).toBe('write about autumn');
    });

    it('strips Discord nickname <@!BOTID>', () => {
      const r = parseMessageFlags('<@!1478986205319135302> -m haiku hi');
      expect(r.intent).toEqual({ stickyModel: 'haiku' });
    });

    it('strips chat-sdk-stripped Slack @UID', () => {
      const r = parseMessageFlags('@U0AKALV5HRP -m sonnet -e low explain');
      expect(r.intent).toEqual({ stickyModel: 'sonnet', stickyEffort: 'low' });
      expect(r.cleanedText).toBe('explain');
    });
  });

  describe('clear sticky', () => {
    it(`clears sticky model on -m ''`, () => {
      const r = parseMessageFlags(`-m '' hi`);
      expect(r.intent).toEqual({ clearStickyModel: true });
      expect(r.cleanedText).toBe('hi');
    });

    it(`clears sticky effort (and ultracode) on -e ""`, () => {
      const r = parseMessageFlags(`-e "" hi`);
      expect(r.intent).toEqual({ clearStickyEffort: true, clearStickyUltracode: true });
    });
  });

  describe('/switch prefix', () => {
    it('strips /switch prefix and parses flags', () => {
      const r = parseMessageFlags('/switch -m haiku');
      expect(r.intent).toEqual({ stickyModel: 'haiku' });
      expect(r.cleanedText).toBe('');
    });

    it('handles /switch combined with mention prefix', () => {
      const r = parseMessageFlags('@U0AKALV5HRP /switch -m opus -e high');
      expect(r.intent).toEqual({ stickyModel: 'opus', stickyEffort: 'high' });
      expect(r.cleanedText).toBe('');
    });

    it('is case-insensitive on the /switch token', () => {
      expect(parseMessageFlags('/Switch -m haiku').intent).toEqual({ stickyModel: 'haiku' });
      expect(parseMessageFlags('/SWITCH -m opus').intent).toEqual({ stickyModel: 'opus' });
    });
  });

  describe('standalone (no prompt)', () => {
    it(`parses bare -m haiku with no trailing text`, () => {
      const r = parseMessageFlags('-m haiku');
      expect(r.intent).toEqual({ stickyModel: 'haiku' });
      expect(r.cleanedText).toBe('');
    });

    it('parses bare multi-flag switch', () => {
      const r = parseMessageFlags('-m opus -e high');
      expect(r.intent).toEqual({ stickyModel: 'opus', stickyEffort: 'high' });
      expect(r.cleanedText).toBe('');
    });
  });

  describe('validation', () => {
    it('warns and drops effort when model is haiku', () => {
      const r = parseMessageFlags('-m haiku -e low summarize');
      expect(r.intent).toEqual({ stickyModel: 'haiku' });
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toMatch(/haiku doesn't support effort/);
    });

    it('accepts xhigh on bare sonnet (now resolves to Sonnet 5, which has xhigh)', () => {
      const r = parseMessageFlags('-m sonnet -e xhigh explain');
      expect(r.intent).toEqual({ stickyModel: 'sonnet', stickyEffort: 'xhigh' });
      expect(r.warnings).toEqual([]);
    });

    it('accepts xhigh on an explicit claude-sonnet-5 pin', () => {
      const r = parseMessageFlags('-m claude-sonnet-5 -e xhigh explain');
      expect(r.intent).toEqual({ stickyModel: 'claude-sonnet-5', stickyEffort: 'xhigh' });
      expect(r.warnings).toEqual([]);
    });

    it('errors on unknown model', () => {
      const r = parseMessageFlags('-m gpt4 hi');
      expect(r.intent).toBeUndefined();
      expect(r.errors[0]).toMatch(/unknown model: gpt4/);
    });

    it('errors on unknown effort', () => {
      const r = parseMessageFlags('-e turbo hi');
      expect(r.intent).toBeUndefined();
      expect(r.errors[0]).toMatch(/unknown effort level: turbo/);
    });
  });

  describe('ultracode', () => {
    it('maps -e ultracode to xhigh effort + a separate ultracode flag (not the effort enum)', () => {
      const r = parseMessageFlags('-e ultracode build the thing');
      expect(r.intent).toEqual({ stickyEffort: 'xhigh', stickyUltracode: true });
      expect(r.errors).toEqual([]);
      expect(r.cleanedText).toBe('build the thing');
    });

    it('is case-insensitive and supports the per-turn -e1 form', () => {
      expect(parseMessageFlags('-e ULTRACODE x').intent).toEqual({ stickyEffort: 'xhigh', stickyUltracode: true });
      expect(parseMessageFlags('-e1 ultracode x').intent).toEqual({ turnEffort: 'xhigh', turnUltracode: true });
    });

    it('a normal -e level emits a clean intent (ultracode-off is inferred container-side)', () => {
      // No stickyUltracode field — the container clears ultracode whenever
      // stickyEffort is set without the ultracode flag.
      expect(parseMessageFlags('-e high x').intent).toEqual({ stickyEffort: 'high' });
    });

    it(`-e '' clears both effort and ultracode`, () => {
      expect(parseMessageFlags(`-e '' x`).intent).toEqual({ clearStickyEffort: true, clearStickyUltracode: true });
    });

    it('drops ultracode and warns when the model is not xhigh-capable', () => {
      // opus 4.6 has no xhigh; bare `sonnet` now resolves to Sonnet 5 (which
      // has xhigh), so it would NOT drop ultracode.
      const r = parseMessageFlags('-m opus46 -e ultracode x');
      expect(r.intent).toEqual({ stickyModel: 'claude-opus-4-6[1m]' });
      expect(r.warnings.some((w) => /ultracode needs an xhigh-capable model/.test(w))).toBe(true);
    });
  });
});

describe('formatFlagConfirmation', () => {
  it('formats a plain sticky switch', () => {
    const out = formatFlagConfirmation({ stickyModel: 'haiku' }, [], []);
    expect(out).toBe('⚙️ model → haiku');
  });

  it('combines model + effort on one line', () => {
    const out = formatFlagConfirmation({ stickyModel: 'opus', stickyEffort: 'high' }, [], []);
    expect(out).toBe('⚙️ model → opus, effort → high');
  });

  it('appends warnings on their own line', () => {
    const out = formatFlagConfirmation({ stickyModel: 'haiku' }, ["haiku doesn't support effort — skipped effort"], []);
    expect(out).toContain('⚙️ model → haiku');
    expect(out).toContain('⚠️');
  });

  it('returns only errors when nothing applied', () => {
    const out = formatFlagConfirmation({}, [], ['unknown model: gpt4']);
    expect(out).toBe('❌ unknown model: gpt4');
  });

  it('returns empty string for empty intent with no messages', () => {
    expect(formatFlagConfirmation({}, [], [])).toBe('');
  });

  it('shows ultracode instead of a redundant effort → xhigh line', () => {
    const out = formatFlagConfirmation({ stickyEffort: 'xhigh', stickyUltracode: true }, [], []);
    expect(out).toContain('ultracode ON');
    expect(out).not.toContain('effort → xhigh');
  });
});

describe('provider-aware vocabulary (codex)', () => {
  // Observed live 2026-06-10 on dirt-market-codex: `-m fable` was acked and
  // stored on a codex session (then silently ignored by the provider), while
  // `-m gpt-5.5` — the model actually running — was rejected as unknown.
  // The parser now selects vocabulary by the target group's provider.

  it('accepts codex model ids that the claude vocab rejects', () => {
    const r = parseMessageFlags('-m gpt-5.5 hi', 'codex');
    expect(r.intent).toEqual({ stickyModel: 'gpt-5.5' });
    expect(r.errors).toEqual([]);
  });

  it('accepts dotted/dashed codex ids and turn overrides', () => {
    const r = parseMessageFlags('-m1 gpt-5.2-codex hi', 'codex');
    expect(r.intent).toEqual({ turnModel: 'gpt-5.2-codex' });
  });

  it('resolves codex convenience aliases', () => {
    const r = parseMessageFlags('-m gpt5.5 hi', 'codex');
    expect(r.intent).toEqual({ stickyModel: 'gpt-5.5' });
  });

  it('rejects claude ids on a codex group with a shape hint', () => {
    const r = parseMessageFlags('-m fable hi', 'codex');
    expect(r.intent).toBeUndefined();
    expect(r.errors[0]).toMatch(/unknown model: fable/);
    expect(r.errors[0]).toMatch(/gpt-5\.5/);
  });

  it.each(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])('accepts the current codex effort level %s', (effort) => {
    expect(parseMessageFlags(`-e ${effort} hi`, 'codex').intent).toEqual({ stickyEffort: effort });
    expect(parseMessageFlags(`-e1 ${effort} hi`, 'codex').intent).toEqual({ turnEffort: effort });
  });

  it.each(['none', 'minimal'])('rejects unsupported codex effort level %s', (effort) => {
    const r = parseMessageFlags(`-e ${effort} hi`, 'codex');
    expect(r.intent).toBeUndefined();
    expect(r.errors[0]).toMatch(new RegExp(`unknown effort level: ${effort}`));
    expect(r.errors[0]).toMatch(/low\|medium\|high\|xhigh\|max\|ultra/);
  });

  it('rejects ultracode on codex with an honest provider message', () => {
    const r = parseMessageFlags('-e ultracode hi', 'codex');
    expect(r.intent).toBeUndefined();
    expect(r.errors[0]).toMatch(/ultracode is Claude-only/);
    const r1 = parseMessageFlags('-e1 ultracode hi', 'codex');
    expect(r1.errors[0]).toMatch(/ultracode is Claude-only/);
  });

  it('clears sticky model/effort identically across providers', () => {
    expect(parseMessageFlags("-m '' hi", 'codex').intent).toEqual({ clearStickyModel: true });
    expect(parseMessageFlags("-e '' hi", 'codex').intent).toEqual({
      clearStickyEffort: true,
      clearStickyUltracode: true,
    });
  });

  it('codex model+effort pairs skip the claude effort matrix', () => {
    const r = parseMessageFlags('-m gpt-5.5 -e xhigh hi', 'codex');
    expect(r.intent).toEqual({ stickyModel: 'gpt-5.5', stickyEffort: 'xhigh' });
    expect(r.warnings).toEqual([]);
  });

  it('defaults to the claude vocabulary when no provider is passed (back-compat)', () => {
    const r = parseMessageFlags('-m fable hi');
    expect(r.intent).toEqual({ stickyModel: 'claude-fable-5[1m]' });
    expect(parseMessageFlags('-m gpt-5.5 hi').errors[0]).toMatch(/unknown model/);
  });
});

describe('provider-aware vocabulary (opencode)', () => {
  // OpenCode validates slug SHAPE (`<provider>/<id…>`), not an allowlist — the
  // live catalog is huge and only enumerable in-container (list_models MCP).

  it('accepts a provider-prefixed Go slug', () => {
    const r = parseMessageFlags('-m opencode-go/kimi-k2.7-code hi', 'opencode');
    expect(r.intent).toEqual({ stickyModel: 'opencode-go/kimi-k2.7-code' });
    expect(r.errors).toEqual([]);
  });

  it('accepts a Zen slug and a multi-segment nvidia slug', () => {
    expect(parseMessageFlags('-m opencode/gpt-5.5 hi', 'opencode').intent).toEqual({
      stickyModel: 'opencode/gpt-5.5',
    });
    expect(parseMessageFlags('-m1 nvidia/meta/llama-3.3-70b-instruct hi', 'opencode').intent).toEqual({
      turnModel: 'nvidia/meta/llama-3.3-70b-instruct',
    });
  });

  it('rejects unprefixed ids (claude aliases, bare codex ids) with a shape hint', () => {
    const claude = parseMessageFlags('-m fable hi', 'opencode');
    expect(claude.intent).toBeUndefined();
    expect(claude.errors[0]).toMatch(/unknown model: fable/);
    expect(claude.errors[0]).toMatch(/provider-prefixed/);
    const codex = parseMessageFlags('-m gpt-5.5 hi', 'opencode');
    expect(codex.intent).toBeUndefined();
    expect(codex.errors[0]).toMatch(/unknown model: gpt-5\.5/);
  });

  it('accepts the portable effort enum (low|medium|high)', () => {
    expect(parseMessageFlags('-e low hi', 'opencode').intent).toEqual({ stickyEffort: 'low' });
    expect(parseMessageFlags('-e high hi', 'opencode').intent).toEqual({ stickyEffort: 'high' });
  });

  it('accepts max (a real opencode variant, e.g. DeepSeek V4)', () => {
    expect(parseMessageFlags('-e max hi', 'opencode').intent).toEqual({ stickyEffort: 'max' });
    expect(parseMessageFlags('-m opencode-go/deepseek-v4-pro -e max hi', 'opencode').intent).toEqual({
      stickyModel: 'opencode-go/deepseek-v4-pro',
      stickyEffort: 'max',
    });
  });

  it('rejects non-opencode effort levels (xhigh/none/minimal) with the opencode enum', () => {
    for (const bad of ['xhigh', 'none', 'minimal']) {
      const r = parseMessageFlags(`-e ${bad} hi`, 'opencode');
      expect(r.intent).toBeUndefined();
      expect(r.errors[0]).toMatch(new RegExp(`unknown effort level: ${bad}`));
      expect(r.errors[0]).toMatch(/low\|medium\|high\|max/);
    }
  });

  it('rejects ultracode on opencode (Claude-only)', () => {
    const r = parseMessageFlags('-e ultracode hi', 'opencode');
    expect(r.intent).toBeUndefined();
    expect(r.errors[0]).toMatch(/ultracode is Claude-only/);
  });

  it('accepts a model+effort pair with no claude effort-matrix warnings', () => {
    const r = parseMessageFlags('-m opencode-go/glm-5.1 -e medium hi', 'opencode');
    expect(r.intent).toEqual({ stickyModel: 'opencode-go/glm-5.1', stickyEffort: 'medium' });
    expect(r.warnings).toEqual([]);
  });
});

describe('isOpenCodeModelSlug (shared with change_model validation)', () => {
  it('accepts provider-prefixed slugs', () => {
    expect(isOpenCodeModelSlug('opencode-go/kimi-k2.7-code')).toBe(true);
    expect(isOpenCodeModelSlug('opencode/gpt-5.5')).toBe(true);
    expect(isOpenCodeModelSlug('nvidia/meta/llama-3.3-70b-instruct')).toBe(true);
    expect(isOpenCodeModelSlug('  opencode-go/glm-5.1  ')).toBe(true); // trims
  });

  it('rejects bare/malformed slugs (the change_model failure mode)', () => {
    expect(isOpenCodeModelSlug('kimi-k2.7-code')).toBe(false); // no provider prefix
    expect(isOpenCodeModelSlug('opencode-go/')).toBe(false); // empty id
    expect(isOpenCodeModelSlug('/kimi')).toBe(false); // empty provider
    expect(isOpenCodeModelSlug('')).toBe(false);
  });
});
