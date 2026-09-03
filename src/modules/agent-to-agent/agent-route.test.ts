import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { forwardAttachedFiles, isSafeAttachmentName, routeAgentMessage } from './agent-route.js';
import { log } from '../../log.js';
import { createDestination } from './db/agent-destinations.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createSession, updateSession } from '../../db/sessions.js';
import { initSessionFolder, inboundDbPath, sessionDir, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-a2a-route') }));

function now(): string {
  return new Date().toISOString();
}

function readPairedInboundTriggers(agentGroupId: string, sessionId: string) {
  const db = new Database(inboundDbPath(agentGroupId, sessionId), { readonly: true });
  const rows = db
    .prepare(
      'SELECT id, seq, kind, trigger, platform_id, channel_type, content, source_session_id FROM messages_in ORDER BY seq',
    )
    .all() as Array<{
    id: string;
    seq: number;
    kind: string;
    trigger: number;
    platform_id: string | null;
    channel_type: string | null;
    content: string;
    source_session_id: string | null;
  }>;
  db.close();
  const triggers = rows.filter((row) => row.trigger === 1 && row.kind !== 'system');
  const recallRows = rows.filter((row) => {
    if (row.kind !== 'system' || row.trigger !== 0) return false;
    const content = JSON.parse(row.content) as { subtype?: string };
    return content.subtype === 'recall_context';
  });
  expect(recallRows).toHaveLength(triggers.length);
  for (const trigger of triggers) {
    const index = rows.indexOf(trigger);
    const recall = rows[index - 1];
    expect(recall).toMatchObject({
      id: `recall-${trigger.id}`,
      kind: 'system',
      trigger: 0,
      seq: trigger.seq - 2,
    });
    expect(JSON.parse(recall!.content)).toMatchObject({ subtype: 'recall_context' });
  }
  return triggers;
}

describe('isSafeAttachmentName', () => {
  it('accepts plain filenames', async () => {
    expect(isSafeAttachmentName('baby-duck.png')).toBe(true);
    expect(isSafeAttachmentName('file with spaces.pdf')).toBe(true);
    expect(isSafeAttachmentName('report.v2.docx')).toBe(true);
    expect(isSafeAttachmentName('.hidden')).toBe(true);
  });

  it('rejects empty / sentinel values', async () => {
    expect(isSafeAttachmentName('')).toBe(false);
    expect(isSafeAttachmentName('.')).toBe(false);
    expect(isSafeAttachmentName('..')).toBe(false);
  });

  it('rejects path separators', async () => {
    expect(isSafeAttachmentName('../evil.png')).toBe(false);
    expect(isSafeAttachmentName('/etc/passwd')).toBe(false);
    expect(isSafeAttachmentName('nested/file.txt')).toBe(false);
    expect(isSafeAttachmentName('windows\\path.exe')).toBe(false);
  });

  it('rejects NUL bytes', async () => {
    expect(isSafeAttachmentName('clean\0.png')).toBe(false);
  });

  it('rejects anything path.basename would strip', async () => {
    expect(isSafeAttachmentName('a/b')).toBe(false);
    expect(isSafeAttachmentName('./thing')).toBe(false);
  });

  it('rejects non-string input', async () => {
    expect(isSafeAttachmentName(null as unknown as string)).toBe(false);
    expect(isSafeAttachmentName(undefined as unknown as string)).toBe(false);
  });
});

/**
 * Return-path routing: when an a2a reply targets an agent group with multiple
 * sessions, it must land in the *originating* session — not the newest one.
 *
 * Setup: agent A has two active sessions S1 (older) + S2 (newer).
 * Agent B is the peer A talks to. Bidirectional destinations wired.
 */
describe('routeAgentMessage return-path', () => {
  const A = 'ag-A';
  const B = 'ag-B';
  let S1: Session;
  let S2: Session;
  let SB: Session;

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = initTestDb();
    runMigrations(db);

    createAgentGroup({ id: A, name: 'A', folder: 'a', agent_provider: null, created_at: now() });
    createAgentGroup({ id: B, name: 'B', folder: 'b', agent_provider: null, created_at: now() });

    // S1 (older), S2 (newer) — both active sessions on A.
    S1 = {
      id: 'sess-A-old',
      agent_group_id: A,
      messaging_group_id: null,
      // Distinct non-system thread: migration 049 folds NULLs, so a second
      // active NULL/NULL session on A would be rejected at insert. A named
      // thread keeps S1 eligible for findSessionByAgentGroup's newest-first
      // lookup (it only excludes 'system:%' threads), which these tests need.
      thread_id: 'thr-A-old',
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    S2 = {
      id: 'sess-A-new',
      agent_group_id: A,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-02-01T00:00:00.000Z',
    };
    SB = {
      id: 'sess-B',
      agent_group_id: B,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-01-15T00:00:00.000Z',
    };
    createSession(S1);
    createSession(S2);
    createSession(SB);
    initSessionFolder(A, S1.id);
    initSessionFolder(A, S2.id);
    initSessionFolder(B, SB.id);

    createDestination({
      agent_group_id: A,
      local_name: 'b',
      target_type: 'agent',
      target_id: B,
      created_at: now(),
    });
    createDestination({
      agent_group_id: B,
      local_name: 'a',
      target_type: 'agent',
      target_id: A,
      created_at: now(),
    });
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('forward direction: stamps source_session_id on the target inbound row', async () => {
    // A.S1 emits an outbound a2a to B.
    await routeAgentMessage(
      {
        id: 'msg-from-A-S1',
        platform_id: B,
        content: JSON.stringify({ text: 'hello B' }),
        in_reply_to: null,
      },
      S1,
    );

    const bRows = readPairedInboundTriggers(B, SB.id);
    expect(bRows).toHaveLength(1);
    expect(bRows[0].platform_id).toBe(A);
    expect(bRows[0].source_session_id).toBe(S1.id); // <- the return address
  });

  it('reply direction: routes back to the originating session, not the newest', async () => {
    // A.S1 sends to B.
    await routeAgentMessage(
      {
        id: 'msg-from-A-S1',
        platform_id: B,
        content: JSON.stringify({ text: 'ping' }),
        in_reply_to: null,
      },
      S1,
    );

    // Capture the synthetic id the host stamped on B's inbound — that's what
    // B's container would reference as `in_reply_to` when replying.
    const bRows = readPairedInboundTriggers(B, SB.id);
    const yId = bRows[0].id;

    // B replies to that message.
    await routeAgentMessage(
      {
        id: 'msg-from-B',
        platform_id: A,
        content: JSON.stringify({ text: 'pong' }),
        in_reply_to: yId,
      },
      SB,
    );

    const s1Rows = readPairedInboundTriggers(A, S1.id);
    const s2Rows = readPairedInboundTriggers(A, S2.id);

    // The reply lands in S1 (originator) even though S2 is newer.
    expect(s1Rows).toHaveLength(1);
    expect(s1Rows[0].platform_id).toBe(B);
    expect(JSON.parse(s1Rows[0].content).text).toBe('pong');
    expect(s2Rows).toHaveLength(0);
  });

  it('fallback: a2a with no in_reply_to falls through to newest-session lookup', async () => {
    // No prior conversation. B initiates an a2a to A out of the blue.
    await routeAgentMessage(
      {
        id: 'msg-from-B-fresh',
        platform_id: A,
        content: JSON.stringify({ text: 'unsolicited' }),
        in_reply_to: null,
      },
      SB,
    );

    // Newest session wins (current heuristic, preserved).
    const s1Rows = readPairedInboundTriggers(A, S1.id);
    const s2Rows = readPairedInboundTriggers(A, S2.id);
    expect(s1Rows).toHaveLength(0);
    expect(s2Rows).toHaveLength(1);
  });

  it('peer-affinity fallback: with no in_reply_to, routes to most recent peer-source session', async () => {
    // A.S1 sends to B (establishing affinity: B's last contact from A was via S1).
    await routeAgentMessage(
      {
        id: 'msg-from-A-S1-pre',
        platform_id: B,
        content: JSON.stringify({ text: 'context-establishing' }),
        in_reply_to: null,
      },
      S1,
    );

    // B sends a follow-up but its container forgot to set in_reply_to (e.g.
    // emitted via an MCP tool path that doesn't thread the batch's in_reply_to
    // through). The host should still route this to S1 because S1 is the
    // session most recently in conversation with B — not the chronologically
    // newest session of A.
    await routeAgentMessage(
      {
        id: 'msg-from-B-followup',
        platform_id: A,
        content: JSON.stringify({ text: 'standing by' }),
        in_reply_to: null,
      },
      SB,
    );

    const s1Rows = readPairedInboundTriggers(A, S1.id);
    const s2Rows = readPairedInboundTriggers(A, S2.id);
    // Affinity wins: reply to S1, not the newer S2.
    expect(s1Rows).toHaveLength(1);
    expect(JSON.parse(s1Rows[0].content).text).toBe('standing by');
    expect(s2Rows).toHaveLength(0);
  });

  it('stale origin fallback: closed origin session falls through to newest active', async () => {
    // A.S1 sends to B, establishing source_session_id = S1.id on B's inbound.
    await routeAgentMessage(
      { id: 'msg-fwd', platform_id: B, content: JSON.stringify({ text: 'hello' }), in_reply_to: null },
      S1,
    );
    const bRows = readPairedInboundTriggers(B, SB.id);
    const inboundId = bRows[0].id;

    // Close S1 — simulates session cleanup or channel disconnect.
    updateSession(S1.id, { status: 'closed' });

    // B replies. origin points to S1 (closed), should fall through to S2.
    await routeAgentMessage(
      { id: 'msg-reply-stale', platform_id: A, content: JSON.stringify({ text: 'reply' }), in_reply_to: inboundId },
      SB,
    );

    const s1Rows = readPairedInboundTriggers(A, S1.id);
    const s2Rows = readPairedInboundTriggers(A, S2.id);
    expect(s1Rows).toHaveLength(0);
    expect(s2Rows).toHaveLength(1);
  });

  it('cross-agent-group guard: origin session belonging to wrong agent group is rejected', async () => {
    // Third agent group C sends to B, stamping source_session_id = SC on B's inbound.
    const C = 'ag-C';
    createAgentGroup({ id: C, name: 'C', folder: 'c', agent_provider: null, created_at: now() });
    const SC: Session = {
      id: 'sess-C',
      agent_group_id: C,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-03-01T00:00:00.000Z',
    };
    createSession(SC);
    initSessionFolder(C, SC.id);
    createDestination({ agent_group_id: C, local_name: 'b', target_type: 'agent', target_id: B, created_at: now() });

    await routeAgentMessage(
      { id: 'msg-from-C', platform_id: B, content: JSON.stringify({ text: 'from C' }), in_reply_to: null },
      SC,
    );
    const bRows = readPairedInboundTriggers(B, SB.id);
    const cInboundId = bRows.find((r) => r.platform_id === C)!.id;

    // B replies to A, but in_reply_to references the C-originated row.
    // Guard rejects (SC belongs to C, not A) → falls through to newest of A.
    await routeAgentMessage(
      {
        id: 'msg-reply-tamper',
        platform_id: A,
        content: JSON.stringify({ text: 'misdirected' }),
        in_reply_to: cInboundId,
      },
      SB,
    );

    const s1Rows = readPairedInboundTriggers(A, S1.id);
    const s2Rows = readPairedInboundTriggers(A, S2.id);
    expect(s1Rows).toHaveLength(0);
    expect(s2Rows).toHaveLength(1);
  });

  it('in_reply_to referencing a non-a2a row falls through to newest session', async () => {
    // Write a channel message into B's inbound (no source_session_id).
    await writeSessionMessage(B, SB.id, {
      id: 'channel-msg-1',
      kind: 'chat',
      timestamp: now(),
      platformId: 'user-123',
      channelType: 'slack',
      threadId: null,
      content: 'hello from slack',
    });

    // B replies to A with in_reply_to pointing to the channel message.
    // source_session_id is null → peer-affinity finds nothing → newest of A.
    await routeAgentMessage(
      {
        id: 'msg-reply-channel',
        platform_id: A,
        content: JSON.stringify({ text: 'response' }),
        in_reply_to: 'channel-msg-1',
      },
      SB,
    );

    const s1Rows = readPairedInboundTriggers(A, S1.id);
    const s2Rows = readPairedInboundTriggers(A, S2.id);
    expect(s1Rows).toHaveLength(0);
    expect(s2Rows).toHaveLength(1);
  });

  it('self-message is allowed without a destination row', async () => {
    // A targets itself — no agent_destinations row exists for A→A.
    await routeAgentMessage(
      { id: 'self-msg', platform_id: A, content: JSON.stringify({ text: 'self-note' }), in_reply_to: null },
      S1,
    );

    // Lands in S2 (newest active session of A via resolveSession fallback).
    const s2Rows = readPairedInboundTriggers(A, S2.id);
    expect(s2Rows).toHaveLength(1);
    expect(JSON.parse(s2Rows[0].content).text).toBe('self-note');
  });

  it('drops a self-directed status message instead of reinjecting it as chat', async () => {
    await routeAgentMessage(
      {
        id: 'self-status',
        kind: 'status',
        platform_id: A,
        content: JSON.stringify({ text: '> Working' }),
        in_reply_to: null,
      },
      S1,
    );

    expect(readPairedInboundTriggers(A, S1.id)).toHaveLength(0);
    expect(readPairedInboundTriggers(A, S2.id)).toHaveLength(0);
  });

  it('drops a chat response that loops back into the exact same session', async () => {
    await routeAgentMessage(
      { id: 'self-seed', kind: 'chat', platform_id: A, content: '{"text":"seed"}', in_reply_to: null },
      S2,
    );
    const seedInbound = readPairedInboundTriggers(A, S2.id);
    expect(seedInbound).toHaveLength(1);
    expect(seedInbound[0].source_session_id).toBe(S2.id);

    await routeAgentMessage(
      {
        id: 'self-loop-reply',
        kind: 'chat',
        platform_id: A,
        content: '{"text":"loop reply"}',
        in_reply_to: seedInbound[0].id,
      },
      S2,
    );

    expect(readPairedInboundTriggers(A, S2.id)).toHaveLength(1);
  });

  it('BUG: no volume cap on a2a routing — unbounded ping-pong is allowed (#2063)', async () => {
    // Two agents can exchange unlimited messages with no rate limit or loop
    // detection. This test documents the gap — it should FAIL once #2063 lands.
    const errors: string[] = [];
    for (let i = 0; i < 20; i++) {
      try {
        await routeAgentMessage(
          { id: `ping-${i}`, platform_id: B, content: JSON.stringify({ text: `ping ${i}` }), in_reply_to: null },
          S1,
        );
        await routeAgentMessage(
          { id: `pong-${i}`, platform_id: A, content: JSON.stringify({ text: `pong ${i}` }), in_reply_to: null },
          SB,
        );
      } catch (e) {
        errors.push((e as Error).message);
        break;
      }
    }
    // BUG: all 40 messages go through — no cap, no throttle.
    // Once loop prevention lands, this should throw or reject after a threshold.
    const bRows = readPairedInboundTriggers(B, SB.id);
    const s1Rows = readPairedInboundTriggers(A, S1.id);
    const s2Rows = readPairedInboundTriggers(A, S2.id);
    expect(errors).toHaveLength(0);
    expect(bRows).toHaveLength(20);
    expect(s1Rows.length + s2Rows.length).toBe(20);
  });

  it('file forwarding: copies bytes from source outbox to target inbox', async () => {
    // Place a file in S1's outbox for the message.
    const outboxDir = path.join(sessionDir(A, S1.id), 'outbox', 'msg-with-file');
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(path.join(outboxDir, 'report.pdf'), 'fake-pdf-bytes');

    await routeAgentMessage(
      {
        id: 'msg-with-file',
        platform_id: B,
        content: JSON.stringify({ text: 'see attached', files: ['report.pdf'] }),
        in_reply_to: null,
      },
      S1,
    );

    const bRows = readPairedInboundTriggers(B, SB.id);
    expect(bRows).toHaveLength(1);
    const parsed = JSON.parse(bRows[0].content);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].name).toBe('report.pdf');
    expect(parsed.attachments[0].type).toBe('file');

    // Verify actual file bytes were copied to the target inbox.
    const targetPath = path.join(sessionDir(B, SB.id), parsed.attachments[0].localPath);
    expect(fs.existsSync(targetPath)).toBe(true);
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('fake-pdf-bytes');
  });

  it('file forwarding: skips symlinked source files', async () => {
    const secretPath = path.join(TEST_DIR, 'host-secret.txt');
    fs.writeFileSync(secretPath, 'host-secret-bytes');

    const outboxDir = path.join(sessionDir(A, S1.id), 'outbox', 'msg-with-symlink');
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.symlinkSync(secretPath, path.join(outboxDir, 'safe-name.txt'));

    await routeAgentMessage(
      {
        id: 'msg-with-symlink',
        platform_id: B,
        content: JSON.stringify({ text: 'see attached', files: ['safe-name.txt'] }),
        in_reply_to: null,
      },
      S1,
    );

    const bRows = readPairedInboundTriggers(B, SB.id);
    expect(bRows).toHaveLength(1);
    const parsed = JSON.parse(bRows[0].content);
    expect(parsed.attachments).toHaveLength(0);
  });

  // #2828 — target-side symlink containment. A compromised target agent can
  // write inside its own session dir; these tests prove it cannot redirect a
  // forwarded attachment outside the session sandbox via a pre-placed symlink.

  it('file forwarding (#2828): skips a symlinked target inbox dir, writes nothing outside', async () => {
    const warnSpy = vi.spyOn(log, 'warn');
    const canaryDir = path.join(TEST_DIR, 'canary-outside-inbox');
    fs.mkdirSync(canaryDir, { recursive: true });

    // Source has a real attachment to forward.
    const outboxDir = path.join(sessionDir(A, S1.id), 'outbox', 'msg-evil-inbox');
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(path.join(outboxDir, 'pwn.txt'), 'attacker-bytes');

    // Target pre-places its whole `inbox` as a symlink pointing outside.
    const targetInbox = path.join(sessionDir(B, SB.id), 'inbox');
    fs.rmSync(targetInbox, { recursive: true, force: true });
    fs.symlinkSync(canaryDir, targetInbox);

    await routeAgentMessage(
      {
        id: 'msg-evil-inbox',
        platform_id: B,
        content: JSON.stringify({ text: 'see attached', files: ['pwn.txt'] }),
        in_reply_to: null,
      },
      S1,
    );

    // Message still routes — just with no attachments.
    const bRows = readPairedInboundTriggers(B, SB.id);
    expect(bRows).toHaveLength(1);
    expect(JSON.parse(bRows[0].content).attachments).toHaveLength(0);

    // Nothing was written through the symlink to the canary location.
    expect(fs.readdirSync(canaryDir)).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('file forwarding (#2828): skips a symlinked inbox/<msgId> subdir, writes nothing outside', async () => {
    const warnSpy = vi.spyOn(log, 'warn');
    const canaryDir = path.join(TEST_DIR, 'canary-outside-subdir');
    fs.mkdirSync(canaryDir, { recursive: true });

    const outboxDir = path.join(sessionDir(A, S1.id), 'outbox', 'msg-evil-subdir');
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(path.join(outboxDir, 'pwn.txt'), 'attacker-bytes');

    // The forwarded a2a msg id generated inside routeAgentMessage is random, so
    // a symlink can't be pre-placed at inbox/<that-id>. Drive forwardAttachedFiles
    // directly with a fixed target message id and plant the symlink at that path.
    const targetMsgId = 'evil-subdir-msg';
    const realInbox = path.join(sessionDir(B, SB.id), 'inbox');
    fs.mkdirSync(realInbox, { recursive: true });
    fs.symlinkSync(canaryDir, path.join(realInbox, targetMsgId));

    const attachments = forwardAttachedFiles(
      { agentGroupId: A, sessionId: S1.id, messageId: 'msg-evil-subdir', filenames: ['pwn.txt'] },
      { agentGroupId: B, sessionId: SB.id, messageId: targetMsgId },
    );

    expect(attachments).toHaveLength(0);
    expect(fs.readdirSync(canaryDir)).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('file forwarding (#2828): refuses a pre-existing symlinked dst file (COPYFILE_EXCL)', async () => {
    const warnSpy = vi.spyOn(log, 'warn');
    const canaryFile = path.join(TEST_DIR, 'canary-dst-target.txt');
    fs.writeFileSync(canaryFile, 'original-canary');

    const outboxDir = path.join(sessionDir(A, S1.id), 'outbox', 'msg-evil-dst');
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(path.join(outboxDir, 'doc.txt'), 'attacker-bytes');

    // inbox/<msgId>/ is a real dir, but contains a pre-placed symlink named
    // exactly like the incoming attachment, pointing at the canary file.
    // We can only do this once we know the a2a msg id, which is generated
    // inside routeAgentMessage. So we instead drive forwardAttachedFiles
    // directly with a fixed target message id.
    const targetMsgId = 'fixed-evil-dst';
    const realInboxSubdir = path.join(sessionDir(B, SB.id), 'inbox', targetMsgId);
    fs.mkdirSync(realInboxSubdir, { recursive: true });
    fs.symlinkSync(canaryFile, path.join(realInboxSubdir, 'doc.txt'));

    const attachments = forwardAttachedFiles(
      { agentGroupId: A, sessionId: S1.id, messageId: 'msg-evil-dst', filenames: ['doc.txt'] },
      { agentGroupId: B, sessionId: SB.id, messageId: targetMsgId },
    );

    // The exclusive write failed → nothing forwarded.
    expect(attachments).toHaveLength(0);
    // Canary file untouched (symlink not followed/overwritten).
    expect(fs.readFileSync(canaryFile, 'utf-8')).toBe('original-canary');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('file forwarding (#2828 regression): a normal forward still works end-to-end', async () => {
    const outboxDir = path.join(sessionDir(A, S1.id), 'outbox', 'msg-ok-file');
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(path.join(outboxDir, 'ok.txt'), 'legit-bytes');

    await routeAgentMessage(
      {
        id: 'msg-ok-file',
        platform_id: B,
        content: JSON.stringify({ text: 'see attached', files: ['ok.txt'] }),
        in_reply_to: null,
      },
      S1,
    );

    const bRows = readPairedInboundTriggers(B, SB.id);
    expect(bRows).toHaveLength(1);
    const parsed = JSON.parse(bRows[0].content);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].name).toBe('ok.txt');
    const targetPath = path.join(sessionDir(B, SB.id), parsed.attachments[0].localPath);
    expect(fs.existsSync(targetPath)).toBe(true);
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('legit-bytes');
  });
});
