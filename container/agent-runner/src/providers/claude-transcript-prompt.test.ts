import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { transcriptContainsUserText } from './claude-transcript-prompt.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-prompt-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeTranscript(entries: unknown[], extra = ''): string {
  const p = path.join(dir, 'session.jsonl');
  fs.writeFileSync(p, extra + entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return p;
}
const user = (content: unknown) => ({ type: 'user', message: { role: 'user', content } });
const PROMPT = '<messages><message from="operator">Review the release queue once.</message></messages>';

describe('transcriptContainsUserText', () => {
  it('finds a prompt recorded as a string user message', () => {
    const p = writeTranscript([user('earlier'), user(PROMPT), { type: 'assistant', message: { content: [] } }]);
    expect(transcriptContainsUserText(p, PROMPT)).toBe(true);
  });

  it('finds a prompt recorded as text blocks alongside an image', () => {
    const p = writeTranscript([
      user([
        { type: 'text', text: PROMPT },
        { type: 'image', source: {} },
      ]),
    ]);
    expect(transcriptContainsUserText(p, PROMPT)).toBe(true);
  });

  it('answers false when the prompt was never recorded', () => {
    const p = writeTranscript([user('something else entirely')]);
    expect(transcriptContainsUserText(p, PROMPT)).toBe(false);
  });

  it('ignores tool-result-only user entries when counting the newest entries', () => {
    const toolResults = Array.from({ length: 30 }, () =>
      user([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]),
    );
    const p = writeTranscript([user(PROMPT), ...toolResults]);
    expect(transcriptContainsUserText(p, PROMPT)).toBe(true);
  });

  it('only searches the newest user entries — an old copy does not count', () => {
    const later = Array.from({ length: 25 }, (_, i) => user(`message ${i}`));
    const p = writeTranscript([user(PROMPT), ...later]);
    expect(transcriptContainsUserText(p, PROMPT)).toBe(false);
  });

  it('answers false for a missing file, an empty prompt, and unparseable lines', () => {
    expect(transcriptContainsUserText(path.join(dir, 'nope.jsonl'), PROMPT)).toBe(false);
    const p = writeTranscript([user(PROMPT)], '{not json\n');
    expect(transcriptContainsUserText(p, '')).toBe(false);
    expect(transcriptContainsUserText(p, PROMPT)).toBe(true);
  });
});
