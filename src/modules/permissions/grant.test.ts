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
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const notifyCalls: Array<{ sessionId: string; text: string }> = [];
vi.mock('../approvals/index.js', () => ({
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
} from '../../db/index.js';
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
    agent_group_id: 'ag-illie',
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

function inboundDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages_in (
      id TEXT PRIMARY KEY,
      seq INTEGER,
      kind TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      status TEXT,
      process_after TEXT,
      recurrence TEXT,
      series_id TEXT,
      tries INTEGER,
      platform_id TEXT,
      channel_type TEXT,
      thread_id TEXT,
      content TEXT NOT NULL
    );
  `);
  return db;
}

function insertChatInbound(
  db: Database.Database,
  content: Record<string, unknown>,
  opts: { channelType?: string; timestamp?: string } = {},
): void {
  db.prepare(
    `INSERT INTO messages_in (id, kind, timestamp, channel_type, content) VALUES (?, 'chat', ?, ?, ?)`,
  ).run(
    `in-${Math.random().toString(36).slice(2, 8)}`,
    opts.timestamp ?? now(),
    opts.channelType ?? 'slack-illysium',
    JSON.stringify(content),
  );
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  notifyCalls.length = 0;

  createMessagingGroup(makeMg('mg-test', 'slack-illysium', 'slack:C1'));
  createAgentGroup(makeAg('ag-illie', 'illysium-v2', 'illie'));
  createAgentGroup(makeAg('ag-other', 'other', 'other'));

  createUser({ id: 'slack-illysium:OWNER', kind: 'slack-illysium', display_name: 'Owner', created_at: now() });
  createUser({ id: 'slack-illysium:GADMIN', kind: 'slack-illysium', display_name: 'GlobalAdmin', created_at: now() });
  createUser({ id: 'slack-illysium:SADMIN', kind: 'slack-illysium', display_name: 'ScopedAdmin', created_at: now() });
  createUser({ id: 'slack-illysium:STRANGER', kind: 'slack-illysium', display_name: 'Stranger', created_at: now() });
  // Target users that test-local addMember/grantRole calls reference before
  // the handler's own ensureUserExists has a chance to create them.
  createUser({ id: 'slack-illysium:BOB', kind: 'slack-illysium', display_name: 'Bob', created_at: now() });
  createUser({ id: 'slack-illysium:CAROL', kind: 'slack-illysium', display_name: 'Carol', created_at: now() });

  grantRole({ user_id: 'slack-illysium:OWNER', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  grantRole({ user_id: 'slack-illysium:GADMIN', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });
  grantRole({ user_id: 'slack-illysium:SADMIN', role: 'admin', agent_group_id: 'ag-illie', granted_by: null, granted_at: now() });
});

afterEach(() => {
  closeDb();
});

describe('_resolveTargetUserId', () => {
  it('returns a namespaced id as-is', () => {
    expect(_resolveTargetUserId('slack-illysium:U1', makeSession())).toBe('slack-illysium:U1');
  });

  it('unwraps <@Uxxx> mentions and prepends channel_type', () => {
    expect(_resolveTargetUserId('<@U12345>', makeSession())).toBe('slack-illysium:U12345');
  });

  it('strips a Slack display-alias pipe in the mention', () => {
    expect(_resolveTargetUserId('<@U12345|dave>', makeSession())).toBe('slack-illysium:U12345');
  });

  it('rejects Discord role mentions (<@&snowflake>)', () => {
    expect(_resolveTargetUserId('<@&12345>', makeSession())).toBeNull();
  });

  it('accepts bare handles and prepends channel_type', () => {
    expect(_resolveTargetUserId('U12345', makeSession())).toBe('slack-illysium:U12345');
  });

  it('returns null when the session has no messaging group', () => {
    expect(_resolveTargetUserId('U12345', makeSession({ messaging_group_id: null }))).toBeNull();
  });
});

describe('_deriveCallerId', () => {
  it('reads senderId from the latest chat inbound', () => {
    const db = inboundDb();
    insertChatInbound(db, { senderId: 'slack-illysium:OWNER', text: 'hi' });
    expect(_deriveCallerId(makeSession(), db)).toBe('slack-illysium:OWNER');
  });

  it('falls back to author.userId when senderId is absent', () => {
    const db = inboundDb();
    insertChatInbound(db, { author: { userId: 'slack-illysium:OWNER' }, text: 'hi' });
    expect(_deriveCallerId(makeSession(), db)).toBe('slack-illysium:OWNER');
  });

  it('prepends channel_type when the raw id is bare', () => {
    const db = inboundDb();
    insertChatInbound(db, { senderId: 'OWNER', text: 'hi' });
    expect(_deriveCallerId(makeSession(), db)).toBe('slack-illysium:OWNER');
  });

  it('returns null when there are no chat messages', () => {
    expect(_deriveCallerId(makeSession(), inboundDb())).toBeNull();
  });

  it('returns null on malformed content JSON', () => {
    const db = inboundDb();
    db.prepare(
      `INSERT INTO messages_in (id, kind, timestamp, channel_type, content) VALUES (?, 'chat', ?, 'slack-illysium', ?)`,
    ).run('bad', now(), 'not json');
    expect(_deriveCallerId(makeSession(), db)).toBeNull();
  });
});

describe('handleGrantAccess', () => {
  it('owner can grant member', async () => {
    const db = inboundDb();
    insertChatInbound(db, { senderId: 'OWNER' });
    await handleGrantAccess({ user: '<@BOB>' }, makeSession(), db);
    expect(isMember('slack-illysium:BOB', 'ag-illie')).toBe(true);
    expect(notifyCalls.at(-1)?.text).toMatch(/Granted member access/);
  });

  it('owner can grant admin', async () => {
    const db = inboundDb();
    insertChatInbound(db, { senderId: 'OWNER' });
    await handleGrantAccess({ user: '<@BOB>', role: 'admin' }, makeSession(), db);
    expect(isAdminOfAgentGroup('slack-illysium:BOB', 'ag-illie')).toBe(true);
  });

  it('scoped admin can grant member but NOT admin', async () => {
    const db = inboundDb();
    insertChatInbound(db, { senderId: 'SADMIN' });
    await handleGrantAccess({ user: '<@BOB>' }, makeSession(), db);
    expect(isMember('slack-illysium:BOB', 'ag-illie')).toBe(true);

    insertChatInbound(db, { senderId: 'SADMIN' });
    await handleGrantAccess({ user: '<@CAROL>', role: 'admin' }, makeSession(), db);
    expect(isAdminOfAgentGroup('slack-illysium:CAROL', 'ag-illie')).toBe(false);
    expect(notifyCalls.at(-1)?.text).toMatch(/only owner \/ global admin can grant `admin`/);
  });

  it('stranger is denied', async () => {
    const db = inboundDb();
    insertChatInbound(db, { senderId: 'STRANGER' });
    await handleGrantAccess({ user: '<@BOB>' }, makeSession(), db);
    expect(isMember('slack-illysium:BOB', 'ag-illie')).toBe(false);
    expect(notifyCalls.at(-1)?.text).toMatch(/denied: you don't have authority/);
  });

  it('scoped admin is denied on OTHER groups', async () => {
    const db = inboundDb();
    insertChatInbound(db, { senderId: 'SADMIN' });
    await handleGrantAccess({ user: '<@BOB>', agentGroupId: 'ag-other' }, makeSession(), db);
    expect(isMember('slack-illysium:BOB', 'ag-other')).toBe(false);
  });

  it('rejects unknown agent groups', async () => {
    const db = inboundDb();
    insertChatInbound(db, { senderId: 'OWNER' });
    await handleGrantAccess({ user: '<@BOB>', agentGroupId: 'ag-missing' }, makeSession(), db);
    expect(notifyCalls.at(-1)?.text).toMatch(/does not exist/);
  });

  it('is idempotent on repeat grants', async () => {
    const db = inboundDb();
    insertChatInbound(db, { senderId: 'OWNER' });
    await handleGrantAccess({ user: '<@BOB>' }, makeSession(), db);
    insertChatInbound(db, { senderId: 'OWNER' });
    await handleGrantAccess({ user: '<@BOB>' }, makeSession(), db);
    expect(notifyCalls.at(-1)?.text).toMatch(/already has access/);
  });
});

describe('handleRevokeAccess', () => {
  it('owner can revoke a member', async () => {
    addMember({ user_id: 'slack-illysium:BOB', agent_group_id: 'ag-illie', added_by: null, added_at: now() });
    const db = inboundDb();
    insertChatInbound(db, { senderId: 'OWNER' });
    await handleRevokeAccess({ user: '<@BOB>' }, makeSession(), db);
    expect(isMember('slack-illysium:BOB', 'ag-illie')).toBe(false);
  });

  it('scoped admin cannot revoke another admin', async () => {
    grantRole({ user_id: 'slack-illysium:CAROL', role: 'admin', agent_group_id: 'ag-illie', granted_by: null, granted_at: now() });
    const db = inboundDb();
    insertChatInbound(db, { senderId: 'SADMIN' });
    await handleRevokeAccess({ user: '<@CAROL>' }, makeSession(), db);
    expect(isAdminOfAgentGroup('slack-illysium:CAROL', 'ag-illie')).toBe(true);
    expect(notifyCalls.at(-1)?.text).toMatch(/only a global admin can revoke another admin/);
  });

  it('never revokes an owner', async () => {
    const db = inboundDb();
    insertChatInbound(db, { senderId: 'GADMIN' });
    await handleRevokeAccess({ user: '<@OWNER>' }, makeSession(), db);
    expect(isOwner('slack-illysium:OWNER')).toBe(true);
    expect(notifyCalls.at(-1)?.text).toMatch(/owner revocation must be done by direct edit/);
  });
});

describe('handleListAccess', () => {
  it('lists owners, global admins, scoped admins, members', async () => {
    addMember({ user_id: 'slack-illysium:BOB', agent_group_id: 'ag-illie', added_by: null, added_at: now() });
    await handleListAccess({}, makeSession(), inboundDb());
    const text = notifyCalls.at(-1)?.text ?? '';
    expect(text).toMatch(/Access for `ag-illie`/);
    expect(text).toMatch(/slack-illysium:OWNER/);
    expect(text).toMatch(/slack-illysium:GADMIN/);
    expect(text).toMatch(/slack-illysium:SADMIN/);
    expect(text).toMatch(/slack-illysium:BOB/);
  });
});
