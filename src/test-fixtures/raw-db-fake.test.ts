/**
 * Pins the fake's routing to the SQL the guard path actually executes.
 *
 * `rawDbFake` routes by table name rather than by importing the leaf constants,
 * because it has to stay loadable from inside a `vi.mock` factory (no logger,
 * no connection module). That indirection is only safe if something asserts the
 * two stay in step: a leaf whose SELECT is rewritten past these patterns would
 * otherwise leave every guard-path test reading an empty row and failing closed
 * for a reason no message names.
 */
import { describe, expect, it } from 'vitest';

import { CONTAINER_CONFIG_BY_GROUP_SQL } from '../db/container-configs.js';
import { PENDING_APPROVAL_BY_ID_SQL, SESSION_BY_ID_SQL } from '../db/sessions.js';
import { rawDbFake } from './raw-db-fake.js';

describe('rawDbFake routes the guard path’s own SQL', () => {
  it('answers each leaf constant from its route, keyed by the statement argument', () => {
    const db = rawDbFake({
      sessions: (id) => ({ table: 'sessions', id }),
      containerConfigs: (id) => ({ table: 'container_configs', id }),
      pendingApprovals: (id) => ({ table: 'pending_approvals', id }),
    });

    expect(db.prepare(SESSION_BY_ID_SQL).get('sess-1')).toEqual({ table: 'sessions', id: 'sess-1' });
    expect(db.prepare(CONTAINER_CONFIG_BY_GROUP_SQL).get('ag-1')).toEqual({
      table: 'container_configs',
      id: 'ag-1',
    });
    expect(db.prepare(PENDING_APPROVAL_BY_ID_SQL).get('appr-1')).toEqual({
      table: 'pending_approvals',
      id: 'appr-1',
    });
  });

  it('reads empty for a table it has no route for, and defers to a fallback when given one', () => {
    expect(rawDbFake().prepare(SESSION_BY_ID_SQL).get('sess-1')).toBeUndefined();
    expect(
      rawDbFake({ sessions: () => undefined })
        .prepare('SELECT * FROM users WHERE id = ?')
        .get('u1'),
    ).toBeUndefined();
    expect(rawDbFake({}).prepare(SESSION_BY_ID_SQL).all()).toEqual([]);

    const seen: string[] = [];
    const withFallback = rawDbFake({ fallback: (sql) => (seen.push(sql), { fell: true }) });
    expect(withFallback.prepare('SELECT * FROM users WHERE id = ?').get('u1')).toEqual({ fell: true });
    expect(seen).toEqual(['SELECT * FROM users WHERE id = ?']);
  });
});
