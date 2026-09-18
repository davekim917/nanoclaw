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

  it('does not touch fenced code blocks', () => {
    const text = 'Verdict NO_GO\n```\nverdict=NO_GO\n`HUMAN_DECISION`\n```\nafter NO_GO\n```NO_GO```\nend NO_GO';
    expect(humanizeVerdictTokens(text)).toBe(
      'Verdict No-go\n```\nverdict=NO_GO\n`HUMAN_DECISION`\n```\nafter No-go\n```NO_GO```\nend No-go',
    );
  });

  it('closes a fence only on the same char at least as long (CommonMark)', () => {
    const tilde = '~~~\n```\nNO_GO\n~~~\nafter NO_GO';
    expect(humanizeVerdictTokens(tilde)).toBe('~~~\n```\nNO_GO\n~~~\nafter No-go');
    const four = '````md\n```\nNO_GO\n```\nNO_GO\n````\nafter NO_GO';
    expect(humanizeVerdictTokens(four)).toBe('````md\n```\nNO_GO\n```\nNO_GO\n````\nafter No-go');
    const crlf = '```\r\nNO_GO\r\n```\r\nNO_GO';
    expect(humanizeVerdictTokens(crlf)).toBe('```\r\nNO_GO\r\n```\r\nNo-go');
  });

  it('leaves everything after an unterminated fence untouched', () => {
    const text = 'NO_GO\n```\nNO_GO\nstill code NO_GO';
    expect(humanizeVerdictTokens(text)).toBe('No-go\n```\nNO_GO\nstill code NO_GO');
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
      '``NO_GO``',
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
