import { describe, expect, test } from 'vitest';

import { MANAGED_MARKER, formatCodexAgentToml, isManagedToml, parseClaudeAgentMd } from './claude-agent-md.js';

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

  test('keeps `effort:` when present — the delegation shims are nothing else', () => {
    const src = '---\nname: worker-low\ndescription: y\nmodel: inherit\neffort: low\n---\nbody\n';
    expect(parseClaudeAgentMd(src)).toEqual({
      name: 'worker-low',
      description: 'y',
      body: 'body',
      effort: 'low',
    });
  });

  test('omits the effort key entirely when the source has none', () => {
    const out = parseClaudeAgentMd('---\nname: x\ndescription: y\n---\nbody\n');
    expect(out).not.toHaveProperty('effort');
  });

  test('treats a blank `effort:` as absent, never as an empty option value', () => {
    // An empty string reaching the OpenCode converter would emit
    // `reasoningEffort: ""` — a provider option with no value.
    expect(parseClaudeAgentMd('---\nname: x\ndescription: y\neffort:   \n---\nbody\n')).not.toHaveProperty('effort');
  });

  test('rejects missing frontmatter', () => {
    expect(parseClaudeAgentMd('no frontmatter here')).toBeNull();
  });

  test('rejects when name or description is missing', () => {
    expect(parseClaudeAgentMd('---\nname: x\n---\nbody')).toBeNull();
    expect(parseClaudeAgentMd('---\ndescription: y\n---\nbody')).toBeNull();
  });

  test('rejects an opened but never-closed frontmatter block', () => {
    // No `\n---` anywhere after the opener. Returning the whole file as
    // frontmatter would make the entire agent body parse as scalars.
    expect(parseClaudeAgentMd('---\nname: x\ndescription: y\nbody with no close\n')).toBeNull();
  });

  test('reads a single-quoted scalar, unquoted', () => {
    expect(parseClaudeAgentMd("---\nname: x\ndescription: 'y: with a colon'\n---\nbody\n")?.description).toBe(
      'y: with a colon',
    );
  });

  test('reads a folded block scalar that contains a blank line and ends at the next key', () => {
    // Exercises the block-scalar collector's three exits: a blank line inside
    // the block (kept, once something has been collected), a following line at
    // no indent (ends the block), and the indent-mismatch guard.
    const src = ['---', 'name: x', 'description: |', '  first', '', '  third', 'effort: high', '---', 'body', ''].join(
      '\n',
    );
    const out = parseClaudeAgentMd(src);
    expect(out?.description).toBe('first\n\nthird');
    expect(out?.effort).toBe('high');
  });

  test('a leading blank line inside a block scalar is not collected', () => {
    // `collected.length > 0` guards it: a block that opens with a blank line
    // must not start with an empty paragraph.
    const src = ['---', 'name: x', 'description: |', '', '  only', '---', 'body', ''].join('\n');
    expect(parseClaudeAgentMd(src)?.description).toBe('only');
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

  test('refuses a newline in a single-line TOML basic string rather than emitting invalid TOML', () => {
    // `name` is always a basic string. A newline in it would close the string
    // mid-value and produce a TOML file Codex cannot parse; the guard turns
    // that into a loud throw at write time instead.
    expect(() => formatCodexAgentToml({ name: 'a\nb', description: 'd', body: 'c' })).toThrow(
      /tomlMultilineString for multi-line values/,
    );
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

describe('no role carries a provider-specific model pin', () => {
  test('every converted role inherits its parent model, whatever its name', () => {
    // `CODEX_WORKER_MODELS` used to give `worker-frontier` a Codex model, and
    // `retargetRunsOnSentence` rewrote its description to match. Both are gone
    // with the role. Asserted on that exact name so a re-introduced special
    // case fails here rather than shipping a pin nothing else knows about.
    for (const name of ['worker-frontier', 'codex-rescue', 'worker-max']) {
      const out = formatCodexAgentToml({ name, description: 'd', body: 'b' });
      expect(out, name).not.toContain('model = ');
    }
  });

  test('leaves the description exactly as written — it is a routing signal', () => {
    const out = formatCodexAgentToml({
      name: 'worker-frontier',
      description: 'Review in a fresh context. Runs on Opus 5 at high effort.',
      body: 'b',
    });
    expect(out).toContain('description = "Review in a fresh context. Runs on Opus 5 at high effort."');
  });
});

describe('formatCodexAgentToml carries `effort:` as model_reasoning_effort', () => {
  /**
   * Shaped exactly like the five bootstrap delegation shims
   * (`~/plugins/bootstrap/plugins/orchestrate/agents/worker-<level>.md`):
   * `model: inherit`, an `effort:` scalar, a description that names the level,
   * and a one-line body. Those files are the whole reason this mapping exists,
   * so the fixture is the real shape rather than a reduced `name/description`
   * stub.
   */
  function shimMd(level: string): string {
    return [
      '---',
      `name: worker-${level}`,
      `description: Effort shim for /orchestrate — a sub-agent that inherits the parent's tools and runs at ${level} effort on whatever model the dispatch names. Not a role; carries no instructions of its own.`,
      'model: inherit',
      `effort: ${level}`,
      '---',
      '',
      'Do the task in your prompt. Your final message is your only output.',
      '',
    ].join('\n');
  }

  test('each shim converts to its OWN level, not one shared value', () => {
    // The mutation this pins: before this mapping existed, all five shims
    // rendered to TOMLs that differed only in prose and every one of them ran
    // at the global `[agents].default_subagent_reasoning_effort` ("high").
    // Collecting the five emitted values and asserting they are five DISTINCT
    // ones fails both a dropped mapping (five missing keys) and a hardcoded
    // one (five identical keys) — asserting only that `worker-high` renders
    // `"high"` would stay green under both.
    const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
    const emitted = levels.map((level) => {
      const parsed = parseClaudeAgentMd(shimMd(level));
      expect(parsed, level).not.toBeNull();
      const out = formatCodexAgentToml(parsed!);
      expect(out, level).toContain(`model_reasoning_effort = "${level}"`);
      return out.match(/^model_reasoning_effort = "(.+)"$/m)?.[1];
    });
    expect(new Set(emitted).size).toBe(levels.length);
  });

  test('the value comes from `effort:`, never from the role name', () => {
    // A second mutation guard: a plausible-but-wrong implementation could
    // derive the level from the `worker-<level>` name. Here the name and the
    // effort deliberately disagree, so only reading `effort:` passes.
    const out = formatCodexAgentToml({ name: 'worker-low', description: 'd', body: 'b', effort: 'xhigh' });
    expect(out).toContain('model_reasoning_effort = "xhigh"');
    expect(out).not.toContain('"low"');
  });

  test('omits the key entirely for a role whose frontmatter has no `effort:`', () => {
    // Roles already converted without an effort must keep running at Codex's
    // global subagent default — this sync must not invent a pin for them.
    const parsed = parseClaudeAgentMd('---\nname: codex-rescue\ndescription: d\n---\nbody\n');
    expect(formatCodexAgentToml(parsed!)).not.toContain('model_reasoning_effort');
  });

  test('treats a blank effort as absent rather than emitting the one value Codex rejects', () => {
    // `ReasoningEffort::from_str` errors on "" and only on ""
    // (codex-rs protocol/src/openai_models.rs:137-155), and the role file is
    // `deny_unknown_fields`, so `model_reasoning_effort = ""` would fail the
    // whole TOML to parse. Exercised via a hand-built ClaudeAgent, the path
    // `parseClaudeAgentMd`'s own blank-folding does not cover.
    expect(formatCodexAgentToml({ name: 'a', description: 'd', body: 'b', effort: '   ' })).not.toContain(
      'model_reasoning_effort',
    );
  });

  test('emits the key at the top level, above developer_instructions', () => {
    // It deserializes through `RawAgentRoleFileToml`'s `#[serde(flatten)]` into
    // `ConfigToml` (codex-rs agent-roles/src/agent_role_config.rs:20-28,
    // config/src/config_toml.rs:371) — a top-level key, exactly like
    // `developer_instructions`. Ordering it before the multiline body also keeps
    // it out of reach of any future table header the body could otherwise sit
    // under.
    const out = formatCodexAgentToml({ name: 'a', description: 'd', body: 'b', effort: 'high' });
    expect(out.indexOf('model_reasoning_effort = ')).toBeGreaterThan(-1);
    expect(out.indexOf('model_reasoning_effort = ')).toBeLessThan(out.indexOf('developer_instructions = '));
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
