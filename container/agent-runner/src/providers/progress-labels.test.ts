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

  test('forwards thinking block text', () => {
    const msg = assistantMessage([{ type: 'thinking', thinking: 'Let me check the schema.', signature: 'sig' }]);
    expect(deriveProgressLabels(msg)).toEqual(['Let me check the schema.']);
  });

  test('truncates long thinking text on word boundary', () => {
    const long = 'word '.repeat(200).trim();
    const labels = deriveProgressLabels(
      assistantMessage([{ type: 'thinking', thinking: long, signature: 'sig' }]),
    );
    expect(labels).toHaveLength(1);
    expect(labels[0].endsWith('…')).toBe(true);
    expect(labels[0].length).toBeLessThanOrEqual(500);
  });

  test('NANOCLAW_HIDE_THINKING=1 suppresses thinking', () => {
    process.env.NANOCLAW_HIDE_THINKING = '1';
    const msg = assistantMessage([{ type: 'thinking', thinking: 'Hidden reasoning', signature: 's' }]);
    expect(deriveProgressLabels(msg)).toEqual([]);
  });

  test('Bash label shows the actual command, first line only', () => {
    const msg = assistantMessage([
      {
        type: 'tool_use',
        name: 'Bash',
        input: { command: 'snow sql -q "SELECT count(*) FROM foo"\necho done' },
      },
    ]);
    expect(deriveProgressLabels(msg)).toEqual(['Bash: snow sql -q "SELECT count(*) FROM foo"']);
  });

  test('Read / Edit / Write labels show file path', () => {
    for (const name of ['Read', 'Edit', 'Write', 'NotebookEdit']) {
      const msg = assistantMessage([{ type: 'tool_use', name, input: { file_path: 'src/delivery.ts' } }]);
      expect(deriveProgressLabels(msg)).toEqual([`${name}: src/delivery.ts`]);
    }
  });

  test('Glob shows the pattern', () => {
    const msg = assistantMessage([{ type: 'tool_use', name: 'Glob', input: { pattern: '**/*.ts' } }]);
    expect(deriveProgressLabels(msg)).toEqual(['Glob: **/*.ts']);
  });

  test('Grep formats "pattern" in path', () => {
    const msg1 = assistantMessage([
      { type: 'tool_use', name: 'Grep', input: { pattern: 'thinking', path: 'container/' } },
    ]);
    expect(deriveProgressLabels(msg1)).toEqual(['Grep: "thinking" in container/']);

    const msg2 = assistantMessage([{ type: 'tool_use', name: 'Grep', input: { pattern: 'thinking' } }]);
    expect(deriveProgressLabels(msg2)).toEqual(['Grep: "thinking"']);
  });

  test('WebSearch / WebFetch show query / url', () => {
    const msg1 = assistantMessage([{ type: 'tool_use', name: 'WebSearch', input: { query: 'claude api docs' } }]);
    expect(deriveProgressLabels(msg1)).toEqual(['WebSearch: claude api docs']);

    const msg2 = assistantMessage([
      { type: 'tool_use', name: 'WebFetch', input: { url: 'https://example.com/page' } },
    ]);
    expect(deriveProgressLabels(msg2)).toEqual(['WebFetch: https://example.com/page']);
  });

  test('Skill shows skill name', () => {
    expect(
      deriveProgressLabels(
        assistantMessage([{ type: 'tool_use', name: 'Skill', input: { skill: 'team-brief' } }]),
      ),
    ).toEqual(['Skill: team-brief']);
    // Plugin-namespaced
    expect(
      deriveProgressLabels(
        assistantMessage([
          { type: 'tool_use', name: 'Skill', input: { skill: 'bootstrap-workflow:team-brief' } },
        ]),
      ),
    ).toEqual(['Skill: bootstrap-workflow:team-brief']);
    // Missing input → tool name only
    expect(
      deriveProgressLabels(assistantMessage([{ type: 'tool_use', name: 'Skill', input: {} }])),
    ).toEqual(['Skill']);
  });

  test('Task shows subagent type', () => {
    const msg = assistantMessage([
      { type: 'tool_use', name: 'Task', input: { subagent_type: 'general-purpose', description: 'research X' } },
    ]);
    expect(deriveProgressLabels(msg)).toEqual(['Task: general-purpose']);
  });

  test('TodoWrite shows task count', () => {
    const msg = assistantMessage([
      { type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'a' }, { content: 'b' }] } },
    ]);
    expect(deriveProgressLabels(msg)).toEqual(['TodoWrite: 2 tasks']);
  });

  test('MCP tools: show full name and first string input', () => {
    const msg = assistantMessage([
      { type: 'tool_use', name: 'mcp__gitnexus__query', input: { query: 'auth flow' } },
    ]);
    expect(deriveProgressLabels(msg)).toEqual(['mcp__gitnexus__query: auth flow']);
  });

  test('MCP tools: no usable input → name only', () => {
    const msg = assistantMessage([{ type: 'tool_use', name: 'mcp__x__y', input: {} }]);
    expect(deriveProgressLabels(msg)).toEqual(['mcp__x__y']);
  });

  test('emits both thinking and tool_use labels in order', () => {
    const msg = assistantMessage([
      { type: 'thinking', thinking: 'Looking up the schema.', signature: 's' },
      { type: 'tool_use', name: 'Grep', input: { pattern: 'schema', path: 'src/' } },
    ]);
    expect(deriveProgressLabels(msg)).toEqual(['Looking up the schema.', 'Grep: "schema" in src/']);
  });
});
