import { describe, it, expect } from 'bun:test';

import {
  buildAttachmentFileParts,
  buildPromptParts,
  declarationsApplyToModel,
  forwardableAttachmentMime,
  resolveModelCapabilities,
} from './opencode.js';

const allPresent = () => true;
const nonePresent = () => false;

describe('buildAttachmentFileParts', () => {
  it('test_oc_attachment_file_url_not_data_uri: emits a file:// part for a staged image', () => {
    // OpenCode resolves a file: part server-side and re-emits it as base64
    // itself; the server shares this container's filesystem, so base64-ing here
    // would only duplicate the work and inflate the request body.
    const parts = buildAttachmentFileParts(
      [{ filename: 'cat.png', mime: 'image/png', path: '/workspace/inbox/cat.png' }],
      { exists: allPresent },
    );
    expect(parts).toEqual([
      { type: 'file', mime: 'image/png', filename: 'cat.png', url: 'file:///workspace/inbox/cat.png' },
    ]);
  });

  it('test_oc_attachment_mime_from_extension: falls back to the extension when the channel gave no mime', () => {
    const parts = buildAttachmentFileParts([{ filename: 'Report.PDF', path: '/workspace/inbox/Report.PDF' }], {
      exists: allPresent,
    });
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
      { exists: allPresent },
    );
    // They are still described in the prompt text by the formatter, so nothing
    // is lost — just not handed over as media.
    expect(parts).toEqual([]);
  });

  it('test_oc_attachment_skips_unreadable: drops an attachment with no readable local file', () => {
    const linkOnly = buildAttachmentFileParts([{ filename: 'cat.png', mime: 'image/png', url: 'https://x/cat.png' }], {
      exists: allPresent,
    });
    expect(linkOnly).toEqual([]);

    const missing = buildAttachmentFileParts(
      [{ filename: 'cat.png', mime: 'image/png', path: '/workspace/inbox/gone.png' }],
      { exists: nonePresent },
    );
    expect(missing).toEqual([]);
  });

  it('test_oc_attachment_non_string_mime_falls_back: a non-string mime uses the extension instead of throwing', () => {
    // buildAttachmentFileParts is exported and structurally typed, so a caller
    // that hands over a raw channel object must get the extension fallback, not
    // a TypeError from `.startsWith()` that aborts the entire provider query.
    const parts = buildAttachmentFileParts(
      [{ mime: { foo: 'bar' }, filename: 'cat.png', path: '/workspace/inbox/cat.png' } as never],
      { exists: allPresent },
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
    expect(buildAttachmentFileParts([{ mime: {}, filename: {}, path: {} } as never], { exists: allPresent })).toEqual(
      [],
    );
  });

  it('a non-string filename is dropped from the part rather than emitted', () => {
    const parts = buildAttachmentFileParts(
      [{ mime: 'image/png', filename: { a: 1 }, path: '/workspace/inbox/cat.png' } as never],
      { exists: allPresent },
    );
    expect(parts[0]?.filename).toBeUndefined();
    expect(parts[0]?.url).toBe('file:///workspace/inbox/cat.png');
  });

  it('an absent attachment list is an empty part list, not a throw', () => {
    expect(buildAttachmentFileParts(undefined, { exists: allPresent })).toEqual([]);
    expect(buildAttachmentFileParts([], { exists: allPresent })).toEqual([]);
  });
});

describe('buildPromptParts', () => {
  it('test_oc_prompt_parts_text_first: the text part always leads, media follows', () => {
    const parts = buildPromptParts(
      'look at this',
      [{ filename: 'cat.png', mime: 'image/png', path: '/workspace/inbox/cat.png' }],
      { exists: allPresent },
    );
    expect(parts[0]).toEqual({ type: 'text', text: 'look at this' });
    expect(parts).toHaveLength(2);
    expect(parts[1]).toMatchObject({ type: 'file', mime: 'image/png' });
  });

  it('test_oc_prompt_parts_unchanged_without_media: a turn with no attachments is the old single text part', () => {
    expect(buildPromptParts('hello', undefined, { exists: allPresent })).toEqual([{ type: 'text', text: 'hello' }]);
    expect(buildPromptParts('hello', [], { exists: allPresent })).toEqual([{ type: 'text', text: 'hello' }]);
  });
});

describe('forwardableAttachmentMime', () => {
  it('test_oc_forward_images_and_pdfs_unconditionally: the long-standing behavior is unchanged', () => {
    expect(forwardableAttachmentMime('image/png', undefined, {})).toBe(true);
    expect(forwardableAttachmentMime('image/heic', undefined, {})).toBe(true);
    expect(forwardableAttachmentMime('application/pdf', undefined, {})).toBe(true);
    expect(forwardableAttachmentMime('text/plain', undefined, {})).toBe(false);
    expect(forwardableAttachmentMime('application/zip', undefined, {})).toBe(false);
  });

  it('test_oc_forward_audio_video_only_when_declared: the advertised modalities are the forwarded ones', () => {
    // resolveModelModalities accepts and advertises audio and video, but the
    // forwarder used to drop both — so declaring either did nothing. One
    // declaration now drives both gates.
    expect(forwardableAttachmentMime('audio/ogg', undefined, {})).toBe(false);
    expect(forwardableAttachmentMime('video/mp4', undefined, {})).toBe(false);

    const audioOnly = { OPENCODE_MODEL: 'nvidia/m', OPENCODE_MODEL_INPUT_MODALITIES: 'audio' };
    expect(forwardableAttachmentMime('audio/ogg', 'nvidia/m', audioOnly)).toBe(true);
    expect(forwardableAttachmentMime('video/mp4', 'nvidia/m', audioOnly)).toBe(false);

    const both = { OPENCODE_MODEL: 'nvidia/m', OPENCODE_MODEL_INPUT_MODALITIES: 'audio,video' };
    expect(forwardableAttachmentMime('audio/mpeg', 'nvidia/m', both)).toBe(true);
    expect(forwardableAttachmentMime('video/webm', 'nvidia/m', both)).toBe(true);

    // Declaring an image modality does not open the audio gate.
    expect(
      forwardableAttachmentMime('audio/ogg', 'nvidia/m', {
        OPENCODE_MODEL: 'nvidia/m',
        OPENCODE_MODEL_INPUT_MODALITIES: 'image',
      }),
    ).toBe(false);
  });

  it('test_oc_forward_audio_extension_fallback: a voice note with no channel mime resolves by extension', () => {
    // The host names a Telegram voice note `.ogg` via its own TYPE_TO_EXT map,
    // and reports no mimeType for it.
    const previousModalities = process.env.OPENCODE_MODEL_INPUT_MODALITIES;
    const previousModel = process.env.OPENCODE_MODEL;
    process.env.OPENCODE_MODEL_INPUT_MODALITIES = 'audio';
    process.env.OPENCODE_MODEL = 'nvidia/test-model';
    try {
      const parts = buildAttachmentFileParts([{ filename: 'voice.ogg', path: '/workspace/inbox/voice.ogg' }], {
        exists: allPresent,
      });
      expect(parts).toHaveLength(1);
      expect(parts[0]?.mime).toBe('audio/ogg');
    } finally {
      if (previousModalities === undefined) delete process.env.OPENCODE_MODEL_INPUT_MODALITIES;
      else process.env.OPENCODE_MODEL_INPUT_MODALITIES = previousModalities;
      if (previousModel === undefined) delete process.env.OPENCODE_MODEL;
      else process.env.OPENCODE_MODEL = previousModel;
    }
  });
});

describe('declarationsApplyToModel / resolveModelCapabilities', () => {
  const env = {
    OPENCODE_MODEL: 'openrouter/shared',
    OPENCODE_MODEL_CONTEXT_LIMIT: '128000',
    OPENCODE_MODEL_OUTPUT_LIMIT: '8192',
    OPENCODE_MODEL_INPUT_MODALITIES: 'image,audio',
  };

  it('test_oc_caps_full_slug_identity: a provider-id collision does not inherit the declarations', () => {
    // `openrouter/shared` and `nvidia/shared` are different models that share an
    // id. Comparing ids alone applied one model's context window and media
    // support to the other.
    expect(declarationsApplyToModel('openrouter/shared', env)).toBe(true);
    expect(declarationsApplyToModel('nvidia/shared', env)).toBe(false);
    expect(resolveModelCapabilities('nvidia/shared', env)).toEqual({});
    expect(resolveModelCapabilities('openrouter/shared', env)).toEqual({
      limit: { context: 128000, output: 8192 },
      modalities: { input: ['text', 'image', 'audio'], output: ['text'] },
    });
  });

  it('test_oc_caps_no_override_is_the_configured_model: an unresolved effective model applies them', () => {
    expect(declarationsApplyToModel(undefined, env)).toBe(true);
    expect(resolveModelCapabilities(undefined, env).limit).toEqual({ context: 128000, output: 8192 });
  });

  it('slugs compare trimmed and case-insensitively', () => {
    expect(declarationsApplyToModel('  OpenRouter/Shared ', env)).toBe(true);
  });

  it('no configured model means no declarations apply anywhere', () => {
    expect(declarationsApplyToModel('nvidia/m', { OPENCODE_MODEL_CONTEXT_LIMIT: '1' })).toBe(false);
    expect(resolveModelCapabilities('nvidia/m', { OPENCODE_MODEL_CONTEXT_LIMIT: '1' })).toEqual({});
  });

  it('test_oc_caps_forwarder_and_writer_agree: media forwarding follows the same predicate', () => {
    // The round-3 fix checked identity in the config writer only; the forwarder
    // read the declarations unconditionally. Both now route through
    // resolveModelCapabilities, so an override cannot be handed audio the
    // configured model declared, nor have its own media dropped for a reason
    // that belongs to a different model.
    expect(forwardableAttachmentMime('audio/ogg', 'openrouter/shared', env)).toBe(true);
    expect(forwardableAttachmentMime('audio/ogg', 'nvidia/shared', env)).toBe(false);
    // Images and PDFs stay unconditional on every model.
    expect(forwardableAttachmentMime('image/png', 'nvidia/shared', env)).toBe(true);
    expect(forwardableAttachmentMime('application/pdf', 'nvidia/shared', env)).toBe(true);
  });
});
