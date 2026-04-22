import { describe, it, expect } from 'vitest';

import { parseTextStyles, parseSignalStyles } from './text-styles.js';

describe('parseTextStyles — passthrough channels', () => {
  it('passes text through unchanged on discord', () => {
    const md = '**bold** and *italic* and [link](https://example.com)';
    expect(parseTextStyles(md, 'discord')).toBe(md);
  });

  it('passes text through unchanged on signal (signal uses parseSignalStyles)', () => {
    const md = '**bold** and *italic* and [link](https://example.com)';
    expect(parseTextStyles(md, 'signal')).toBe(md);
  });
});

describe('parseTextStyles — bold', () => {
  it('converts **bold** to *bold* on telegram', () => {
    expect(parseTextStyles('say **this** now', 'telegram')).toBe('say *this* now');
  });

  it('converts **bold** to *bold* on slack', () => {
    expect(parseTextStyles('**hello**', 'slack')).toBe('*hello*');
  });

  it('does not convert a lone * as bold', () => {
    expect(parseTextStyles('a * b * c', 'telegram')).toBe('a * b * c');
  });
});

describe('parseTextStyles — italic', () => {
  it('converts *italic* to _italic_ on telegram', () => {
    expect(parseTextStyles('*italic*', 'telegram')).toBe('_italic_');
  });

  it('bold-before-italic: **bold** *italic* → *bold* _italic_', () => {
    expect(parseTextStyles('**bold** *italic*', 'telegram')).toBe('*bold* _italic_');
  });
});

describe('parseTextStyles — headings', () => {
  it('converts # heading on telegram', () => {
    expect(parseTextStyles('# Top', 'telegram')).toBe('*Top*');
  });

  it('converts ## heading on slack', () => {
    expect(parseTextStyles('## Hello World', 'slack')).toBe('*Hello World*');
  });

  it('only converts headings at line start', () => {
    const input = 'not a ## heading in middle';
    expect(parseTextStyles(input, 'telegram')).toBe(input);
  });
});

describe('parseTextStyles — links', () => {
  it('converts [text](url) to text (url) on telegram', () => {
    expect(parseTextStyles('[Link](https://example.com)', 'telegram')).toBe('Link (https://example.com)');
  });

  it('converts [text](url) to <url|text> on slack', () => {
    expect(parseTextStyles('[Click here](https://example.com)', 'slack')).toBe('<https://example.com|Click here>');
  });
});

describe('parseTextStyles — horizontal rules', () => {
  it('strips --- on telegram', () => {
    expect(parseTextStyles('above\n---\nbelow', 'telegram')).toBe('above\n\nbelow');
  });

  it('collapses --- + surrounding blank lines on slack', () => {
    expect(parseTextStyles('above\n\n---\n\nbelow', 'slack')).toBe('above\n\nbelow');
  });
});

describe('parseTextStyles — code block protection', () => {
  it('does not transform **bold** inside fenced code block', () => {
    const input = '```\n**not bold**\n```';
    expect(parseTextStyles(input, 'telegram')).toBe(input);
  });

  it('does not transform *italic* inside inline code', () => {
    const input = 'use `*star*` literally';
    expect(parseTextStyles(input, 'telegram')).toBe(input);
  });

  it('transforms text outside code blocks but not inside', () => {
    const input = '**bold** and `*code*` and *italic*';
    expect(parseTextStyles(input, 'telegram')).toBe('*bold* and `*code*` and _italic_');
  });
});

describe('parseSignalStyles — basic styles', () => {
  it('extracts BOLD from **text**', () => {
    const { text, textStyle } = parseSignalStyles('**hello**');
    expect(text).toBe('hello');
    expect(textStyle).toEqual([{ style: 'BOLD', start: 0, length: 5 }]);
  });

  it('extracts ITALIC from *text*', () => {
    const { text, textStyle } = parseSignalStyles('*hello*');
    expect(text).toBe('hello');
    expect(textStyle).toEqual([{ style: 'ITALIC', start: 0, length: 5 }]);
  });

  it('extracts STRIKETHROUGH from ~~text~~', () => {
    const { text, textStyle } = parseSignalStyles('~~hello~~');
    expect(text).toBe('hello');
    expect(textStyle).toEqual([{ style: 'STRIKETHROUGH', start: 0, length: 5 }]);
  });

  it('extracts MONOSPACE from `inline code`', () => {
    const { text, textStyle } = parseSignalStyles('`code`');
    expect(text).toBe('code');
    expect(textStyle).toEqual([{ style: 'MONOSPACE', start: 0, length: 4 }]);
  });

  it('no styles for plain text', () => {
    const { text, textStyle } = parseSignalStyles('just plain text');
    expect(text).toBe('just plain text');
    expect(textStyle).toHaveLength(0);
  });
});

describe('parseSignalStyles — mixed + snake_case guard', () => {
  it('correctly offsets styles in mixed text', () => {
    const { text, textStyle } = parseSignalStyles('say **hi** now');
    expect(text).toBe('say hi now');
    expect(textStyle).toEqual([{ style: 'BOLD', start: 4, length: 2 }]);
  });

  it('does not italicise underscores in snake_case', () => {
    const { text, textStyle } = parseSignalStyles('use snake_case_here');
    expect(text).toBe('use snake_case_here');
    expect(textStyle).toHaveLength(0);
  });
});
