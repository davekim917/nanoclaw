import { describe, it, expect } from 'bun:test';

import { buildAttachmentFileParts, buildPromptParts, forwardableAttachmentMime } from './opencode.js';

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

  it('test_oc_attachment_skips_non_media: drops anything the group has not opened the gate for', () => {
    const parts = buildAttachmentFileParts(
      [
        { filename: 'notes.txt', mime: 'text/plain', path: '/workspace/inbox/notes.txt' },
        { filename: 'archive.zip', path: '/workspace/inbox/archive.zip' },
        // Undeclared modality: OpenCode would drop it anyway, substituting a
        // "does not support video input" error, so forwarding only inflates
        // the request.
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

  it('test_oc_attachment_non_string_mime_falls_back: a non-string mime uses the extension instead of throwing', () => {
    // buildAttachmentFileParts is exported and structurally typed, so a caller
    // that hands over a raw channel object must get the extension fallback, not
    // a TypeError from `.startsWith()` that aborts the entire provider query.
    const parts = buildAttachmentFileParts(
      [{ mime: { foo: 'bar' }, filename: 'cat.png', path: '/workspace/inbox/cat.png' } as never],
      allPresent,
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]?.mime).toBe('image/png');
  });

  it('test_oc_attachment_non_string_fields_never_throw: no field shape can abort the turn', () => {
    expect(() =>
      buildAttachmentFileParts(
        [
          { mime: 42, filename: {}, path: {}, url: [] } as never,
          { mime: 'image/png', filename: {}, path: {} } as never,
          { mime: {}, filename: {}, path: {} } as never,
        ],
        allPresent,
      ),
    ).not.toThrow();
    expect(buildAttachmentFileParts([{ mime: {}, filename: {}, path: {} } as never], allPresent)).toEqual([]);
  });

  it('a non-string filename is dropped from the part rather than emitted', () => {
    const parts = buildAttachmentFileParts(
      [{ mime: 'image/png', filename: { a: 1 }, path: '/workspace/inbox/cat.png' } as never],
      allPresent,
    );
    expect(parts[0]?.filename).toBeUndefined();
    expect(parts[0]?.url).toBe('file:///workspace/inbox/cat.png');
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

describe('forwardableAttachmentMime', () => {
  it('test_oc_forward_images_and_pdfs_unconditionally: the long-standing behavior is unchanged', () => {
    expect(forwardableAttachmentMime('image/png', {})).toBe(true);
    expect(forwardableAttachmentMime('image/heic', {})).toBe(true);
    expect(forwardableAttachmentMime('application/pdf', {})).toBe(true);
    expect(forwardableAttachmentMime('text/plain', {})).toBe(false);
    expect(forwardableAttachmentMime('application/zip', {})).toBe(false);
  });

  it('test_oc_forward_audio_video_only_when_declared: the advertised modalities are the forwarded ones', () => {
    // resolveModelModalities accepts and advertises audio and video, but the
    // forwarder used to drop both — so declaring either did nothing. One
    // declaration now drives both gates.
    expect(forwardableAttachmentMime('audio/ogg', {})).toBe(false);
    expect(forwardableAttachmentMime('video/mp4', {})).toBe(false);

    const audioOnly = { OPENCODE_MODEL_INPUT_MODALITIES: 'audio' };
    expect(forwardableAttachmentMime('audio/ogg', audioOnly)).toBe(true);
    expect(forwardableAttachmentMime('video/mp4', audioOnly)).toBe(false);

    const both = { OPENCODE_MODEL_INPUT_MODALITIES: 'audio,video' };
    expect(forwardableAttachmentMime('audio/mpeg', both)).toBe(true);
    expect(forwardableAttachmentMime('video/webm', both)).toBe(true);

    // Declaring an image modality does not open the audio gate.
    expect(forwardableAttachmentMime('audio/ogg', { OPENCODE_MODEL_INPUT_MODALITIES: 'image' })).toBe(false);
  });

  it('test_oc_forward_audio_extension_fallback: a voice note with no channel mime resolves by extension', () => {
    // The host names a Telegram voice note `.ogg` via its own TYPE_TO_EXT map,
    // and reports no mimeType for it.
    const previous = process.env.OPENCODE_MODEL_INPUT_MODALITIES;
    process.env.OPENCODE_MODEL_INPUT_MODALITIES = 'audio';
    try {
      const parts = buildAttachmentFileParts(
        [{ filename: 'voice.ogg', path: '/workspace/inbox/voice.ogg' }],
        allPresent,
      );
      expect(parts).toHaveLength(1);
      expect(parts[0]?.mime).toBe('audio/ogg');
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_MODEL_INPUT_MODALITIES;
      else process.env.OPENCODE_MODEL_INPUT_MODALITIES = previous;
    }
  });
});
