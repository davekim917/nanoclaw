/**
 * Tests for chat-invokable access grants. Exercises:
 *   - _resolveTargetUserId: namespaced id, <@mention>, bare handle, Slack
 *     alias pipe, Discord role-mention rejection
 *   - _deriveCallerId: happy path, missing content, malformed JSON, fallback
 *     to messaging_group channel_type
 *   - handleGrantAccess: authority tiers (owner, global_admin,
 *     scoped_admin, stranger), role gating (admin vs member), idempotency,
 *     missing agent group, bad args
 *   - handleRevokeAccess: authority + escalation blocks
 *   - handleListAccess: readable by anyone
 *
 * notifyAgent is mocked — its real implementation writes to a session
 * directory and wakes a container, neither of which are available in a
 * unit-test harness. We capture the messages it would have sent so the
 * tests can assert on the user-visible outcome.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// deriveCallerId now opens the session's real mailbox instead of taking a
// handle from the delivery loop (plan §4.5b), so these tests run against a
// real temp session mailbox rather than an in-memory stand-in.
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-permissions-grant',
    GROUPS_DIR: '/tmp/nanoclaw-test-permissions-grant/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-permissions-grant';

const notifyCalls: Array<{ sessionId: string; text: string }> = [];
vi.mock('../approvals/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../approvals/index.js')>()),
  notifyAgent: (session: { id: string }, text: string) => {
    notifyCalls.push({ sessionId: session.id, text });
  },
}));

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  initTestDb,
  runMigrations,
  getRawDb,
} from '../../db/index.js';
import { initSessionFolder } from '../../session-manager.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import type { AgentGroup, MessagingGroup, Session } from '../../types.js';
import { addMember, isMember } from './db/agent-group-members.js';
import { createUser } from './db/users.js';
import { grantRole, isAdminOfAgentGroup, isOwner } from './db/user-roles.js';
import {
  _deriveCallerId,
  _resolveTargetUserId,
  handleGrantAccess,
  handleListAccess,
  handleRevokeAccess,
} from './grant.js';

function now(): string {
  return new Date().toISOString();
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-helper',
    messaging_group_id: 'mg-test',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: now(),
    created_at: now(),
    ...overrides,
  };
}

function makeMg(id: string, channelType: string, platformId: string): MessagingGroup {
  return {
    id,
    channel_type: channelType,
    platform_id: platformId,
    name: null,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  };
}

function makeAg(id: string, folder: string, name: string): AgentGroup {
  return { id, folder, name, agent_provider: null, created_at: now() };
}

/** Write straight into the session's real inbound.db, the way the host would. */
function insertChatInbound(
  content: Record<string, unknown>,
  opts: { channelType?: string; timestamp?: string; kind?: string } = {},
): void {
  const db = new Database(inboundDbPath('ag-helper', 'sess-test'));
  try {
    db.prepare(`INSERT INTO messages_in (id, kind, timestamp, channel_type, content) VALUES (?, ?, ?, ?, ?)`).run(
      `in-${Math.random().toString(36).slice(2, 8)}`,
      opts.kind ?? 'chat',
      opts.timestamp ?? now(),
      opts.channelType ?? 'slack-example-labs',
      JSON.stringify(content),
    );
  } finally {
    db.close();
  }
}

function insertRawInbound(id: string, content: string): void {
  const db = new Database(inboundDbPath('ag-helper', 'sess-test'));
  try {
    db.prepare(
      `INSERT INTO messages_in (id, kind, timestamp, channel_type, content) VALUES (?, 'chat', ?, 'slack-example-labs', ?)`,
    ).run(id, now(), content);
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initTestDb();
  const db = getRawDb();
  runMigrations(db);
  notifyCalls.length = 0;
  initSessionFolder('ag-helper', 'sess-test');

  createMessagingGroup(makeMg('mg-test', 'slack-example-labs', 'slack:C1'));
  createAgentGroup(makeAg('ag-helper', 'example-labs-v2', 'helper'));
  createAgentGroup(makeAg('ag-other', 'other', 'other'));

  createUser({ id: 'slack-example-labs:OWNER', kind: 'slack-example-labs', display_name: 'Owner', created_at: now() });
  createUser({
    id: 'slack-example-labs:GADMIN',
    kind: 'slack-example-labs',
    display_name: 'GlobalAdmin',
    created_at: now(),
  });
  createUser({
    id: 'slack-example-labs:SADMIN',
    kind: 'slack-example-labs',
    display_name: 'ScopedAdmin',
    created_at: now(),
  });
  createUser({
    id: 'slack-example-labs:STRANGER',
    kind: 'slack-example-labs',
    display_name: 'Stranger',
    created_at: now(),
  });
  // Target users that test-local addMember/grantRole calls reference before
  // the handler's own ensureUserExists has a chance to create them.
  createUser({ id: 'slack-example-labs:BOB', kind: 'slack-example-labs', display_name: 'Bob', created_at: now() });
  createUser({ id: 'slack-example-labs:CAROL', kind: 'slack-example-labs', display_name: 'Carol', created_at: now() });

  grantRole({
    user_id: 'slack-example-labs:OWNER',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  grantRole({
    user_id: 'slack-example-labs:GADMIN',
    role: 'admin',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  grantRole({
    user_id: 'slack-example-labs:SADMIN',
    role: 'admin',
    agent_group_id: 'ag-helper',
    granted_by: null,
    granted_at: now(),
  });
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('_resolveTargetUserId', () => {
  it('returns a namespaced id as-is', () => {
    expect(_resolveTargetUserId('slack-example-labs:U1', makeSession())).toBe('slack-example-labs:U1');
  });

  it('unwraps <@Uxxx> mentions and prepends channel_type', () => {
    expect(_resolveTargetUserId('<@U12345>', makeSession())).toBe('slack-example-labs:U12345');
  });

  it('strips a Slack display-alias pipe in the mention', () => {
    expect(_resolveTargetUserId('<@U12345|operator>', makeSession())).toBe('slack-example-labs:U12345');
  });

  it('rejects Discord role mentions (<@&snowflake>)', () => {
    expect(_resolveTargetUserId('<@&12345>', makeSession())).toBeNull();
  });

  it('accepts bare handles and prepends channel_type', () => {
    expect(_resolveTargetUserId('U12345', makeSession())).toBe('slack-example-labs:U12345');
  });

  it('returns null when the session has no messaging group', () => {
    expect(_resolveTargetUserId('U12345', makeSession({ messaging_group_id: null }))).toBeNull();
  });
});

describe('_deriveCallerId', () => {
  it('reads senderId from the latest chat inbound', async () => {
    insertChatInbound({ senderId: 'slack-example-labs:OWNER', text: 'hi' });
    expect(await _deriveCallerId(makeSession())).toBe('slack-example-labs:OWNER');
  });

  it('falls back to author.userId when senderId is absent', async () => {
    insertChatInbound({ author: { userId: 'slack-example-labs:OWNER' }, text: 'hi' });
    expect(await _deriveCallerId(makeSession())).toBe('slack-example-labs:OWNER');
  });

  it('prepends channel_type when the raw id is bare', async () => {
    insertChatInbound({ senderId: 'OWNER', text: 'hi' });
    expect(await _deriveCallerId(makeSession())).toBe('slack-example-labs:OWNER');
  });

  it('returns null when there are no chat messages', async () => {
    expect(await _deriveCallerId(makeSession())).toBeNull();
  });

  // Regression: the chat-SDK bridge writes kind='chat-sdk'. A `kind='chat'`-only
  // filter matched nothing, so every admin action was denied as "unidentified".
  it("reads kind='chat-sdk' rows", async () => {
    insertChatInbound({ senderId: 'OWNER', author: { userId: 'OWNER' } }, { kind: 'chat-sdk' });
    expect(await _deriveCallerId(makeSession())).toBe('slack-example-labs:OWNER');
  });

  // Regression: notifyAgent writes its own failure notice as kind='chat' with
  // senderId 'system'. Without the skip, a retry attributes the action to the
  // previous attempt's error message instead of the human.
  it("skips the host's own system notices", async () => {
    insertChatInbound({ senderId: 'OWNER' }, { kind: 'chat-sdk', timestamp: '2026-01-01T00:00:00.000Z' });
    insertChatInbound(
      { text: 'grant_access failed: ...', sender: 'system', senderId: 'system' },
      { channelType: 'agent', timestamp: '2026-01-01T00:00:01.000Z' },
    );
    expect(await _deriveCallerId(makeSession())).toBe('slack-example-labs:OWNER');
  });

  it('returns null on malformed content JSON', async () => {
    insertRawInbound('bad', 'not json');
    expect(await _deriveCallerId(makeSession())).toBeNull();
  });
});

describe('handleGrantAccess', () => {
  it('owner can grant member', async () => {
    insertChatInbound({ senderId: 'OWNER' });
    await handleGrantAccess({ user: '<@BOB>' }, makeSession());
    expect(isMember('slack-example-labs:BOB', 'ag-helper')).toBe(true);
    expect(notifyCalls.at(-1)?.text).toMatch(/Granted member access/);
  });

  it('owner can grant admin', async () => {
    insertChatInbound({ senderId: 'OWNER' });
    await handleGrantAccess({ user: '<@BOB>', role: 'admin' }, makeSession());
    expect(isAdminOfAgentGroup('slack-example-labs:BOB', 'ag-helper')).toBe(true);
  });

  it('scoped admin can grant member but NOT admin', async () => {
    insertChatInbound({ senderId: 'SADMIN' });
    await handleGrantAccess({ user: '<@BOB>' }, makeSession());
    expect(isMember('slack-example-labs:BOB', 'ag-helper')).toBe(true);

    insertChatInbound({ senderId: 'SADMIN' });
    await handleGrantAccess({ user: '<@CAROL>', role: 'admin' }, makeSession());
    expect(isAdminOfAgentGroup('slack-example-labs:CAROL', 'ag-helper')).toBe(false);
    expect(notifyCalls.at(-1)?.text).toMatch(/only owner \/ global admin can grant `admin`/);
  });

  it('stranger is denied', async () => {
    insertChatInbound({ senderId: 'STRANGER' });
    await handleGrantAccess({ user: '<@BOB>' }, makeSession());
    expect(isMember('slack-example-labs:BOB', 'ag-helper')).toBe(false);
    expect(notifyCalls.at(-1)?.text).toMatch(/denied: you don't have authority/);
  });

  it('scoped admin is denied on OTHER groups', async () => {
    insertChatInbound({ senderId: 'SADMIN' });
    await handleGrantAccess({ user: '<@BOB>', agentGroupId: 'ag-other' }, makeSession());
    expect(isMember('slack-example-labs:BOB', 'ag-other')).toBe(false);
  });

  it('rejects unknown agent groups', async () => {
    insertChatInbound({ senderId: 'OWNER' });
    await handleGrantAccess({ user: '<@BOB>', agentGroupId: 'ag-missing' }, makeSession());
    expect(notifyCalls.at(-1)?.text).toMatch(/does not exist/);
  });

  it('is idempotent on repeat grants', async () => {
    insertChatInbound({ senderId: 'OWNER' });
    await handleGrantAccess({ user: '<@BOB>' }, makeSession());
    insertChatInbound({ senderId: 'OWNER' });
    await handleGrantAccess({ user: '<@BOB>' }, makeSession());
    expect(notifyCalls.at(-1)?.text).toMatch(/already has access/);
  });
});

describe('handleRevokeAccess', () => {
  it('owner can revoke a member', async () => {
    addMember({ user_id: 'slack-example-labs:BOB', agent_group_id: 'ag-helper', added_by: null, added_at: now() });
    insertChatInbound({ senderId: 'OWNER' });
    await handleRevokeAccess({ user: '<@BOB>' }, makeSession());
    expect(isMember('slack-example-labs:BOB', 'ag-helper')).toBe(false);
  });

  it('scoped admin cannot revoke another admin', async () => {
    grantRole({
      user_id: 'slack-example-labs:CAROL',
      role: 'admin',
      agent_group_id: 'ag-helper',
      granted_by: null,
      granted_at: now(),
    });
    insertChatInbound({ senderId: 'SADMIN' });
    await handleRevokeAccess({ user: '<@CAROL>' }, makeSession());
    expect(isAdminOfAgentGroup('slack-example-labs:CAROL', 'ag-helper')).toBe(true);
    expect(notifyCalls.at(-1)?.text).toMatch(/only a global admin can revoke another admin/);
  });

  it('never revokes an owner', async () => {
    insertChatInbound({ senderId: 'GADMIN' });
    await handleRevokeAccess({ user: '<@OWNER>' }, makeSession());
    expect(isOwner('slack-example-labs:OWNER')).toBe(true);
    expect(notifyCalls.at(-1)?.text).toMatch(/owner revocation must be done by direct edit/);
  });
});

describe('handleListAccess', () => {
  it('lists owners, global admins, scoped admins, members', async () => {
    addMember({ user_id: 'slack-example-labs:BOB', agent_group_id: 'ag-helper', added_by: null, added_at: now() });
    await handleListAccess({}, makeSession());
    const text = notifyCalls.at(-1)?.text ?? '';
    expect(text).toMatch(/Access for `ag-helper`/);
    expect(text).toMatch(/slack-example-labs:OWNER/);
    expect(text).toMatch(/slack-example-labs:GADMIN/);
    expect(text).toMatch(/slack-example-labs:SADMIN/);
    expect(text).toMatch(/slack-example-labs:BOB/);
  });
});
