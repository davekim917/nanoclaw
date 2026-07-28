/**
 * Tests for child-only MCP tools: spawn_progress, spawn_complete, spawn_failed.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import type { WriteMessageOut } from '../db/messages-out.js';
import { createSpawnChildTools } from './dispatch-child.js';

let sessionTaskId: string | null = null;
let outbound: WriteMessageOut[] = [];

const { spawnProgress, spawnComplete, spawnFailed } = createSpawnChildTools({
  getSessionSpawnTaskId: () => sessionTaskId,
  writeMessageOut: (message) => {
    outbound.push(message);
    return 1;
  },
  makeSystemId: () => `spawn-child-test-${outbound.length + 1}`,
  log: () => {},
});

function createSessionRoutingWithTaskId(taskId: string | null): void {
  sessionTaskId = taskId;
}

function firstAction(): Record<string, unknown> {
  expect(outbound.length).toBeGreaterThan(0);
  return JSON.parse(outbound[0].content) as Record<string, unknown>;
}

beforeEach(() => {
  sessionTaskId = null;
  outbound = [];
});

describe('spawn_progress', () => {
  it('test_spawn_progress_auto_fills_task_id', async () => {
    createSessionRoutingWithTaskId('spawn-test123');
    await spawnProgress.handler({ message: 'half done' });

    const parsed = firstAction();
    expect(parsed.action).toBe('spawn_progress');
    expect(parsed.task_id).toBe('spawn-test123');
    expect(parsed.message).toBe('half done');
  });

  it('test_spawn_progress_allows_explicit_task_id_override', async () => {
    createSessionRoutingWithTaskId('spawn-auto');
    await spawnProgress.handler({ message: 'override test', task_id: 'spawn-override' });

    expect(firstAction().task_id).toBe('spawn-override');
  });

  it('test_spawn_progress_requires_message', async () => {
    createSessionRoutingWithTaskId('spawn-abc');
    const result = await spawnProgress.handler({});
    expect(result.isError).toBe(true);
    expect(outbound).toHaveLength(0);
  });

  it('test_spawn_progress_without_session_spawn_task_id_returns_error', async () => {
    createSessionRoutingWithTaskId(null);
    const result = await spawnProgress.handler({ message: 'test' });
    expect(result.isError).toBe(true);
    expect(outbound).toHaveLength(0);
  });
});

describe('spawn_complete', () => {
  it('test_spawn_complete_terminal_state', async () => {
    createSessionRoutingWithTaskId('spawn-x');
    await spawnComplete.handler({ summary: 'All done successfully' });

    const parsed = firstAction();
    expect(parsed.action).toBe('spawn_complete');
    expect(parsed.task_id).toBe('spawn-x');
    expect(parsed.summary).toBe('All done successfully');
  });

  it('test_spawn_complete_requires_summary', async () => {
    createSessionRoutingWithTaskId('spawn-x');
    const result = await spawnComplete.handler({});
    expect(result.isError).toBe(true);
    expect(outbound).toHaveLength(0);
  });
});

describe('spawn_failed', () => {
  it('test_spawn_failed_with_reason', async () => {
    createSessionRoutingWithTaskId('spawn-x');
    await spawnFailed.handler({ summary: 'Bad failure', fail_reason: 'agent_error' });

    const parsed = firstAction();
    expect(parsed.action).toBe('spawn_failed');
    expect(parsed.task_id).toBe('spawn-x');
    expect(parsed.summary).toBe('Bad failure');
    expect(parsed.fail_reason).toBe('agent_error');
  });

  it('test_spawn_failed_without_fail_reason', async () => {
    createSessionRoutingWithTaskId('spawn-y');
    await spawnFailed.handler({ summary: 'Unknown failure' });

    const parsed = firstAction();
    expect(parsed.action).toBe('spawn_failed');
    expect(parsed.fail_reason).toBeUndefined();
  });

  it('test_spawn_failed_auto_fills_task_id', async () => {
    createSessionRoutingWithTaskId('spawn-auto-fill');
    await spawnFailed.handler({ summary: 'Failed' });

    expect(firstAction().task_id).toBe('spawn-auto-fill');
  });
});
