/**
 * Tests for the host-side command gate — filtered commands are dropped
 * before reaching the container, and admin commands are gated against
 * the user_roles table.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { preFanoutGate, gateCommand, clearInterceptHandlers } from './command-gate.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from './db/index.js';
import { createUser } from './modules/permissions/db/users.js';
import { grantRole } from './modules/permissions/db/user-roles.js';

function now(): string {
  return new Date().toISOString();
}

function insertUser(id: string): void {
  getDb()
    .prepare("INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'test', NULL, ?)")
    .run(id, now());
}

function insertRole(userId: string, role: 'owner' | 'admin', agentGroupId: string | null): void {
  if (agentGroupId !== null) {
    getDb()
      .prepare(
        'INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, NULL, ?)',
      )
      .run(userId, role, agentGroupId, now());
  } else {
    getDb()
      .prepare(
        'INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, NULL, NULL, ?)',
      )
      .run(userId, role, now());
  }
}

function seedAgentGroup(id: string): void {
  createAgentGroup({ id, name: id.toUpperCase(), folder: id, agent_provider: null, created_at: now() });
}

function seedUser(id: string): void {
  createUser({ id, kind: 'telegram', display_name: null, created_at: now() });
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  seedAgentGroup('ag-1');
  seedAgentGroup('ag-2');
});

afterEach(() => {
  clearInterceptHandlers();
  closeDb();
});

describe('preFanoutGate', () => {
  it('test_preFanoutGate_intercept_dashboard_token_admin', () => {
    insertUser('u1');
    insertRole('u1', 'owner', null);
    const result = preFanoutGate(JSON.stringify({ text: '/dashboard-token' }), 'u1');
    expect(result).toEqual({
      action: 'intercept',
      handlerName: 'dashboard_token_issue',
      command: '/dashboard-token',
      args: '',
    });
  });

  it('test_preFanoutGate_intercept_non_admin_denies', () => {
    insertUser('u2');
    const result = preFanoutGate(JSON.stringify({ text: '/dashboard-token' }), 'u2');
    expect(result).toEqual({ action: 'deny', command: '/dashboard-token' });
  });

  it('test_preFanoutGate_filtered_drops', () => {
    const result = preFanoutGate(JSON.stringify({ text: '/help' }), 'any');
    expect(result).toEqual({ action: 'filter' });
  });

  it('test_preFanoutGate_admin_command_passes', () => {
    const result = preFanoutGate(JSON.stringify({ text: '/clear' }), 'any');
    expect(result).toEqual({ action: 'pass' });
  });

  it('test_preFanoutGate_unknown_slash_passes', () => {
    const result = preFanoutGate(JSON.stringify({ text: '/unknown' }), 'any');
    expect(result).toEqual({ action: 'pass' });
  });

  it('test_preFanoutGate_non_slash_passes', () => {
    const result = preFanoutGate(JSON.stringify({ text: 'hello world' }), 'any');
    expect(result).toEqual({ action: 'pass' });
  });
});

describe('gateCommand (unchanged regression tests)', () => {
  it('test_gateCommand_unchanged_filtered', () => {
    const result = gateCommand(JSON.stringify({ text: '/help' }), 'u1', 'ag-1');
    expect(result).toEqual({ action: 'filter' });
  });

  it('test_gateCommand_unchanged_admin_owner_passes', () => {
    insertUser('u1');
    insertRole('u1', 'owner', null);
    const result = gateCommand(JSON.stringify({ text: '/clear' }), 'u1', 'ag-1');
    expect(result).toEqual({ action: 'pass' });
  });

  it('test_gateCommand_admin_command_denied_non_admin', () => {
    const result = gateCommand(JSON.stringify({ text: '/clear' }), 'u-nobody', 'ag-1');
    expect(result).toEqual({ action: 'deny', command: '/clear' });
  });

  it('test_gateCommand_plain_text_passes', () => {
    const result = gateCommand(JSON.stringify({ text: 'hello' }), null, 'ag-1');
    expect(result).toEqual({ action: 'pass' });
  });
});

describe('stripLeadingMentions integration via preFanoutGate', () => {
  it('test_preFanoutGate_intercept_with_discord_mention_prefix', () => {
    // Discord formal mention prefix on /dashboard-token must still intercept.
    const owner = 'discord:owner-1';
    insertUser(owner);
    insertRole(owner, 'owner', null);
    const result = preFanoutGate(JSON.stringify({ text: '<@123456789000000014> /dashboard-token' }), owner);
    expect(result).toEqual({
      action: 'intercept',
      handlerName: 'dashboard_token_issue',
      command: '/dashboard-token',
      args: '',
    });
  });

  it('test_preFanoutGate_intercept_with_slack_mention_prefix_with_alias', () => {
    // Slack mention with display-name alias `<@U_ID|name>` must still intercept.
    const owner = 'slack-example-labs:owner-2';
    insertUser(owner);
    insertRole(owner, 'owner', null);
    const result = preFanoutGate(JSON.stringify({ text: '<@UTEST00013|helper> /dashboard-token' }), owner);
    expect(result).toEqual({
      action: 'intercept',
      handlerName: 'dashboard_token_issue',
      command: '/dashboard-token',
      args: '',
    });
  });

  it('test_preFanoutGate_intercept_with_bare_at_mention', () => {
    // Bare @bot prefix (some clients send plain text rather than formal tags).
    const owner = 'discord:owner-3';
    insertUser(owner);
    insertRole(owner, 'owner', null);
    const result = preFanoutGate(JSON.stringify({ text: '@example-agent /dashboard-token' }), owner);
    expect(result).toEqual({
      action: 'intercept',
      handlerName: 'dashboard_token_issue',
      command: '/dashboard-token',
      args: '',
    });
  });
});

describe('threaded inbound — extractUserMessage', () => {
  it('test_preFanoutGate_intercept_when_wrapped_in_thread_context', () => {
    // chat-sdk wraps Slack DM thread replies with "[Thread context]\n...\n[Latest message]\n<user>".
    // preFanoutGate must classify the user's last message, not the prior assistant context.
    const owner = 'slack-example-labs:UTEST00013';
    insertUser(owner);
    insertRole(owner, 'owner', null);
    const wrapped = `[Thread context]\nassistant: prior message about something\n[Latest message]\n@UTEST00021 /dashboard-token`;
    const result = preFanoutGate(JSON.stringify({ text: wrapped }), owner);
    expect(result).toEqual({
      action: 'intercept',
      handlerName: 'dashboard_token_issue',
      command: '/dashboard-token',
      args: '',
    });
  });

  it('test_preFanoutGate_intercept_thread_context_no_mention', () => {
    // Same as above but the user typed `/dashboard-token` directly without @ prefix.
    const owner = 'discord:plain-thread';
    insertUser(owner);
    insertRole(owner, 'owner', null);
    const wrapped = `[Thread context]\nassistant: hello\n[Latest message]\n/dashboard-token`;
    const result = preFanoutGate(JSON.stringify({ text: wrapped }), owner);
    expect(result.action).toBe('intercept');
  });

  it('test_preFanoutGate_pass_when_user_text_in_thread_is_not_command', () => {
    // The wrapped portion is not a command — should still pass.
    const result = preFanoutGate(
      JSON.stringify({
        text: `[Thread context]\nassistant: /dashboard-token (false hit in context)\n[Latest message]\nthanks`,
      }),
      'any-user',
    );
    expect(result).toEqual({ action: 'pass' });
  });
});

describe('filtered commands', () => {
  it('drops /start before it reaches the container', () => {
    expect(gateCommand('/start', 'telegram:1', 'ag-1')).toEqual({ action: 'filter' });
  });

  it('drops /start regardless of sender', () => {
    expect(gateCommand('/start', null, 'ag-1')).toEqual({ action: 'filter' });
  });
});

describe('admin gating goes through roles', () => {
  it('denies an admin command from a non-admin user', () => {
    expect(gateCommand('/clear', 'telegram:nobody', 'ag-1')).toEqual({ action: 'deny', command: '/clear' });
  });

  it('denies an admin command with no sender', () => {
    expect(gateCommand('/clear', null, 'ag-1')).toEqual({ action: 'deny', command: '/clear' });
  });

  it('allows an admin command from an owner', () => {
    seedUser('telegram:owner');
    grantRole({ user_id: 'telegram:owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    expect(gateCommand('/clear', 'telegram:owner', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('allows an admin command from a scoped admin of the group', () => {
    seedUser('telegram:admin');
    grantRole({
      user_id: 'telegram:admin',
      role: 'admin',
      agent_group_id: 'ag-1',
      granted_by: null,
      granted_at: now(),
    });
    expect(gateCommand('/clear', 'telegram:admin', 'ag-1')).toEqual({ action: 'pass' });
    expect(gateCommand('/clear', 'telegram:admin', 'ag-2')).toEqual({ action: 'deny', command: '/clear' });
  });
});

describe('normal messages pass through', () => {
  it('passes a plain message', () => {
    expect(gateCommand('hello there', 'telegram:1', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('passes an unknown slash command', () => {
    expect(gateCommand('/whatever', 'telegram:1', 'ag-1')).toEqual({ action: 'pass' });
  });
});
