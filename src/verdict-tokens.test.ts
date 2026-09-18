import { describe, expect, it } from 'vitest';

import { humanizeOutboundContent, humanizeVerdictTokens } from './verdict-tokens.js';

describe('humanizeVerdictTokens', () => {
  it('rewrites the incident sentence', () => {
    expect(humanizeVerdictTokens('**Verdict: do not ship — `NO_GO` on develop lineage `a276e08f`.**')).toBe(
      '**Verdict: do not ship — No-go on develop lineage `a276e08f`.**',
    );
  });

  it('rewrites bare and inline-backtick forms of every token', () => {
    expect(humanizeVerdictTokens('Result: NO_GO. Then `HUMAN_DECISION`, then BLOCKED_BUILD_IDENTITY')).toBe(
      'Result: No-go. Then Needs a human decision, then Blocked (build identity)',
    );
    expect(humanizeVerdictTokens('(NO_GO)')).toBe('(No-go)');
  });

  it('leaves GO and BLOCKED alone', () => {
    expect(humanizeVerdictTokens('GO / `BLOCKED`')).toBe('GO / `BLOCKED`');
  });

  it('rewrites tokens wrapped in prose or markdown punctuation', () => {
    expect(humanizeVerdictTokens('`NO_GO`.')).toBe('No-go.');
    expect(humanizeVerdictTokens('(NO_GO)')).toBe('(No-go)');
    expect(humanizeVerdictTokens('**NO_GO**, "HUMAN_DECISION"; [BLOCKED_BUILD_IDENTITY]!')).toBe(
      '**No-go**, "Needs a human decision"; [Blocked (build identity)]!',
    );
  });

  it('rewrites the parenthesised inline form with trailing punctuation', () => {
    expect(humanizeVerdictTokens('Verdict (`NO_GO`).')).toBe('Verdict (No-go).');
  });

  it('rewrites nothing in a message that carries any fence-like run', () => {
    const untouched = [
      'Verdict NO_GO\n```\nverdict=NO_GO\n```',
      '```NO_GO```',
      '~~~\n```\nNO_GO\n~~~\nafter NO_GO',
      '````md\n```\nNO_GO\n```\n````',
      'NO_GO\n```\nunterminated NO_GO',
      '- ```\n  NO_GO\n  ```',
      '> ```\n> NO_GO\n> ```',
    ];
    for (const s of untouched) expect(humanizeVerdictTokens(s)).toBe(s);
  });

  it('does not touch URLs, paths, queries or identifiers containing a token', () => {
    const untouched = [
      'task-NO_GO-x',
      'NO_GO_REASON',
      'MY_NO_GO',
      '_NO_GO',
      'NO_GO2',
      'NO_GO.md',
      'reports/NO_GO.md',
      'a/NO_GO/b',
      'C:\\NO_GO',
      '#NO_GO',
      '?NO_GO=1',
      'https://example.com/NO_GO',
      'https://example.com/#NO_GO',
      'https://example.com/?v=NO_GO',
      'lower no_go',
      '`NO_GO_REASON`',
      '`verdict NO_GO`',
      '`NO_GO`/result',
      'https://example.com/`NO_GO`',
      'reports/`NO_GO`/result',
      '`toString`',
      '`__proto__`',
      'toString __proto__ constructor',
    ];
    for (const s of untouched) expect(humanizeVerdictTokens(s)).toBe(s);
  });

  it('is idempotent', () => {
    const once = humanizeVerdictTokens('`NO_GO` HUMAN_DECISION BLOCKED_BUILD_IDENTITY');
    expect(humanizeVerdictTokens(once)).toBe(once);
  });
});

describe('humanizeOutboundContent', () => {
  it('rewrites the text field and keeps other fields', () => {
    const out = humanizeOutboundContent(JSON.stringify({ text: 'NO_GO', threadKey: 'NO_GO', files: ['a'] }));
    expect(JSON.parse(out)).toEqual({ text: 'No-go', threadKey: 'NO_GO', files: ['a'] });
  });

  it('passes unchanged, textless or unparseable content through byte-for-byte', () => {
    for (const c of ['{"text":  "fine"}', '{"operation":"reaction","emoji":"x"}', 'not json NO_GO', 'null']) {
      expect(humanizeOutboundContent(c)).toBe(c);
    }
  });
});
