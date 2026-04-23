import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { deriveProgressLabels } from './claude.js';

function assistantMessage(content: unknown[]): unknown {
  return { type: 'assistant', message: { content } };
}

describe('deriveProgressLabels', () => {
  const originalEnv = process.env.NANOCLAW_HIDE_THINKING;

  beforeEach(() => {
    delete process.env.NANOCLAW_HIDE_THINKING;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.NANOCLAW_HIDE_THINKING;
    else process.env.NANOCLAW_HIDE_THINKING = originalEnv;
  });

  test('empty / non-assistant input', () => {
    expect(deriveProgressLabels({ type: 'system' })).toEqual([]);
    expect(deriveProgressLabels(null)).toEqual([]);
    expect(deriveProgressLabels({ message: { content: 'text' } })).toEqual([]);
  });

  test('forwards thinking block text verbatim', () => {
    const msg = assistantMessage([{ type: 'thinking', thinking: 'Let me check the schema.', signature: 'sig' }]);
    expect(deriveProgressLabels(msg)).toEqual(['Let me check the schema.']);
  });

  test('truncates long thinking text on word boundary at 2000 chars', () => {
    const long = 'word '.repeat(1000).trim();
    const labels = deriveProgressLabels(
      assistantMessage([{ type: 'thinking', thinking: long, signature: 'sig' }]),
    );
    expect(labels).toHaveLength(1);
    expect(labels[0].endsWith('…')).toBe(true);
    expect(labels[0].length).toBeLessThanOrEqual(2000);
  });

  test('short thinking not truncated', () => {
    const msg = assistantMessage([
      { type: 'thinking', thinking: 'Short reasoning here.', signature: 's' },
    ]);
    const labels = deriveProgressLabels(msg);
    expect(labels).toEqual(['Short reasoning here.']);
    expect(labels[0].endsWith('…')).toBe(false);
  });

  test('NANOCLAW_HIDE_THINKING=1 suppresses all progress', () => {
    process.env.NANOCLAW_HIDE_THINKING = '1';
    const msg = assistantMessage([{ type: 'thinking', thinking: 'Hidden reasoning', signature: 's' }]);
    expect(deriveProgressLabels(msg)).toEqual([]);
  });

  test('tool_use blocks are IGNORED — only thinking surfaces', () => {
    // Design: the post-then-edit chat UX overwrites each progress event, so a
    // tool label emitted immediately after thinking would erase the reasoning.
    // Thinking is the signal worth reading; tool actions are implied.
    const msg = assistantMessage([
      { type: 'thinking', thinking: 'Looking up the schema.', signature: 's' },
      { type: 'tool_use', name: 'Bash', input: { command: 'dbt build' } },
      { type: 'tool_use', name: 'Skill', input: { skill: 'team-brief' } },
      { type: 'tool_use', name: 'mcp__gitnexus__query', input: { query: 'auth' } },
    ]);
    expect(deriveProgressLabels(msg)).toEqual(['Looking up the schema.']);
  });

  test('tool_use alone (no thinking) produces no labels', () => {
    const msg = assistantMessage([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]);
    expect(deriveProgressLabels(msg)).toEqual([]);
  });

  test('multiple thinking blocks emit in order', () => {
    const msg = assistantMessage([
      { type: 'thinking', thinking: 'First thought.', signature: 's1' },
      { type: 'thinking', thinking: 'Second thought.', signature: 's2' },
    ]);
    expect(deriveProgressLabels(msg)).toEqual(['First thought.', 'Second thought.']);
  });

  test('empty thinking blocks are skipped (signature-only)', () => {
    const msg = assistantMessage([
      { type: 'thinking', thinking: '', signature: 'sig-only' },
      { type: 'thinking', thinking: '   ', signature: 'whitespace' },
      { type: 'thinking', thinking: 'Real content.', signature: 'good' },
    ]);
    expect(deriveProgressLabels(msg)).toEqual(['Real content.']);
  });
});
