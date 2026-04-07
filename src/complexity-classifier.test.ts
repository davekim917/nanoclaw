import { describe, it, expect } from 'vitest';

import { classifyComplexity } from './complexity-classifier.js';

// Minimal regression guard for the complexity classifier. The classifier
// is pure regex/set lookups, so we don't exhaustively test every trivial
// word — just one representative per tier and the key edge cases that
// historically broke (ambiguous narrative messages, strict mode, etc.).
describe('complexity-classifier', () => {
  it('tier 1 regex: single trivial word → TRIVIAL', () => {
    for (const word of ['lol', 'hmm', 'interesting', 'welp', 'bro', 'done']) {
      const r = classifyComplexity(word);
      expect(r.complexity).toBe('TRIVIAL');
      expect(r.reason).toBe('regex');
    }
  });

  it('tier 1 regex: word with trailing punctuation/emoji → TRIVIAL', () => {
    for (const text of ['nice!', 'thanks!!', 'lol 😂', '🎉👍']) {
      const r = classifyComplexity(text);
      expect(r.complexity).toBe('TRIVIAL');
    }
  });

  it('tier 1 regex: fixed idiomatic phrases → TRIVIAL', () => {
    for (const text of ['will do', 'can do', 'hell yeah', 'damn right']) {
      const r = classifyComplexity(text);
      expect(r.complexity).toBe('TRIVIAL');
      expect(r.reason).toBe('regex');
    }
  });

  it('tier 1 vocab: short multi-word casual phrase → TRIVIAL', () => {
    for (const text of [
      'got it',
      'makes sense',
      'no worries',
      'sounds good',
      'my bad',
      'oh really',
      "that's crazy",
      'hmm yeah',
      'sup bro',
      'i see',
    ]) {
      const r = classifyComplexity(text);
      expect(r.complexity).toBe('TRIVIAL');
      expect(r.reason).toBe('phrase');
    }
  });

  it('tier 1 vocab: rejects unknown word', () => {
    // "thoughts" not in vocab → falls through to default WORK
    const r = classifyComplexity('any thoughts');
    expect(r.complexity).toBe('WORK');
  });

  it('tier 1 vocab: rejects messages over the size caps', () => {
    // >40 chars
    const r1 = classifyComplexity(
      'yeah ok sure thanks for all that really appreciate',
    );
    expect(r1.complexity).toBe('WORK');
    // >6 words
    const r2 = classifyComplexity('yeah ok sure nice cool dope sweet');
    expect(r2.complexity).toBe('WORK');
  });

  // Regression: `\p{Emoji}` used to match ASCII digits / #. A numeric
  // reply like "1500" would classify as TRIVIAL → route to Haiku. Fixed
  // by switching to `\p{Extended_Pictographic}` in EMOJI_ONLY + suffix
  // classes + tokenize().
  it('regression: numeric-only messages classify as WORK, not TRIVIAL', () => {
    for (const text of ['5', '500', '1500', '#5', '12 50', '0', '3 2 1']) {
      const r = classifyComplexity(text);
      expect(r.complexity).toBe('WORK');
    }
  });

  it('regression: messages with trailing digits tokenize correctly', () => {
    // tokenize() must NOT strip digits — otherwise "its 9000" → ["its"] → TRIVIAL
    const r = classifyComplexity('its 9000');
    expect(r.complexity).toBe('WORK');
  });

  // Regression: TRIVIAL_VOCAB previously included 'call', 'point', 'deal',
  // 'big' as noun-form entries. They also function as imperative verbs in
  // short phrases and routed real work to Haiku.
  it('regression: imperative uses of removed vocab words → WORK', () => {
    for (const text of [
      'call me',
      'call me later',
      'point me to that',
      'deal with this',
      'big problem here',
    ]) {
      const r = classifyComplexity(text);
      expect(r.complexity).toBe('WORK');
    }
  });

  it('tier 2: work keywords → WORK', () => {
    for (const text of [
      'can you fix this?',
      'check the logs',
      'remind me at 5pm',
      'restart the server',
      'how does this work',
      'ping me when done',
      'email the team',
    ]) {
      const r = classifyComplexity(text);
      expect(r.complexity).toBe('WORK');
      expect(r.reason).toBe('keyword');
    }
  });

  it('tier 2: code fences, URLs, long, multi-line → WORK', () => {
    expect(classifyComplexity('```code```').complexity).toBe('WORK');
    expect(classifyComplexity('see https://x.com').complexity).toBe('WORK');
    expect(classifyComplexity('a'.repeat(81)).complexity).toBe('WORK');
    expect(classifyComplexity('line1\nline2').complexity).toBe('WORK');
  });

  it('default: ambiguous narrative → WORK', () => {
    // Historical case from the tier-3 era: this used to reach Haiku and
    // classify TRIVIAL. Without the slow path, it defaults to WORK.
    const r = classifyComplexity('sorry I took you out for a bit');
    expect(r.complexity).toBe('WORK');
    expect(r.reason).toBe('default');
  });

  it('classifier is synchronous and fast', () => {
    // The classifier is pure regex/set lookups — no awaits, no I/O. This
    // test guards against accidental reintroduction of a slow path.
    const t0 = Date.now();
    for (let i = 0; i < 1000; i++) {
      classifyComplexity('interesting thought here');
    }
    expect(Date.now() - t0).toBeLessThan(500);
  });

  describe('strict mode', () => {
    it('tier 1 regex matches still downgrade', () => {
      expect(classifyComplexity('lol', true).complexity).toBe('TRIVIAL');
    });

    it('tier 1 vocab matches still downgrade', () => {
      // Intentional: vocab phrases are "obvious chit-chat" and should
      // downgrade even when the user has pinned a model with -m.
      expect(classifyComplexity('makes sense', true).complexity).toBe(
        'TRIVIAL',
      );
    });

    it('skips tier 2 — ambiguous + keyword both default to WORK', () => {
      const r1 = classifyComplexity('any progress', true);
      expect(r1.complexity).toBe('WORK');
      expect(r1.reason).toBe('default');
      const r2 = classifyComplexity('fix this', true);
      expect(r2.complexity).toBe('WORK');
      expect(r2.reason).toBe('default');
    });
  });
});
