import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

import { buildSessionServicesSnapshot, type SessionServicesSnapshot } from '../../capabilities.js';
import { getDb } from '../../db/connection.js';
import {
  queryArchiveExactLinks,
  recentConversationSenderNames,
  searchArchiveEvidence,
  type ArchiveEvidenceRow,
} from '../../message-archive.js';
import { GENERATED_MEMORY_MAX_BYTES, GENERATED_MEMORY_RELATIVE_PATH } from './curator-contract.js';
import { GRAPH_SCENT_BOUNDS, readGraphScent, STOP_WORDS, type GraphScent } from './graph-scent.js';
import { workgroupMemoryDir } from '../workgroup/shared-dirs.js';

export const PRE_TURN_BOUNDS = Object.freeze({
  markdownFiles: 256,
  // Must clear GENERATED_MEMORY_MAX_BYTES with room for the manual tree beside
  // it: this is a shared budget consumed in listing order, so a generated store
  // at its own cap would otherwise silently truncate every file after it.
  markdownScannedBytes: 16 * 1_048_576,
  markdownFileBytes: 65_536,
  markdownCoreChars: 2_500,
  markdownHeadings: 24,
  markdownHeadingChars: 240,
  markdownCandidates: 48,
  markdownExcerpts: 3,
  markdownExcerptChars: 900,
  // generated/memory.md is a flat list of self-contained one-line facts, so it
  // is ranked per FACT rather than as one document. Scored as a single file it
  // contributed at most one 900-char passage per turn no matter how much it
  // held — measured against a live 328-fact store (median line 817 chars) that
  // is ~1.1 facts surfaced out of 328, and growing the store could not improve
  // it. Facts also get their own excerpt lane so they cannot crowd out manual
  // memory in the shared markdownExcerpts budget, and vice versa.
  generatedFactCandidates: 48,
  generatedFactExcerpts: 3,
  // A fact is one atomic unit, so it is delivered whole rather than windowed
  // mid-sentence. Matched to CURATOR_MAX_MEMORY_TEXT_CHARS plus its provenance
  // marker. Worst case 3 x 2200 is still inside finalChars alongside archive
  // recall, and enforceFinalBound trims the tail if a bootstrap turn is tight.
  generatedFactExcerptChars: 2_200,
  // Deterministic per-person preference lane: preferences/<name-slug>.md files
  // matching the conversation's involved senders are injected whole (bounded),
  // never lexically ranked. Cap covers a busy multi-human thread.
  preferenceExcerpts: 6,
  // Total for BOTH memory lanes, enforced after selection.
  //
  // Load-bearing for the same reason capabilityTotalChars is. Per-lane caps
  // alone took the worst-case memory footprint from 2,700 (3 x 900) to 9,300
  // (3 x 2,200 + 3 x 900) inside an unchanged 12,000 finalChars. Facts, files
  // and archive together then reach finalChars exactly, before per-excerpt JSON
  // overhead — and enforceFinalBound sacrifices conversation excerpts FIRST, so
  // a few long facts could silently evict every archive excerpt. 5,500 leaves
  // the archive lane intact on a normal turn while still fitting three
  // typical facts (median 817 chars) plus the file lane.
  memoryExcerptTotalChars: 5_500,
  archiveCandidates: 96,
  archiveExcerpts: 3,
  archiveExcerptChars: 900,
  exactLinkCandidates: 32,
  exactLinkExcerpts: 8,
  capabilityServices: 32,
  // Capability text is authored in-tree (capabilities.ts), not user input, and
  // its whole job is to stop the agent denying an ability it has. At 600 this
  // amputated exactly the part that does that work: the Slack entry's "never
  // tell the owner you can't read a thread without trying X" bottom line, and
  // GitHub's CI verbs, both sat past the cut. Six entries were over 600 —
  // Slack, GitHub, Wix, Cloudflare, SELECT, Hex. 2500 clears the largest with
  // headroom, so a kept entry is never clipped mid-sentence.
  capabilityDetailChars: 2500,
  // Total budget for the capability block, enforced in boundedCapabilities.
  //
  // Load-bearing: `finalChars` below is a budget for the ENTIRE serialized
  // context, and enforceFinalBound evicts in the order conversation excerpts →
  // memory excerpts → halve memory core → capability services. Capabilities are
  // therefore the LAST thing sacrificed, so a per-field cap alone lets them
  // silently consume the whole budget and starve recall: raising the per-field
  // cap to 2500 with no total pushed a widely-wired owner-safe group's block to
  // ~11.2k of the 12k budget, leaving the agent with zero archive recall and
  // zero workgroup-memory excerpts and only an internal notice as evidence.
  // 8000 keeps the block at roughly its historical footprint (~7.4k measured at
  // the old 600 cap) while leaving room for recall.
  capabilityTotalChars: 8_000,
  // Advisory graph-pointer lane; enforced inside readGraphScent by dropping
  // lowest-ranked pointers, and shed FIRST by enforceFinalBound.
  graphScentChars: GRAPH_SCENT_BOUNDS.chars,
  finalChars: 12_000,
  exactLinkFinalChars: 16_000,
});

export interface PreTurnContextInput {
  agentGroupId: string;
  sessionId: string;
  /** Actual host-routed scope for agent-shared sessions; omitted uses the persisted session scope. */
  messagingGroupId?: string | null;
  threadId?: string | null;
  kind: string;
  trigger: 0 | 1;
  normalizedContent: string;
  /** Provider-specific context identity supplied by the trusted host lifecycle. */
  provider?: string;
  contextEpoch?: number;
  /** Full capabilities plus index.md are emitted only at a fresh context boundary. */
  includeBootstrap?: boolean;
  /** Evidence already delivered in this provider context epoch. */
  seenEvidenceFingerprints?: readonly string[];
}

export interface ContextNotice {
  source: 'scope' | 'capabilities' | 'markdown' | 'archive' | 'exact-link' | 'context' | 'graph';
  status: 'ok' | 'no-match' | 'degraded' | 'truncated' | 'conflict';
  code: string;
  detail: string;
}

export interface MemoryEvidenceExcerpt {
  path: string;
  headings: string[];
  text: string;
  score: number;
  fingerprint: string;
  provenance: { authority: 'workgroup-memory-canon'; workgroupId: string };
}

export interface ConversationEvidenceExcerpt {
  id: string;
  agentGroupId: string;
  messagingGroupId: string | null;
  channelType: string;
  channelName: string | null;
  platformId: string | null;
  threadId: string | null;
  role: string;
  senderId: string | null;
  senderName: string | null;
  text: string;
  sentAt: string;
  rank: 'exact-link' | 'current-thread' | 'workgroup';
  score: number;
  fingerprint: string;
  provenance: { authority: 'host-message-archive'; archiveId: string };
}

export interface PreTurnContext {
  provider?: string;
  contextEpoch?: number;
  trustedCapabilities?: SessionServicesSnapshot;
  memoryEvidence: {
    core: MemoryEvidenceExcerpt[];
    excerpts: MemoryEvidenceExcerpt[];
  };
  conversationEvidence: {
    excerpts: ConversationEvidenceExcerpt[];
  };
  /** Advisory graph pointers; absent when the lane is cold, empty, or shed. */
  graphScent?: GraphScent;
  notices: ContextNotice[];
}

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

const CORE_PATHS = ['index.md'] as const;
const NON_RECALL_PATHS = new Set(['system/definition.md']);
const PREFERENCES_DIR = 'preferences/';

/** Canonical filename key for a person: "Pat Doe" -> "pat-doe". */
export function preferenceSlug(name: string): string {
  return name
    .toLocaleLowerCase('en-US')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Stem matches a sender when equal or hyphen-prefix either way ("alex" <-> "alex-stone"). */
function preferenceStemMatches(stem: string, senderSlug: string): boolean {
  return stem === senderSlug || senderSlug.startsWith(`${stem}-`) || stem.startsWith(`${senderSlug}-`);
}

function extractSenderName(normalizedContent: string): string | null {
  try {
    const parsed = JSON.parse(normalizedContent) as { sender?: unknown };
    return typeof parsed.sender === 'string' && parsed.sender.trim().length > 0 ? parsed.sender.trim() : null;
  } catch {
    return null;
  }
}
const TRUNCATED_MARKDOWN_FILE = '\n[truncated:markdown-file]';
const TRUNCATED_MARKDOWN_EXCERPT = '\n[truncated:markdown-excerpt]';
const TRUNCATED_ARCHIVE_EXCERPT = '\n[truncated:archive-excerpt]';
const TRUNCATED_CAPABILITY_DETAIL = '[truncated:capability-detail]';
const CORRECTION_PATTERN = /\b(?:actually|correction|corrected|instead|not|rather than|but)\b/i;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function evidenceFingerprint(authority: string, scope: string, source: string, fullContent: string): string {
  return sha256(`${authority}\0${scope}\0${source}\0${sha256(fullContent)}`);
}

function compareCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// STOP_WORDS moved to graph-scent.ts (imported above): both modules use it,
// and this module already imports graph-scent for readGraphScent, so the value
// dependency must run that way to avoid a module cycle.

function canonicalToken(token: string): string {
  let value = token.toLocaleLowerCase('en-US');
  if (/^(?:manage|manages|managed|managing|host|hosts|hosted|hosting)$/.test(value)) return 'host';
  if (/^(?:capability|capabilities)$/.test(value)) return 'capabil';
  if (/^(?:provider|providers)$/.test(value)) return 'provid';
  if (/^(?:suggestion|suggestions)$/.test(value)) return 'suggest';
  if (/^(?:column|columns)$/.test(value)) return 'column';
  if (/^(?:worktree|worktrees)$/.test(value)) return 'worktree';
  if (value.length > 5 && value.endsWith('ing')) value = value.slice(0, -3);
  else if (value.length > 4 && value.endsWith('ed')) value = value.slice(0, -2);
  else if (value.length > 4 && value.endsWith('s')) value = value.slice(0, -1);
  return value;
}

export function tokenizeForRecall(value: string): string[] {
  return [...new Set(tokenStreamForRecall(value).map((token) => token.value))];
}

type RecallToken = { value: string; start: number; end: number };

// Tokenizing the generated store is the single largest per-turn cost, and it
// repeats identically every turn: the curator rewrites the file a few times an
// hour while turns are constant, so the same fact lines are re-normalized,
// re-matched and re-filtered over and over. Measured on a live 1 MiB / 1,058
// fact store that was 875 ms added to EVERY turn, and it scales linearly with
// the store — which made the size cap a latency decision rather than a storage
// one.
//
// Keyed on the text itself, so it needs no invalidation: a rewritten fact is a
// different string and simply misses. Cleared wholesale when full rather than
// evicted least-recently-used — the working set is the current fact store, so a
// clear costs one turn of recompute and the LRU bookkeeping is not worth it.
// ponytail: plain Map, swap for an LRU only if clears start showing up hot.
const TOKEN_STREAM_CACHE = new Map<string, readonly RecallToken[]>();
// Sized to hold the whole fact store plus a turn's manual files and archive
// candidates several times over, so a clear stays rare. Roughly 6 MB of heap
// per 1,000 cached fact lines.
const TOKEN_STREAM_CACHE_MAX = 8192;

function tokenStreamForRecall(value: string): readonly RecallToken[] {
  const cached = TOKEN_STREAM_CACHE.get(value);
  if (cached) return cached;
  const normalized = value.normalize('NFKC').toLocaleLowerCase('en-US');
  const tokens = [...normalized.matchAll(/[\p{L}\p{N}_-]{2,}/gu)]
    .map((match) => ({
      value: canonicalToken(match[0]),
      start: match.index,
      end: match.index + match[0].length,
    }))
    .filter((token) => token.value.length > 1 && !STOP_WORDS.has(token.value));
  if (TOKEN_STREAM_CACHE.size >= TOKEN_STREAM_CACHE_MAX) TOKEN_STREAM_CACHE.clear();
  TOKEN_STREAM_CACHE.set(value, tokens);
  return tokens;
}

interface PassageMatch {
  text: string;
  coverage: number;
  tokenSpan: number;
  density: number;
  questionLike: boolean;
  score: number;
}

interface RankedPassage<T> {
  candidate: T;
  passage: PassageMatch;
  sourceOrder: number;
}

interface RankPassagesOptions<T> {
  maxChars?: number;
  priority?: (candidate: T) => number;
  tieBreak?: (a: T, b: T) => number;
}

function boundedPassages(candidate: string, maxChars: number): string[] {
  const sentences: Array<{ start: number; end: number }> = [];
  let start = 0;
  const push = (end: number): void => {
    let valueStart = start;
    let valueEnd = end;
    start = end;
    while (valueStart < valueEnd && /\s/.test(candidate[valueStart]!)) valueStart++;
    while (valueEnd > valueStart && /\s/.test(candidate[valueEnd - 1]!)) valueEnd--;
    if (valueStart === valueEnd) return;
    for (let offset = valueStart; offset < valueEnd; offset += maxChars) {
      sentences.push({ start: offset, end: Math.min(valueEnd, offset + maxChars) });
    }
  };
  for (let index = 0; index < candidate.length; index++) {
    const char = candidate[index]!;
    if (char === '\n') {
      push(index);
      start = index + 1;
      continue;
    }
    if (
      (char === '.' || char === '!' || char === '?') &&
      (index + 1 === candidate.length || /\s/.test(candidate[index + 1]!))
    ) {
      push(index + 1);
      while (start < candidate.length && /\s/.test(candidate[start]!)) start++;
      index = start - 1;
    }
  }
  if (start < candidate.length) push(candidate.length);
  if (sentences.length === 0 && candidate.trim()) {
    const valueStart = candidate.search(/\S/);
    sentences.push({ start: valueStart, end: Math.min(candidate.length, valueStart + maxChars) });
  }

  const windows: string[] = [];
  for (let first = 0; first < sentences.length; first++) {
    for (let last = first; last < Math.min(sentences.length, first + 3); last++) {
      const windowStart = sentences[first]!.start;
      const windowEnd = sentences[last]!.end;
      if (windowEnd - windowStart > maxChars) break;
      windows.push(candidate.slice(windowStart, windowEnd));
    }
  }
  return windows;
}

function minimumTokenSpan(queryTokens: Set<string>, passageTokens: readonly { value: string }[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let start = 0; start < passageTokens.length; start++) {
    if (!queryTokens.has(passageTokens[start]!.value)) continue;
    const seen = new Set<string>();
    for (let end = start; end < passageTokens.length; end++) {
      const token = passageTokens[end]!;
      if (queryTokens.has(token.value)) seen.add(token.value);
      if (seen.size === queryTokens.size) {
        best = Math.min(best, end - start + 1);
        break;
      }
    }
  }
  return best;
}

function comparePassageMatch(a: PassageMatch, b: PassageMatch): number {
  return (
    b.coverage - a.coverage ||
    b.density - a.density ||
    a.tokenSpan - b.tokenSpan ||
    Number(a.questionLike) - Number(b.questionLike)
  );
}

function bestPassage(
  queryTokens: string[],
  candidate: string,
  maxChars: number = PRE_TURN_BOUNDS.archiveExcerptChars,
): PassageMatch | null {
  if (queryTokens.length === 0) return null;
  const minimumOverlap = queryTokens.length <= 2 ? 1 : 2;
  const matches: PassageMatch[] = [];
  for (const text of boundedPassages(candidate, maxChars)) {
    const passageTokens = tokenStreamForRecall(text);
    const candidateSet = new Set(passageTokens.map((token) => token.value));
    const matchedTerms = new Set(queryTokens.filter((token) => candidateSet.has(token)));
    if (matchedTerms.size < minimumOverlap) continue;
    const tokenSpan = minimumTokenSpan(matchedTerms, passageTokens);
    const density = matchedTerms.size / Math.max(1, passageTokens.length);
    const questionLike = text.includes('?');
    // The encoded score mirrors the tuple above for display and downstream
    // conflict checks. Ranking itself compares the tuple, avoiding a pile of
    // independent incident-specific weights.
    const score =
      matchedTerms.size * 1_000_000_000 +
      Math.round(density * 1_000_000) +
      Math.max(0, 100_000 - tokenSpan * 100) +
      (questionLike ? 0 : 1);
    matches.push({
      text,
      coverage: matchedTerms.size,
      tokenSpan,
      density,
      questionLike,
      score,
    });
  }
  return matches.sort(comparePassageMatch)[0] ?? null;
}

function rankByBestPassage<T>(
  queryTokens: string[],
  candidates: readonly T[],
  textOf: (candidate: T) => string,
  options: RankPassagesOptions<T> = {},
): RankedPassage<T>[] {
  const priority = options.priority ?? (() => 0);
  const tieBreak = options.tieBreak ?? (() => 0);
  return candidates
    .map((candidate, sourceOrder) => ({
      candidate,
      sourceOrder,
      passage: bestPassage(queryTokens, textOf(candidate), options.maxChars),
    }))
    .filter((candidate): candidate is RankedPassage<T> => candidate.passage !== null)
    .sort(
      (a, b) =>
        priority(a.candidate) - priority(b.candidate) ||
        comparePassageMatch(a.passage, b.passage) ||
        tieBreak(a.candidate, b.candidate) ||
        a.sourceOrder - b.sourceOrder,
    );
}

function lexicalScore(queryTokens: string[], candidate: string): number {
  return bestPassage(queryTokens, candidate)?.score ?? 0;
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

/**
 * The only permitted query expansion is ephemeral and bounded. It is used
 * after an unchanged lexical corpus fails, and its terms never become
 * evidence or persistent state.
 */
function ephemeralExpansion(query: string): string[] {
  const tokens = new Set(tokenizeForRecall(query));
  const expanded: string[] = [];
  const add = (...values: string[]): void => {
    for (const value of values) {
      if (expanded.length >= 8) return;
      expanded.push(value);
    }
  };
  if (tokens.has('dns')) add('registrar', 'nameserver', 'domain');
  if (tokens.has('search') && tokens.has('console')) add('gsc');
  if (tokens.has('unavailable') || tokens.has('access')) add('gateway', 'https', 'api');
  return expanded;
}

function markExpansionUsed(notices: ContextNotice[]): void {
  if (notices.some((notice) => notice.code === 'ephemeral-query-expansion-used')) return;
  notices.push({
    source: 'context',
    status: 'ok',
    code: 'ephemeral-query-expansion-used',
    detail: 'Direct lexical retrieval had no match; bounded current-query expansion selected authoritative evidence.',
  });
}

export function evaluateRecallCorpus(corpus: RecallCorpus): RecallCorpusResult {
  const lexical = scoreCorpus(corpus, false);
  if (meetsGate(lexical)) return { revision: corpus.revision, lexical, final: lexical, expansionUsed: false };
  return { revision: corpus.revision, lexical, final: scoreCorpus(corpus, true), expansionUsed: true };
}

function boundedText(value: string, maxChars: number, marker: string): string {
  if (value.length <= maxChars) return value;
  const available = Math.max(0, maxChars - marker.length);
  return `${value.slice(0, available)}${marker}`;
}

function extractQueryText(normalizedContent: string): string {
  try {
    const parsed = JSON.parse(normalizedContent) as { text?: unknown };
    if (typeof parsed.text === 'string') {
      const marker = '[Latest message]\n';
      const latest = parsed.text.lastIndexOf(marker);
      return latest === -1 ? parsed.text : parsed.text.slice(latest + marker.length);
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Plain-text rows are valid host inputs.
  }
  return normalizedContent;
}

function headingsOf(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/)?.[1]?.trim())
    .filter((heading): heading is string => !!heading)
    .slice(0, PRE_TURN_BOUNDS.markdownHeadings)
    .map((heading) => boundedText(heading, PRE_TURN_BOUNDS.markdownHeadingChars, '[truncated:heading]'));
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function readBoundedFile(
  filePath: string,
  canonicalRoot: string,
  allowedBytes: number,
  fileBytes: number = PRE_TURN_BOUNDS.markdownFileBytes,
): { content: string; bytes: number; truncated: boolean } {
  // Open the checked leaf itself without following a final-component symlink,
  // then validate the identity of the object that was actually opened. A
  // leaf-only O_NOFOLLOW does not stop an enumerated ancestor directory from
  // being swapped to a symlink before open.
  //
  // Node has no portable openat(2) API. The cross-platform equivalent here is
  // to pin the leaf with an fd, resolve the requested path under the canonical
  // root, and require that resolved object's device+inode match the pinned fd
  // before reading. If an ancestor remains swapped, containment fails. If it
  // is swapped back after open, identity fails. The final read uses the already
  // validated fd, so a later path mutation cannot redirect it.
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('not a regular Markdown file');
    const resolved = fs.realpathSync(filePath);
    if (!isContainedPath(canonicalRoot, resolved)) {
      throw new Error('opened Markdown file escaped canonical memory root');
    }
    const resolvedStat = fs.statSync(resolved);
    if (!resolvedStat.isFile() || stat.dev !== resolvedStat.dev || stat.ino !== resolvedStat.ino) {
      throw new Error('opened Markdown file identity changed during validation');
    }
    const bytes = Math.max(0, Math.min(stat.size, allowedBytes, fileBytes));
    const buffer = Buffer.alloc(bytes);
    const read = bytes > 0 ? fs.readSync(fd, buffer, 0, bytes, 0) : 0;
    const truncated = stat.size > read;
    return {
      content: `${buffer.subarray(0, read).toString('utf8')}${truncated ? TRUNCATED_MARKDOWN_FILE : ''}`,
      bytes: read,
      truncated,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function listMarkdownFiles(root: string, notices: ContextNotice[]): string[] {
  const files: string[] = [];
  const pending = [''];
  let visited = 0;
  let skippedSymlinks = 0;
  while (pending.length > 0 && visited < PRE_TURN_BOUNDS.markdownFiles) {
    const relativeDir = pending.shift()!;
    const absoluteDir = path.join(root, relativeDir);
    const entries = fs
      .readdirSync(absoluteDir, { withFileTypes: true })
      .sort((a, b) => compareCodepoint(a.name, b.name));
    for (const entry of entries) {
      if (visited >= PRE_TURN_BOUNDS.markdownFiles) break;
      visited++;
      const relative = path.posix.join(relativeDir.split(path.sep).join('/'), entry.name);
      if (entry.isSymbolicLink()) {
        skippedSymlinks++;
        continue;
      }
      if (entry.isDirectory()) pending.push(relative);
      else if (entry.isFile() && entry.name.toLocaleLowerCase('en-US').endsWith('.md')) files.push(relative);
    }
  }
  if (skippedSymlinks > 0) {
    notices.push({
      source: 'markdown',
      status: 'degraded',
      code: 'markdown-symlink-skipped',
      detail: `skipped ${skippedSymlinks} symbolic link${skippedSymlinks === 1 ? '' : 's'}`,
    });
  }
  if (pending.length > 0 || visited >= PRE_TURN_BOUNDS.markdownFiles) {
    notices.push({
      source: 'markdown',
      status: 'truncated',
      code: 'markdown-file-limit',
      detail: `examined at most ${PRE_TURN_BOUNDS.markdownFiles} sorted filesystem entries`,
    });
  }
  return files.sort();
}

interface SearchableCandidate {
  path: string;
  headings: string[];
  /** Text handed to the agent: for a generated fact this keeps the provenance marker. */
  content: string;
  /** Text used for ranking only: for a generated fact this drops the marker. */
  searchable: string;
  /** ISO-8601 capture stamp for a generated fact; empty for ordinary files. */
  capturedAt: string;
}

const CAPTURED_AT_PATTERN = /captured=([0-9T:.Z+-]+)/;

function capturedAtOf(line: string): string {
  return CAPTURED_AT_PATTERN.exec(line)?.[1] ?? '';
}

/**
 * Bound one generated fact, keeping its provenance marker attached.
 *
 * A fact can legitimately exceed the excerpt width: the text alone may reach
 * CURATOR_MAX_MEMORY_TEXT_CHARS and the marker carries up to
 * CURATOR_MAX_EVIDENCE_IDS archive ids after it. Windowing the line generically
 * cuts from the end, which drops exactly the `id=` and `captured=` the agent
 * needs to judge how old a fact is and to cite it. Trim the prose instead and
 * re-attach the marker, so provenance survives at any width.
 */
function boundedFactLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line;
  const markerAt = line.indexOf('<!--');
  if (markerAt < 0) return boundedText(line, maxChars, TRUNCATED_MARKDOWN_EXCERPT);
  const marker = line.slice(markerAt);
  const budget = maxChars - marker.length - TRUNCATED_MARKDOWN_EXCERPT.length - 1;
  // Marker alone over budget: keep it whole, since a citation without prose is
  // still usable and prose without a citation is not.
  if (budget <= 0) return marker;
  return `${line.slice(0, budget).trimEnd()}${TRUNCATED_MARKDOWN_EXCERPT} ${marker}`;
}

function readMemoryEvidence(
  root: string,
  workgroupId: string,
  query: string,
  notices: ContextNotice[],
  includeBootstrap: boolean,
  seenEvidenceFingerprints: ReadonlySet<string>,
  bypassDedupe: boolean,
  involvedSenderNames: readonly string[] = [],
): PreTurnContext['memoryEvidence'] {
  if (!fs.existsSync(root)) throw new Error(`canonical memory tree missing: ${root}`);
  const canonicalRoot = fs.realpathSync(root);
  if (!fs.statSync(canonicalRoot).isDirectory()) throw new Error(`canonical memory tree is not a directory: ${root}`);
  const core: MemoryEvidenceExcerpt[] = [];
  let scannedBytes = 0;
  if (includeBootstrap) {
    for (const relative of CORE_PATHS) {
      const absolute = path.join(root, relative);
      if (!fs.existsSync(absolute)) {
        notices.push({
          source: 'markdown',
          status: 'degraded',
          code: 'missing-core-memory',
          detail: relative,
        });
        continue;
      }
      const read = readBoundedFile(absolute, canonicalRoot, PRE_TURN_BOUNDS.markdownScannedBytes - scannedBytes);
      scannedBytes += read.bytes;
      core.push({
        path: relative,
        headings: headingsOf(read.content),
        text: boundedText(read.content, PRE_TURN_BOUNDS.markdownCoreChars, TRUNCATED_MARKDOWN_FILE),
        score: Number.MAX_SAFE_INTEGER,
        fingerprint: evidenceFingerprint('workgroup-memory-canon', workgroupId, relative, read.content),
        provenance: { authority: 'workgroup-memory-canon', workgroupId },
      });
    }
  }

  const queryTokens = tokenizeForRecall(query);
  const expandedTokens = tokenizeForRecall(`${query} ${ephemeralExpansion(query).join(' ')}`);
  const fileCandidates: SearchableCandidate[] = [];
  const factCandidates: SearchableCandidate[] = [];
  // Read the fact store first. `markdownScannedBytes` is a single budget spent
  // in listing order, and `generated/` sorts after `bootstrap/`, `concepts/`,
  // `conversations/`, `facts/` and `imports/`. A large manual tree would
  // otherwise leave too few bytes for it and truncate the file MID-LINE, which
  // is worse than dropping it: the partial line still starts with "- " and is
  // parsed as a fact, so a half-sentence reaches the agent with its provenance
  // marker cut off. Stable sort, so everything else keeps codepoint order.
  const allFiles = listMarkdownFiles(root, notices);

  // Deterministic per-person preference lane. Files under preferences/ are
  // keyed by name slug and injected whole for the conversation's involved
  // senders — never lexically ranked, so a preference cannot lose a relevance
  // contest to unrelated memory. Reads run before the ranked scan so the
  // shared byte budget cannot starve them.
  const preferenceExcerpts: MemoryEvidenceExcerpt[] = [];
  if (involvedSenderNames.length > 0) {
    const senderSlugs = [...new Set(involvedSenderNames.map(preferenceSlug))].filter((slug) => slug.length > 0);
    const preferenceStems = allFiles
      .filter((relative) => relative.startsWith(PREFERENCES_DIR))
      .map((relative) => relative.slice(PREFERENCES_DIR.length, -'.md'.length))
      .filter((stem) => stem.length > 0 && !stem.includes('/'));
    // ONE file per sender: exact slug match wins outright; otherwise the
    // longest prefix-compatible stem. Injecting every prefix match would let
    // `alex.md` ride along with `alex-stone.md` for the same person.
    const matched = [
      ...new Set(
        senderSlugs
          .map((slug) => {
            if (preferenceStems.includes(slug)) return slug;
            const compatible = preferenceStems
              .filter((stem) => preferenceStemMatches(stem, slug))
              .sort((a, b) => b.length - a.length || compareCodepoint(a, b));
            return compatible[0];
          })
          .filter((stem): stem is string => stem !== undefined),
      ),
    ].map((stem) => `${PREFERENCES_DIR}${stem}.md`);
    for (const relative of matched.slice(0, PRE_TURN_BOUNDS.preferenceExcerpts)) {
      const remaining = PRE_TURN_BOUNDS.markdownScannedBytes - scannedBytes;
      if (remaining <= 0) break;
      try {
        const read = readBoundedFile(path.join(root, relative), canonicalRoot, remaining);
        scannedBytes += read.bytes;
        const text = boundedText(read.content, PRE_TURN_BOUNDS.markdownExcerptChars, TRUNCATED_MARKDOWN_EXCERPT);
        preferenceExcerpts.push({
          path: relative,
          headings: headingsOf(read.content),
          text,
          score: Number.MAX_SAFE_INTEGER,
          fingerprint: evidenceFingerprint(
            'workgroup-memory-canon',
            workgroupId,
            `${relative}\0${sha256(text)}`,
            read.content,
          ),
          provenance: { authority: 'workgroup-memory-canon', workgroupId },
        });
      } catch (error) {
        notices.push({
          source: 'markdown',
          status: 'degraded',
          code: 'preference-read-failed',
          detail: `${relative}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    if (preferenceExcerpts.length > 0) {
      notices.push({
        source: 'markdown',
        status: 'ok',
        code: 'preference-recall',
        detail: `injected sender preference file${preferenceExcerpts.length === 1 ? '' : 's'}: ${preferenceExcerpts.map((row) => row.path).join(', ')}`,
      });
    }
  }

  const scanOrder = allFiles.sort(
    (a, b) => Number(b === GENERATED_MEMORY_RELATIVE_PATH) - Number(a === GENERATED_MEMORY_RELATIVE_PATH),
  );
  for (const relative of scanOrder) {
    if ((CORE_PATHS as readonly string[]).includes(relative)) continue;
    if (NON_RECALL_PATHS.has(relative)) continue;
    if (relative.startsWith(PREFERENCES_DIR)) continue;
    const remaining = PRE_TURN_BOUNDS.markdownScannedBytes - scannedBytes;
    if (remaining <= 0) {
      notices.push({
        source: 'markdown',
        status: 'truncated',
        code: 'markdown-byte-limit',
        detail: `scanned ${PRE_TURN_BOUNDS.markdownScannedBytes} bytes`,
      });
      break;
    }
    const read = readBoundedFile(
      path.join(root, relative),
      canonicalRoot,
      remaining,
      relative === GENERATED_MEMORY_RELATIVE_PATH ? GENERATED_MEMORY_MAX_BYTES : PRE_TURN_BOUNDS.markdownFileBytes,
    );
    scannedBytes += read.bytes;
    const headings = headingsOf(read.content);
    if (relative === GENERATED_MEMORY_RELATIVE_PATH) {
      for (const line of read.content.split('\n')) {
        if (!line.startsWith('- ')) continue;
        const markerAt = line.indexOf('<!--');
        factCandidates.push({
          path: relative,
          headings,
          content: line,
          // Score the fact, not its provenance marker. The marker is ~20% of a
          // line's characters, and its tokens dilute the density term ranking
          // uses, so scoring it penalised generated facts against clean manual
          // Markdown. selectGeneratedMemoryForPrompt already strips it exactly
          // this way on the curator side; this makes both paths agree.
          searchable: markerAt < 0 ? line : line.slice(0, markerAt),
          capturedAt: capturedAtOf(line),
        });
      }
      continue;
    }
    fileCandidates.push({
      path: relative,
      headings,
      content: read.content,
      searchable: `${relative}\n${headings.join('\n')}\n${read.content}`,
      capturedAt: '',
    });
  }
  const rankPool = (
    pool: SearchableCandidate[],
    tokens: string[],
    maxChars: number,
    tieBreak: (a: SearchableCandidate, b: SearchableCandidate) => number,
  ) =>
    rankByBestPassage(tokens, pool, (candidate) => candidate.searchable, {
      maxChars,
      tieBreak,
    });
  const byPath = (a: SearchableCandidate, b: SearchableCandidate) => compareCodepoint(a.path, b.path);
  // Age ranks, it never filters. Between facts of equal relevance the newer
  // capture wins; an older exact match still outranks a fresher weak one, so a
  // fact stays recallable however old it is. ISO-8601 sorts chronologically.
  const byRecency = (a: SearchableCandidate, b: SearchableCandidate) => compareCodepoint(b.capturedAt, a.capturedAt);
  const rankAll = (tokens: string[]) => ({
    files: rankPool(fileCandidates, tokens, PRE_TURN_BOUNDS.markdownExcerptChars, byPath),
    facts: rankPool(factCandidates, tokens, PRE_TURN_BOUNDS.generatedFactExcerptChars, byRecency),
  });
  let ranked = rankAll(queryTokens);
  if (ranked.files.length === 0 && ranked.facts.length === 0) {
    const expanded = rankAll(expandedTokens);
    if (expanded.files.length > 0 || expanded.facts.length > 0) {
      ranked = expanded;
      markExpansionUsed(notices);
    }
  }
  const toExcerpt = (
    { candidate, passage }: { candidate: SearchableCandidate; passage: PassageMatch },
    maxChars: number,
  ): MemoryEvidenceExcerpt => {
    const text =
      candidate.path === GENERATED_MEMORY_RELATIVE_PATH
        ? boundedFactLine(candidate.content, maxChars)
        : contextualExcerpt(candidate.content, passage.text, maxChars, TRUNCATED_MARKDOWN_EXCERPT);
    return {
      path: candidate.path,
      headings: candidate.headings,
      text,
      score: passage.score,
      fingerprint: evidenceFingerprint(
        'workgroup-memory-canon',
        workgroupId,
        `${candidate.path}\0${sha256(text)}`,
        candidate.content,
      ),
      provenance: { authority: 'workgroup-memory-canon' as const, workgroupId },
    };
  };
  const rankedFiles = ranked.files.map((row) => toExcerpt(row, PRE_TURN_BOUNDS.markdownExcerptChars));
  const rankedFacts = ranked.facts.map((row) => toExcerpt(row, PRE_TURN_BOUNDS.generatedFactExcerptChars));
  const keepUnseen = (rows: MemoryEvidenceExcerpt[]): MemoryEvidenceExcerpt[] =>
    bypassDedupe ? rows : rows.filter((row) => !seenEvidenceFingerprints.has(row.fingerprint));
  const dedupedFiles = keepUnseen(rankedFiles);
  const dedupedFacts = keepUnseen(rankedFacts);
  const dedupedPreferences = keepUnseen(preferenceExcerpts);
  const suppressed =
    rankedFiles.length -
    dedupedFiles.length +
    (rankedFacts.length - dedupedFacts.length) +
    (preferenceExcerpts.length - dedupedPreferences.length);
  if (suppressed > 0) {
    notices.push({
      source: 'context',
      status: 'ok',
      code: 'evidence-already-delivered',
      detail: `suppressed ${suppressed} unchanged Markdown passage${suppressed === 1 ? '' : 's'} in this context epoch`,
    });
  }
  const boundedCandidates = dedupedFiles.slice(0, PRE_TURN_BOUNDS.markdownCandidates);
  if (rankedFiles.length > boundedCandidates.length) {
    notices.push({
      source: 'markdown',
      status: 'truncated',
      code: 'markdown-candidate-limit',
      detail: `selected ${boundedCandidates.length} of ${rankedFiles.length} relevant Markdown candidates`,
    });
  }
  const fileExcerpts = boundedCandidates.slice(0, PRE_TURN_BOUNDS.markdownExcerpts);
  if (boundedCandidates.length > fileExcerpts.length) {
    notices.push({
      source: 'markdown',
      status: 'truncated',
      code: 'markdown-excerpt-limit',
      detail: `selected ${fileExcerpts.length} of ${boundedCandidates.length} bounded Markdown candidates`,
    });
  }
  const boundedFacts = dedupedFacts.slice(0, PRE_TURN_BOUNDS.generatedFactCandidates);
  if (rankedFacts.length > boundedFacts.length) {
    notices.push({
      source: 'markdown',
      status: 'truncated',
      code: 'generated-fact-candidate-limit',
      detail: `selected ${boundedFacts.length} of ${rankedFacts.length} relevant generated facts`,
    });
  }
  const factExcerpts = boundedFacts.slice(0, PRE_TURN_BOUNDS.generatedFactExcerpts);
  if (boundedFacts.length > factExcerpts.length) {
    notices.push({
      source: 'markdown',
      status: 'truncated',
      code: 'generated-fact-excerpt-limit',
      detail: `selected ${factExcerpts.length} of ${boundedFacts.length} bounded generated facts`,
    });
  }
  // Most relevant first: enforceFinalBound pops from the end when over budget.
  // Preferences carry MAX_SAFE_INTEGER scores, so they sort first and the
  // budget loop below (which pops the tail) can never drop them.
  const excerpts = [...dedupedPreferences, ...factExcerpts, ...fileExcerpts].sort((a, b) => b.score - a.score);
  // Keep both memory lanes inside one shared total, dropping the least relevant
  // first, so memory cannot reach enforceFinalBound large enough to evict the
  // archive lane that function sacrifices ahead of it.
  let excerptChars = excerpts.reduce((sum, row) => sum + row.text.length, 0);
  let droppedForBudget = 0;
  while (excerpts.length > 1 && excerptChars > PRE_TURN_BOUNDS.memoryExcerptTotalChars) {
    excerptChars -= excerpts.pop()!.text.length;
    droppedForBudget += 1;
  }
  if (droppedForBudget > 0) {
    notices.push({
      source: 'markdown',
      status: 'truncated',
      code: 'memory-excerpt-total-budget',
      detail: `dropped ${droppedForBudget} lower-ranked memory excerpt${droppedForBudget === 1 ? '' : 's'} to stay within ${PRE_TURN_BOUNDS.memoryExcerptTotalChars} characters`,
    });
  }
  if (excerpts.length === 0) {
    notices.push({
      source: 'markdown',
      status: 'no-match',
      code: 'no-relevant-memory',
      detail: includeBootstrap
        ? 'Bootstrap index is present; no deeper Markdown matched the current input.'
        : 'No new deeper Markdown matched the current input.',
    });
  }
  return { core, excerpts };
}

function contextualExcerpt(content: string, passage: string, maxChars: number, marker: string): string {
  if (content.length <= maxChars) return content;
  const passageStart = Math.max(0, content.indexOf(passage));
  const prefix = '[excerpt-start] ';
  const contentBudget = Math.max(0, maxChars - marker.length - prefix.length);
  const before = Math.max(0, Math.floor((contentBudget - Math.min(contentBudget, passage.length)) / 2));
  const start = Math.max(0, Math.min(passageStart - before, content.length - contentBudget));
  const end = Math.min(content.length, start + contentBudget);
  return boundedText(`${start > 0 ? prefix : ''}${content.slice(start, end)}${marker}`, maxChars, marker);
}

function archiveExcerpt(row: ArchiveEvidenceRow, score: number, passageText?: string): ConversationEvidenceExcerpt {
  const text =
    passageText === undefined
      ? boundedText(row.text, PRE_TURN_BOUNDS.archiveExcerptChars, TRUNCATED_ARCHIVE_EXCERPT)
      : contextualExcerpt(row.text, passageText, PRE_TURN_BOUNDS.archiveExcerptChars, TRUNCATED_ARCHIVE_EXCERPT);
  return {
    ...row,
    text,
    score,
    fingerprint: evidenceFingerprint('host-message-archive', row.agentGroupId, `${row.id}\0${sha256(text)}`, row.text),
    provenance: { authority: 'host-message-archive', archiveId: row.id },
  };
}

/** Exported for direct test of the total-block budget — see pre-turn-context.test.ts. */
export function boundedCapabilities(
  snapshot: SessionServicesSnapshot,
  notices: ContextNotice[],
): SessionServicesSnapshot {
  const selected = snapshot.services.slice(0, PRE_TURN_BOUNDS.capabilityServices).map((service) => ({
    ...service,
    name: boundedText(service.name, PRE_TURN_BOUNDS.capabilityDetailChars, TRUNCATED_CAPABILITY_DETAIL),
    cli:
      service.cli === undefined
        ? undefined
        : boundedText(service.cli, PRE_TURN_BOUNDS.capabilityDetailChars, TRUNCATED_CAPABILITY_DETAIL),
    mcpNamespace:
      service.mcpNamespace === undefined
        ? undefined
        : boundedText(service.mcpNamespace, PRE_TURN_BOUNDS.capabilityDetailChars, TRUNCATED_CAPABILITY_DETAIL),
    declaredTools: service.declaredTools.map((value) =>
      boundedText(value, PRE_TURN_BOUNDS.capabilityDetailChars, TRUNCATED_CAPABILITY_DETAIL),
    ),
    scopes: service.scopes.map((value) =>
      boundedText(value, PRE_TURN_BOUNDS.capabilityDetailChars, TRUNCATED_CAPABILITY_DETAIL),
    ),
    credentialPaths: service.credentialPaths.map((value) =>
      boundedText(value, PRE_TURN_BOUNDS.capabilityDetailChars, TRUNCATED_CAPABILITY_DETAIL),
    ),
    activation:
      service.activation === undefined
        ? undefined
        : boundedText(service.activation, PRE_TURN_BOUNDS.capabilityDetailChars, TRUNCATED_CAPABILITY_DETAIL),
    useFor:
      service.useFor === undefined
        ? undefined
        : boundedText(service.useFor, PRE_TURN_BOUNDS.capabilityDetailChars, TRUNCATED_CAPABILITY_DETAIL),
  }));
  if (selected.length < snapshot.services.length) {
    notices.push({
      source: 'capabilities',
      status: 'truncated',
      code: 'capability-service-limit',
      detail: `selected ${selected.length} of ${snapshot.services.length} services`,
    });
  }
  // Total-block budget. Drops whole services from the end rather than clipping
  // a kept one, because boundedText cuts from the END and the operative
  // sentence of every capability entry ("never tell the owner you can't X
  // without first trying Y") is written last — clipping would remove exactly
  // the guidance the entry exists to deliver. Enforced here so capabilities can
  // never reach enforceFinalBound large enough to evict conversation and memory
  // recall, which that function sacrifices first.
  const droppedForBudget: string[] = [];
  while (selected.length > 0 && JSON.stringify(selected).length > PRE_TURN_BOUNDS.capabilityTotalChars) {
    droppedForBudget.push(selected.pop()!.name);
  }
  if (droppedForBudget.length > 0) {
    notices.push({
      source: 'capabilities',
      status: 'truncated',
      code: 'capability-total-budget',
      detail: `dropped ${droppedForBudget.length} service(s) over ${PRE_TURN_BOUNDS.capabilityTotalChars} chars: ${droppedForBudget.join(', ')}`,
    });
  }
  return { agentGroupId: snapshot.agentGroupId, services: selected };
}

function enforceFinalBound(context: PreTurnContext): void {
  let truncated = false;
  const serializedLength = (): number => JSON.stringify(context).length;
  const limit = context.conversationEvidence.excerpts.some((row) => row.rank === 'exact-link')
    ? PRE_TURN_BOUNDS.exactLinkFinalChars
    : PRE_TURN_BOUNDS.finalChars;
  // The graph-scent LANE is shed FIRST — the field AND its notices — before
  // any conversation or memory excerpt. It is the one purely advisory lane,
  // and shedding it first is what makes "enabling the lane never displaces
  // recall" true by construction rather than by budget arithmetic. Notices are
  // part of the lane deliberately (review finding): a cold/no-match notice
  // surviving the excerpt loops could evict a 900-char archive excerpt to keep
  // ~140 bytes of advisory bookkeeping. Both prior budget incidents (see the
  // bounds comments above) came from a lane that could not be shed.
  if (serializedLength() > limit) {
    if (context.graphScent !== undefined) {
      delete context.graphScent;
      truncated = true;
    }
    const withoutGraphNotices = context.notices.filter((notice) => notice.source !== 'graph');
    if (withoutGraphNotices.length < context.notices.length) {
      context.notices = withoutGraphNotices;
      truncated = true;
    }
  }
  while (serializedLength() > limit && context.conversationEvidence.excerpts.some((row) => row.rank !== 'exact-link')) {
    let index = context.conversationEvidence.excerpts.length - 1;
    while (index >= 0 && context.conversationEvidence.excerpts[index]!.rank === 'exact-link') index -= 1;
    context.conversationEvidence.excerpts.splice(index, 1);
    truncated = true;
  }
  while (serializedLength() > limit && context.memoryEvidence.excerpts.length > 0) {
    context.memoryEvidence.excerpts.pop();
    truncated = true;
  }
  while (serializedLength() > limit && context.memoryEvidence.core.some((row) => row.text.length > 512)) {
    const row = [...context.memoryEvidence.core].reverse().find((candidate) => candidate.text.length > 512)!;
    row.text = boundedText(row.text, Math.max(512, Math.floor(row.text.length / 2)), TRUNCATED_MARKDOWN_FILE);
    truncated = true;
  }
  while (serializedLength() > limit && (context.trustedCapabilities?.services.length ?? 0) > 0) {
    context.trustedCapabilities!.services.pop();
    truncated = true;
  }
  while (serializedLength() > limit && context.conversationEvidence.excerpts.length > 0) {
    context.conversationEvidence.excerpts.pop();
    truncated = true;
  }
  if (truncated) {
    context.notices.push({
      source: 'context',
      status: 'truncated',
      code: 'final-context-limit',
      detail: `bounded serialized context to ${limit} characters`,
    });
  }
  for (const notice of context.notices) {
    notice.detail = boundedText(notice.detail, 120, '[truncated:notice]');
  }
  while (serializedLength() > limit && context.memoryEvidence.core.some((row) => row.text.length > 64)) {
    const row = [...context.memoryEvidence.core].reverse().find((candidate) => candidate.text.length > 64)!;
    row.text = boundedText(row.text, Math.max(64, Math.floor(row.text.length / 2)), TRUNCATED_MARKDOWN_FILE);
  }
  while (serializedLength() > limit && context.memoryEvidence.core.some((row) => row.headings.length > 0)) {
    [...context.memoryEvidence.core]
      .reverse()
      .find((candidate) => candidate.headings.length > 0)!
      .headings.pop();
  }
  while (serializedLength() > limit && context.notices.length > 2) {
    let removable = -1;
    for (let index = context.notices.length - 1; index >= 0; index--) {
      const notice = context.notices[index]!;
      if (notice.code !== 'current-input-authoritative' && notice.code !== 'final-context-limit') {
        removable = index;
        break;
      }
    }
    if (removable === -1) break;
    context.notices.splice(removable, 1);
  }
}

function potentialConflict(
  queryTokens: string[],
  memory: MemoryEvidenceExcerpt[],
  conversation: ConversationEvidenceExcerpt[],
): boolean {
  if (memory.length === 0 || conversation.length === 0) return false;
  const correction = /\b(?:not|correction|corrected|instead|rather than|but)\b/i;
  return memory.some((memoryRow) =>
    conversation.some(
      (conversationRow) =>
        lexicalScore(queryTokens, memoryRow.text) > 0 &&
        lexicalScore(queryTokens, conversationRow.text) > 0 &&
        (correction.test(memoryRow.text) || correction.test(conversationRow.text)),
    ),
  );
}

/**
 * Build fresh, bounded provider context from trusted host scope. The current
 * content is query material only and is never used to choose a workgroup,
 * member set, messaging group, or capability boundary.
 */
export function buildPreTurnContext(input: PreTurnContextInput): PreTurnContext {
  const db = getDb();
  const scope = db
    .prepare(
      `SELECT s.agent_group_id, s.messaging_group_id, s.thread_id, a.workgroup_id
         FROM sessions s
         JOIN agent_groups a ON a.id = s.agent_group_id
        WHERE s.id = ?`,
    )
    .get(input.sessionId) as
    | {
        agent_group_id: string;
        messaging_group_id: string | null;
        thread_id: string | null;
        workgroup_id: string | null;
      }
    | undefined;
  if (!scope || scope.agent_group_id !== input.agentGroupId) {
    throw new Error(`Unable to resolve trusted session scope for ${input.agentGroupId}/${input.sessionId}`);
  }
  const currentMessagingGroupId =
    input.messagingGroupId === undefined ? scope.messaging_group_id : input.messagingGroupId;
  const currentThreadId = input.threadId === undefined ? scope.thread_id : input.threadId;
  const fallbackGroup = db.prepare(`SELECT folder FROM agent_groups WHERE id = ?`).get(input.agentGroupId) as
    | { folder: string }
    | undefined;
  const workgroupId = scope.workgroup_id ?? fallbackGroup?.folder;
  if (!workgroupId) throw new Error(`Unable to resolve trusted workgroup for ${input.agentGroupId}/${input.sessionId}`);
  const memberAgentGroupIds = scope.workgroup_id
    ? (
        db.prepare(`SELECT id FROM agent_groups WHERE workgroup_id = ? ORDER BY id`).all(workgroupId) as Array<{
          id: string;
        }>
      ).map((row) => row.id)
    : [input.agentGroupId];
  if (memberAgentGroupIds.length === 0 || !memberAgentGroupIds.includes(input.agentGroupId)) {
    throw new Error(`Unable to resolve trusted workgroup members for ${input.agentGroupId}/${input.sessionId}`);
  }

  const notices: ContextNotice[] = [
    {
      source: 'context',
      status: 'ok',
      code: 'current-input-authoritative',
      detail: 'Current input follows this evidence pair and wins over recalled material.',
    },
  ];
  if (!scope.workgroup_id) {
    notices.push({
      source: 'scope',
      status: 'degraded',
      code: 'legacy-isolated-workgroup-scope',
      detail: 'The agent group has no workgroup_id; recall is fail-closed to this group and its DB folder only.',
    });
  }
  const includeBootstrap = input.includeBootstrap ?? true;
  const seenEvidenceFingerprints = new Set(input.seenEvidenceFingerprints ?? []);
  const query = extractQueryText(input.normalizedContent);
  const bypassDedupe = CORRECTION_PATTERN.test(query);
  let trustedCapabilities: SessionServicesSnapshot | undefined;
  if (includeBootstrap) {
    try {
      trustedCapabilities = boundedCapabilities(
        buildSessionServicesSnapshot(input.agentGroupId, currentMessagingGroupId),
        notices,
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      trustedCapabilities = { agentGroupId: input.agentGroupId, services: [] };
      notices.push({
        source: 'capabilities',
        status: 'degraded',
        code: 'capability-detail-read-failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Involved senders for the deterministic preference lane: the triggering
  // message's sender plus recent inbound senders in this conversation.
  const involvedSenderNames: string[] = [];
  const triggerSender = extractSenderName(input.normalizedContent);
  if (triggerSender) involvedSenderNames.push(triggerSender);
  try {
    for (const name of recentConversationSenderNames({
      memberAgentGroupIds,
      messagingGroupId: currentMessagingGroupId,
      threadId: currentThreadId,
    })) {
      if (!involvedSenderNames.includes(name)) involvedSenderNames.push(name);
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    notices.push({
      source: 'archive',
      status: 'degraded',
      code: 'sender-recall-failed',
      detail: error.message,
    });
  }

  let memoryEvidence: PreTurnContext['memoryEvidence'];
  try {
    memoryEvidence = readMemoryEvidence(
      workgroupMemoryDir(workgroupId),
      workgroupId,
      query,
      notices,
      includeBootstrap,
      seenEvidenceFingerprints,
      bypassDedupe,
      involvedSenderNames,
    );
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    memoryEvidence = { core: [], excerpts: [] };
    notices.push({
      source: 'markdown',
      status: 'degraded',
      code: 'markdown-read-failed',
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const queryTokens = tokenizeForRecall(query);
  const conversationRows: ConversationEvidenceExcerpt[] = [];
  const seenArchiveIds = new Set<string>();
  try {
    const exactRows = queryArchiveExactLinks({
      memberAgentGroupIds,
      normalizedContent: query,
      candidateLimit: PRE_TURN_BOUNDS.exactLinkCandidates,
    });
    for (const row of exactRows.slice(0, PRE_TURN_BOUNDS.exactLinkExcerpts)) {
      seenArchiveIds.add(row.id);
      conversationRows.push(archiveExcerpt(row, Number.MAX_SAFE_INTEGER));
    }
    if (exactRows.length > PRE_TURN_BOUNDS.exactLinkExcerpts) {
      notices.push({
        source: 'exact-link',
        status: 'truncated',
        code: 'exact-link-excerpt-limit',
        detail: `selected ${PRE_TURN_BOUNDS.exactLinkExcerpts} exact-link rows`,
      });
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    notices.push({
      source: 'exact-link',
      status: 'degraded',
      code: 'exact-link-read-failed',
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const rankArchive = (searchQuery: string, scoreTokens: string[]) =>
      rankByBestPassage(
        scoreTokens,
        searchArchiveEvidence({
          memberAgentGroupIds,
          query: searchQuery,
          currentMessagingGroupId,
          currentThreadId,
          currentNormalizedContent: query.trim(),
          candidateLimit: PRE_TURN_BOUNDS.archiveCandidates,
        }),
        (row) => row.text,
        { priority: (row) => (row.rank === 'current-thread' ? 0 : 1) },
      );
    let candidates = rankArchive(query, queryTokens);
    const expansion = ephemeralExpansion(query);
    if (conversationRows.length === 0 && candidates.length === 0 && expansion.length > 0) {
      candidates = rankArchive(`${query} ${expansion.join(' ')}`, tokenizeForRecall(`${query} ${expansion.join(' ')}`));
      if (candidates.length > 0) markExpansionUsed(notices);
    }
    const lexicalCandidates = candidates.filter((candidate) => {
      if (seenArchiveIds.has(candidate.candidate.id)) return false;
      if (bypassDedupe) return true;
      const fingerprint = archiveExcerpt(
        candidate.candidate,
        candidate.passage.score,
        candidate.passage.text,
      ).fingerprint;
      return !seenEvidenceFingerprints.has(fingerprint);
    });
    const eligibleCandidates = candidates.filter((candidate) => !seenArchiveIds.has(candidate.candidate.id));
    const suppressed = eligibleCandidates.length - lexicalCandidates.length;
    if (suppressed > 0) {
      notices.push({
        source: 'context',
        status: 'ok',
        code: 'evidence-already-delivered',
        detail: `suppressed ${suppressed} unchanged archive excerpt${suppressed === 1 ? '' : 's'} in this context epoch`,
      });
    }
    const selectedLexical = lexicalCandidates.slice(0, PRE_TURN_BOUNDS.archiveExcerpts);
    for (const candidate of selectedLexical) {
      seenArchiveIds.add(candidate.candidate.id);
      conversationRows.push(archiveExcerpt(candidate.candidate, candidate.passage.score, candidate.passage.text));
    }
    if (lexicalCandidates.length > selectedLexical.length) {
      notices.push({
        source: 'archive',
        status: 'truncated',
        code: 'archive-excerpt-limit',
        detail: `selected ${selectedLexical.length} of ${lexicalCandidates.length} lexical archive rows`,
      });
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    notices.push({
      source: 'archive',
      status: 'degraded',
      code: 'archive-read-failed',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  if (conversationRows.length === 0) {
    notices.push({
      source: 'archive',
      status: 'no-match',
      code: 'no-relevant-conversation',
      detail: 'No authoritative archive excerpt matched the current input.',
    });
  }
  if (potentialConflict(queryTokens, [...memoryEvidence.core, ...memoryEvidence.excerpts], conversationRows)) {
    notices.push({
      source: 'context',
      status: 'conflict',
      code: 'potential-source-conflict',
      detail: 'Canonical memory and archive evidence may conflict; both are retained with provenance for the provider.',
    });
  }

  // Advisory graph pointers. readGraphScent never throws and refuses cold
  // workgroups outright, so this adds at most one warm bounded FTS query
  // (0-120ms measured) to the turn.
  const graphScent = readGraphScent(workgroupId, query, notices);

  const context: PreTurnContext = {
    ...(input.provider === undefined ? {} : { provider: input.provider.toLocaleLowerCase('en-US') }),
    ...(input.contextEpoch === undefined ? {} : { contextEpoch: input.contextEpoch }),
    ...(trustedCapabilities === undefined ? {} : { trustedCapabilities }),
    memoryEvidence,
    conversationEvidence: { excerpts: conversationRows },
    ...(graphScent === null ? {} : { graphScent }),
    notices,
  };
  enforceFinalBound(context);
  return context;
}
