import { describe, expect, it } from 'vitest';
import { renderMarkdown, stripMarkdown } from './markdown.js';

/**
 * Two renderings of the same agent-authored text, and they must not be
 * confused: one produces HTML for a block container, the other produces plain
 * text for a one-line excerpt.
 */

describe('renderMarkdown', () => {
  it('formats', () => {
    expect(renderMarkdown('**ship it**')).toContain('<strong>ship it</strong>');
  });

  it('keeps breaks:true — a single newline is a line break, as in Slack', () => {
    expect(renderMarkdown('one\ntwo')).toContain('<br>');
  });

  /**
   * Every caller feeds this to `dangerouslySetInnerHTML` on agent-authored text.
   * marked does NOT escape raw HTML by default (verified on 18.0.10) — these
   * are the assertions that keep the overrides in markdown.ts alive.
   */
  describe('escapes untrusted markup — the reason dangerouslySetInnerHTML is allowed', () => {
    it('renders raw HTML tags as text, block and inline alike', () => {
      const block = renderMarkdown('<img src=x onerror="alert(1)">');
      expect(block).not.toContain('<img');
      expect(block).toContain('&lt;img');

      const inline = renderMarkdown('hello <script>alert(2)</script> there');
      expect(inline).not.toContain('<script');
      expect(inline).toContain('&lt;script&gt;');
    });

    it('drops a link whose scheme is not on the allow-list, keeping the text', () => {
      const js = renderMarkdown('[click me](javascript:alert(1))');
      expect(js).not.toContain('href');
      expect(js).toContain('click me');
      expect(renderMarkdown('[x](data:text/html,<script>1</script>)')).not.toContain('href');
    });

    it('still renders the links that are actually links', () => {
      expect(renderMarkdown('[PR 733](https://example.test/pr/733)')).toContain('href="https://example.test/pr/733"');
      expect(renderMarkdown('[mail](mailto:someone@example.test)')).toContain('href="mailto:someone@example.test"');
      // Autolinks go through the same renderer.
      expect(renderMarkdown('<https://example.test/x>')).toContain('href="https://example.test/x"');
    });

    it('leaves every other GFM construct working', () => {
      expect(renderMarkdown('```sh\nx < y\n```')).toContain('<pre><code');
      expect(renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |')).toContain('<table>');
      expect(renderMarkdown('- one\n- two')).toContain('<li>');
      expect(renderMarkdown('~~gone~~')).toContain('<del>');
    });
  });
});

describe('stripMarkdown — one line of plain text, for previews only', () => {
  it.each([
    ['**ship it**', 'ship it'],
    ['__ship it__', 'ship it'],
    ['*ship it*', 'ship it'],
    ['_ship it_', 'ship it'],
    ['***ship it***', 'ship it'],
    ['~~dropped~~ ship it', 'dropped ship it'],
    ['`npm run build` failed', 'npm run build failed'],
    ['```sh\nnpm run build\n```', 'npm run build'],
    ['# Heading\nbody', 'Heading body'],
    ['- one\n- two', 'one two'],
    ['1. one\n2. two', 'one two'],
    ['> quoted', 'quoted'],
    ['see [the PR](https://example.test/pr/1)', 'see the PR'],
    ['![a chart](https://example.test/c.png) here', 'a chart here'],
    ['<https://example.test/x>', 'https://example.test/x'],
    ['a\n\n\nb', 'a b'],
  ])('%s → %s', (src, want) => {
    expect(stripMarkdown(src)).toBe(want);
  });

  it('leaves prose that merely looks like markup alone', () => {
    // snake_case identifiers and a lone asterisk in arithmetic are NOT emphasis.
    expect(stripMarkdown('run_the_thing with 2 * 3')).toBe('run_the_thing with 2 * 3');
  });

  it('returns a single line for a whole formatted message', () => {
    const src = ['## Status', '', '- **done**: the `publish` gate', '- next: [PR 733](https://x.test/733)'].join('\n');
    expect(stripMarkdown(src)).toBe('Status done: the publish gate next: PR 733');
    expect(stripMarkdown(src)).not.toMatch(/\n/);
  });

  /**
   * The stripper is NOT a sanitiser and this test says so out loud: raw HTML in
   * the source comes out verbatim, because the output is rendered as a text
   * node and there is nothing to sanitise. If anyone ever routes this into
   * `dangerouslySetInnerHTML`, this is the assertion that documents why not.
   */
  it('passes raw HTML through untouched — it flattens markdown, it does not sanitise', () => {
    expect(stripMarkdown('**a** `b` [c](http://d.test) <b>e</b>')).toBe('a b c <b>e</b>');
  });
});
