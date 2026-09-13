import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { getInboundDb, getOutboundDb } from '../mailbox/sqlite/connection.js';
import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';
import { wikiAdmissionTool } from './wiki-admission.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

describe('wiki admission session transport', () => {
  it('correlates the host response using a generated request identity, never caller action/id fields', async () => {
    const pending = wikiAdmissionTool.handler({
      operation: 'begin',
      action: 'repository_publish',
      requestId: 'forged',
    });
    await Bun.sleep(0);
    const row = getOutboundDb().prepare("SELECT id,content FROM messages_out WHERE kind='system'").get() as {
      id: string;
      content: string;
    };
    expect(row.id).toMatch(/^repo-\d+-[0-9a-f]{16}$/);
    expect(JSON.parse(row.content)).toEqual({ operation: 'begin', action: 'wiki_admission', requestId: row.id });
    getInboundDb()
      .prepare('INSERT INTO messages_in(id,kind,timestamp,status,trigger,content) VALUES(?,?,?,?,?,?)')
      .run(
        `wiki-response-${row.id}`,
        'system',
        new Date().toISOString(),
        'pending',
        0,
        '{"candidateId":"host-created"}',
      );
    const result = await pending;
    expect(result.content).toEqual([{ type: 'text', text: '{"candidateId":"host-created"}' }]);
    expect(
      getOutboundDb().prepare('SELECT message_id FROM processing_ack WHERE message_id=?').get(`wiki-response-${row.id}`),
    ).toBeTruthy();
  });
});
