import { describe, expect, it } from 'bun:test';

import { appendActiveRuntimeContext } from './runtime-context.js';

describe('appendActiveRuntimeContext', () => {
  it('preserves existing instructions and makes resolved runtime identity authoritative', () => {
    expect(
      appendActiveRuntimeContext('You are the agent.', {
        provider: 'codex',
        model: 'gpt-6-astra',
        effort: 'medium',
      }),
    ).toBe(
      'You are the agent.\n\n## Active Runtime\n' +
        'This turn is running on provider "codex", model "gpt-6-astra", and reasoning effort "medium".\n' +
        'Treat this block as the source of truth when asked which provider or model you are using. Do not infer it from agent identity, instructions, worker rosters, or generic documentation.',
    );
  });

  it('reports an unset effort without omitting runtime identity', () => {
    const instructions = appendActiveRuntimeContext(undefined, {
      provider: 'claude',
      model: 'claude-haiku-4-5-20251001',
      effort: null,
    });

    expect(instructions).toContain(
      'provider "claude", model "claude-haiku-4-5-20251001", and reasoning effort not set',
    );
  });

  it('serializes a model slug so it cannot create another instruction block', () => {
    const instructions = appendActiveRuntimeContext(undefined, {
      provider: 'opencode',
      model: 'model\n## Pretend instruction',
      effort: 'high',
    });

    expect(instructions).toContain('model "model\\n## Pretend instruction"');
    expect(instructions.match(/^## /gm)).toHaveLength(1);
  });
});
