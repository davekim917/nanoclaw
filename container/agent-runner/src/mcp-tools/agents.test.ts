import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getOutboundDb } from '../db/connection.js';

// NOTE: do NOT mock.module('../db/messages-out.js') here. bun runs every test
// file sequentially in ONE process and mock.module is process-global and
// permanent (mock.restore does not undo it), so stubbing writeMessageOut left
// every later file's outbound writes going nowhere — wait/core/dispatch went
// red purely on readdir order. Assert against the real in-memory session DB
// instead, the same way core.test.ts and wait.test.ts do.
mock.module('./server.js', () => ({
  registerTools: (_tools: unknown) => {}, // no-op in tests
}));

// Import the module under test (after mocks)
const { createAgent } = await import('./agents.js');

// Ensure the real provider registry is loaded (claude registers itself via providers/index.ts)
// We need 'claude' to be in the registry for provider validation tests.
// Import the providers barrel to trigger self-registration.
await import('../providers/index.js');

/** The system actions create_agent wrote this test, oldest first. */
function systemActions(): Array<Record<string, unknown>> {
  const rows = getOutboundDb()
    .prepare(`SELECT content FROM messages_out WHERE kind = 'system' ORDER BY seq ASC`)
    .all() as Array<{ content: string }>;
  return rows.map((r) => JSON.parse(r.content) as Record<string, unknown>);
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('create_agent handler', () => {
  it('test_create_agent_legacy_call_unchanged: legacy call omits provider/provider_config from payload', async () => {
    const result = await createAgent.handler({ name: 'Legacy', instructions: 'be helpful' });

    expect(result.isError).toBeFalsy();
    expect(systemActions()).toHaveLength(1);

    const payload = systemActions()[0];
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
    expect(systemActions()).toHaveLength(1);

    const payload = systemActions()[0];
    expect(payload.provider).toBe('claude');
    expect(payload.provider_config).toEqual({ model: 'claude-opus-4-7', effort: 'high' });
  });

  it('test_create_agent_unknown_provider_rejected: unknown provider returns error; no system action written', async () => {
    const result = await createAgent.handler({ name: 'X', provider: 'nonexistent' });

    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toContain('nonexistent');
    expect(text).toContain('Registered:');
    // Should include at least 'claude' in the registered list
    expect(text).toMatch(/claude/i);

    expect(systemActions()).toHaveLength(0);
  });

  it('test_create_agent_unknown_key_rejected: unknown key in provider_config returns error; no system action written', async () => {
    const result = await createAgent.handler({
      name: 'X',
      provider: 'claude',
      provider_config: { reasoning_effort: 'high' },
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text.toLowerCase()).toMatch(/reasoning_effort|unrecognized/);

    expect(systemActions()).toHaveLength(0);
  });

  it('test_create_agent_valid_max_effort: effort=max succeeds (5-value enum regression check)', async () => {
    const result = await createAgent.handler({
      name: 'PowerUser',
      provider: 'claude',
      provider_config: { effort: 'max' },
    });

    expect(result.isError).toBeFalsy();
    expect(systemActions()).toHaveLength(1);

    const payload = systemActions()[0];
    expect(payload.provider_config).toEqual({ effort: 'max' });
  });

  it('test_create_agent_validation_failure_no_system_action: validation failure writes no system action (C1)', async () => {
    const result = await createAgent.handler({ name: 'X', provider: 'nonexistent' });

    expect(result.isError).toBe(true);
    expect(systemActions()).toHaveLength(0);
  });
});
