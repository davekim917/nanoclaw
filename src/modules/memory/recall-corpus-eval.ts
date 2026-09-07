/**
 * Recall-corpus evaluation harness.
 *
 * Test-only: the sole consumer is `pre-turn-context.test.ts`, which scores
 * `tests/fixtures/workgroup-memory-recall.json` against the live retrieval
 * helpers. Nothing here runs in production. It lived in `pre-turn-context.ts`
 * until it was split out, where its exports read as live retrieval API.
 */
import { compareCodepoint, ephemeralExpansion, rankByBestPassage, tokenizeForRecall } from './pre-turn-context.js';

export interface RecallCorpus {
  revision: string;
  documents: Array<{
    id: string;
    source: 'memory' | 'archive';
    thread: string;
    link?: string;
    text: string;
  }>;
  cases: Array<{
    id: string;
    category: 'exact' | 'correction' | 'link' | 'paraphrase' | 'cross_thread' | 'distractor' | 'no_match';
    query: string;
    expected: string | null;
  }>;
}

export interface RecallCorpusMetrics {
  exact: number;
  correction: number;
  link: number;
  paraphraseAndCrossThread: number;
  distractorFalsePositive: number;
  honestNoMatch: number;
}

export interface RecallCorpusResult {
  revision: string;
  lexical: RecallCorpusMetrics;
  final: RecallCorpusMetrics;
  expansionUsed: boolean;
}

function rankCorpusDocuments(corpus: RecallCorpus, query: string, expansions: string[] = []): string[] {
  const exactLinks = corpus.documents.filter((doc) => doc.link && query.includes(doc.link)).map((doc) => doc.id);
  if (exactLinks.length > 0) return exactLinks;
  const queryTokens = tokenizeForRecall(`${query} ${expansions.join(' ')}`);
  return rankByBestPassage(queryTokens, corpus.documents, (doc) => doc.text, {
    tieBreak: (a, b) => compareCodepoint(a.id, b.id),
  })
    .slice(0, 4)
    .map(({ candidate }) => candidate.id);
}

function scoreCorpus(corpus: RecallCorpus, expand: boolean): RecallCorpusMetrics {
  const successes = new Map<string, { hit: number; total: number }>();
  let distractorHits = 0;
  let distractorTotal = 0;
  let noMatchHits = 0;
  let noMatchTotal = 0;
  for (const testCase of corpus.cases) {
    const lexicalRanked = rankCorpusDocuments(corpus, testCase.query);
    const ranked =
      expand && lexicalRanked.length === 0
        ? rankCorpusDocuments(corpus, testCase.query, ephemeralExpansion(testCase.query))
        : lexicalRanked;
    if (testCase.category === 'distractor') {
      distractorTotal++;
      if (ranked.length > 0) distractorHits++;
      continue;
    }
    if (testCase.category === 'no_match') {
      noMatchTotal++;
      if (ranked.length === 0) noMatchHits++;
      continue;
    }
    const bucket =
      testCase.category === 'paraphrase' || testCase.category === 'cross_thread'
        ? 'paraphraseAndCrossThread'
        : testCase.category;
    const prior = successes.get(bucket) ?? { hit: 0, total: 0 };
    prior.total++;
    if (testCase.expected !== null && ranked.includes(testCase.expected)) prior.hit++;
    successes.set(bucket, prior);
  }
  const ratio = (key: string): number => {
    const value = successes.get(key);
    return value && value.total > 0 ? value.hit / value.total : 1;
  };
  return {
    exact: ratio('exact'),
    correction: ratio('correction'),
    link: ratio('link'),
    paraphraseAndCrossThread: ratio('paraphraseAndCrossThread'),
    distractorFalsePositive: distractorTotal > 0 ? distractorHits / distractorTotal : 0,
    honestNoMatch: noMatchTotal > 0 ? noMatchHits / noMatchTotal : 1,
  };
}

function meetsGate(metrics: RecallCorpusMetrics): boolean {
  return (
    metrics.exact === 1 &&
    metrics.correction === 1 &&
    metrics.link === 1 &&
    metrics.paraphraseAndCrossThread >= 0.9 &&
    metrics.distractorFalsePositive <= 0.05 &&
    metrics.honestNoMatch === 1
  );
}

export function evaluateRecallCorpus(corpus: RecallCorpus): RecallCorpusResult {
  const lexical = scoreCorpus(corpus, false);
  if (meetsGate(lexical)) return { revision: corpus.revision, lexical, final: lexical, expansionUsed: false };
  return { revision: corpus.revision, lexical, final: scoreCorpus(corpus, true), expansionUsed: true };
}
