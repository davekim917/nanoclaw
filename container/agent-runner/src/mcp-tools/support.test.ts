/**
 * Contract test for the dispatch_support_issue tool: it must emit a
 * `kind='system'` outbound carrying the action + Gmail thread + ticket fields
 * that the host's support-threads handler consumes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { dispatchSupportIssue, updateSupportTicket } from './support.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('dispatch_support_issue tool', () => {
  it('emits a dispatch_support_issue system action with the ticket payload', async () => {
    await dispatchSupportIssue.handler({
      gmailThreadId: 'gt-1',
      linearIssue: 'XZO-9',
      linearTeam: 'XZO',
      subject: 'help',
      sender: 'a@b.com',
      bodyText: 'something is broken',
      lastMessageId: '<m1@b.com>',
    });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('system');
    const c = JSON.parse(out[0].content) as Record<string, unknown>;
    expect(c.action).toBe('dispatch_support_issue');
    expect(c.gmailThreadId).toBe('gt-1');
    expect(c.linearIssue).toBe('XZO-9');
    expect(c.lastMessageId).toBe('<m1@b.com>');
  });

  it('rejects a call without gmailThreadId', async () => {
    const res = await dispatchSupportIssue.handler({});
    expect(res.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

describe('update_support_ticket tool', () => {
  it('emits an update_support_ticket system action with the ticket fields', async () => {
    await updateSupportTicket.handler({ linearIssue: 'XZO-200', linearTeam: 'XZO' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('system');
    const c = JSON.parse(out[0].content) as Record<string, unknown>;
    expect(c.action).toBe('update_support_ticket');
    expect(c.linearIssue).toBe('XZO-200');
    expect(c.linearTeam).toBe('XZO');
  });

  it('rejects a call without linearIssue', async () => {
    const res = await updateSupportTicket.handler({});
    expect(res.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
