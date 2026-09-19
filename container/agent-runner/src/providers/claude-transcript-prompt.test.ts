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

const T0 = Date.parse('2026-09-18T12:00:00.000Z'); // the batch's first-attempt start
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
type Entry = Record<string, unknown>;
const user = (uuid: string, parent: string | null, content: unknown, offsetMs: number, extra: Entry = {}): Entry => ({
  type: 'user',
  uuid,
  parentUuid: parent,
  timestamp: at(offsetMs),
  message: { role: 'user', content },
  ...extra,
});
const assistant = (uuid: string, parent: string, offsetMs: number): Entry => ({
  type: 'assistant',
  uuid,
  parentUuid: parent,
  timestamp: at(offsetMs),
  message: { content: [] },
});
function write(lines: Array<Entry | string>): string {
  const p = path.join(dir, 'session.jsonl');
  fs.writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return p;
}
const PROMPT = '<messages><message from="operator">Review the release queue once.</message></messages>';
const has = (lines: Array<Entry | string>) => transcriptContainsUserText(write(lines), PROMPT, T0);

describe('transcriptContainsUserText', () => {
  it('finds the prompt this attempt recorded on the resumed chain (string or text blocks)', () => {
    expect(
      has([
        user('a', null, 'earlier', -60_000),
        assistant('b', 'a', -59_000),
        user('c', 'b', PROMPT, 5),
        assistant('d', 'c', 900),
      ]),
    ).toBe(true);
    const blocks = [
      { type: 'text', text: PROMPT },
      { type: 'image', source: {} },
    ];
    expect(has([user('c', null, blocks, 5)])).toBe(true);
  });

  it('rejects an identical copy from before the attempt started — even 1 ms before', () => {
    expect(has([user('a', null, PROMPT, -1), assistant('b', 'a', 200)])).toBe(false);
  });

  it('still finds the original after an earlier pointer-only retry was recorded', () => {
    const pointer = '<runner-retry-provenance>…</runner-retry-provenance>\n\nThe interrupted batch …';
    expect(has([user('c', null, PROMPT, 5), assistant('d', 'c', 100), user('e', 'd', pointer, 3000)])).toBe(true);
  });

  it('rejects a match on an abandoned branch the resumed leaf does not descend from', () => {
    expect(
      has([user('a', null, 'earlier', -60_000), user('x', 'a', PROMPT, 5), user('y', 'a', 'other branch', 50)]),
    ).toBe(false);
  });

  it('rejects when the chain crosses a compact_boundary or a missing parent', () => {
    const boundary = { type: 'system', subtype: 'compact_boundary', uuid: 'k', parentUuid: 'c', timestamp: at(50) };
    expect(has([user('c', null, PROMPT, 5), boundary, assistant('d', 'k', 60)])).toBe(false);
    expect(has([assistant('d', 'gone', 60)])).toBe(false);
  });

  it('fails closed on corrupt lines and ignores entries the SDK would not load', () => {
    expect(has([user('c', null, PROMPT, 5), '{not json'])).toBe(false);
    expect(has([{ type: 'user', timestamp: at(5), message: { content: PROMPT } }])).toBe(false); // no uuid
    expect(has([user('c', null, PROMPT, 5, { isSidechain: true })])).toBe(false);
    expect(has([{ type: 'user', uuid: 'u', parentUuid: null, message: { content: PROMPT } }])).toBe(false); // undated
  });

  it('accepts a match on the resumed chain even when an abandoned sibling branch exists', () => {
    // The newest user/assistant entry is `d`, so the resumed chain is d → x → a;
    // `y` hangs off `a` and is never loaded. Before 2026-09-19 a sibling anywhere
    // in the attempt vetoed the pointer, which is what made this check answer
    // false for every live retry. A `system` line on the chain does not block it.
    const sys = { type: 'system', subtype: 'informational', uuid: 's', parentUuid: 'x', timestamp: at(80) };
    expect(
      has([
        user('a', null, 'earlier', -60_000),
        user('x', 'a', PROMPT, 5),
        user('y', 'a', 'sibling', 50),
        sys,
        assistant('d', 's', 100),
      ]),
    ).toBe(true);
  });

  it('accepts a chain whose entries hang off lines this walk skips (the live shape)', () => {
    // Real transcripts interleave entries whose parents are queue ops, titles and
    // sidechain roots — lines with no `uuid` or `isSidechain: true`. They make the
    // recorded entries look like several roots; none of them is on the resumed chain.
    const orphan = { type: 'user', uuid: 'o', parentUuid: 'queue-op', timestamp: at(20), message: { role: 'user', content: 'queued' } };
    expect(
      has([
        { type: 'queue', content: 'no uuid at all' },
        user('c', null, PROMPT, 5),
        orphan,
        assistant('d', 'c', 900),
      ]),
    ).toBe(true);
  });

  it('rejects malformed conversation entries: empty uuid, absent parentUuid, non-user role', () => {
    expect(has([user('', null, PROMPT, 5)])).toBe(false);
    const noParent = user('c', null, PROMPT, 5);
    delete noParent.parentUuid;
    expect(has([noParent])).toBe(false);
    expect(has([{ ...user('c', null, PROMPT, 5), message: { role: 'assistant', content: PROMPT } }])).toBe(false);
  });

  it('rejects a late progress entry that hangs off an abandoned branch', () => {
    // Reproduced against SDK 0.3.278 / CLI 2.1.278 (PR #948 review): the resume
    // loads a → y, so pointing at x would drop the batch. Only user/assistant
    // entries may start the walk.
    const progress = { type: 'progress', uuid: 'p', parentUuid: 'x', timestamp: at(120) };
    expect(
      has([user('a', null, 'ROOT', -60_000), user('x', 'a', PROMPT, 5), user('y', 'a', 'OTHER_BRANCH', 50), progress]),
    ).toBe(false);
  });

  it('rejects a file that repeats a uuid, which could hide a compact_boundary', () => {
    // Same review: re-appending the pre-compaction entry made it `newest`, so the
    // walk returned true without ever visiting the boundary that orphaned it.
    const boundary = { type: 'system', subtype: 'compact_boundary', uuid: 'k', parentUuid: 'x', timestamp: at(50) };
    const summary = user('y', 'k', 'SUMMARY', 60, { isCompactSummary: true });
    expect(
      has([user('a', null, 'ROOT', -60_000), user('x', 'a', PROMPT, 5), boundary, summary, user('x', 'a', PROMPT, 70)]),
    ).toBe(false);
  });

  it('rejects a compaction written after the match, including a terminal one', () => {
    // PR #948 review round 2, captured against SDK 0.3.278 / CLI 2.1.278: a
    // terminal compact_boundary is nobody's parent, so the chain walk never
    // reaches it, but the resume loads the summary and not the batch.
    const terminal = { type: 'system', subtype: 'compact_boundary', uuid: 'k', parentUuid: 'x', timestamp: at(90) };
    expect(has([user('a', null, 'ROOT', -60_000), user('x', 'a', PROMPT, 5), terminal])).toBe(false);
  });

  it('rejects a sidechain entry that reuses a main-conversation uuid', () => {
    // Same review: the sidechain copy shadows the batch on resume, and skipping
    // sidechains before the duplicate check let it through.
    const shadow = user('x', 'a', 'SIDE', 40, { isSidechain: true });
    expect(
      has([user('a', null, 'ROOT', -60_000), user('x', 'a', PROMPT, 5), shadow, assistant('z', 'x', 100)]),
    ).toBe(false);
  });

  it('refuses a non-boolean isSidechain rather than reading it as main conversation', () => {
    // PR #948 review round 3: the SDK excluded entries marked "true" or 1, so
    // treating them as main conversation pointed at a batch the resume omits.
    expect(has([user('a', null, 'ROOT', -60_000), user('x', 'a', PROMPT, 5, { isSidechain: 'true' })])).toBe(false);
    expect(has([user('a', null, 'ROOT', -60_000), user('x', 'a', PROMPT, 5, { isSidechain: 1 })])).toBe(false);
  });

  it('answers false for a missing file, an empty prompt, or an unrecorded prompt', () => {
    expect(transcriptContainsUserText(path.join(dir, 'nope.jsonl'), PROMPT, T0)).toBe(false);
    expect(transcriptContainsUserText(write([user('c', null, PROMPT, 5)]), '', T0)).toBe(false);
    expect(has([user('c', null, 'something else', 5)])).toBe(false);
  });
});
