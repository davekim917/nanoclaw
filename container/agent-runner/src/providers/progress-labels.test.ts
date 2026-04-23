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

  test('returns empty on non-assistant message', () => {
    expect(deriveProgressLabels({ type: 'system' })).toEqual([]);
    expect(deriveProgressLabels(null)).toEqual([]);
  });

  test('returns empty when content is not an array', () => {
    expect(deriveProgressLabels({ message: { content: 'text' } })).toEqual([]);
  });

  test('forwards thinking block text', () => {
    const msg = assistantMessage([{ type: 'thinking', thinking: 'Let me check the schema first.', signature: 'sig' }]);
    expect(deriveProgressLabels(msg)).toEqual(['Let me check the schema first.']);
  });

  test('truncates long thinking text on word boundary', () => {
    const long = 'word '.repeat(200).trim();
    const labels = deriveProgressLabels(
      assistantMessage([{ type: 'thinking', thinking: long, signature: 'sig' }]),
    );
    expect(labels).toHaveLength(1);
    expect(labels[0].endsWith('…')).toBe(true);
    expect(labels[0].length).toBeLessThanOrEqual(400);
  });

  test('skips empty thinking blocks', () => {
    expect(deriveProgressLabels(assistantMessage([{ type: 'thinking', thinking: '   ', signature: 's' }]))).toEqual([]);
  });

  test('hides thinking when NANOCLAW_HIDE_THINKING=1', () => {
    process.env.NANOCLAW_HIDE_THINKING = '1';
    const msg = assistantMessage([{ type: 'thinking', thinking: 'Hidden reasoning', signature: 's' }]);
    expect(deriveProgressLabels(msg)).toEqual([]);
  });

  test('0 / false / empty string all count as enabled (default behavior)', () => {
    for (const v of ['0', 'false', 'False', '']) {
      process.env.NANOCLAW_HIDE_THINKING = v;
      const msg = assistantMessage([{ type: 'thinking', thinking: 'visible', signature: 's' }]);
      expect(deriveProgressLabels(msg)).toEqual(['visible']);
    }
  });

  test('emits both thinking and tool_use labels in order', () => {
    const msg = assistantMessage([
      { type: 'thinking', thinking: 'Searching files for the config', signature: 's' },
      { type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } },
    ]);
    expect(deriveProgressLabels(msg)).toEqual(['Searching files for the config', 'Searching']);
  });

  test('Skill tool reads skill name from `skill` input', () => {
    const msg = assistantMessage([{ type: 'tool_use', name: 'Skill', input: { skill: 'team-brief' } }]);
    expect(deriveProgressLabels(msg)).toEqual(['Invoking skill: team-brief']);
  });

  test('Skill tool falls back to `name` input', () => {
    const msg = assistantMessage([{ type: 'tool_use', name: 'Skill', input: { name: 'review-swarm' } }]);
    expect(deriveProgressLabels(msg)).toEqual(['Invoking skill: review-swarm']);
  });

  test('Skill tool preserves plugin:skill namespaces', () => {
    const msg = assistantMessage([{ type: 'tool_use', name: 'Skill', input: { skill: 'bootstrap-workflow:team-brief' } }]);
    expect(deriveProgressLabels(msg)).toEqual(['Invoking skill: bootstrap-workflow:team-brief']);
  });

  test('Skill tool falls back to generic label when neither input is set', () => {
    const msg = assistantMessage([{ type: 'tool_use', name: 'Skill', input: {} }]);
    expect(deriveProgressLabels(msg)).toEqual(['Invoking skill']);
  });

  test('MCP tool shows the tool suffix', () => {
    const msg = assistantMessage([{ type: 'tool_use', name: 'mcp__gitnexus__query', input: {} }]);
    expect(deriveProgressLabels(msg)).toEqual(['Using query']);
  });

  test('standard Bash/Read/Edit/WebSearch labels still render', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['Bash', { command: 'dbt build --select fct_orders' }, 'Running: dbt build --select fct_orders'],
      ['Read', {}, 'Reading files'],
      ['Grep', {}, 'Searching'],
      ['Edit', {}, 'Editing files'],
      ['WebSearch', {}, 'Web search'],
      ['WebFetch', {}, 'Fetching web page'],
      ['TodoWrite', {}, 'Planning'],
      ['Task', {}, 'Delegating subtask'],
    ];
    for (const [name, input, expected] of cases) {
      const msg = assistantMessage([{ type: 'tool_use', name, input }]);
      expect(deriveProgressLabels(msg)).toEqual([expected]);
    }
  });
});
