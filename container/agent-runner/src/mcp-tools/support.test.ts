/**
 * Contract test for the dispatch_support_issue tool: it must emit a
 * `kind='system'` outbound carrying the action + Gmail thread + ticket fields
 * that the host's support-threads handler consumes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { dispatchSupportIssue, updateSupportTicket, writeSupportAction } from './support.js';

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
      linearIssue: 'EXAMPLE-9',
      linearTeam: 'EXAMPLE',
      subject: 'help',
      sender: 'person8@fixture1.example.com',
      date: 'Fri, 17 Jul 2026 16:40:55 -0400',
      bodyText: 'something is broken',
      lastMessageId: '<person18@fixture1.example.com>',
    });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('system');
    const c = JSON.parse(out[0].content) as Record<string, unknown>;
    expect(c.action).toBe('dispatch_support_issue');
    expect(c.gmailThreadId).toBe('gt-1');
    expect(c.linearIssue).toBe('EXAMPLE-9');
    expect(c.date).toBe('Fri, 17 Jul 2026 16:40:55 -0400');
    expect(c.lastMessageId).toBe('<person18@fixture1.example.com>');
  });

  it('rejects a call without gmailThreadId', async () => {
    const res = await dispatchSupportIssue.handler({});
    expect(res.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('rejects a dispatch when required email context is missing', async () => {
    const res = await dispatchSupportIssue.handler({
      gmailThreadId: 'gt-1',
      subject: 'help',
      sender: 'person8@fixture1.example.com',
      bodyText: 'something is broken',
    });

    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('date is required');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('retries transient outbound DB locks without waiting for the next poll run', async () => {
    let attempts = 0;
    const waits: number[] = [];

    await writeSupportAction(
      { id: 'sys-retry', kind: 'system', content: '{}' },
      {
        write: () => {
          attempts += 1;
          if (attempts < 3) throw new Error('database is locked');
          return 1;
        },
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );

    expect(attempts).toBe(3);
    expect(waits).toEqual([50, 100]);
  });

  it('does not retry non-lock SQLite failures', async () => {
    let attempts = 0;

    const result = writeSupportAction(
      { id: 'sys-fail', kind: 'system', content: '{}' },
      {
        write: () => {
          attempts += 1;
          throw new Error('disk I/O error');
        },
        sleep: async () => {},
      },
    );

    await expect(result).rejects.toThrow('disk I/O error');
    expect(attempts).toBe(1);
  });

  it('bounds persistent lock retries', async () => {
    let attempts = 0;
    const waits: number[] = [];

    const result = writeSupportAction(
      { id: 'sys-still-locked', kind: 'system', content: '{}' },
      {
        write: () => {
          attempts += 1;
          throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
        },
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );

    await expect(result).rejects.toThrow('busy');
    expect(attempts).toBe(5);
    expect(waits).toEqual([50, 100, 250, 500]);
  });
});

describe('update_support_ticket tool', () => {
  it('emits an update_support_ticket system action with the ticket fields', async () => {
    await updateSupportTicket.handler({ linearIssue: 'EXAMPLE-200', linearTeam: 'EXAMPLE' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('system');
    const c = JSON.parse(out[0].content) as Record<string, unknown>;
    expect(c.action).toBe('update_support_ticket');
    expect(c.linearIssue).toBe('EXAMPLE-200');
    expect(c.linearTeam).toBe('EXAMPLE');
  });

  it('rejects a call without linearIssue', async () => {
    const res = await updateSupportTicket.handler({});
    expect(res.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
