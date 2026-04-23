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

  test('forwards thinking block wrapped in italic markers + emoji prefix', () => {
    const msg = assistantMessage([{ type: 'thinking', thinking: 'Let me check the schema.', signature: 'sig' }]);
    expect(deriveProgressLabels(msg)).toEqual(['💭 _Let me check the schema._']);
  });

  test('escapes underscores in thinking text so italic run does not close early', () => {
    const msg = assistantMessage([
      { type: 'thinking', thinking: 'Looking at fct_orders and dim_customers.', signature: 'sig' },
    ]);
    expect(deriveProgressLabels(msg)).toEqual(['💭 _Looking at fct\\_orders and dim\\_customers._']);
  });

  test('truncates long thinking text on word boundary at 2000 chars (pre-format)', () => {
    const long = 'word '.repeat(1000).trim();
    const labels = deriveProgressLabels(
      assistantMessage([{ type: 'thinking', thinking: long, signature: 'sig' }]),
    );
    expect(labels).toHaveLength(1);
    // Label is `💭 _<prose>…_`. The prose inside italic wrappers is capped to
    // LABEL_MAX=2000; the emoji+space prefix + italic markers add ~6 chars.
    expect(labels[0].startsWith('💭 _')).toBe(true);
    expect(labels[0].endsWith('…_')).toBe(true);
    expect(labels[0].length).toBeLessThanOrEqual(2010);
  });

  test('short thinking not truncated', () => {
    const msg = assistantMessage([
      { type: 'thinking', thinking: 'Short reasoning here.', signature: 's' },
    ]);
    const labels = deriveProgressLabels(msg);
    expect(labels).toEqual(['💭 _Short reasoning here._']);
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
    expect(deriveProgressLabels(msg)).toEqual(['💭 _Looking up the schema._']);
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
    expect(deriveProgressLabels(msg)).toEqual(['💭 _First thought._', '💭 _Second thought._']);
  });

  test('empty thinking blocks are skipped (signature-only)', () => {
    const msg = assistantMessage([
      { type: 'thinking', thinking: '', signature: 'sig-only' },
      { type: 'thinking', thinking: '   ', signature: 'whitespace' },
      { type: 'thinking', thinking: 'Real content.', signature: 'good' },
    ]);
    expect(deriveProgressLabels(msg)).toEqual(['💭 _Real content._']);
  });
});
