import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createGate,
  getGateById,
  getPendingGate,
  getPendingGateByJid,
  resolveGate,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

function makeGate(overrides: Partial<{
  id: string;
  group_folder: string;
  chat_jid: string;
  label: string;
  summary: string;
  context_data: string | null;
  resume_prompt: string | null;
  session_key: string | null;
  status: 'pending' | 'approved' | 'cancelled';
}> = {}) {
  return {
    id: overrides.id || `gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    group_folder: overrides.group_folder || 'test-group',
    chat_jid: overrides.chat_jid || 'dc:123456',
    label: overrides.label || 'Test Gate',
    summary: overrides.summary || 'Are you sure?',
    context_data: overrides.context_data ?? null,
    resume_prompt: overrides.resume_prompt ?? null,
    session_key: overrides.session_key ?? null,
    status: overrides.status || 'pending',
    created_at: new Date().toISOString(),
  };
}

describe('createGate', () => {
  it('creates a gate and retrieves it by ID', () => {
    const gate = makeGate({ id: 'gate-1' });
    createGate(gate);

    const retrieved = getGateById('gate-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe('gate-1');
    expect(retrieved!.label).toBe('Test Gate');
    expect(retrieved!.summary).toBe('Are you sure?');
    expect(retrieved!.status).toBe('pending');
    expect(retrieved!.resolved_at).toBeNull();
  });

  it('stores context_data as JSON', () => {
    const contextData = JSON.stringify({ emails: ['a@b.com', 'c@d.com'], count: 2 });
    const gate = makeGate({ id: 'gate-ctx', context_data: contextData });
    createGate(gate);

    const retrieved = getGateById('gate-ctx');
    expect(retrieved!.context_data).toBe(contextData);
    const parsed = JSON.parse(retrieved!.context_data!);
    expect(parsed.emails).toHaveLength(2);
    expect(parsed.count).toBe(2);
  });

  it('stores resume_prompt', () => {
    const gate = makeGate({ id: 'gate-rp', resume_prompt: 'Call read_gate_context and send emails.' });
    createGate(gate);

    const retrieved = getGateById('gate-rp');
    expect(retrieved!.resume_prompt).toBe('Call read_gate_context and send emails.');
  });
});

describe('getPendingGate', () => {
  it('returns the most recent pending gate for a group', () => {
    const gateOld = makeGate({ id: 'gate-old', group_folder: 'grp1' });
    gateOld.created_at = '2026-01-01T00:00:00.000Z';
    createGate(gateOld);

    const gateNew = makeGate({ id: 'gate-new', group_folder: 'grp1' });
    gateNew.created_at = '2026-01-01T00:01:00.000Z';
    createGate(gateNew);

    const pending = getPendingGate('grp1');
    expect(pending).not.toBeNull();
    // Should return the most recent (gate-new)
    expect(pending!.id).toBe('gate-new');
  });

  it('returns null when no pending gates exist', () => {
    const pending = getPendingGate('empty-group');
    expect(pending).toBeNull();
  });

  it('does not return resolved gates', () => {
    createGate(makeGate({ id: 'gate-resolved', group_folder: 'grp2' }));
    resolveGate('gate-resolved', 'approved');

    const pending = getPendingGate('grp2');
    expect(pending).toBeNull();
  });
});

describe('getPendingGateByJid', () => {
  it('returns the pending gate for a specific chat JID', () => {
    createGate(makeGate({ id: 'gate-jid', chat_jid: 'dc:999' }));

    const pending = getPendingGateByJid('dc:999');
    expect(pending).not.toBeNull();
    expect(pending!.id).toBe('gate-jid');
  });

  it('returns null for unrelated JID', () => {
    createGate(makeGate({ id: 'gate-other', chat_jid: 'dc:111' }));

    const pending = getPendingGateByJid('dc:222');
    expect(pending).toBeNull();
  });
});

describe('resolveGate', () => {
  it('approves a pending gate', () => {
    createGate(makeGate({ id: 'gate-approve' }));

    const resolved = resolveGate('gate-approve', 'approved');
    expect(resolved).toBe(true);

    const gate = getGateById('gate-approve');
    expect(gate!.status).toBe('approved');
    expect(gate!.resolved_at).not.toBeNull();
  });

  it('cancels a pending gate', () => {
    createGate(makeGate({ id: 'gate-cancel' }));

    const resolved = resolveGate('gate-cancel', 'cancelled');
    expect(resolved).toBe(true);

    const gate = getGateById('gate-cancel');
    expect(gate!.status).toBe('cancelled');
    expect(gate!.resolved_at).not.toBeNull();
  });

  it('returns false for non-existent gate', () => {
    const resolved = resolveGate('gate-nonexistent', 'approved');
    expect(resolved).toBe(false);
  });

  it('returns false when resolving an already-resolved gate', () => {
    createGate(makeGate({ id: 'gate-double' }));
    resolveGate('gate-double', 'approved');

    // Try to resolve again
    const resolved = resolveGate('gate-double', 'cancelled');
    expect(resolved).toBe(false);

    // Status should remain approved
    const gate = getGateById('gate-double');
    expect(gate!.status).toBe('approved');
  });

  it('does not affect other gates when resolving one', () => {
    createGate(makeGate({ id: 'gate-a', group_folder: 'grp' }));
    createGate(makeGate({ id: 'gate-b', group_folder: 'grp' }));

    resolveGate('gate-a', 'approved');

    const gateA = getGateById('gate-a');
    const gateB = getGateById('gate-b');
    expect(gateA!.status).toBe('approved');
    expect(gateB!.status).toBe('pending');
  });
});

describe('gate protocol integration', () => {
  it('full lifecycle: create → pending → approve → read context', () => {
    const contextData = JSON.stringify({ tables: ['old_data', 'temp_logs', 'cache_v1'] });
    createGate(makeGate({
      id: 'gate-lifecycle',
      group_folder: 'dev',
      chat_jid: 'dc:456',
      label: 'Drop tables',
      summary: 'About to drop 3 tables: old_data, temp_logs, cache_v1',
      context_data: contextData,
      resume_prompt: 'User approved. Call read_gate_context with gate_id "gate-lifecycle", then drop the tables.',
    }));

    // Verify it's pending
    const pending = getPendingGateByJid('dc:456');
    expect(pending).not.toBeNull();
    expect(pending!.label).toBe('Drop tables');

    // Approve it
    resolveGate('gate-lifecycle', 'approved');

    // No longer pending
    const pendingAfter = getPendingGateByJid('dc:456');
    expect(pendingAfter).toBeNull();

    // Context is still readable
    const gate = getGateById('gate-lifecycle');
    expect(gate!.status).toBe('approved');
    expect(gate!.context_data).toBe(contextData);
    const tables = JSON.parse(gate!.context_data!).tables;
    expect(tables).toEqual(['old_data', 'temp_logs', 'cache_v1']);
  });
});
