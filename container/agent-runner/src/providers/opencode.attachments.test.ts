import { describe, it, expect } from 'bun:test';

import { buildAttachmentFileParts, buildPromptParts } from './opencode.js';

const allPresent = () => true;
const nonePresent = () => false;

describe('buildAttachmentFileParts', () => {
  it('test_oc_attachment_file_url_not_data_uri: emits a file:// part for a staged image', () => {
    // OpenCode resolves a file: part server-side and re-emits it as base64
    // itself; the server shares this container's filesystem, so base64-ing here
    // would only duplicate the work and inflate the request body.
    const parts = buildAttachmentFileParts(
      [{ filename: 'cat.png', mime: 'image/png', path: '/workspace/inbox/cat.png' }],
      allPresent,
    );
    expect(parts).toEqual([
      { type: 'file', mime: 'image/png', filename: 'cat.png', url: 'file:///workspace/inbox/cat.png' },
    ]);
  });

  it('test_oc_attachment_mime_from_extension: falls back to the extension when the channel gave no mime', () => {
    const parts = buildAttachmentFileParts(
      [{ filename: 'Report.PDF', path: '/workspace/inbox/Report.PDF' }],
      allPresent,
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]?.mime).toBe('application/pdf');
  });

  it('test_oc_attachment_skips_non_media: drops anything that is neither image nor pdf', () => {
    const parts = buildAttachmentFileParts(
      [
        { filename: 'notes.txt', mime: 'text/plain', path: '/workspace/inbox/notes.txt' },
        { filename: 'archive.zip', path: '/workspace/inbox/archive.zip' },
        { filename: 'clip.mp4', mime: 'video/mp4', path: '/workspace/inbox/clip.mp4' },
      ],
      allPresent,
    );
    // They are still described in the prompt text by the formatter, so nothing
    // is lost — just not handed over as media.
    expect(parts).toEqual([]);
  });

  it('test_oc_attachment_skips_unreadable: drops an attachment with no readable local file', () => {
    const linkOnly = buildAttachmentFileParts(
      [{ filename: 'cat.png', mime: 'image/png', url: 'https://x/cat.png' }],
      allPresent,
    );
    expect(linkOnly).toEqual([]);

    const missing = buildAttachmentFileParts(
      [{ filename: 'cat.png', mime: 'image/png', path: '/workspace/inbox/gone.png' }],
      nonePresent,
    );
    expect(missing).toEqual([]);
  });

  it('an absent attachment list is an empty part list, not a throw', () => {
    expect(buildAttachmentFileParts(undefined, allPresent)).toEqual([]);
    expect(buildAttachmentFileParts([], allPresent)).toEqual([]);
  });
});

describe('buildPromptParts', () => {
  it('test_oc_prompt_parts_text_first: the text part always leads, media follows', () => {
    const parts = buildPromptParts(
      'look at this',
      [{ filename: 'cat.png', mime: 'image/png', path: '/workspace/inbox/cat.png' }],
      allPresent,
    );
    expect(parts[0]).toEqual({ type: 'text', text: 'look at this' });
    expect(parts).toHaveLength(2);
    expect(parts[1]).toMatchObject({ type: 'file', mime: 'image/png' });
  });

  it('test_oc_prompt_parts_unchanged_without_media: a turn with no attachments is the old single text part', () => {
    expect(buildPromptParts('hello', undefined, allPresent)).toEqual([{ type: 'text', text: 'hello' }]);
    expect(buildPromptParts('hello', [], allPresent)).toEqual([{ type: 'text', text: 'hello' }]);
  });
});
