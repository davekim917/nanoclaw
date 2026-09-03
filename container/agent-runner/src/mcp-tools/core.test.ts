/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 *
 * The stamp is published through session_state in outbound.db, not module
 * state — the MCP server runs as a separate stdio subprocess from the poll
 * loop, so it can only see the stamp through the shared DB. These tests seed
 * it the same way the poll-loop process does (a direct DB write) rather than
 * via any in-memory helper, so they exercise the real process boundary.
 */
import { describe, it, test, expect, beforeEach, afterEach } from 'bun:test';

import { getInboundDb, getOutboundDb } from '../mailbox/sqlite/connection.js';
import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { sendMessage, isAllowedFilePath } from './core.js';

/**
 * Publish the a2a reply stamp the way the poll loop does: a direct write to
 * session_state in outbound.db. `ageMs` back-dates updated_at to exercise the
 * staleness guard MCP tools apply when reading it.
 */
function publishInReplyTo(id: string, ageMs = 0): void {
  const updatedAt = new Date(Date.now() - ageMs).toISOString();
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('current_in_reply_to', id, updatedAt);
}

beforeEach(() => {
  initTestSessionDb();
  // Seed a peer agent destination
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps the batch in_reply_to (published via the DB) on outbound rows', async () => {
    publishInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no batch is active', async () => {
    // Nothing published to session_state — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });

  it('ignores a stale stamp left behind by a killed container', async () => {
    publishInReplyTo('inbound-msg-1', 60 * 60 * 1000); // an hour old

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });
});

describe('send_message MCP tool — default replies in the current conversation', () => {
  // Regression for the /team-auto-to-DM bug: omitting `to` must post in the
  // session's own thread, even when an owner-DM destination exists. Only an
  // explicit `to` redirects elsewhere.
  beforeEach(() => {
    const db = getInboundDb();
    db.exec(
      'CREATE TABLE IF NOT EXISTS session_routing (id INTEGER PRIMARY KEY, channel_type TEXT, platform_id TEXT, thread_id TEXT)',
    );
    db.prepare(
      "INSERT INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, 'slack', 'slack:CTEST00004', 'slack:CTEST00004:1780316121.601669')",
    ).run();
    // An owner-DM destination the agent could (wrongly) redirect to.
    db.prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('operator', 'Operator', 'channel', 'slack', 'slack:DTEST00009', NULL)`,
    ).run();
  });

  it('omitting `to` posts in the session thread, not the owner DM', async () => {
    await sendMessage.handler({ text: 'team-auto: build stage done' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('slack:CTEST00004');
    expect(out[0].thread_id).toBe('slack:CTEST00004:1780316121.601669');
  });

  it('explicit `to` still redirects to the DM (channel-root, no thread)', async () => {
    await sendMessage.handler({ to: 'operator', text: 'explicitly DM you' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('slack:DTEST00009');
    expect(out[0].thread_id).toBeNull();
  });
});

describe('send_file allowlist (Group G — workgroup shared tree)', () => {
  test('test_send_file_allows_workgroup: a /workspace/workgroup path is allowed', () => {
    expect(isAllowedFilePath('/workspace/workgroup/repos/svc/report.png')).toBe(true);
    expect(isAllowedFilePath('/workspace/workgroup')).toBe(true);
    // Existing prefixes remain allowed (no regression).
    expect(isAllowedFilePath('/workspace/agent/x.txt')).toBe(true);
    expect(isAllowedFilePath('/workspace/worktrees/svc/y.txt')).toBe(true);
  });

  test('test_send_file_rejects_outside: a path outside all prefixes is rejected', () => {
    expect(isAllowedFilePath('/etc/passwd')).toBe(false);
    expect(isAllowedFilePath('/home/node/.codex/auth.json')).toBe(false);
    expect(isAllowedFilePath('/workspace/secrets')).toBe(false);
  });

  test('test_send_file_rejects_prefix_lookalike: boundary holds — lookalike rejected, real path allowed', () => {
    // The matcher uses a path-separator boundary, so a sibling dir that merely
    // shares the prefix STRING does not satisfy the allowlist.
    expect(isAllowedFilePath('/workspace/workgroup-evil/x')).toBe(false);
    expect(isAllowedFilePath('/workspace/agentXYZ/secret')).toBe(false);
    // ...while the genuine prefixed path still passes.
    expect(isAllowedFilePath('/workspace/workgroup/x')).toBe(true);
  });
});
