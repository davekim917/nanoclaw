/**
 * Minimal classifier-output validator (Plan B, scoped to a single rule).
 *
 * Background — the full Plan B span-grounding validator (4 rules: source-quote
 * substring + entity substring + parenthetical-grounded + capitalized-name
 * grounded) was rejected as too aggressive after the WG → Whisky Gauge
 * confabulation incident. Rules 3 and 4 would also reject the established-
 * context resolution memory exists to provide ("WG → William Grant" looked up
 * from prior facts in mnemon).
 *
 * This module ships ONE rule — the surgical catch for the confabulation
 * pattern, with near-zero capability cost:
 *
 *   Reject any fact whose `content` contains a parenthetical alias `(X)`
 *   where the literal parenthetical text does not appear in the source text
 *   (chat-pair body for classifier, document text for source-ingest).
 *
 * Failure mode this catches: classifier expanding "WG" to "WG (Whisky Gauge)"
 * by reaching for plausible world knowledge — even when the source never
 * said "Whisky Gauge". Same pattern caught SF (Salesforce) and SP (Stored
 * Procedures) in the post-incident sweep.
 *
 * This is intentionally PROVIDER-AGNOSTIC: works against Anthropic Haiku
 * output, Codex GPT-5.5 output, or any future backend's output. Smarter
 * models confabulate less, but a structural defense floor keeps the bug
 * from reappearing if we fall back to a smaller model.
 */
import type { ClassifierOutput } from './classifier-client.js';

export interface ValidationResult {
  /** Facts that passed validation. */
  accepted: ClassifierOutput['facts'];
  /** Facts rejected with the rule that fired. */
  rejected: Array<{ fact: ClassifierOutput['facts'][number]; reason: string }>;
}

// Match parentheticals like (Whisky Gauge), (Stored Procedures), but NOT
// (1), (a), (e.g.), (i.e.), (etc.) — common abbreviation/example patterns
// that aren't aliases. The signal is "parenthetical containing words that
// look like a name or definition the model invented."
//
// Rule of thumb: at least one capitalized multi-character word OR a phrase
// of 3+ word characters total, excluding common abbreviations.
const PARENTHETICAL_RE = /\(([^()]{3,80})\)/g;
const SAFE_PARENTHETICAL_TOKENS = new Set([
  'e.g.',
  'i.e.',
  'etc.',
  'cf.',
  'esp.',
  'incl.',
  'excl.',
  'ca.',
  'vs.',
  'a.k.a.',
  'aka',
]);

function shouldCheck(parenContent: string): boolean {
  const trimmed = parenContent.trim().toLowerCase();
  if (SAFE_PARENTHETICAL_TOKENS.has(trimmed)) return false;
  // Common-abbrev-prefix exclusion: "(e.g., for window functions)",
  // "(i.e., row-by-row)" etc. The abbreviation and an optional comma
  // signal an example/clarification, not an invented alias.
  for (const tok of SAFE_PARENTHETICAL_TOKENS) {
    if (trimmed === tok || trimmed.startsWith(`${tok} `) || trimmed.startsWith(`${tok},`)) return false;
  }
  // Pure numeric / single-letter / very short — almost never an invented alias.
  if (/^[0-9a-z]{1,2}$/i.test(trimmed)) return false;
  // Pure number with optional decimals, percent, units — list items / measurements.
  if (/^\d+([.,]\d+)?\s*(%|s|ms|kb|mb|gb|tb)?$/i.test(trimmed)) return false;
  return true;
}

/**
 * Normalize text for substring matching: collapse whitespace, lowercase.
 * The check is "does the literal `(X)` parenthetical appear somewhere in the
 * source?" — case-insensitive matching with tolerant whitespace catches
 * harmless surface variations without weakening the structural rule.
 */
function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').toLowerCase().trim();
}

/**
 * Filter classifier output to remove facts whose content contains an invented
 * parenthetical alias not grounded in the source text. Returns the partitioned
 * accepted/rejected lists; caller decides what to do with rejections (typically:
 * log + drop, or route to dead_letters with the reason).
 */
export function validateFactsAgainstSource(output: ClassifierOutput, sourceText: string): ValidationResult {
  const normalizedSource = normalize(sourceText);
  const accepted: ClassifierOutput['facts'] = [];
  const rejected: ValidationResult['rejected'] = [];

  for (const fact of output.facts) {
    const violations: string[] = [];
    let m: RegExpExecArray | null;
    PARENTHETICAL_RE.lastIndex = 0;
    while ((m = PARENTHETICAL_RE.exec(fact.content)) !== null) {
      const inner = m[1];
      if (!shouldCheck(inner)) continue;
      // Look for the FULL parenthetical including parens in the source. This
      // is intentional — "Whisky Gauge" might appear in the source as a
      // standalone phrase, but the classifier writing "(Whisky Gauge)" as
      // an *alias* requires the source to also use that parenthetical form.
      const needle = normalize(`(${inner})`);
      if (!normalizedSource.includes(needle)) {
        violations.push(`parenthetical "(${inner})" not in source`);
      }
    }
    if (violations.length > 0) {
      rejected.push({ fact, reason: violations.join('; ') });
    } else {
      accepted.push(fact);
    }
  }

  return { accepted, rejected };
}
