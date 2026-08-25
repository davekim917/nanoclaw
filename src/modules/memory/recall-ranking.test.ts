/**
 * Guards for the two recall-ranking performance changes: the `canonicalToken`
 * memo and the query-term hit list inside `bestPassage`.
 *
 * Every test here exists because a plausible future "optimization" silently
 * changes the bytes delivered to the agent rather than failing loudly. The
 * reason is in each test name — read it before deleting one.
 */
import { describe, expect, it, vi } from 'vitest';

import { log } from '../../log.js';
import {
  _bestPassageForTest,
  _canonicalMemoStatsForTest,
  _resetCanonicalMemoForTest,
  _resetTokenStreamCacheForTest,
  passageWindows,
  tokenizeForRecall,
  tokenStreamForRecall,
  type RecallToken,
} from './pre-turn-context.js';

/** Distinct tokens the canonical rules never rewrite: no `ing`/`ed`/`s` tail. */
function distinctTokens(prefix: string, count: number, from = 0): string {
  const parts: string[] = [];
  for (let index = from; index < from + count; index++) parts.push(`${prefix}${index}`);
  return parts.join(' ');
}

function resetCaches(): void {
  _resetCanonicalMemoForTest();
  _resetTokenStreamCacheForTest();
}

describe('canonicalToken memo', () => {
  it('caches repeated tokens — a memo that is not wired in still passes every output test', () => {
    resetCaches();
    expect(tokenizeForRecall('hosting hosting hosting')).toEqual(['host']);
    const stats = _canonicalMemoStatsForTest();
    expect(stats.hits).toBe(2);
    // One miss per DISTINCT token, so the miss count is the distinct-token count.
    expect(stats.misses).toBe(1);
    expect(stats.size).toBe(1);
  });

  it('leaves every canonical form byte-identical — the memo must not become a second stemmer', () => {
    resetCaches();
    const expected: Array<[string, string]> = [
      ['manage', 'host'],
      ['manages', 'host'],
      ['managed', 'host'],
      ['managing', 'host'],
      ['host', 'host'],
      ['hosts', 'host'],
      ['hosted', 'host'],
      ['hosting', 'host'],
      ['capability', 'capabil'],
      ['capabilities', 'capabil'],
      ['provider', 'provid'],
      ['providers', 'provid'],
      ['suggestion', 'suggest'],
      ['suggestions', 'suggest'],
      ['column', 'column'],
      ['columns', 'column'],
      ['worktree', 'worktree'],
      ['worktrees', 'worktree'],
      ['running', 'runn'],
      ['shipped', 'shipp'],
      ['files', 'file'],
      ['ab', 'ab'],
    ];
    for (const [word, canonical] of expected) {
      expect(tokenizeForRecall(word)).toEqual([canonical]);
      // Second call comes out of the memo; it must not differ from the first.
      expect(tokenizeForRecall(word)).toEqual([canonical]);
    }
  });

  it('evicts exactly ONE oldest entry on overflow — a wholesale .clear() never warms up again', () => {
    resetCaches();
    const max = _canonicalMemoStatsForTest().max;
    tokenStreamForRecall(distinctTokens('zq', max + 1));
    // `.clear()` on overflow would leave size 1. Evict-one leaves the cap.
    expect(_canonicalMemoStatsForTest().size).toBe(max);
    resetCaches();
  });

  // SLOW (~70s) and unavoidably so: crossing the 1M-lookup threshold at a
  // sub-50% hit rate means >500k misses, which means >370k evictions, and an
  // over-capacity Map costs ~80us per delete+insert (measured). That cost IS
  // the failure mode this warning exists to surface, so the test pays it.
  it('warns exactly once when the hit rate collapses — an undersized cap fails silently otherwise', () => {
    resetCaches();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const fired = (): number =>
      warn.mock.calls.filter(([message]) => message.includes('canonical-token memo hit rate')).length;
    try {
      // All-distinct tokens past the 1M-lookup threshold: hit rate 0%. The token
      // stream cache is reset per chunk so the fixture does not retain 1M tokens.
      const chunk = 10_000;
      for (let index = 0; index <= 1_000_000 / chunk; index++) {
        tokenStreamForRecall(distinctTokens('wq', chunk, index * chunk));
        _resetTokenStreamCacheForTest();
      }
      const stats = _canonicalMemoStatsForTest();
      expect(stats.hits + stats.misses).toBeGreaterThan(1_000_000);
      expect(stats.hits).toBe(0);
      expect(fired()).toBe(1);

      // One-shot: more sub-50% traffic must not re-warn.
      tokenStreamForRecall(distinctTokens('wq', chunk, 5_000_000));
      _resetTokenStreamCacheForTest();
      expect(fired()).toBe(1);
    } finally {
      warn.mockRestore();
      resetCaches();
    }
  }, 180_000);
});

describe('bestPassage hit list', () => {
  it('returns the FIRST of two tied windows — a keep-best `<=` scan returns the LAST and changes delivered bytes', () => {
    resetCaches();
    const candidate = 'alpha one beta\nbeta two alpha';
    // Windows 0 and 2 tie on all four ranking fields; the stable sort keeps the
    // first, a keep-best scan would return 'beta two alpha'.
    expect(passageWindows(candidate, 900).map((window) => window.text)).toEqual([
      'alpha one beta',
      'alpha one beta\nbeta two alpha',
      'beta two alpha',
    ]);
    expect(_bestPassageForTest(['alpha', 'beta'], candidate, 900)).toEqual({
      text: 'alpha one beta',
      coverage: 2,
      tokenSpan: 3,
      density: 0.6666666666666666,
      questionLike: false,
      score: 2000766368,
    });
  });

  it('spans interleaved non-query tokens — compressed hit-list positions would give tokenSpan 2, not 5', () => {
    resetCaches();
    // NOTE: the filler must be 2+ characters. The token pattern is `{2,}`, so
    // 'alpha x y z beta' has span 2 even in correct code and proves nothing.
    expect(_bestPassageForTest(['alpha', 'beta'], 'alpha one two three beta', 900)).toEqual({
      text: 'alpha one two three beta',
      coverage: 2,
      tokenSpan: 5,
      density: 0.4,
      questionLike: false,
      score: 2000499501,
    });
  });

  it('emits no match for token-free windows — density before the overlap filter would be 0/0 = NaN', () => {
    resetCaches();
    for (const candidate of ['... ... ...', '?\n?\n?']) {
      expect(passageWindows(candidate, 900).every((window) => window.tokens.length === 0)).toBe(true);
      expect(_bestPassageForTest(['alpha', 'beta'], candidate, 900)).toBeNull();
    }
    // A token-free window alongside a real one must not poison the score.
    const mixed = 'alpha beta gamma.\n...\nalpha beta delta.';
    const best = _bestPassageForTest(['alpha', 'beta'], mixed, 900);
    expect(best).toEqual({
      text: 'alpha beta gamma.',
      coverage: 2,
      tokenSpan: 2,
      density: 0.6666666666666666,
      questionLike: false,
      score: 2000766468,
    });
    expect(Number.isFinite(best!.score)).toBe(true);
  });

  it('falls back for non-sliceable candidates — the parent stream and the window text genuinely disagree there', () => {
    resetCaches();
    // Decomposed 'e' + combining acute: NFKC shifts the offsets, so the
    // candidate fails `offsetStable`. (The COMPOSED form is sliceable and would
    // not exercise this path.)
    const combining = 'cafe\u0301 alpha beta is good.\nalpha beta again here.';
    expect(_bestPassageForTest(['alpha', 'beta'], combining, 900)).toEqual({
      text: combining.slice(0, 25),
      coverage: 2,
      tokenSpan: 2,
      density: 0.5,
      questionLike: false,
      score: 2000599801,
    });
    // Mid-word chop: `sentenceSpans` hard-cuts a sentence longer than maxChars,
    // minting window-local tokens ('mma') the parent stream never had.
    const chopped = `${'alphaalpha'.repeat(6)} beta ${'gamma '.repeat(4)}alpha`;
    expect(_bestPassageForTest(['alpha', 'beta'], chopped, 40)).toEqual({
      text: 'mma gamma alpha',
      coverage: 1,
      tokenSpan: 1,
      density: 0.3333333333333333,
      questionLike: false,
      score: 1000433234,
    });
  });
});

describe('passageWindows', () => {
  it('is unchanged for a sliceable candidate — recall-projection.ts persists these spans verbatim', () => {
    resetCaches();
    const candidate = 'café alpha beta is good.\nalpha beta again here.';
    expect(passageWindows(candidate, 900)).toEqual([
      {
        text: 'café alpha beta is good.',
        tokens: [
          { value: 'café', start: 0, end: 4 },
          { value: 'alpha', start: 5, end: 10 },
          { value: 'beta', start: 11, end: 15 },
          { value: 'good', start: 19, end: 23 },
        ],
        start: 0,
        end: 24,
      },
      {
        text: 'café alpha beta is good.\nalpha beta again here.',
        tokens: [
          { value: 'café', start: 0, end: 4 },
          { value: 'alpha', start: 5, end: 10 },
          { value: 'beta', start: 11, end: 15 },
          { value: 'good', start: 19, end: 23 },
          { value: 'alpha', start: 25, end: 30 },
          { value: 'beta', start: 31, end: 35 },
          { value: 'again', start: 36, end: 41 },
          { value: 'here', start: 42, end: 46 },
        ],
        start: 0,
        end: 47,
      },
      {
        text: 'alpha beta again here.',
        tokens: [
          { value: 'alpha', start: 25, end: 30 },
          { value: 'beta', start: 31, end: 35 },
          { value: 'again', start: 36, end: 41 },
          { value: 'here', start: 42, end: 46 },
        ],
        start: 25,
        end: 47,
      },
    ]);
  });

  it('is unchanged for a non-sliceable candidate — its token offsets index the WINDOW, not the candidate', () => {
    resetCaches();
    const chopped = `${'alphaalpha'.repeat(6)} beta ${'gamma '.repeat(4)}alpha`;
    expect(passageWindows(chopped, 40)).toEqual([
      {
        text: 'alphaalphaalphaalphaalphaalphaalphaalpha',
        tokens: [{ value: 'alphaalphaalphaalphaalphaalphaalphaalpha', start: 0, end: 40 }],
        start: 0,
        end: 40,
      },
      {
        text: 'alphaalphaalphaalpha beta gamma gamma ga',
        tokens: [
          { value: 'alphaalphaalphaalpha', start: 0, end: 20 },
          { value: 'beta', start: 21, end: 25 },
          { value: 'gamma', start: 26, end: 31 },
          { value: 'gamma', start: 32, end: 37 },
          { value: 'ga', start: 38, end: 40 },
        ],
        start: 40,
        end: 80,
      },
      {
        text: 'mma gamma alpha',
        tokens: [
          { value: 'mma', start: 0, end: 3 },
          { value: 'gamma', start: 4, end: 9 },
          { value: 'alpha', start: 10, end: 15 },
        ],
        start: 80,
        end: 95,
      },
    ]);
  });

  it('reports the TRUE span of a repeated window — recovering it by search finds the first occurrence', () => {
    resetCaches();
    expect(passageWindows('aa bb?\naa bb?', 900).map((window) => [window.start, window.end])).toEqual([
      [0, 6],
      [0, 13],
      [7, 13],
    ]);
  });
});

/**
 * Corpus equivalence. The reference is the pre-patch algorithm — a Set over
 * every token of every window — written out longhand. The fast path must agree
 * with it on every field, not just on the winning text.
 */
function bestPassageReference(
  queryTokens: string[],
  candidate: string,
  maxChars: number,
): Record<string, unknown> | null {
  if (queryTokens.length === 0) return null;
  const minimumOverlap = queryTokens.length <= 2 ? 1 : 2;
  const matches: Array<Record<string, number | string | boolean>> = [];
  for (const { text, tokens } of passageWindows(candidate, maxChars)) {
    const candidateSet = new Set(tokens.map((token: RecallToken) => token.value));
    const matchedTerms = new Set(queryTokens.filter((token) => candidateSet.has(token)));
    if (matchedTerms.size < minimumOverlap) continue;
    let tokenSpan = Number.POSITIVE_INFINITY;
    for (let start = 0; start < tokens.length; start++) {
      if (!matchedTerms.has(tokens[start]!.value)) continue;
      const seen = new Set<string>();
      for (let end = start; end < tokens.length; end++) {
        if (matchedTerms.has(tokens[end]!.value)) seen.add(tokens[end]!.value);
        if (seen.size === matchedTerms.size) {
          tokenSpan = Math.min(tokenSpan, end - start + 1);
          break;
        }
      }
    }
    const density = matchedTerms.size / Math.max(1, tokens.length);
    const questionLike = text.includes('?');
    matches.push({
      text,
      coverage: matchedTerms.size,
      tokenSpan,
      density,
      questionLike,
      score:
        matchedTerms.size * 1_000_000_000 +
        Math.round(density * 1_000_000) +
        Math.max(0, 100_000 - tokenSpan * 100) +
        (questionLike ? 0 : 1),
    });
  }
  return (
    matches.sort(
      (a, b) =>
        (b.coverage as number) - (a.coverage as number) ||
        (b.density as number) - (a.density as number) ||
        (a.tokenSpan as number) - (b.tokenSpan as number) ||
        Number(a.questionLike) - Number(b.questionLike),
    )[0] ?? null
  );
}

describe('bestPassage corpus equivalence', () => {
  it('matches the per-window reference on every field — the fast path is an optimization, not a re-specification', () => {
    resetCaches();
    const candidates = [
      'alpha one beta\nbeta two alpha',
      'alpha one two three beta',
      'alpha beta gamma.\n...\nalpha beta delta.',
      'café alpha beta is good.\nalpha beta again here.',
      'cafe\u0301 alpha beta is good.\nalpha beta again here.',
      'Is alpha the beta?\nNo, gamma is the beta.\nalpha alpha alpha beta.',
      'The host manages providers.\nProviders host columns.\nWorktrees host suggestions.',
      'aa bb?\naa bb?',
      '... ... ...',
      '?\n?\n?',
      '-- -- --',
      'one',
      '',
      'alpha',
      'alpha beta',
      `${'alphaalpha'.repeat(6)} beta ${'gamma '.repeat(4)}alpha`,
      `${'word '.repeat(200)}alpha beta gamma.`,
      'alphá betá gammá.\nalpha beta gamma.',
      'A. B. C. alpha. beta. gamma. alpha beta gamma.',
      'alpha,beta;gamma\talpha\nbeta gamma alpha',
    ];
    const queries = [
      ['alpha', 'beta'],
      ['alpha'],
      ['alpha', 'beta', 'gamma'],
      ['host', 'provid', 'column'],
      ['nothing', 'here'],
      ['alpha', 'alpha'],
    ];
    let compared = 0;
    for (const candidate of candidates) {
      for (const maxChars of [900, 40, 20]) {
        for (const query of queries) {
          expect(_bestPassageForTest(query, candidate, maxChars)).toEqual(
            bestPassageReference(query, candidate, maxChars),
          );
          compared++;
        }
      }
    }
    expect(compared).toBe(candidates.length * 3 * queries.length);
  });
});
