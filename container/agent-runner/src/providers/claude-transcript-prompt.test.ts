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

const T0 = Date.parse('2026-09-18T12:00:00.000Z'); // attempt start
const at = (offsetS: number) => new Date(T0 + offsetS * 1000).toISOString();
const user = (content: unknown, offsetS: number, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  timestamp: at(offsetS),
  message: { role: 'user', content },
  ...extra,
});
const assistant = (offsetS: number) => ({ type: 'assistant', timestamp: at(offsetS), message: { content: [] } });
function write(lines: unknown[]): string {
  const p = path.join(dir, 'session.jsonl');
  fs.writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return p;
}
const PROMPT = '<messages><message from="operator">Review the release queue once.</message></messages>';

describe('transcriptContainsUserText', () => {
  it('finds the prompt recorded during this attempt (string or text blocks)', () => {
    expect(transcriptContainsUserText(write([user('earlier', -60), user(PROMPT, 1), assistant(2)]), PROMPT, T0)).toBe(
      true,
    );
    const blocks = user(
      [
        { type: 'text', text: PROMPT },
        { type: 'image', source: {} },
      ],
      1,
    );
    expect(transcriptContainsUserText(write([blocks]), PROMPT, T0)).toBe(true);
  });

  it('rejects an identical OLDER copy — a repeated delivery is not this attempt', () => {
    expect(transcriptContainsUserText(write([user(PROMPT, -300), assistant(-290)]), PROMPT, T0)).toBe(false);
  });

  it('still finds the original after an earlier pointer-only retry was recorded', () => {
    const pointerRetry = user('<runner-retry-provenance>…</runner-retry-provenance>\n\nThe interrupted batch …', 5);
    expect(transcriptContainsUserText(write([user(PROMPT, 1), assistant(2), pointerRetry]), PROMPT, T0)).toBe(true);
  });

  it('answers false when compaction happened after the match', () => {
    const lines = [user(PROMPT, 1), { type: 'system', subtype: 'compact_boundary', timestamp: at(3) }];
    expect(transcriptContainsUserText(write(lines), PROMPT, T0)).toBe(false);
  });

  it('answers false when a newer line is corrupt', () => {
    expect(transcriptContainsUserText(write([user(PROMPT, 1), '{not json']), PROMPT, T0)).toBe(false);
  });

  it('skips sidechain (subagent) and tool-result-only user entries', () => {
    const lines = [
      user(PROMPT, 1),
      user('subagent brief', 2, { isSidechain: true }),
      user([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }], 3),
    ];
    expect(transcriptContainsUserText(write(lines), PROMPT, T0)).toBe(true);
    expect(transcriptContainsUserText(write([user(PROMPT, 1, { isSidechain: true })]), PROMPT, T0)).toBe(false);
  });

  it('answers false for a missing file, empty prompt, undated entry, or unrecorded prompt', () => {
    expect(transcriptContainsUserText(path.join(dir, 'nope.jsonl'), PROMPT, T0)).toBe(false);
    expect(transcriptContainsUserText(write([user(PROMPT, 1)]), '', T0)).toBe(false);
    expect(transcriptContainsUserText(write([{ type: 'user', message: { content: PROMPT } }]), PROMPT, T0)).toBe(false);
    expect(transcriptContainsUserText(write([user('something else', 1)]), PROMPT, T0)).toBe(false);
  });
});
