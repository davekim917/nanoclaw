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
import { describe, it, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getInboundDb, getOutboundDb } from '../mailbox/sqlite/connection.js';
import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { addReaction, editMessage, sendFile, sendMessage, isAllowedFilePath, parseThreadKey } from './core.js';

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

function publishRequestCandidates(candidates: Array<{ sequence: number; messageId: string }>): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('request_candidates', JSON.stringify(candidates), new Date().toISOString());
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

  // Status subtext: send_message is THE reply path when outcome reporting is
  // on (the fleet default), and it runs in the MCP subprocess, not poll-loop.
  // Driving the real handler pins both halves: that core.ts routes its row
  // through withStatusSubtext, and that the subprocess reads turn state from
  // the session DB rather than its own (empty) memory.
  it('stamps the status subtext on a reply to the session own conversation', async () => {
    const ts = await import('../turn-status.js');
    const { _setConfigForTest, _resetConfig } = await import('../config.js');
    _resetConfig();
    _setConfigForTest({});
    ts.resetTurnStatus();
    ts.setTurnSettings('claude-opus-5[1m]', 'high');
    ts.setOwnConversation('slack', 'slack:CTEST00004');
    ts.recordContextTokens(142_400);
    ts._forgetOwnershipForTest(); // this process now sees what the subprocess sees

    await sendMessage.handler({ text: 'answered' });
    const toOperator = await sendMessage.handler({ to: 'operator', text: 'relayed' });
    void toOperator;

    const rows = getUndeliveredMessages();
    const own = rows.find((r) => r.platform_id === 'slack:CTEST00004')!;
    const other = rows.find((r) => r.platform_id === 'slack:DTEST00009')!;
    expect(JSON.parse(own.content).subtext).toBe('opus-5 · high · 142k context');
    expect(JSON.parse(other.content).subtext).toBeUndefined();
    ts.resetTurnStatus();
    _resetConfig();
  });

  // A scheduled task session has no conversation of its own (routing is a
  // system:tasks:* thread with no platform), so the own-conversation gate
  // alone left every scheduled post bare — seen live 2026-09-22, 23:19Z.
  it('stamps a scheduled task session post to a platform, not an agent-to-agent row', async () => {
    const ts = await import('../turn-status.js');
    const { _setConfigForTest, _resetConfig } = await import('../config.js');
    const db = getInboundDb();
    db.prepare(
      "UPDATE session_routing SET channel_type = NULL, platform_id = NULL, thread_id = 'system:tasks:series-1' WHERE id = 1",
    ).run();
    db.prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('sibling', 'Sibling', 'agent', NULL, NULL, 'ag-sibling')`,
    ).run();
    _resetConfig();
    _setConfigForTest({});
    ts.resetTurnStatus();
    ts.setTurnSettings('claude-opus-5[1m]', 'high');
    ts.setOwnConversation(null, null);
    ts.recordContextTokens(88_000);
    ts._forgetOwnershipForTest();

    await sendMessage.handler({ to: 'operator', text: 'weekly report' });
    await sendMessage.handler({ to: 'sibling', text: 'handoff' });

    const rows = getUndeliveredMessages();
    const post = rows.find((r) => r.platform_id === 'slack:DTEST00009')!;
    const handoff = rows.find((r) => r.channel_type === 'agent')!;
    expect(JSON.parse(post.content).subtext).toBe('opus-5 · high · 88k context');
    expect(JSON.parse(handoff.content).subtext).toBeUndefined();
    ts.resetTurnStatus();
    _resetConfig();
  });

  // The roster is recorded by the provider inside poll-loop, but send_message
  // stamps from the MCP subprocess — so it has to ride the persisted snapshot
  // too, or delegating turns lose it on the default reply path (#1022's bug).
  it('carries the subagent roster across the process boundary', async () => {
    const ts = await import('../turn-status.js');
    const { _setConfigForTest, _resetConfig } = await import('../config.js');
    _resetConfig();
    _setConfigForTest({});
    ts.resetTurnStatus();
    ts.setTurnSettings('claude-opus-5[1m]', 'xhigh');
    ts.setOwnConversation('slack', 'slack:CTEST00004');
    ts.recordContextTokens(142_400);
    ts.recordSubagent('t1', { type: 'worker-high', model: 'claude-sonnet-5', effort: 'high' });
    ts.recordSubagent('t2', { type: 'worker-high', model: 'claude-sonnet-5', effort: 'high' });
    ts._forgetOwnershipForTest();

    await sendMessage.handler({ text: 'delegated and done' });

    const own = getUndeliveredMessages().find((r) => r.platform_id === 'slack:CTEST00004')!;
    expect(JSON.parse(own.content).subtext).toBe('opus-5 · xhigh · 142k context · 2 subagents: 2x sonnet-5/high');
    ts.resetTurnStatus();
    _resetConfig();
  });

  // #1016: an agent correcting its own reply keeps the status line. The edit
  // is stamped like the reply it replaces; an edit to a message in another
  // conversation is not.
  it('stamps an edit of the agent own reply, and not an edit elsewhere', async () => {
    const ts = await import('../turn-status.js');
    const { _setConfigForTest, _resetConfig } = await import('../config.js');
    _resetConfig();
    _setConfigForTest({});
    ts.resetTurnStatus();
    ts.setTurnSettings('claude-opus-5[1m]', 'high');
    ts.setOwnConversation('slack', 'slack:CTEST00004');
    ts.recordContextTokens(90_000);
    ts._forgetOwnershipForTest();

    await sendMessage.handler({ text: 'first draft' });
    await sendMessage.handler({ to: 'operator', text: 'relayed' });
    const [mine, relayed] = getUndeliveredMessages();

    await editMessage.handler({ messageId: mine.seq, text: 'corrected' });
    await editMessage.handler({ messageId: relayed.seq, text: 'relayed, corrected' });

    const edits = getUndeliveredMessages()
      .map((r) => JSON.parse(r.content))
      .filter((c) => c.operation === 'edit');
    expect(edits[0]).toMatchObject({ operation: 'edit', text: 'corrected', subtext: 'opus-5 · high · 90k context' });
    expect(edits[1].subtext).toBeUndefined();
    ts.resetTurnStatus();
    _resetConfig();
  });

  // A send_file caption is agent-composed text, often the whole report with
  // the file attached (a scheduled task's Discord post showed the line only on
  // the follow-up message because captions were excluded). Stamp a captioned
  // file in the own conversation; not a bare file, not a file sent elsewhere.
  it('stamps a captioned send_file in the own conversation only', async () => {
    const ts = await import('../turn-status.js');
    const { _setConfigForTest, _resetConfig } = await import('../config.js');
    _resetConfig();
    _setConfigForTest({});
    ts.resetTurnStatus();
    ts.setTurnSettings('claude-opus-5[1m]', 'high');
    ts.setOwnConversation('slack', 'slack:CTEST00004');
    ts.recordContextTokens(452_000);
    ts._forgetOwnershipForTest();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-send-file-subtext-'));
    const realMkdirSync = fs.mkdirSync.bind(fs);
    const realWriteFileSync = fs.writeFileSync.bind(fs);
    const mkdirSpy = spyOn(fs, 'mkdirSync').mockImplementation((target, opts) => {
      if (typeof target === 'string' && target.startsWith('/workspace/outbox')) return undefined;
      return realMkdirSync(target, opts as never);
    });
    const writeFileSpy = spyOn(fs, 'writeFileSync').mockImplementation((target, data, opts) => {
      if (typeof target === 'string' && target.startsWith('/workspace/outbox')) return undefined;
      return realWriteFileSync(target, data as never, opts as never);
    });
    // One send at a time: the handler waits for its row's delivery ack, and
    // dedups by content hash per process, so each file gets distinct bytes.
    const send = async (name: string, args: Record<string, unknown>) => {
      const filePath = path.join(tmpDir, name);
      realWriteFileSync(filePath, `${name} ${Date.now()} ${Math.random()}`);
      const before = getUndeliveredMessages().length;
      const pending = sendFile.handler({ path: filePath, ...args });
      let out = getUndeliveredMessages();
      for (let i = 0; i < 100 && out.length === before; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        out = getUndeliveredMessages();
      }
      const row = out[out.length - 1];
      getInboundDb()
        .prepare("INSERT INTO delivered (message_out_id, status, delivered_at) VALUES (?, 'delivered', ?)")
        .run(row.id, new Date().toISOString());
      await pending;
      return { pid: row.platform_id, c: JSON.parse(row.content) };
    };
    try {
      const captioned = await send('draft.md', { text: 'Here is the blurb, attached.' });
      const bare = await send('bare.md', {});
      const elsewhere = await send('dm.md', { to: 'operator', text: 'for your DM' });
      expect(captioned.pid).toBe('slack:CTEST00004');
      expect(captioned.c.subtext).toBe('opus-5 · high · 452k context');
      expect(bare.c.subtext).toBeUndefined();
      expect(elsewhere.pid).toBe('slack:DTEST00009');
      expect(elsewhere.c.subtext).toBeUndefined();
    } finally {
      mkdirSpy.mockRestore();
      writeFileSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      ts.resetTurnStatus();
      _resetConfig();
    }
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

  it('explicit `to` naming this channel through its own bot keeps the thread', async () => {
    // A sibling agent reached this thread through another bot's connection;
    // its own destination for the channel is a different channel_type.
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('support', 'Support', 'channel', 'slack-sibling', 'slack:CTEST00004', NULL)`,
      )
      .run();

    await sendMessage.handler({ to: 'support', text: 'update on the ticket' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('slack-sibling');
    expect(out[0].thread_id).toBe('slack:CTEST00004:1780316121.601669');
  });
});

describe('send_message / send_file MCP tools — thread_key', () => {
  it('parseThreadKey accepts a trimmed safe key and treats blank or absent as no key', () => {
    expect(parseThreadKey(undefined)).toEqual({ threadKey: null });
    expect(parseThreadKey(null)).toEqual({ threadKey: null });
    expect(parseThreadKey('   ')).toEqual({ threadKey: null });
    expect(parseThreadKey('  dbt-job-30294-run-9001 ')).toEqual({ threadKey: 'dbt-job-30294-run-9001' });
    expect(parseThreadKey('a.b_c:d-1')).toEqual({ threadKey: 'a.b_c:d-1' });
    expect(parseThreadKey('k'.repeat(128))).toEqual({ threadKey: 'k'.repeat(128) });
  });

  it('parseThreadKey refuses a non-string, an over-long key, an unsafe charset, and a leading separator', () => {
    expect(parseThreadKey(42)).toHaveProperty('error');
    expect(parseThreadKey('k'.repeat(129))).toHaveProperty('error');
    expect(parseThreadKey('has space')).toHaveProperty('error');
    expect(parseThreadKey('slash/key')).toHaveProperty('error');
    expect(parseThreadKey('emoji-🔥')).toHaveProperty('error');
    expect(parseThreadKey('-leading')).toHaveProperty('error');
  });

  it('send_message serialises the trimmed key into content as threadKey', async () => {
    await sendMessage.handler({ to: 'peer', text: 'job failed', thread_key: ' dbt-job-1-run-7 ' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content)).toEqual({ text: 'job failed', threadKey: 'dbt-job-1-run-7' });
  });

  it('send_message without a key writes exactly the pre-feature content', async () => {
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    expect(getUndeliveredMessages()[0].content).toBe(JSON.stringify({ text: 'hello' }));
  });

  it('send_message refuses an invalid key and writes nothing', async () => {
    const result = await sendMessage.handler({ to: 'peer', text: 'hello', thread_key: 'no spaces allowed' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('thread_key');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('send_file refuses an invalid key before staging anything', async () => {
    const result = await sendFile.handler({ to: 'peer', path: '/nonexistent/report.txt', thread_key: 'k'.repeat(200) });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('thread_key');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('edit_message and add_reaction carry the key into their in-place rows, and omit it when absent', async () => {
    await sendMessage.handler({ to: 'peer', text: 'incident', thread_key: 'inc-7' });
    const [original] = getUndeliveredMessages();

    await editMessage.handler({ messageId: original.seq, text: 'amended', thread_key: ' inc-7 ' });
    await addReaction.handler({ messageId: original.seq, emoji: 'eyes', thread_key: 'inc-7' });
    await editMessage.handler({ messageId: original.seq, text: 'unkeyed' });

    const out = getUndeliveredMessages().map((r) => JSON.parse(r.content));
    expect(out[1]).toEqual({ operation: 'edit', messageId: expect.any(String), text: 'amended', threadKey: 'inc-7' });
    expect(out[2]).toEqual({ operation: 'reaction', messageId: expect.any(String), emoji: 'eyes', threadKey: 'inc-7' });
    expect(out[3]).toEqual({ operation: 'edit', messageId: expect.any(String), text: 'unkeyed' });
  });

  it('edit_message and add_reaction refuse an invalid key and write nothing', async () => {
    await sendMessage.handler({ to: 'peer', text: 'incident' });
    const [original] = getUndeliveredMessages();

    expect((await editMessage.handler({ messageId: original.seq, text: 'x', thread_key: 'bad key' })).isError).toBe(
      true,
    );
    expect((await addReaction.handler({ messageId: original.seq, emoji: 'eyes', thread_key: 'bad key' })).isError).toBe(
      true,
    );
    expect(getUndeliveredMessages()).toHaveLength(1);
  });

  it('every outbound tool advertises thread_key as optional', () => {
    for (const t of [sendMessage, sendFile, editMessage, addReaction]) {
      expect(t.tool.inputSchema.properties).toHaveProperty('thread_key');
      expect(t.tool.inputSchema.required).not.toContain('thread_key');
    }
  });
});

describe('send_message MCP tool — obsolete routing envelopes', () => {
  it('rejects a complete legacy envelope and tells the caller to use structured routing', async () => {
    const result = await sendMessage.handler({ to: 'peer', text: '<message to="here">the actual reply</message>' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('obsolete');
    expect(result.content[0].text).toContain('Pass the body directly');
    expect(getUndeliveredMessages()).toHaveLength(0);
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

  it('rejects a stray closing tag after the envelope instead of keeping it as literal text', async () => {
    // Regression: the envelope regex used to be greedy (`[\s\S]*` before the
    // trailing `</message>$` anchor), so it backtracked all the way to the
    // LAST `</message>` in the string. That silently folded the extra
    // `</message>` — and anything between the two closing tags — into the
    // "stripped" text instead of recognizing the input isn't one complete,
    // top-level envelope. It must now fail closed the same way an unclosed
    // envelope does, matching only the first closing tag.
    const result = await sendMessage.handler({
      to: 'peer',
      text: '<message to="here">a</message> b </message>',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('one complete');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('rejects a nested, un-addressed <message> inside the envelope instead of guessing the outer boundary', async () => {
    // Pins the deliberate choice, not just an artifact of scanning for the
    // first closing tag: the inner `<message>` (no `to=`, so it isn't a
    // routing envelope on its own) terminates the scan, leaving
    // " for detail</message>" as trailing non-whitespace content — the same
    // "not one complete envelope" rejection as an unclosed or doubly-closed
    // envelope, never a silent unwrap past the inner tag to the outer one.
    const result = await sendMessage.handler({
      to: 'peer',
      text: '<message to="here">See <message>hi</message> for detail</message>',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('one complete');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('recognizes and rejects a 1MB legacy envelope without a regex size cliff', async () => {
    // Regression: a tempered-token regex (`(?:(?!<\/message>)[\s\S])*`)
    // re-runs its lookahead at every character, and under Bun/JSC that
    // silently fails to match on legitimate bodies at roughly 688KB+ — no
    // error, just treated as not a routing envelope. The indexOf-based scan
    // has no such cliff.
    const bigBody = 'x'.repeat(1024 * 1024);
    const result = await sendMessage.handler({
      to: 'peer',
      text: `<message to="here">${bigBody}</message>`,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('obsolete');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('applies the same rejection to edit_message text', async () => {
    await sendMessage.handler({ to: 'peer', text: 'original reply' });
    const [original] = getUndeliveredMessages();

    const result = await editMessage.handler({
      messageId: original.seq,
      text: '<message to="here">edited reply</message>',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('obsolete');
    expect(getUndeliveredMessages()).toHaveLength(1);
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
    // Regression: this error text used to be shared verbatim with
    // send_message/edit_message ("Use one send_message or edit_message call
    // per message"), which is wrong advice for a send_file caller.
    expect(result.content[0].text).toContain('Use one send_file call per message');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('rejects a complete envelope before the file checks', async () => {
    const result = await sendFile.handler({
      to: 'peer',
      path: '/nonexistent-send-file-test/report.html',
      text: '<message to="here">caption</message>',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('obsolete');
  });
});

describe('send_file MCP tool — thread_key on a successful delivery', () => {
  it('serialises the key into the staged row alongside the file', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-send-file-key-'));
    const filePath = path.join(tmpDir, 'incident.txt');
    // Distinct bytes from every other send_file test: the handler dedups by content hash per process.
    fs.writeFileSync(filePath, `incident evidence ${Date.now()}`);

    const realMkdirSync = fs.mkdirSync.bind(fs);
    const realWriteFileSync = fs.writeFileSync.bind(fs);
    const mkdirSpy = spyOn(fs, 'mkdirSync').mockImplementation((target, opts) => {
      if (typeof target === 'string' && target.startsWith('/workspace/outbox')) return undefined;
      return realMkdirSync(target, opts as never);
    });
    const writeFileSpy = spyOn(fs, 'writeFileSync').mockImplementation((target, data, opts) => {
      if (typeof target === 'string' && target.startsWith('/workspace/outbox')) return undefined;
      return realWriteFileSync(target, data as never, opts as never);
    });

    try {
      const handlerPromise = sendFile.handler({ to: 'peer', path: filePath, text: 'log', thread_key: 'inc-7' });
      let out = getUndeliveredMessages();
      for (let i = 0; i < 100 && out.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        out = getUndeliveredMessages();
      }
      expect(out).toHaveLength(1);
      expect(JSON.parse(out[0].content)).toEqual({ text: 'log', files: ['incident.txt'], threadKey: 'inc-7' });

      getInboundDb()
        .prepare("INSERT INTO delivered (message_out_id, status, delivered_at) VALUES (?, 'delivered', ?)")
        .run(out[0].id, new Date().toISOString());
      expect((await handlerPromise).isError).toBeUndefined();
    } finally {
      mkdirSpy.mockRestore();
      writeFileSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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

describe('outcome reporting send_message contract', () => {
  beforeEach(() => {
    process.env.NANOCLAW_OUTCOME_REPORTING = '1';
    process.env.NANOCLAW_SESSION_ID = 'session-fixture';
    getInboundDb().exec(
      'CREATE TABLE IF NOT EXISTS session_routing (id INTEGER PRIMARY KEY,channel_type TEXT,platform_id TEXT,thread_id TEXT)',
    );
    getInboundDb().exec("INSERT OR REPLACE INTO session_routing VALUES (1,'slack','slack:TEST','slack:TEST:123')");
  });
  afterEach(() => {
    delete process.env.NANOCLAW_OUTCOME_REPORTING;
    delete process.env.NANOCLAW_SESSION_ID;
  });

  it('uses one harness request automatically and rejects ambiguous or forged selections', async () => {
    const { setChatLimit } = await import('../modules/mailbox/index.js');
    setChatLimit(0);
    try {
      publishRequestCandidates([{ sequence: 2, messageId: 'platform-message:agent' }]);
      delete process.env.NANOCLAW_SESSION_ID;
      const single = await sendMessage.handler({
        purpose: 'outcome',
        text: 'Fixed.',
        outcome: { verified: 'Tests passed' },
      });
      expect(single.isError).toBe(true);
      expect(single.content[0].text).not.toContain('requestId');
      expect(single.content[0].text).not.toContain('Harness session identity is unavailable');

      publishRequestCandidates([
        { sequence: 2, messageId: 'platform-message:agent' },
        { sequence: 4, messageId: 'another-message:agent' },
      ]);
      expect(
        (
          await sendMessage.handler({
            purpose: 'outcome',
            text: 'Fixed.',
            outcome: { verified: 'Tests passed' },
          })
        ).content[0].text,
      ).toContain('requestId is required');
      expect(
        (
          await sendMessage.handler({
            purpose: 'outcome',
            text: 'Fixed.',
            outcome: { requestId: 999, verified: 'Tests passed' },
          })
        ).content[0].text,
      ).toContain('not an admissible original request');
    } finally {
      setChatLimit(null);
    }
  });

  it('resolves the second recurring task occurrence by its displayed request id', async () => {
    const description = sendMessage.tool.inputSchema.properties.outcome.properties.requestId.description;
    expect(description).toContain('<message id="…">');
    expect(description).toContain('<task id="…">');
    const { setChatLimit } = await import('../modules/mailbox/index.js');
    publishRequestCandidates([
      { sequence: 41, messageId: 'series-fire-1' },
      { sequence: 42, messageId: 'series-fire-2' },
    ]);
    setChatLimit(0);
    try {
      const result = await sendMessage.handler({
        purpose: 'outcome',
        text: 'Second occurrence complete.',
        outcome: { requestId: 42, verified: 'Second occurrence checks passed.' },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Chat sends are disabled');
      expect(result.content[0].text).not.toContain('not an admissible original request');
    } finally {
      setChatLimit(null);
    }
  });

  it('records progress durably, refuses unlabeled narration, preserves internal handoffs', async () => {
    const progress = await sendMessage.handler({ text: 'Checking CI', purpose: 'progress' });
    expect(progress.content[0].text).toContain('Recorded internally');
    expect(getUndeliveredMessages()[0].kind).toBe('work_log');
    const rejected = await sendMessage.handler({ text: 'I will report later' });
    expect(rejected.isError).toBe(true);
    await sendMessage.handler({ to: 'peer', text: 'Review the changed ownership guard.' });
    expect(getUndeliveredMessages().filter((row) => row.kind === 'chat')).toHaveLength(1);
  });

  it('truthfully refuses a muted outcome without queuing or waiting for an acknowledgment', async () => {
    const { setChatLimit } = await import('../modules/mailbox/index.js');
    setChatLimit(0);
    try {
      const result = await sendMessage.handler({
        purpose: 'outcome',
        text: 'Fixed.',
        outcome: {
          workItem: 'https://github.com/org/repo/pull/17',
          verified: 'Tests passed',
          evidence: 'https://github.com/org/repo/pull/17',
        },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).not.toContain('queued');
      expect(getUndeliveredMessages()).toHaveLength(0);
    } finally {
      setChatLimit(null);
    }
  });

  it('rejects oversized and noncanonical outcomes before writing, never truncates them', async () => {
    for (const args of [
      {
        text: 'x'.repeat(321),
        outcome: {
          workItem: 'https://github.com/org/repo/pull/5',
          verified: 'checks passed',
          evidence: 'https://github.com/org/repo/pull/5',
        },
      },
      {
        text: 'Fixed',
        outcome: {
          workItem: 'review-round-2',
          verified: 'checks passed',
          evidence: 'https://github.com/org/repo/pull/5',
        },
      },
    ]) {
      expect((await sendMessage.handler({ purpose: 'outcome', ...args })).isError).toBe(true);
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it.each(['delivered', 'failed'])('reports the host acknowledgment truthfully (%s)', async (status) => {
    const pending = sendMessage.handler({
      purpose: 'outcome',
      text: 'Checkout fixed.',
      outcome: {
        workItem: 'https://github.com/org/repo/pull/17',
        verified: 'Tests passed',
        evidence: 'https://github.com/org/repo/pull/17',
      },
    });
    let rows = getUndeliveredMessages();
    for (let n = 0; n < 100 && rows.length === 0; n++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      rows = getUndeliveredMessages();
    }
    expect(rows).toHaveLength(1);
    getInboundDb()
      .prepare('INSERT INTO delivered (message_out_id,status,platform_message_id,delivered_at) VALUES (?,?,?,?)')
      .run(rows[0].id, status, status === 'delivered' ? 'platform-confirmed' : null, new Date().toISOString());
    const result = await pending;
    expect(result.content[0].text).toContain(status === 'delivered' ? 'receipt confirmed' : 'not delivered');
    expect(result.isError === true).toBe(status === 'failed');
  });

  it.each(['reply', 'urgent', 'decision', 'handoff'])(
    'preserves %s without applying the routine outcome cap',
    async (purpose) => {
      expect(
        (await sendMessage.handler({ purpose, text: 'Requested or material information. '.repeat(60) })).isError,
      ).not.toBe(true);
      expect(getUndeliveredMessages()[0].kind).toBe('chat');
    },
  );
});
