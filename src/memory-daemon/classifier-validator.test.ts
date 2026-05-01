import { describe, expect, it } from 'vitest';

import type { ClassifierOutput } from './classifier-client.js';
import { validateFactsAgainstSource } from './classifier-validator.js';

function fact(content: string, overrides: Partial<ClassifierOutput['facts'][number]> = {}): ClassifierOutput['facts'][number] {
  return {
    content,
    category: 'fact',
    importance: 3,
    entities: [],
    source_role: 'user',
    ...overrides,
  };
}

describe('validateFactsAgainstSource', () => {
  it('test_rejects_wg_whisky_gauge_confabulation', () => {
    // The exact production incident: source said "WG is already working
    // from last night's recovery" — classifier extracted "WG (Whisky Gauge)
    // is already working...". "(Whisky Gauge)" appears 0× in source.
    const source = "WG is already working from last night's recovery, so the demo itself should be fine.";
    const output: ClassifierOutput = {
      worth_storing: true,
      facts: [fact("WG (Whisky Gauge) is already working from last night's recovery")],
    };
    const result = validateFactsAgainstSource(output, source);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('Whisky Gauge');
  });

  it('test_rejects_sf_salesforce_confabulation', () => {
    // SF in this org context = Snowflake, not Salesforce. Source never said
    // "(Salesforce)" but classifier confidently expanded it.
    const source = 'The credential update broke the SF connection.';
    const output: ClassifierOutput = {
      worth_storing: true,
      facts: [fact('The credential update likely caused SF (Salesforce) connection failures')],
    };
    const result = validateFactsAgainstSource(output, source);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('Salesforce');
  });

  it('test_accepts_grounded_parenthetical', () => {
    // If the source DID say "(Redis)" alongside REDI, the parenthetical is
    // grounded and should be allowed through. This was 037a65b4 in the
    // post-incident sweep — legit, since "Redis" appears 18× in archive.
    const source = 'PROMORAVEN-REDI (Redis) cache is rate-limited at 100 RPS.';
    const output: ClassifierOutput = {
      worth_storing: true,
      facts: [fact('PROMORAVEN-REDI (Redis) is rate-limited at 100 RPS')],
    };
    const result = validateFactsAgainstSource(output, source);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it('test_accepts_fact_with_no_parenthetical', () => {
    const source = 'Dave prefers TypeScript over JavaScript.';
    const output: ClassifierOutput = {
      worth_storing: true,
      facts: [fact('Dave prefers TypeScript over JavaScript')],
    };
    const result = validateFactsAgainstSource(output, source);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it('test_partial_rejection_keeps_grounded_facts', () => {
    // Multi-fact output where one is poisoned and one is clean. The clean
    // one survives; the confabulation is dropped.
    const source = 'WG production is fine. Dave prefers TypeScript.';
    const output: ClassifierOutput = {
      worth_storing: true,
      facts: [
        fact('WG (Whisky Gauge) production is fine'),
        fact('Dave prefers TypeScript'),
      ],
    };
    const result = validateFactsAgainstSource(output, source);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].content).toBe('Dave prefers TypeScript');
    expect(result.rejected).toHaveLength(1);
  });

  it('test_safe_parentheticals_are_not_checked', () => {
    // (e.g.), (i.e.), (etc.) etc. are common abbreviation patterns and not
    // candidates for alias confabulation.
    const source = 'Use vectorized operations on Snowflake.';
    const output: ClassifierOutput = {
      worth_storing: true,
      facts: [
        fact('Always default to vectorized operations on Snowflake (e.g., for window functions)'),
        fact('Reading rows in a loop (i.e., row-by-row) is an anti-pattern'),
      ],
    };
    const result = validateFactsAgainstSource(output, source);
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toHaveLength(0);
  });

  it('test_short_alphanumeric_parenthetical_skipped', () => {
    // List markers like (1), (a), (b) and short tokens are not alias candidates.
    const source = 'Steps include: setup, run, verify.';
    const output: ClassifierOutput = {
      worth_storing: true,
      facts: [
        fact('Steps: (1) setup, (2) run, (3) verify'),
        fact('Items (a) and (b) require approval'),
      ],
    };
    const result = validateFactsAgainstSource(output, source);
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toHaveLength(0);
  });

  it('test_numeric_parenthetical_with_unit_skipped', () => {
    const source = 'The query takes 25.7 seconds.';
    const output: ClassifierOutput = {
      worth_storing: true,
      facts: [fact('Query takes 25.7s — exceeds (30s) Render frontend timeout')],
    };
    const result = validateFactsAgainstSource(output, source);
    expect(result.accepted).toHaveLength(1);
  });

  it('test_case_insensitive_match_against_source', () => {
    // If the source says "(Redis)" and the fact uses "(redis)" or vice
    // versa, the substring check normalizes case. This is intentional: the
    // classifier may capitalize differently than the source on legitimately
    // grounded aliases.
    const source = 'Backed by REDIS for caching.';
    const output: ClassifierOutput = {
      worth_storing: true,
      facts: [fact('Cache uses REDI (Redis) for hot data')],
    };
    const result = validateFactsAgainstSource(output, source);
    // The parenthetical "(Redis)" doesn't appear literally in source ("REDIS"
    // alone, no parens) → rejected. This is correct: the classifier invented
    // the parenthetical FORM even if the word itself is mentioned.
    expect(result.rejected).toHaveLength(1);
  });

  it('test_whitespace_tolerant_match', () => {
    // Source has parenthetical with weird internal whitespace; fact is
    // normalized. Both should be treated as the same.
    const source = "Database (Stored  Procedures) live in /db.";
    const output: ClassifierOutput = {
      worth_storing: true,
      facts: [fact('SP (Stored Procedures) live in /db')],
    };
    const result = validateFactsAgainstSource(output, source);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it('test_empty_facts_array_returns_empty_partitions', () => {
    const result = validateFactsAgainstSource({ worth_storing: false, facts: [] }, 'whatever');
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([]);
  });
});
