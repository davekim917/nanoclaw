import { describe, it, expect } from 'vitest';

import { parseTrailer } from './state.js';

describe('parseTrailer', () => {
  it('strips [over] at end of message', () => {
    const { text, trailer } = parseTrailer('Hello there. [over]');
    expect(trailer).toBe('over');
    expect(text).toBe('Hello there.');
  });

  it('strips [out] at end of message', () => {
    const { text, trailer } = parseTrailer('Done with all that. [out]');
    expect(trailer).toBe('out');
    expect(text).toBe('Done with all that.');
  });

  it('is case-insensitive', () => {
    expect(parseTrailer('Done [OVER]').trailer).toBe('over');
    expect(parseTrailer('Done [Out]').trailer).toBe('out');
  });

  it('tolerates trailing whitespace and newlines after trailer', () => {
    const { text, trailer } = parseTrailer('Message body.\n[over]   \n');
    expect(trailer).toBe('over');
    expect(text).toBe('Message body.');
  });

  it('returns trailer=null when no trailer present', () => {
    const { text, trailer } = parseTrailer('Plain message with no trailer.');
    expect(trailer).toBeNull();
    expect(text).toBe('Plain message with no trailer.');
  });

  it('does not match a trailer inside a fenced code block', () => {
    const content = '```\nsome code with [over]\n```';
    const { text, trailer } = parseTrailer(content);
    expect(trailer).toBeNull();
    expect(text).toBe(content);
  });

  it('does not match a trailer mid-message', () => {
    const { trailer } = parseTrailer('I said [over] in the middle and continued.');
    expect(trailer).toBeNull();
  });

  it('handles empty content', () => {
    const { text, trailer } = parseTrailer('');
    expect(text).toBe('');
    expect(trailer).toBeNull();
  });

  it('only matches over and out, not other bracketed words', () => {
    expect(parseTrailer('Tell me more. [continue]').trailer).toBeNull();
    expect(parseTrailer('Tell me more. [done]').trailer).toBeNull();
  });
});
