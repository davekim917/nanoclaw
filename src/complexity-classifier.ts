/**
 * Complexity Classifier for Dynamic Model Selection
 *
 *   Tier 1 — TRIVIAL downgrade signals:
 *     • pure emoji
 *     • single trivial word, optionally with trailing punctuation/emoji
 *     • short message where every word is in TRIVIAL_VOCAB
 *
 *   Tier 2 — WORK upgrade signals:
 *     • work keyword (fix/build/deploy/remind/ping/...)
 *     • code fence / URL / length > 80 / multi-line
 *
 *   Default (neither tier fires) — WORK. Safer to answer ambiguous
 *   chit-chat on the default model than to misroute a work request
 *   to Haiku (a bad response is visible; an over-provisioned correct
 *   response is not).
 */

import { logger } from './logger.js';

export type ComplexityTier = 'TRIVIAL' | 'WORK';

export interface ComplexityResult {
  complexity: ComplexityTier;
  reason: 'regex' | 'phrase' | 'keyword' | 'default';
}

// ---------- Tier 1: trivial patterns ----------

// Pure emoji + whitespace. `\p{Extended_Pictographic}` excludes ASCII
// digits/#/* (which `\p{Emoji}` would otherwise match as keycap bases) so
// numeric replies like "1500" don't get classified as TRIVIAL.
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\s]+$/u;

// Single trivial word (bare)
const TRIVIAL_WORDS =
  /^(lol|lmao|lmfao|lul|lulz|kek|haha|hahaha|ahaha|hehe|heh|hahahaha|nice|sweet|cool|neat|dope|sick|lit|fire|rad|awesome|amazing|excellent|perfect|thanks|thx|ty|thankyou|ok|okay|k|kk|okie|okey|yep|yup|yeah|yea|mhm|mmhmm|nope|nah|naw|nada|sure|gotcha|bet|word|fr|gg|rip|wp|ez|wow|omg|dayum|dam|damn|dang|bruh|shit|fuck|hell|wtf|jeez|geez|gosh|dammit|fml|yo|hey|hi|hello|sup|gm|gn|howdy|np|yw|wb|smh|ikr|tbh|idk|nvm|istg|true|facts|same|mood|based|valid|real|tru|legit|lfg|aight|ight|fasho|fosho|fs|fax|cap|sheesh|bussin|goat|goated|w|l|huh|hmm|hm|hmmm|wat|wut|eh|meh|welp|oof|yikes|whoa|woah|um|umm|uh|uhh|agreed|exactly|totally|absolutely|definitely|indeed|done|easy|simple|great|respect|props|noted|understood|acknowledged|interesting|curious|fascinating|weird|strange|crazy|wild|insane|nuts|bro|dude|mate|fam|homie|bruv|bye|later|peace|cya|gtg|ttyl)$/i;

// Single trivial word + trailing punctuation/emoji ("nice!", "lol 😂", "thanks!!").
// Uses `\p{Extended_Pictographic}` (not `\p{Emoji}`) in the trailing class so
// ASCII digits after the trivial word don't accidentally qualify.
const TRIVIAL_WITH_SUFFIX =
  /^(lol|lmao|lmfao|lul|kek|haha|hahaha|hehe|heh|nice|sweet|cool|neat|dope|sick|lit|fire|awesome|amazing|perfect|thanks|thx|ty|ok|okay|yeah|yea|yep|yup|nope|nah|sure|gotcha|bet|wow|omg|damn|dang|bruh|shit|fuck|hell|wtf|jeez|gosh|yo|gg|rip|wild|lfg|sheesh|goated|huh|hmm|welp|oof|yikes|whoa|agreed|exactly|totally|done|great|noted|interesting|weird|crazy|insane|bro|dude|mate|bye|later|peace)[!?.…,;\s\p{Extended_Pictographic}]*$/iu;

// Fixed idiomatic phrases where a constituent word (e.g. "do") is too
// imperative-heavy to safely put in TRIVIAL_VOCAB on its own.
const TRIVIAL_IDIOMS =
  /^(will do|can do|could do|you bet|big w|big l|no cap|hell yeah|hell yea|fuck yeah|fuck yea|damn straight|damn right)[!?.…\s\p{Extended_Pictographic}]*$/iu;

/**
 * Vocabulary of words that may appear in short multi-word casual messages.
 *
 * Rules for inclusion:
 *   • A word is here only if it's reasonable to see in chit-chat AND it is
 *     NOT a work/imperative keyword that belongs in the tier 2 blocklist.
 *   • Helpers (pronouns, copulas, conjunctions) are included because casual
 *     responses like "i see" / "it's fine" need them to match.
 *
 * Coverage check: a message only triggers TRIVIAL via this set if EVERY
 * word is present AND the message is short (≤40 chars, ≤6 words). A single
 * unknown word fails the check — so "fix the bug" fails on "fix", "any
 * thoughts" fails on "thoughts", etc.
 */
const TRIVIAL_VOCAB = new Set<string>([
  // Laughter
  'lol',
  'lmao',
  'lmfao',
  'lul',
  'kek',
  'haha',
  'hahaha',
  'ahaha',
  'hehe',
  'heh',
  // Affirmation (casual)
  'yeah',
  'yea',
  'yep',
  'yup',
  'mhm',
  'mmhmm',
  'uhhuh',
  'mm',
  // Negation (casual)
  'nope',
  'nah',
  'naw',
  // Acknowledgment
  'ok',
  'okay',
  'k',
  'kk',
  'sure',
  'gotcha',
  'bet',
  'word',
  'noted',
  'copy',
  // Positive reactions
  'nice',
  'cool',
  'sweet',
  'neat',
  'dope',
  'sick',
  'lit',
  'fire',
  'rad',
  'awesome',
  'amazing',
  'excellent',
  'perfect',
  'beautiful',
  // Thanks
  'thanks',
  'thx',
  'ty',
  'thank',
  // Exclamations
  'wow',
  'omg',
  'damn',
  'dang',
  'dayum',
  'bruh',
  'shit',
  'fuck',
  'hell',
  'wtf',
  'jeez',
  'geez',
  'gosh',
  'yikes',
  'oof',
  'whoa',
  'woah',
  'dammit',
  // Greetings
  'hi',
  'hey',
  'hello',
  'yo',
  'sup',
  'gm',
  'gn',
  'howdy',
  // Internet slang
  'smh',
  'ikr',
  'tbh',
  'idk',
  'nvm',
  'lfg',
  'gg',
  'rip',
  'wp',
  'ez',
  'fr',
  'fs',
  'fosho',
  'fasho',
  'cap',
  'sheesh',
  'bussin',
  'goat',
  'goated',
  'slay',
  'based',
  'valid',
  'tru',
  'legit',
  'mood',
  'facts',
  'same',
  'np',
  'yw',
  // Thinking/hesitation
  'hmm',
  'hmmm',
  'hm',
  'huh',
  'wat',
  'wut',
  'eh',
  'meh',
  'welp',
  'um',
  'umm',
  'uh',
  'uhh',
  'er',
  // Agreement adverbs
  'agreed',
  'exactly',
  'totally',
  'absolutely',
  'definitely',
  'indeed',
  'precisely',
  // Reactions / interjections
  'oh',
  'ah',
  'aw',
  'aww',
  'ooh',
  'aah',
  'ugh',
  'ahh',
  'ohh',
  // Feeling reactions
  'interesting',
  'curious',
  'fascinating',
  'weird',
  'strange',
  'crazy',
  'wild',
  'insane',
  'nuts',
  'mental',
  'bonkers',
  // Completion / reaction words
  'done',
  'finished',
  'easy',
  'simple',
  'great',
  // Apology
  'sorry',
  'apologies',
  // Terms of address
  'bro',
  'dude',
  'man',
  'mate',
  'fam',
  'homie',
  'sis',
  'bruv',
  'lad',
  'guys',
  'folks',
  // Farewells
  'bye',
  'later',
  'peace',
  'cya',
  'gtg',
  'ttyl',
  'adios',

  // ---- Helper words (for multi-word casual phrases) ----
  // Pronouns & contractions
  'i',
  "i'm",
  'im',
  "i've",
  "i'll",
  "i'd",
  "i'mma",
  'you',
  "you're",
  "you've",
  "you'll",
  "you'd",
  'u',
  'ur',
  'me',
  'my',
  'mine',
  'we',
  'us',
  'our',
  'it',
  "it's",
  'its',
  'this',
  'that',
  "that's",
  'thats',
  'them',
  "they're",
  'your',
  'yours',
  // Copula / aux
  'is',
  'am',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  "isn't",
  "aren't",
  "wasn't",
  "weren't",
  // Casual-phrase verbs (NOT general imperatives — excluded: fix, build, make, do, run, show, find, help)
  'got',
  'will',
  'can',
  'could',
  'would',
  'should',
  "can't",
  "won't",
  "couldn't",
  'makes', // "makes sense" — 'make' is ambiguous, not included
  'sounds',
  'looks',
  'seems',
  'feels', // "sounds good", "looks fine"
  'works',
  'worked', // "works for me"
  'see',
  'hear',
  'feel',
  'know',
  'think',
  'mean', // "i see", "i hear you", "you know"
  'get',
  'gets', // "you get it"
  // Prepositions & conjunctions
  'for',
  'to',
  'of',
  'in',
  'on',
  'at',
  'with',
  'by',
  'from',
  'as',
  'like',
  'about',
  'and',
  'or',
  'but',
  'so',
  'if',
  'then',
  // Reaction adjectives/adverbs
  'right',
  'wrong',
  'correct',
  'true',
  'false',
  'fine',
  'good',
  'bad',
  'best',
  'ok',
  'fair',
  'real',
  'hard',
  'soft',
  'tough',
  'rough',
  'smooth',
  'clean',
  'really',
  'quite',
  'very',
  'pretty',
  'just',
  'only',
  'even',
  'still',
  'kinda',
  'sorta',
  'maybe',
  'probably',
  // Common casual-phrase nouns. Note: 'call', 'point', 'deal', 'big' were
  // intentionally removed — they're noun-form in "good call"/"fair point"/
  // "big w" but imperative-form in "call me"/"point me to that"/"deal with
  // this"/"big problem here", causing false TRIVIAL on work requests.
  // "good call"/"fair point" etc. are still captured by TRIVIAL_IDIOMS if
  // needed.
  'one',
  'job',
  'stuff',
  'thing',
  'problem',
  'prob',
  'worries',
  'biggie',
  'stress',
  'sense',
  'enough',
  'here',
  'there',
  'now',
  'too',
  'also',
  'all',
  'any',
  'some',
  'both',
  // Negation
  'no',
  "don't",
  "doesn't",
  "didn't",
  'not',
  // Fillers
  'well',
  'anyway',
  'anyways',
]);

// Tokenize a short message for vocab check: lowercase, strip punctuation
// and emoji, keep apostrophes for contractions. Uses `\p{Extended_Pictographic}`
// not `\p{Emoji}` so ASCII digits are NOT silently stripped (otherwise
// "its 9000" would tokenize to ["its"] and classify as TRIVIAL).
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/[.,!?…;:"`~*()[\]{}/\\|<>+=]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function isCasualMessage(text: string): boolean {
  if (text.length > 40) return false;
  const words = tokenize(text);
  if (words.length === 0 || words.length > 6) return false;
  return words.every((w) => TRIVIAL_VOCAB.has(w));
}

// ---------- Tier 2: work patterns ----------

const WORK_KEYWORDS =
  /\b(fix|bug|build|check|deploy|update|create|delete|add|remove|implement|refactor|debug|test|review|merge|push|pull|commit|run|install|configure|setup|ship|query|analyze|schedule|cancel|send|draft|write|edit|search|find|show|list|explain|help|how|why|what|when|where|who|which|can you|could you|would you|please|remind|notify|ping|alert|email|slack|investigate|figure|summarize|translate|migrate|rollback|restart|reboot|kill|stop|start|pause|resume|enable|disable|render|generate|compile|lint|format|backup|restore|upload|download|post|comment|forward|reply|respond|share|set|make|fetch|grep|open|close|save|load|trigger|launch|execute|book|order)\b/i;

const CODE_FENCE = /```/;
const URL_PATTERN = /https?:\/\//;
const MAX_TRIVIAL_LENGTH = 80;

/**
 * Classify a message as trivial chit-chat or substantive work.
 * Pure synchronous: regex tests and Set lookups only, no I/O.
 *
 * @param messageText  The message content (trigger prefix already stripped)
 * @param strictMode  When true, only tier 1 runs (for explicit -m sessions)
 */
export function classifyComplexity(
  messageText: string,
  strictMode?: boolean,
): ComplexityResult {
  const trimmed = messageText.trim();

  // Tier 1: emoji / trivial word / trivial word + punctuation / fixed idioms
  if (
    EMOJI_ONLY.test(trimmed) ||
    TRIVIAL_WORDS.test(trimmed) ||
    TRIVIAL_WITH_SUFFIX.test(trimmed) ||
    TRIVIAL_IDIOMS.test(trimmed)
  ) {
    logger.debug(
      { message: trimmed.slice(0, 30) },
      'Complexity: regex TRIVIAL',
    );
    return { complexity: 'TRIVIAL', reason: 'regex' };
  }

  // Tier 1 extended: short message where every word is trivial vocab
  if (isCasualMessage(trimmed)) {
    logger.debug(
      { message: trimmed.slice(0, 30) },
      'Complexity: phrase TRIVIAL',
    );
    return { complexity: 'TRIVIAL', reason: 'phrase' };
  }

  // Strict mode (explicit -m session): only tier 1 can downgrade
  if (strictMode) {
    return { complexity: 'WORK', reason: 'default' };
  }

  // Tier 2: work signals
  if (
    trimmed.length > MAX_TRIVIAL_LENGTH ||
    WORK_KEYWORDS.test(trimmed) ||
    CODE_FENCE.test(trimmed) ||
    URL_PATTERN.test(trimmed) ||
    trimmed.includes('\n')
  ) {
    logger.debug({ message: trimmed.slice(0, 30) }, 'Complexity: tier 2 WORK');
    return { complexity: 'WORK', reason: 'keyword' };
  }

  // Default: ambiguous → WORK
  logger.debug({ message: trimmed.slice(0, 30) }, 'Complexity: default WORK');
  return { complexity: 'WORK', reason: 'default' };
}
