import { describe, expect, it } from 'vitest';

import { parseTaskContent } from './task-content.js';

describe('parseTaskContent', () => {
  it('round-trips the JSON envelope, including the fork-only fields', () => {
    const raw = JSON.stringify({
      prompt: 'post the digest',
      script: 'check.sh',
      scriptHost: true,
      threadAnchor: false,
      originSessionId: 'sess-1',
    });
    expect(parseTaskContent(raw)).toEqual({
      prompt: 'post the digest',
      script: 'check.sh',
      scriptHost: true,
      threadAnchor: false,
      originSessionId: 'sess-1',
    });
  });

  it('round-trips a legacy plain-string body to the fork defaults, not upstream three-field defaults', () => {
    // Pre-v2 rows predate the JSON envelope: the whole string IS the prompt.
    // scriptHost defaults false and threadAnchor defaults true — upstream's
    // shape has neither field, so this pins the fork's own legacy contract.
    expect(parseTaskContent('legacy plain-string prompt')).toEqual({
      prompt: 'legacy plain-string prompt',
      script: null,
      scriptHost: false,
      threadAnchor: true,
      originSessionId: null,
    });
  });

  it('defaults missing fields on a partial JSON envelope', () => {
    expect(parseTaskContent(JSON.stringify({ prompt: 'x' }))).toEqual({
      prompt: 'x',
      script: null,
      scriptHost: false,
      threadAnchor: true,
      originSessionId: null,
    });
  });
});
