/**
 * `observatory_item_assignments`: "this ownerless item has been handed to an agent". Its own module because
 * `assign.ts` (write) and `api/threads.ts` (read) sit on opposite sides of an import cycle.
 */
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';

/**
 * How long a reservation holds an item against a second assign, and how long the read side presents it as live. One
 * constant so the write side's upsert `WHERE` and the read side agree on "stale". Covers sweep admission, container
 * boot and the agent's claim; after it the item is assignable again so an agent that never picked it up cannot strand
 * it.
 */
export const ASSIGN_DEDUPE_MS = 10 * 60 * 1000;

export interface ItemAssignment {
  agentGroupId: string;
  assignedAt: string;
  /** `users.id`. */
  assignedBy: string;
}

/** Keyed by the item's NATURAL id (no `board:` prefix). */
export interface ItemAssignmentRow extends ItemAssignment {
  workgroupId: string;
  itemId: string;
}

/**
 * Reserves the item unless an assignment newer than `windowMs` holds it (double-click and "someone else just did
 * this" are the same case). ONE statement: a read-then-write leaves a window two clicks can both pass. The upsert
 * `WHERE` makes an old assignment re-assignable without making a fresh one overwritable. Reserve BEFORE dispatching
 * and {@link releaseItemAssignment} on failure: a record written after its side effect cannot prevent it happening
 * twice.
 */
export async function reserveItemAssignment(
  workgroupId: string,
  itemId: string,
  agentGroupId: string,
  userId: string,
  now: number,
  windowMs: number,
): Promise<boolean> {
  const staleBefore = new Date(now - windowMs).toISOString();
  const res = await getDb().run(
    `INSERT INTO observatory_item_assignments
       (workgroup_id, item_id, agent_group_id, assigned_at, assigned_by)
     VALUES (@workgroup_id, @item_id, @agent_group_id, @assigned_at, @assigned_by)
     ON CONFLICT(workgroup_id, item_id) DO UPDATE SET
       agent_group_id = excluded.agent_group_id,
       assigned_at    = excluded.assigned_at,
       assigned_by    = excluded.assigned_by
     WHERE observatory_item_assignments.assigned_at < @stale_before`,
    {
      workgroup_id: workgroupId,
      item_id: itemId,
      agent_group_id: agentGroupId,
      assigned_at: new Date(now).toISOString(),
      assigned_by: userId,
      stale_before: staleBefore,
    },
  );
  return res.changes > 0;
}

/**
 * Drops a reservation whose dispatch never landed. Deletes rather than restoring the previous row, which was already
 * past the re-assign window. Unconditional: make it compare-and-delete on `assigned_at` if a cross-process host ever
 * serves this endpoint.
 */
export async function releaseItemAssignment(workgroupId: string, itemId: string): Promise<void> {
  try {
    await getDb().run(
      `DELETE FROM observatory_item_assignments WHERE workgroup_id = ? AND item_id = ?`,
      workgroupId,
      itemId,
    );
  } catch (err) {
    log.warn('observatory assign: could not release a failed reservation', { workgroupId, itemId, err });
  }
}

export async function readItemAssignment(workgroupId: string, itemId: string): Promise<ItemAssignment | null> {
  try {
    const row = await getDb().get<{ agent_group_id: string; assigned_at: string; assigned_by: string }>(
      `SELECT agent_group_id, assigned_at, assigned_by
         FROM observatory_item_assignments
        WHERE workgroup_id = ? AND item_id = ?`,
      workgroupId,
      itemId,
    );
    if (!row) return null;
    return { agentGroupId: row.agent_group_id, assignedAt: row.assigned_at, assignedBy: row.assigned_by };
  } catch (err) {
    log.warn('observatory assign: could not read an item assignment', { workgroupId, itemId, err });
    return null;
  }
}

/**
 * Keyed `<workgroupId>\n<itemId>` (item ids contain `:` and `#`). One query per list build, never per row. Never
 * throws, so an older schema still renders its queue.
 */
export async function readItemAssignments(workgroupIds: string[]): Promise<Map<string, ItemAssignmentRow>> {
  const out = new Map<string, ItemAssignmentRow>();
  if (workgroupIds.length === 0) return out;
  try {
    const rows = await getDb().all<{
      workgroup_id: string;
      item_id: string;
      agent_group_id: string;
      assigned_at: string;
      assigned_by: string;
    }>(
      `SELECT workgroup_id, item_id, agent_group_id, assigned_at, assigned_by
         FROM observatory_item_assignments
        WHERE workgroup_id IN (${workgroupIds.map(() => '?').join(', ')})`,
      ...workgroupIds,
    );
    for (const r of rows) {
      out.set(assignmentKey(r.workgroup_id, r.item_id), {
        workgroupId: r.workgroup_id,
        itemId: r.item_id,
        agentGroupId: r.agent_group_id,
        assignedAt: r.assigned_at,
        assignedBy: r.assigned_by,
      });
    }
  } catch (err) {
    log.warn('observatory assign: could not read item assignments', { err });
  }
  return out;
}

export function assignmentKey(workgroupId: string, itemId: string): string {
  return `${workgroupId}\n${itemId}`;
}

/**
 * Resolved at read time so a rename shows; a deleted user or missing name has no entry and the caller falls back to
 * the raw id.
 */
export async function readUserDisplayNames(userIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (userIds.length === 0) return out;
  try {
    const rows = await getDb().all<{ id: string; display_name: string | null }>(
      `SELECT id, display_name FROM users WHERE id IN (${userIds.map(() => '?').join(', ')})`,
      ...userIds,
    );
    for (const r of rows) if (r.display_name) out.set(r.id, r.display_name);
  } catch (err) {
    log.warn('observatory assign: could not resolve assigner display names', { err });
  }
  return out;
}
