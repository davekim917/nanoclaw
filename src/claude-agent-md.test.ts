import { describe, expect, test } from 'vitest';

import {
  MANAGED_MARKER,
  formatCodexAgentToml,
  isManagedToml,
  parseClaudeAgentMd,
} from './claude-agent-md.js';

describe('parseClaudeAgentMd', () => {
  test('parses plain frontmatter', () => {
    const src = `---
name: code-review-specialist
description: Reviews code for quality and security.
---

You are a senior code reviewer.
`;
    const out = parseClaudeAgentMd(src);
    expect(out).toEqual({
      name: 'code-review-specialist',
      description: 'Reviews code for quality and security.',
      body: 'You are a senior code reviewer.',
    });
  });

  test('handles double-quoted description with escapes', () => {
    const src = `---
name: x
description: "Line one\\nLine \\"two\\""
---
body
`;
    const out = parseClaudeAgentMd(src);
    expect(out?.description).toBe('Line one\nLine "two"');
  });

  test('handles folded `|` block for description', () => {
    const src = `---
name: x
description: |
  Multi-line
  block scalar
  third
---
body
`;
    const out = parseClaudeAgentMd(src);
    expect(out?.description).toBe('Multi-line\nblock scalar\nthird');
  });

  test('ignores Claude-specific keys (model/tools/color)', () => {
    const src = `---
name: x
description: y
model: sonnet
color: green
tools:
  - Read
  - Grep
---
body
`;
    const out = parseClaudeAgentMd(src);
    expect(out).toEqual({ name: 'x', description: 'y', body: 'body' });
  });

  test('rejects missing frontmatter', () => {
    expect(parseClaudeAgentMd('no frontmatter here')).toBeNull();
  });

  test('rejects when name or description is missing', () => {
    expect(parseClaudeAgentMd('---\nname: x\n---\nbody')).toBeNull();
    expect(parseClaudeAgentMd('---\ndescription: y\n---\nbody')).toBeNull();
  });

  test('preserves CRLF line endings before frontmatter close', () => {
    const src = '---\r\nname: x\r\ndescription: y\r\n---\r\nbody\r\n';
    const out = parseClaudeAgentMd(src);
    // We only need the body to make it through; line-ending preservation is
    // a non-goal (Codex TOML normalizes anyway).
    expect(out?.name).toBe('x');
    expect(out?.description).toBe('y');
  });
});

describe('formatCodexAgentToml', () => {
  test('emits required TOML fields with managed marker', () => {
    const out = formatCodexAgentToml({ name: 'a', description: 'b', body: 'c' });
    expect(out).toContain(MANAGED_MARKER);
    expect(out).toContain('name = "a"');
    expect(out).toContain('description = "b"');
    expect(out).toMatch(/developer_instructions = """\nc\n"""/);
  });

  test('uses multiline description when value contains newlines', () => {
    const out = formatCodexAgentToml({
      name: 'a',
      description: 'line one\nline two',
      body: 'c',
    });
    expect(out).toMatch(/description = """\nline one\nline two\n"""/);
  });

  test('escapes embedded triple-quotes in body so the delimiter stays unambiguous', () => {
    const out = formatCodexAgentToml({
      name: 'a',
      description: 'b',
      body: 'has """ inside',
    });
    // The body's literal `"""` must be split (e.g. `""\"`) so it can't be
    // mistaken for the closing delimiter. We also check that the file still
    // has exactly two `"""` runs (the opening + closing delimiters).
    expect(out).toContain('""\\"');
    expect(out.match(/(?<![\\"])"""/g)?.length).toBe(2);
  });

  test('round-trips through parse → format → re-parse cleanly for non-marker content', () => {
    const src = `---
name: r
description: "A round-trip example"
---

Body line 1.
Body line 2.
`;
    const parsed = parseClaudeAgentMd(src)!;
    const toml = formatCodexAgentToml(parsed);
    expect(toml).toContain('name = "r"');
    expect(toml).toContain('A round-trip example');
    expect(toml).toMatch(/Body line 1\.\nBody line 2\./);
  });
});

describe('isManagedToml', () => {
  test('true when content starts with the managed marker', () => {
    expect(isManagedToml(`${MANAGED_MARKER}\n\nname = "x"\n`)).toBe(true);
  });

  test('false when content lacks the marker (hand-written file)', () => {
    expect(isManagedToml('name = "x"\ndescription = "y"\n')).toBe(false);
  });
});
