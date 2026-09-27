import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

import {
  buildCapabilityRoster,
  buildSessionServicesSnapshotFrom,
  CAPABILITY_ROSTER_PREAMBLE,
  type CapabilityRoster,
  type CapabilityRosterEntry,
  type SessionServicesCentral,
  type SessionServicesSnapshot,
} from '../../capabilities.js';
import { type RawStatements, withRawDb } from '../../db/central-lease.js';
import { log } from '../../log.js';
import {
  queryArchiveExactLinks,
  recentConversationSenders,
  searchArchiveEvidence,
  type ArchiveEvidenceRow,
} from '../../message-archive.js';
import { USER_BY_ID_SQL } from '../permissions/db/users.js';
import { workgroupMemoryDir } from '../workgroup/shared-dirs.js';

export const PRE_TURN_BOUNDS = Object.freeze({
  // Per-file read cap. Only index.md and matched preferences/<slug>.md are read
  // per turn; nothing walks the tree.
  markdownFileBytes: 65_536,
  // index.md, injected whole on a bootstrap turn: the map the agent navigates
  // manual memory by. Keep index.md under this or the map is truncated.
  markdownCoreChars: 2_500,
  markdownHeadings: 24,
  markdownHeadingChars: 240,
  // Per-person preference files matching the conversation's senders, injected
  // whole; the ONLY lane that reads manual Markdown per turn. 2,200 fits the
  // write-side guidance for a preference file (~2,000 chars) with headroom.
  preferenceExcerpts: 6,
  preferenceExcerptChars: 2_200,
  // Load-bearing: enforceFinalBound sacrifices conversation excerpts FIRST, so
  // unbounded memory could evict every archive excerpt. Preferences sort first
  // (MAX_SAFE_INTEGER scores) and may crowd out ranked memory.
  memoryExcerptTotalChars: 6_600,
  archiveCandidates: 96,
  archiveExcerpts: 3,
  archiveExcerptChars: 900,
  exactLinkCandidates: 32,
  exactLinkExcerpts: 8,
  capabilityServices: 32,
  // Per-field cap for a roster entry. Kept at 2500 (not the ~80-char authoring
  // target) so a pathological entry isn't clipped mid-sentence; the roster
  // budget is what holds the block down.
  capabilityDetailChars: 2500,
  // Hard cap on ONE roster hint (authoring target ~80). `boundedText` clips from
  // the END, where safety imperatives ("never run `wix login`") are written, so
  // this must not clip them; `src/capabilities.test.ts` fails on an authored
  // summary over it.
  capabilityRosterUseChars: 200,
  // Expected cost of the whole roster block, preamble included. NOT an eviction
  // trigger: a test pins the widest fixture (every hand-written entry) against
  // it so an over-long `summary` fails in CI long before eviction can.
  capabilityRosterChars: 5_200,
  // Eviction trigger in `boundedCapabilities`, measured over the services array
  // only (the ~740-char preamble is extra). Load-bearing: capabilities are the
  // LAST thing enforceFinalBound sacrifices, so without a total they can starve
  // all recall. Real content shouldn't reach it, but an operator can put
  // anything in a stored MCP `description`.
  capabilityTotalChars: 10_000,
  finalChars: 12_000,
  exactLinkFinalChars: 16_000,
  // Bootstrap turns carry mandatory payload (capability block, core index) the
  // ordinary bound never sees; under finalChars it would evict every recall excerpt.
  // Derived: finalChars + capabilityTotalChars + 1,100 (memory-lane raise).
  // Worst realistic payload is ~21,800. Deliberately NOT the sum of every lane
  // cap (~29,000): a bootstrap turn with a full exact-link match is exactly the
  // case this bound should shed memory/lexical excerpts for.
  bootstrapFinalChars: 23_100,
});

export interface PreTurnContextInput {
  agentGroupId: string;
  sessionId: string;
  /** Host-routed scope for agent-shared sessions; omitted uses the persisted session scope. */
  messagingGroupId?: string | null;
  threadId?: string | null;
  kind: string;
  trigger: 0 | 1;
  normalizedContent: string;
  provider?: string;
  contextEpoch?: number;
  /** Full capabilities plus index.md only at a fresh context boundary. */
  includeBootstrap?: boolean;
  seenEvidenceFingerprints?: readonly string[];
  /**
   * Resolved by the caller before its synchronous block: the build itself never
   * awaits (it runs between a write guard and its insert).
   */
  servicesCentral: SessionServicesCentral;
}

export interface ContextNotice {
  source: 'scope' | 'capabilities' | 'markdown' | 'archive' | 'exact-link' | 'context';
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
  /**
   * The always-on ROSTER (one line per wired service), not the full snapshot;
   * full notes stay behind `get_capabilities({ service })`.
   */
  trustedCapabilities?: CapabilityRoster;
  memoryEvidence: {
    core: MemoryEvidenceExcerpt[];
    excerpts: MemoryEvidenceExcerpt[];
  };
  conversationEvidence: {
    excerpts: ConversationEvidenceExcerpt[];
  };
  notices: ContextNotice[];
}

const CORE_PATHS = ['index.md'] as const;
const PREFERENCES_DIR = 'preferences/';

function preferenceSlug(name: string): string {
  return name
    .toLocaleLowerCase('en-US')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Equal, or hyphen-prefix either way ("alex" <-> "alex-stone"). */
function preferenceStemMatches(stem: string, senderSlug: string): boolean {
  return stem === senderSlug || senderSlug.startsWith(`${stem}-`) || stem.startsWith(`${senderSlug}-`);
}

export interface PreferenceFrontmatter {
  ids: string[];
  body: string;
}

/**
 * Optional leading frontmatter declaring platform sender ids:
 *
 *   ---
 *   ids: [U0TEST111AAA, U0TEST222BBB]
 *   ---
 *
 * Deliberately not YAML: exactly that shape, else `ids` is empty and `body` is
 * the unchanged content. Never throws.
 */
export function parsePreferenceFrontmatter(content: string): PreferenceFrontmatter {
  const OPEN = '---\n';
  if (!content.startsWith(OPEN)) return { ids: [], body: content };
  const idsLineEnd = content.indexOf('\n', OPEN.length);
  if (idsLineEnd === -1) return { ids: [], body: content };
  const idsLine = content.slice(OPEN.length, idsLineEnd);
  const idsMatch = idsLine.match(/^ids:\s*\[([^\]]*)\]\s*$/);
  if (!idsMatch) return { ids: [], body: content };
  const afterIdsLine = idsLineEnd + 1;
  const CLOSE = '---\n';
  if (content.slice(afterIdsLine, afterIdsLine + CLOSE.length) !== CLOSE) {
    return { ids: [], body: content };
  }
  const ids = idsMatch[1]!
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return { ids, body: content.slice(afterIdsLine + CLOSE.length) };
}

function extractSenderName(normalizedContent: string): string | null {
  try {
    const parsed = JSON.parse(normalizedContent) as { sender?: unknown };
    return typeof parsed.sender === 'string' && parsed.sender.trim().length > 0 ? parsed.sender.trim() : null;
  } catch {
    return null;
  }
}

/**
 * `senderId`, else `author.userId`, trimmed; null on absence or parse failure.
 * Usually a raw platform id, but a supplied namespace is kept.
 */
function extractSenderId(normalizedContent: string): string | null {
  try {
    const parsed = JSON.parse(normalizedContent) as { senderId?: unknown; author?: unknown };
    if (typeof parsed.senderId === 'string' && parsed.senderId.trim().length > 0) return parsed.senderId.trim();
    const author = parsed.author;
    const userId = author && typeof author === 'object' ? (author as { userId?: unknown }).userId : undefined;
    return typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : null;
  } catch {
    return null;
  }
}

/** Looked up ONCE per build; null means "no verified namespace" and callers skip stripping/prefixing. */
function lookupChannelType(db: RawStatements, messagingGroupId: string | null): string | null {
  if (!messagingGroupId) return null;
  try {
    const row = db.prepare('SELECT channel_type FROM messaging_groups WHERE id = ?').get(messagingGroupId) as
      | { channel_type: string }
      | undefined;
    return row ? row.channel_type : null;
  } catch {
    return null;
  }
}

/**
 * Strips ONLY the current conversation's verified `${channelType}:` prefix.
 * Never "everything before the last colon": raw handles can contain colons
 * (`@alice:matrix.org`), and that rule would collapse different people on one
 * homeserver to the same suffix.
 */
function stripVerifiedPrefix(id: string, channelType: string | null): string {
  if (channelType === null) return id;
  const prefix = `${channelType}:`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

/**
 * Namespaces a raw trigger id like `extractAndUpsertUser` namespaces archived
 * ones (colon-free ids get `${channelType}:`), so it can hit a file's
 * namespace-exact `ids:` entry. A null channelType degrades to the raw id.
 */
function namespaceTriggerSenderId(rawId: string | null, channelType: string | null): string | null {
  if (rawId === null || rawId.includes(':') || !channelType) return rawId;
  return `${channelType}:${rawId}`;
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

export function compareCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const STOP_WORDS = new Set([
  'a',
  'about',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'before',
  'by',
  'can',
  'com',
  'do',
  'does',
  'for',
  'from',
  'has',
  'have',
  'how',
  'i',
  'in',
  'into',
  'is',
  'it',
  'me',
  'of',
  'on',
  'our',
  'should',
  'that',
  'the',
  'their',
  'this',
  'to',
  'we',
  'what',
  'when',
  'where',
  'which',
  'who',
  'with',
  'http',
  'https',
  'www',
]);

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

/**
 * Per-token canonical-form memo (Zipfian reuse; the per-string token-stream
 * cache can't cover it). Two hazards measured:
 * - NO REORDER ON HIT: do not make this an LRU; the delete+set per hit eats
 *   most of the saving.
 * - THE CAP IS A FLOOR: without reordering, a working set larger than the cap
 *   drops the hit rate to ZERO, and over-capacity is slower than no memo. The
 *   working set is the union of tokens across every workgroup; raising the cap
 *   is cheap, lowering it below that union is a cliff. The hit-rate warning is
 *   what makes the cliff observable.
 */
const CANONICAL_MEMO = new Map<string, string>();
const CANONICAL_MEMO_MAX = 131_072;
const CANONICAL_MEMO_STATS = { hits: 0, misses: 0 };
let canonicalMemoWarned = false;

function canonicalTokenMemo(token: string): string {
  const cached = CANONICAL_MEMO.get(token);
  if (cached !== undefined) {
    CANONICAL_MEMO_STATS.hits++;
    return cached;
  }
  CANONICAL_MEMO_STATS.misses++;
  const value = canonicalToken(token);
  // Evict exactly ONE oldest entry; never `.clear()` the warm set.
  if (CANONICAL_MEMO.size >= CANONICAL_MEMO_MAX) {
    CANONICAL_MEMO.delete(CANONICAL_MEMO.keys().next().value!);
  }
  CANONICAL_MEMO.set(token, value);
  const total = CANONICAL_MEMO_STATS.hits + CANONICAL_MEMO_STATS.misses;
  if (!canonicalMemoWarned && total >= 1_000_000 && CANONICAL_MEMO_STATS.hits / total < 0.5) {
    canonicalMemoWarned = true;
    log.warn('canonical-token memo hit rate below 50%: working set has outgrown the cap', {
      hits: CANONICAL_MEMO_STATS.hits,
      misses: CANONICAL_MEMO_STATS.misses,
      max: CANONICAL_MEMO_MAX,
    });
  }
  return value;
}

export function _canonicalMemoStatsForTest(): { hits: number; misses: number; size: number; max: number } {
  return { ...CANONICAL_MEMO_STATS, size: CANONICAL_MEMO.size, max: CANONICAL_MEMO_MAX };
}

export function _resetCanonicalMemoForTest(): void {
  CANONICAL_MEMO.clear();
  CANONICAL_MEMO_STATS.hits = 0;
  CANONICAL_MEMO_STATS.misses = 0;
  canonicalMemoWarned = false;
}

export function tokenizeForRecall(value: string): string[] {
  return [...new Set(tokenStreamForRecall(value).map((token) => token.value))];
}

export type RecallToken = { value: string; start: number; end: number };

// Tokenizing ranked candidates is the largest per-turn cost and repeats across
// turns. Keyed on the text itself, so no invalidation is needed. LRU via
// delete-and-reinsert on hit; never wholesale-clear.
const TOKEN_STREAM_CACHE = new Map<string, readonly RecallToken[]>();
// An entry is one candidate (windows slice its stream), ~4.4 KB each, so
// 24,576 is ~108 MB worst case.
const TOKEN_STREAM_CACHE_MAX = 24_576;

const TOKEN_STREAM_CACHE_STATS = { hits: 0, misses: 0 };

/** Offset-slicing fast-path counters, diffed per build for the log line. */
const OFFSET_SLICE_STATS = { hits: 0, total: 0 };

export function _tokenStreamCacheStatsForTest(): { hits: number; misses: number; size: number; max: number } {
  return { ...TOKEN_STREAM_CACHE_STATS, size: TOKEN_STREAM_CACHE.size, max: TOKEN_STREAM_CACHE_MAX };
}

export function _resetTokenStreamCacheForTest(): void {
  TOKEN_STREAM_CACHE.clear();
  TOKEN_STREAM_CACHE_STATS.hits = 0;
  TOKEN_STREAM_CACHE_STATS.misses = 0;
}

export function tokenStreamForRecall(value: string): readonly RecallToken[] {
  const cached = TOKEN_STREAM_CACHE.get(value);
  if (cached) {
    TOKEN_STREAM_CACHE_STATS.hits++;
    TOKEN_STREAM_CACHE.delete(value);
    TOKEN_STREAM_CACHE.set(value, cached);
    return cached;
  }
  TOKEN_STREAM_CACHE_STATS.misses++;
  const normalized = value.normalize('NFKC').toLocaleLowerCase('en-US');
  const tokens = [...normalized.matchAll(/[\p{L}\p{N}_-]{2,}/gu)]
    .map((match) => ({
      value: canonicalTokenMemo(match[0]),
      start: match.index,
      end: match.index + match[0].length,
    }))
    .filter((token) => token.value.length > 1 && !STOP_WORDS.has(token.value));
  if (TOKEN_STREAM_CACHE.size >= TOKEN_STREAM_CACHE_MAX) {
    TOKEN_STREAM_CACHE.delete(TOKEN_STREAM_CACHE.keys().next().value!);
  }
  TOKEN_STREAM_CACHE.set(value, tokens);
  return tokens;
}

export interface PassageMatch {
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

function sentenceSpans(candidate: string, maxChars: number): Array<{ start: number; end: number }> {
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
  return sentences;
}

const RECALL_TOKEN_CHAR = /[\p{L}\p{N}_-]/u;

/**
 * A non-ASCII character that neither NFKC nor en-US lowercasing can move off its
 * own index or pull a neighbour off theirs, which `offsetSliceable` relies on:
 * not a surrogate (checked by the caller), not a combining mark or Hangul jamo
 * (so NFKC can't act across a character boundary), NFKC-stable alone, and
 * lowercasing to exactly one unit. U+03A3 is excluded because its lowercase is
 * context-sensitive (Final_Sigma). Verified exhaustively over the BMP.
 */
const OFFSET_UNSTABLE_CHAR = /\p{M}|[ᄀ-ᇿꥠ-꥿ힰ-퟿Σ]/u;
const OFFSET_STABLE_CHAR = new Map<string, boolean>();

/**
 * True when NFKC + en-US lowercasing maps every index of `value` to itself.
 * Per character, because whole-string length equality is NOT sufficient (an
 * expansion and a contraction can cancel).
 */
function offsetStable(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) continue;
    if (code >= 0xd800 && code <= 0xdfff) return false;
    const char = value[index]!;
    let stable = OFFSET_STABLE_CHAR.get(char);
    if (stable === undefined) {
      stable =
        !OFFSET_UNSTABLE_CHAR.test(char) &&
        char.normalize('NFKC') === char &&
        char.toLocaleLowerCase('en-US').length === 1;
      OFFSET_STABLE_CHAR.set(char, stable);
    }
    if (!stable) return false;
  }
  return true;
}

/**
 * Whether the whole-candidate token stream can be sliced by window offset.
 * Both must hold: token offsets index the NORMALIZED string while windows slice
 * the ORIGINAL, so every index must be offset-stable; and no token run may
 * cross a window edge (`sentenceSpans` hard-chops long sentences mid-word).
 * Failing costs only the speedup, never correctness.
 */
function offsetSliceable(candidate: string, sentences: readonly { start: number; end: number }[]): boolean {
  if (!offsetStable(candidate)) return false;
  const cuts = (at: number): boolean =>
    at > 0 &&
    at < candidate.length &&
    RECALL_TOKEN_CHAR.test(candidate[at - 1]!) &&
    RECALL_TOKEN_CHAR.test(candidate[at]!);
  return !sentences.some((span) => cuts(span.start) || cuts(span.end));
}

/**
 * TWO COORDINATE SYSTEMS: `start`/`end` are CHARACTER offsets into `candidate`;
 * `tokenLo`/`tokenHi` are PARENT-STREAM token indices, present only when
 * `stream` is non-null. A null stream is a correctness gate (window-local
 * tokenization genuinely differs), not a missed optimization.
 */
function passageWindowSpans(
  candidate: string,
  maxChars: number,
): {
  stream: readonly RecallToken[] | null;
  windows: Array<{ text: string; start: number; end: number; tokenLo: number; tokenHi: number }>;
} {
  const sentences = sentenceSpans(candidate, maxChars);
  const sliceable = offsetSliceable(candidate, sentences);
  OFFSET_SLICE_STATS.total++;
  if (sliceable) OFFSET_SLICE_STATS.hits++;
  const stream = sliceable ? tokenStreamForRecall(candidate) : null;

  // Spans are non-decreasing and no token crosses an edge, so two monotone
  // cursors place every edge in one pass.
  const firstToken: number[] = [];
  const afterToken: number[] = [];
  if (stream) {
    let atStart = 0;
    let atEnd = 0;
    for (const span of sentences) {
      while (atStart < stream.length && stream[atStart]!.start < span.start) atStart++;
      firstToken.push(atStart);
      while (atEnd < stream.length && stream[atEnd]!.start < span.end) atEnd++;
      afterToken.push(atEnd);
    }
  }

  const windows: Array<{ text: string; start: number; end: number; tokenLo: number; tokenHi: number }> = [];
  for (let first = 0; first < sentences.length; first++) {
    for (let last = first; last < Math.min(sentences.length, first + 3); last++) {
      const windowStart = sentences[first]!.start;
      const windowEnd = sentences[last]!.end;
      if (windowEnd - windowStart > maxChars) break;
      windows.push({
        text: candidate.slice(windowStart, windowEnd),
        // REPORTED, never re-derived: searching for the window text finds the
        // first occurrence, not this one (pinned in recall-ranking.test.ts).
        start: windowStart,
        end: windowEnd,
        tokenLo: stream ? firstToken[first]! : 0,
        tokenHi: stream ? afterToken[last]! : 0,
      });
    }
  }
  return { stream, windows };
}

/**
 * Materialized windows the ranking tests assert against; `bestPassage` uses
 * `passageWindowSpans` directly. Windows are original-string slices, so the
 * delivered text is byte-identical.
 */
export function passageWindows(
  candidate: string,
  maxChars: number,
): Array<{ text: string; tokens: readonly RecallToken[]; start: number; end: number }> {
  const { stream, windows } = passageWindowSpans(candidate, maxChars);
  return windows.map(({ text, start, end, tokenLo, tokenHi }) => ({
    text,
    tokens: stream ? stream.slice(tokenLo, tokenHi) : tokenStreamForRecall(text),
    start,
    end,
  }));
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

/**
 * NOT display-only: it drives sorting, budget shedding, the serialized payload
 * and the conflict notice. Every arm must reproduce it BIT-EXACTLY, hence the
 * same float `density` rather than one recomputed from rounded parts.
 */
function encodePassageScore(coverage: number, density: number, tokenSpan: number, questionLike: boolean): number {
  return (
    coverage * 1_000_000_000 +
    Math.round(density * 1_000_000) +
    Math.max(0, 100_000 - tokenSpan * 100) +
    (questionLike ? 0 : 1)
  );
}

function bestPassage(
  queryTokens: string[],
  candidate: string,
  maxChars: number = PRE_TURN_BOUNDS.archiveExcerptChars,
): PassageMatch | null {
  if (queryTokens.length === 0) return null;
  const minimumOverlap = queryTokens.length <= 2 ? 1 : 2;
  const { stream, windows } = passageWindowSpans(candidate, maxChars);
  const matches: PassageMatch[] = [];

  if (stream === null) {
    // Window text and the parent stream disagree: tokenize each window itself.
    for (const { text } of windows) {
      const passageTokens = tokenStreamForRecall(text);
      const candidateSet = new Set(passageTokens.map((token) => token.value));
      const matchedTerms = new Set(queryTokens.filter((token) => candidateSet.has(token)));
      if (matchedTerms.size < minimumOverlap) continue;
      const tokenSpan = minimumTokenSpan(matchedTerms, passageTokens);
      const density = matchedTerms.size / Math.max(1, passageTokens.length);
      const questionLike = text.includes('?');
      matches.push({
        text,
        coverage: matchedTerms.size,
        tokenSpan,
        density,
        questionLike,
        score: encodePassageScore(matchedTerms.size, density, tokenSpan, questionLike),
      });
    }
    return matches.sort(comparePassageMatch)[0] ?? null;
  }

  // Fast path: only query terms can contribute, so collect their positions once
  // per candidate instead of a Set over every window's tokens.
  const queryTermSet = new Set(queryTokens);
  const hitIndex: number[] = [];
  const hitTerm: string[] = [];
  for (let index = 0; index < stream.length; index++) {
    const token = stream[index]!;
    if (queryTermSet.has(token.value)) {
      hitIndex.push(index);
      hitTerm.push(token.value);
    }
  }

  // `windows` is ordered by `tokenLo`, so one monotone cursor suffices.
  let cursor = 0;
  for (const { text, tokenLo, tokenHi } of windows) {
    while (cursor < hitIndex.length && hitIndex[cursor]! < tokenLo) cursor++;
    let end = cursor;
    const matchedTerms = new Set<string>();
    while (end < hitIndex.length && hitIndex[end]! < tokenHi) {
      matchedTerms.add(hitTerm[end]!);
      end++;
    }
    // Filter BEFORE density: an empty window would give 0 / 0 = NaN.
    if (matchedTerms.size < minimumOverlap) continue;
    // Span in PARENT-STREAM indices, never hit-list positions (those skip
    // non-query tokens and would shrink the span, changing the ranking).
    let tokenSpan = Number.POSITIVE_INFINITY;
    for (let start = cursor; start < end; start++) {
      const seen = new Set<string>();
      for (let scan = start; scan < end; scan++) {
        seen.add(hitTerm[scan]!);
        if (seen.size === matchedTerms.size) {
          tokenSpan = Math.min(tokenSpan, hitIndex[scan]! - hitIndex[start]! + 1);
          break;
        }
      }
    }
    const density = matchedTerms.size / Math.max(1, tokenHi - tokenLo);
    const questionLike = text.includes('?');
    matches.push({
      text,
      coverage: matchedTerms.size,
      tokenSpan,
      density,
      questionLike,
      score: encodePassageScore(matchedTerms.size, density, tokenSpan, questionLike),
    });
  }
  // Stable sort, deliberately: a keep-best scan takes the LAST window on a
  // four-field tie where the sort takes the FIRST, changing the bytes delivered.
  return matches.sort(comparePassageMatch)[0] ?? null;
}

/** Test seam: the fast path and the fallback must agree bit-for-bit. */
export function _bestPassageForTest(
  queryTokens: string[],
  candidate: string,
  maxChars?: number,
): Readonly<PassageMatch> | null {
  return bestPassage(queryTokens, candidate, maxChars);
}

export function rankByBestPassage<T>(
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

/** Ephemeral and bounded: its terms never become evidence or persistent state. */
export function ephemeralExpansion(query: string): string[] {
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
  maxBytes: number = PRE_TURN_BOUNDS.markdownFileBytes,
): { content: string; bytes: number; truncated: boolean } {
  // No portable openat(2): pin the leaf with an O_NOFOLLOW fd, resolve the path
  // under the canonical root, and require the resolved object's device+inode to
  // match the fd before reading from it. That defeats a swapped ancestor both
  // before and after open.
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
    const bytes = Math.max(0, Math.min(stat.size, maxBytes));
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

/** Direct, non-recursive listing of one directory's Markdown stems. */
function listDirectMarkdownStems(root: string, dir: string, notices: ContextNotice[]): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const stems: string[] = [];
  let skippedSymlinks = 0;
  for (const entry of entries.sort((a, b) => compareCodepoint(a.name, b.name))) {
    if (entry.isSymbolicLink()) {
      skippedSymlinks++;
      continue;
    }
    if (!entry.isFile() || !entry.name.toLocaleLowerCase('en-US').endsWith('.md')) continue;
    const stem = entry.name.slice(0, -'.md'.length);
    if (stem.length > 0) stems.push(stem);
  }
  if (skippedSymlinks > 0) {
    notices.push({
      source: 'markdown',
      status: 'degraded',
      code: 'markdown-symlink-skipped',
      detail: `skipped ${skippedSymlinks} symbolic link${skippedSymlinks === 1 ? '' : 's'} in ${dir}`,
    });
  }
  return stems;
}

interface InvolvedSenderGroup {
  senderId: string | null;
  /** Per-message display name, plus the canonical users.display_name when resolved and different. */
  aliases: readonly string[];
}

/**
 * mtime+size cache of each preference file's `ids:` frontmatter, so the id
 * tier costs one lstat per file per turn. Only the ids ride it: matched files'
 * content is still read fresh. A same-mtime-same-size in-place edit is an
 * accepted staleness window (the only writer rewrites whole files). Deleted
 * paths are not swept; a stale entry is never looked up again.
 */
const PREFERENCE_ID_CACHE = new Map<string, { mtimeMs: number; size: number; ids: string[] }>();

export function _resetPreferenceIdCacheForTest(): void {
  PREFERENCE_ID_CACHE.clear();
}

function readMemoryEvidence(
  root: string,
  workgroupId: string,
  notices: ContextNotice[],
  includeBootstrap: boolean,
  seenEvidenceFingerprints: ReadonlySet<string>,
  bypassDedupe: boolean,
  involvedSenders: ReadonlyArray<InvolvedSenderGroup> = [],
  /** Null = no verified namespace, so a bare `ids:` entry matches only colon-free sender ids. */
  channelType: string | null = null,
): PreTurnContext['memoryEvidence'] {
  if (!fs.existsSync(root)) throw new Error(`canonical memory tree missing: ${root}`);
  const canonicalRoot = fs.realpathSync(root);
  if (!fs.statSync(canonicalRoot).isDirectory()) throw new Error(`canonical memory tree is not a directory: ${root}`);
  const core: MemoryEvidenceExcerpt[] = [];
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
      const read = readBoundedFile(absolute, canonicalRoot);
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

  // Per-person preference lane, never lexically ranked. Tiers: (1) explicit
  // `ids:` frontmatter, (2) per-message display name, (3) canonical display
  // name. ONE FILE PER PERSON: a rename must not inject both the old and new
  // file. Name aliases are tried in order; one hitting a file another group
  // claimed falls through to the next alias. An id match is TERMINAL for its
  // group (claims the file or contributes nothing) and never falls through to
  // name matching, or a person declared under two ids picks up a stale second
  // file. Read before the ranked scan so the shared budget can't starve it.
  const preferenceExcerpts: MemoryEvidenceExcerpt[] = [];
  if (involvedSenders.length > 0) {
    const preferenceStems = listDirectMarkdownStems(root, PREFERENCES_DIR, notices);
    // Exact slug wins, else the longest prefix-compatible stem; matching every
    // prefix would add `alex.md` alongside `alex-stone.md`.
    const matchStem = (slug: string): string | undefined => {
      if (preferenceStems.includes(slug)) return slug;
      const compatible = preferenceStems
        .filter((stem) => preferenceStemMatches(stem, slug))
        .sort((a, b) => b.length - a.length || compareCodepoint(a, b));
      return compatible[0];
    };
    // Each file is read AT MOST ONCE per turn, which also keeps a read failure
    // from silently succeeding on a second attempt and hiding its notice.
    const preferenceFileReads = new Map<string, { content: string } | { error: unknown }>();
    const readPreferenceFile = (relative: string): { content: string } | { error: unknown } => {
      const cached = preferenceFileReads.get(relative);
      if (cached) return cached;
      let result: { content: string } | { error: unknown };
      try {
        result = { content: readBoundedFile(path.join(root, relative), canonicalRoot).content };
      } catch (error) {
        result = { error };
      }
      preferenceFileReads.set(relative, result);
      return result;
    };
    // At most one notice per file per turn (both loops may reach a file).
    const reportedReadFailures = new Set<string>();
    const reportReadFailure = (relative: string, error: unknown): void => {
      if (reportedReadFailures.has(relative)) return;
      reportedReadFailures.add(relative);
      notices.push({
        source: 'markdown',
        status: 'degraded',
        code: 'preference-read-failed',
        detail: `${relative}: ${error instanceof Error ? error.message : String(error)}`,
      });
    };
    // Explicit-id tier over every file (so read failures are reported even for
    // unmatched files). A bare entry matches a sender id with the current
    // conversation's verified prefix stripped; a colon entry must equal the full
    // id. `lstatSync` mirrors readBoundedFile's O_NOFOLLOW: a symlink-swapped
    // leaf never satisfies a cache hit.
    const frontmatterIds = (relative: string): string[] | undefined => {
      const absolute = path.join(root, relative);
      let stat: fs.Stats | undefined;
      try {
        stat = fs.lstatSync(absolute);
      } catch {
        stat = undefined;
      }
      if (stat?.isFile()) {
        const cached = PREFERENCE_ID_CACHE.get(absolute);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.ids;
      } else {
        // Gone or no longer a plain file: never trust the stale entry.
        PREFERENCE_ID_CACHE.delete(absolute);
      }
      const read = readPreferenceFile(relative);
      if (!('content' in read)) {
        // Never cached on failure.
        reportReadFailure(relative, read.error);
        return undefined;
      }
      const ids = parsePreferenceFrontmatter(read.content).ids;
      if (stat?.isFile()) PREFERENCE_ID_CACHE.set(absolute, { mtimeMs: stat.mtimeMs, size: stat.size, ids });
      return ids;
    };
    // An id declared by more than one file is ambiguous: blacklist it for id
    // matching (both files lose it, with a notice); those senders fall back to
    // name matching.
    const exactDeclarations = new Map<string, Set<string>>();
    const rawDeclarations = new Map<string, Set<string>>();
    for (const stem of preferenceStems) {
      const relative = `${PREFERENCES_DIR}${stem}.md`;
      const ids = frontmatterIds(relative);
      if (ids === undefined) continue;
      for (const id of ids) {
        const declarations = id.includes(':') ? exactDeclarations : rawDeclarations;
        const files = declarations.get(id);
        if (files) files.add(relative);
        else declarations.set(id, new Set([relative]));
      }
    }
    const exactIdToRelative = new Map<string, string>();
    const rawIdToRelative = new Map<string, string>();
    const claimUnconflicted = (declarations: Map<string, Set<string>>, target: Map<string, string>): void => {
      for (const [id, files] of declarations) {
        if (files.size > 1) {
          notices.push({
            source: 'markdown',
            status: 'degraded',
            code: 'preference-id-conflict',
            detail: `id "${id}" declared by multiple preference files (${[...files].join(', ')}); ignored for id matching`,
          });
          continue;
        }
        target.set(id, [...files][0]!);
      }
    };
    claimUnconflicted(exactDeclarations, exactIdToRelative);
    claimUnconflicted(rawDeclarations, rawIdToRelative);
    const selectedRelatives = new Set<string>();
    const matched: string[] = [];
    for (const group of involvedSenders) {
      if (matched.length >= PRE_TURN_BOUNDS.preferenceExcerpts) break;

      // Exact namespaced id first, then the raw tier ONLY when the id was
      // colon-free or its verified prefix was actually stripped: a colon-bearing
      // id under another namespace must never reach the raw map.
      let idRelative: string | undefined;
      if (group.senderId !== null) {
        idRelative = exactIdToRelative.get(group.senderId);
        if (idRelative === undefined) {
          const stripped = stripVerifiedPrefix(group.senderId, channelType);
          const verifiedOrColonFree = stripped !== group.senderId || !group.senderId.includes(':');
          if (verifiedOrColonFree) {
            idRelative = rawIdToRelative.get(stripped);
          }
        }
      }
      if (idRelative !== undefined) {
        // Terminal either way: never fall through to name matching.
        if (!selectedRelatives.has(idRelative)) {
          selectedRelatives.add(idRelative);
          matched.push(idRelative);
        }
        continue;
      }

      for (const alias of group.aliases) {
        const slug = preferenceSlug(alias);
        if (slug.length === 0) continue;
        const stem = matchStem(slug);
        if (stem === undefined) continue;
        const relative = `${PREFERENCES_DIR}${stem}.md`;
        // Another group's claimed file belongs to that person: try the next alias.
        if (selectedRelatives.has(relative)) continue;
        selectedRelatives.add(relative);
        matched.push(relative);
        break; // one file per group: stop at the first alias that claimed a file
      }
    }
    for (const relative of matched.slice(0, PRE_TURN_BOUNDS.preferenceExcerpts)) {
      const read = readPreferenceFile(relative);
      if ('error' in read) {
        // Normally already reported by the id-index loop (deduped).
        reportReadFailure(relative, read.error);
        continue;
      }
      const { body } = parsePreferenceFrontmatter(read.content);
      const text = boundedText(body, PRE_TURN_BOUNDS.preferenceExcerptChars, TRUNCATED_MARKDOWN_EXCERPT);
      preferenceExcerpts.push({
        path: relative,
        headings: headingsOf(body),
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

  const dedupedPreferences = bypassDedupe
    ? preferenceExcerpts
    : preferenceExcerpts.filter((row) => !seenEvidenceFingerprints.has(row.fingerprint));
  const suppressed = preferenceExcerpts.length - dedupedPreferences.length;
  if (suppressed > 0) {
    notices.push({
      source: 'context',
      status: 'ok',
      code: 'evidence-already-delivered',
      detail: `suppressed ${suppressed} unchanged Markdown passage${suppressed === 1 ? '' : 's'} in this context epoch`,
    });
  }
  // Most relevant first: the budget pops from the end, and preferences
  // (MAX_SAFE_INTEGER scores) sort first so they are never dropped.
  const excerpts = [...dedupedPreferences].sort((a, b) => b.score - a.score);
  // Keep the memory lane inside its total so it can't reach enforceFinalBound
  // large enough to evict the archive lane.
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

type CapabilityService = CapabilityRosterEntry;

/**
 * Evicts the LAST entry not marked `retainUnderBudget`, else the last entry.
 * Without the mark, whichever service is authored late (Slack) is the one an
 * agent silently loses.
 */
function evictCapability(services: CapabilityService[]): string | undefined {
  for (let index = services.length - 1; index >= 0; index--) {
    if (!services[index]!.retainUnderBudget) return services.splice(index, 1)[0]!.name;
  }
  return services.pop()?.name;
}

/**
 * The first `limit` entries in authoring order, except that retained entries
 * past the limit displace the latest non-retained ones instead of being cut.
 */
function selectCapabilities(services: CapabilityService[], limit: number): CapabilityService[] {
  const selected = [...services];
  while (selected.length > limit) evictCapability(selected);
  return selected;
}

/**
 * Every wired service, one line each; the full notes stay in
 * `/workspace/capabilities.json` behind `get_capabilities({ service })`.
 */
export function boundedCapabilities(snapshot: SessionServicesSnapshot, notices: ContextNotice[]): CapabilityRoster {
  const roster = buildCapabilityRoster(snapshot);
  const selected = selectCapabilities(roster.services, PRE_TURN_BOUNDS.capabilityServices).map((service) => ({
    ...service,
    name: boundedText(service.name, PRE_TURN_BOUNDS.capabilityDetailChars, TRUNCATED_CAPABILITY_DETAIL),
    via: boundedText(service.via, PRE_TURN_BOUNDS.capabilityDetailChars, TRUNCATED_CAPABILITY_DETAIL),
    use:
      service.use === undefined
        ? undefined
        : boundedText(service.use, PRE_TURN_BOUNDS.capabilityRosterUseChars, TRUNCATED_CAPABILITY_DETAIL),
    // An ISO timestamp from the host, not free text, so it passes unbounded.
    // Dropped here, it would never reach agents.
    expiresAt: service.expiresAt,
  }));
  if (selected.length < snapshot.services.length) {
    notices.push({
      source: 'capabilities',
      status: 'truncated',
      code: 'capability-service-limit',
      detail: `selected ${selected.length} of ${snapshot.services.length} services`,
    });
  }
  // Drop whole services from the end rather than clipping one: the operative
  // sentence of an entry is written last and `boundedText` clips from the end.
  // Keeps capabilities from evicting recall in enforceFinalBound.
  const droppedForBudget: string[] = [];
  while (selected.length > 0 && JSON.stringify(selected).length > PRE_TURN_BOUNDS.capabilityTotalChars) {
    droppedForBudget.push(evictCapability(selected)!);
  }
  if (droppedForBudget.length > 0) {
    notices.push({
      source: 'capabilities',
      status: 'truncated',
      code: 'capability-total-budget',
      detail: `dropped ${droppedForBudget.length} service(s) over ${PRE_TURN_BOUNDS.capabilityTotalChars} chars: ${droppedForBudget.join(', ')}`,
    });
  }
  return { agentGroupId: roster.agentGroupId, howToUse: roster.howToUse, services: selected };
}

/** A safety net that rarely fires on natural content; exported to test the shed order directly. */
export function enforceFinalBound(context: PreTurnContext): void {
  let truncated = false;
  const serializedLength = (): number => JSON.stringify(context).length;
  // A row with trustedCapabilities is a bootstrap row; exact-link has its own
  // bound. Max wins.
  const limit = Math.max(
    context.conversationEvidence.excerpts.some((row) => row.rank === 'exact-link')
      ? PRE_TURN_BOUNDS.exactLinkFinalChars
      : PRE_TURN_BOUNDS.finalChars,
    context.trustedCapabilities !== undefined ? PRE_TURN_BOUNDS.bootstrapFinalChars : 0,
  );
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
    evictCapability(context.trustedCapabilities!.services);
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
  const startedAt = Date.now();
  // Snapshot the process-wide counters so the log line reports THIS build.
  const tokenStatsBefore = { ...TOKEN_STREAM_CACHE_STATS };
  const offsetStatsBefore = { ...OFFSET_SLICE_STATS };
  // Lease-only: this runs inside the caller's `withCentralSync` block.
  const scope = withRawDb(
    (db) =>
      db
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
        | undefined,
  );
  if (!scope || scope.agent_group_id !== input.agentGroupId) {
    throw new Error(`Unable to resolve trusted session scope for ${input.agentGroupId}/${input.sessionId}`);
  }
  const currentMessagingGroupId =
    input.messagingGroupId === undefined ? scope.messaging_group_id : input.messagingGroupId;
  const currentThreadId = input.threadId === undefined ? scope.thread_id : input.threadId;
  // Looked up ONCE and reused by trigger namespacing and prefix stripping.
  const { channelType, workgroupId, memberAgentGroupIds } = withRawDb((db) => {
    const channelType = lookupChannelType(db, currentMessagingGroupId);
    const fallbackGroup = db.prepare(`SELECT folder FROM agent_groups WHERE id = ?`).get(input.agentGroupId) as
      | { folder: string }
      | undefined;
    const workgroupId = scope.workgroup_id ?? fallbackGroup?.folder;
    if (!workgroupId) {
      throw new Error(`Unable to resolve trusted workgroup for ${input.agentGroupId}/${input.sessionId}`);
    }
    const memberAgentGroupIds = scope.workgroup_id
      ? (
          db.prepare(`SELECT id FROM agent_groups WHERE workgroup_id = ? ORDER BY id`).all(workgroupId) as Array<{
            id: string;
          }>
        ).map((row) => row.id)
      : [input.agentGroupId];
    return { channelType, workgroupId, memberAgentGroupIds };
  });
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
  let trustedCapabilities: CapabilityRoster | undefined;
  if (includeBootstrap) {
    try {
      trustedCapabilities = boundedCapabilities(
        buildSessionServicesSnapshotFrom(input.agentGroupId, input.servicesCentral, currentMessagingGroupId),
        notices,
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      trustedCapabilities = { agentGroupId: input.agentGroupId, howToUse: CAPABILITY_ROSTER_PREAMBLE, services: [] };
      notices.push({
        source: 'capabilities',
        status: 'degraded',
        code: 'capability-detail-read-failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Involved senders for the preference lane, one group per person (archive
  // sender_id plus name aliases). The trigger sender is normally already the
  // newest row; a fallback group is prepended only for kinds not archived yet.
  // Suppression of that fallback is by sender id (exact, or equal after
  // stripping the verified prefix), never by a shared display name or an
  // unverified colon suffix; the name check applies only when the trigger has
  // no sender id.
  const involvedSenders: InvolvedSenderGroup[] = [];
  try {
    for (const sender of recentConversationSenders({
      memberAgentGroupIds,
      messagingGroupId: currentMessagingGroupId,
      threadId: currentThreadId,
    })) {
      // Raw, not async `getUser`: this builder runs inside a synchronous lease block.
      const canonicalName = sender.senderId
        ? withRawDb(
            (db) =>
              (db.prepare(USER_BY_ID_SQL).get(sender.senderId) as { display_name?: string | null } | undefined)
                ?.display_name,
          )
        : undefined;
      const aliases =
        canonicalName && canonicalName !== sender.senderName ? [sender.senderName, canonicalName] : [sender.senderName];
      involvedSenders.push({ senderId: sender.senderId, aliases });
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
  const triggerSender = extractSenderName(input.normalizedContent);
  if (triggerSender) {
    const triggerSenderId = namespaceTriggerSenderId(extractSenderId(input.normalizedContent), channelType);
    const alreadyRepresented =
      triggerSenderId !== null
        ? involvedSenders.some(
            (group) =>
              group.senderId !== null &&
              stripVerifiedPrefix(group.senderId, channelType) === stripVerifiedPrefix(triggerSenderId, channelType),
          )
        : involvedSenders.some((group) => group.aliases.includes(triggerSender));
    if (!alreadyRepresented) {
      involvedSenders.unshift({ senderId: triggerSenderId, aliases: [triggerSender] });
    }
  }

  let memoryEvidence: PreTurnContext['memoryEvidence'];
  try {
    memoryEvidence = readMemoryEvidence(
      workgroupMemoryDir(workgroupId),
      workgroupId,
      notices,
      includeBootstrap,
      seenEvidenceFingerprints,
      bypassDedupe,
      involvedSenders,
      channelType,
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

  const context: PreTurnContext = {
    ...(input.provider === undefined ? {} : { provider: input.provider.toLocaleLowerCase('en-US') }),
    ...(input.contextEpoch === undefined ? {} : { contextEpoch: input.contextEpoch }),
    ...(trustedCapabilities === undefined ? {} : { trustedCapabilities }),
    memoryEvidence,
    conversationEvidence: { excerpts: conversationRows },
    notices,
  };
  enforceFinalBound(context);
  // Debug level: fires on every admissible trigger. Counts only, no memory
  // or conversation text.
  log.debug('pre-turn-context: build', {
    workgroupId,
    elapsedMs: Date.now() - startedAt,
    tokenCacheSize: TOKEN_STREAM_CACHE.size,
    tokenCacheMax: TOKEN_STREAM_CACHE_MAX,
    tokenCacheHits: TOKEN_STREAM_CACHE_STATS.hits - tokenStatsBefore.hits,
    tokenCacheMisses: TOKEN_STREAM_CACHE_STATS.misses - tokenStatsBefore.misses,
    fastPathHits: OFFSET_SLICE_STATS.hits - offsetStatsBefore.hits,
    fastPathCandidates: OFFSET_SLICE_STATS.total - offsetStatsBefore.total,
  });
  return context;
}
