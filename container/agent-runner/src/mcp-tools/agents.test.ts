import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Capture writeMessageOut calls
let writeMessageOutCalls: Array<{ id: string; kind: string; content: string }> = [];
const mockWriteMessageOut = mock((msg: { id: string; kind: string; content: string }) => {
  writeMessageOutCalls.push(msg);
});

// Mock dependencies before importing agents.ts
mock.module('../db/messages-out.js', () => ({
  writeMessageOut: mockWriteMessageOut,
}));

mock.module('./server.js', () => ({
  registerTools: (_tools: unknown) => {}, // no-op in tests
}));

// Import the module under test (after mocks)
const { createAgent } = await import('./agents.js');

// Ensure the real provider registry is loaded (claude registers itself via providers/index.ts)
// We need 'claude' to be in the registry for provider validation tests.
// Import the providers barrel to trigger self-registration.
await import('../providers/index.js');

beforeEach(() => {
  writeMessageOutCalls = [];
  mockWriteMessageOut.mockClear();
});

describe('create_agent handler', () => {
  it('test_create_agent_legacy_call_unchanged: legacy call omits provider/provider_config from payload', async () => {
    const result = await createAgent.handler({ name: 'Legacy', instructions: 'be helpful' });

    expect(result.isError).toBeFalsy();
    expect(mockWriteMessageOut).toHaveBeenCalledTimes(1);

    const payload = JSON.parse(writeMessageOutCalls[0].content);
    expect(payload.action).toBe('create_agent');
    expect(payload.name).toBe('Legacy');
    expect('provider' in payload).toBe(false);
    expect('provider_config' in payload).toBe(false);
  });

  it('test_create_agent_valid_claude_config: valid claude config writes correct system action', async () => {
    const result = await createAgent.handler({
      name: 'Reviewer',
      provider: 'claude',
      provider_config: { model: 'claude-opus-4-7', effort: 'high' },
    });

    expect(result.isError).toBeFalsy();
    expect(mockWriteMessageOut).toHaveBeenCalledTimes(1);

    const payload = JSON.parse(writeMessageOutCalls[0].content);
    expect(payload.provider).toBe('claude');
    expect(payload.provider_config).toEqual({ model: 'claude-opus-4-7', effort: 'high' });
  });

  it('test_create_agent_unknown_provider_rejected: unknown provider returns error; writeMessageOut not called', async () => {
    const result = await createAgent.handler({ name: 'X', provider: 'nonexistent' });

    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toContain('nonexistent');
    expect(text).toContain('Registered:');
    // Should include at least 'claude' in the registered list
    expect(text).toMatch(/claude/i);

    expect(mockWriteMessageOut).not.toHaveBeenCalled();
  });

  it('test_create_agent_unknown_key_rejected: unknown key in provider_config returns error; writeMessageOut not called', async () => {
    const result = await createAgent.handler({
      name: 'X',
      provider: 'claude',
      provider_config: { reasoning_effort: 'high' },
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text.toLowerCase()).toMatch(/reasoning_effort|unrecognized/);

    expect(mockWriteMessageOut).not.toHaveBeenCalled();
  });

  it('test_create_agent_valid_max_effort: effort=max succeeds (5-value enum regression check)', async () => {
    const result = await createAgent.handler({
      name: 'PowerUser',
      provider: 'claude',
      provider_config: { effort: 'max' },
    });

    expect(result.isError).toBeFalsy();
    expect(mockWriteMessageOut).toHaveBeenCalledTimes(1);

    const payload = JSON.parse(writeMessageOutCalls[0].content);
    expect(payload.provider_config).toEqual({ effort: 'max' });
  });

  it('test_create_agent_validation_failure_no_system_action: validation failure writes no system action (C1)', async () => {
    const result = await createAgent.handler({ name: 'X', provider: 'nonexistent' });

    expect(result.isError).toBe(true);
    expect(mockWriteMessageOut).toHaveBeenCalledTimes(0);
  });
});
