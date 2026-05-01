import { describe, expect, it } from 'vitest';

import { rewriteDiscordLinks } from './discord.js';

describe('rewriteDiscordLinks', () => {
  it('rewrites bare Google document and slide URLs to safe labeled links', () => {
    const docUrl = 'https://docs.google.com/document/d/doc-id/edit';
    const slidesUrl = 'https://docs.google.com/presentation/d/slides-id/edit';

    expect(rewriteDiscordLinks(`Doc:\n${docUrl}\n\nSlides:\n${slidesUrl}`)).toBe(
      `Doc:\n[Open Google Doc](${docUrl})\n\nSlides:\n[Open Google Slides](${slidesUrl})`,
    );
  });

  it('rewrites masked links whose visible text is also a URL', () => {
    const url = 'https://docs.google.com/document/d/doc-id/edit';

    expect(rewriteDiscordLinks(`[${url}](${url})`)).toBe(`[Open Google Doc](${url})`);
  });

  it('preserves descriptive masked links', () => {
    const input =
      '[Chase Sapphire Reserve official page](https://creditcards.chase.com/rewards-credit-cards/sapphire/reserve)';

    expect(rewriteDiscordLinks(input)).toBe(input);
  });

  it('does not rewrite URLs inside code', () => {
    const url = 'https://example.com/path';
    const input = `Run \`curl ${url}\`\n\n\`\`\`\n${url}\n\`\`\``;

    expect(rewriteDiscordLinks(input)).toBe(input);
  });
});
