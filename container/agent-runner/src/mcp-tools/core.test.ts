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
import { editMessage, sendFile, sendMessage, isAllowedFilePath } from './core.js';

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

describe('send_message MCP tool — final-output envelope normalization', () => {
  it('removes an accidentally nested final-output envelope before writing the chat text', async () => {
    await sendMessage.handler({ to: 'peer', text: '<message to="here">the actual reply</message>' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('the actual reply');
  });

  it('uses the current conversation when the tool omits `to`, regardless of the envelope destination', async () => {
    const db = getInboundDb();
    db.exec(
      'CREATE TABLE IF NOT EXISTS session_routing (id INTEGER PRIMARY KEY, channel_type TEXT, platform_id TEXT, thread_id TEXT)',
    );
    db.prepare(
      "INSERT INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, 'slack', 'C-CURRENT', 'thread-current')",
    ).run();

    await sendMessage.handler({ text: '<message to="other">reply in place</message>' });

    const [out] = getUndeliveredMessages();
    expect(out.platform_id).toBe('C-CURRENT');
    expect(out.thread_id).toBe('thread-current');
    expect(JSON.parse(out.content).text).toBe('reply in place');
  });

  it('keeps the explicit tool destination authoritative over the envelope destination', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('other', 'Other', 'agent', NULL, NULL, 'ag-other')`,
      )
      .run();

    await sendMessage.handler({ to: 'peer', text: '<message to="other">reply to peer</message>' });

    const [out] = getUndeliveredMessages();
    expect(out.platform_id).toBe('ag-peer');
    expect(JSON.parse(out.content).text).toBe('reply to peer');
  });

  it('preserves plain text, ordinary XML, inline XML examples, and fenced examples unchanged', async () => {
    const plain = 'Plain reply.';
    const ordinaryXml = '<message>ordinary XML</message>';
    const inline = 'Document `<message to="here">body</message>` exactly.';
    const fenced = '```xml\n<message to="here">body</message>\n```';

    await sendMessage.handler({ to: 'peer', text: plain });
    await sendMessage.handler({ to: 'peer', text: ordinaryXml });
    await sendMessage.handler({ to: 'peer', text: inline });
    await sendMessage.handler({ to: 'peer', text: fenced });

    const texts = getUndeliveredMessages().map((row) => JSON.parse(row.content).text);
    expect(texts).toEqual([plain, ordinaryXml, inline, fenced]);
  });

  it('rejects multiple addressed envelopes without writing a potentially misrouted message', async () => {
    const result = await sendMessage.handler({
      to: 'peer',
      text: '<message to="peer">private detail</message><message to="other">separate detail</message>',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('multiple routing message envelopes');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('rejects an unclosed routing envelope instead of leaking it literally', async () => {
    const result = await sendMessage.handler({ to: 'peer', text: '<message to="here">unfinished reply' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('one complete');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('applies the same normalization to edit_message text', async () => {
    await sendMessage.handler({ to: 'peer', text: 'original reply' });
    const [original] = getUndeliveredMessages();

    await editMessage.handler({ messageId: original.seq, text: '<message to="here">edited reply</message>' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[1].content)).toMatchObject({ operation: 'edit', text: 'edited reply' });
  });
});

describe('send_file MCP tool — caption envelope normalization', () => {
  // The delivered path needs a real file under /workspace plus a host delivery
  // ack, so it cannot run hermetically. These pin the wiring; the strip itself
  // is the same normalizeToolMessageText the send_message cases cover.
  it('rejects an unclosed routing envelope in the caption before staging anything', async () => {
    const result = await sendFile.handler({
      to: 'peer',
      path: '/workspace/agent/report.html',
      text: '<message to="here">unfinished caption',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('one complete');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('rejects multiple addressed envelopes in the caption', async () => {
    const result = await sendFile.handler({
      to: 'peer',
      path: '/workspace/agent/report.html',
      text: '<message to="here">a</message><message to="other">b</message>',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('multiple routing message envelopes');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('passes a complete envelope through to the file checks', async () => {
    const result = await sendFile.handler({
      to: 'peer',
      path: '/nonexistent-send-file-test/report.html',
      text: '<message to="here">caption</message>',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('File not found');
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
