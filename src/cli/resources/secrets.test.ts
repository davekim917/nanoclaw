import { describe, expect, it } from 'vitest';

import { getResource } from '../crud.js';
import './secrets.js';

describe('ncl secrets arguments', () => {
  it('declares no argument that dispatch auto-fills for a group-scoped agent', () => {
    // dispatch fills `group` and `agent_group_id` with the caller's own id, which would turn a workgroup-only grant
    // into a permanent group grant as well.
    const verbs = getResource('secrets')?.customOperations ?? {};
    const declared = Object.values(verbs).flatMap((op) => (op.args ?? []).map((a) => a.name));
    expect(declared).toContain('groups');
    expect(declared).not.toContain('group');
    expect(declared).not.toContain('agent_group_id');
  });
});
