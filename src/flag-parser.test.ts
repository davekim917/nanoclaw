import { describe, it, expect } from 'vitest';

import { parseMessageFlags, formatFlagConfirmation } from './flag-parser.js';

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
      const r = parseMessageFlags('-m sonnet4-6 hi');
      expect(r.intent).toEqual({ stickyModel: 'claude-sonnet-4-6' });
    });

    it('accepts full concrete model ids', () => {
      const r = parseMessageFlags('-m claude-sonnet-4-6 hi');
      expect(r.intent).toEqual({ stickyModel: 'claude-sonnet-4-6' });
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

    it('warns when sonnet gets xhigh (opus-4.7 only)', () => {
      const r = parseMessageFlags('-m sonnet -e xhigh explain');
      expect(r.intent).toEqual({ stickyModel: 'sonnet' });
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toMatch(/xhigh/);
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
      const r = parseMessageFlags('-m sonnet -e ultracode x');
      expect(r.intent).toEqual({ stickyModel: 'sonnet' });
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
