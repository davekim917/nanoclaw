/**
 * `observatory_item_assignments` — the read and write sides of "this ownerless
 * item has been handed to an agent".
 *
 * Its own module rather than living in `assign.ts` because both ends need it
 * and they sit on opposite sides of an import cycle: `assign.ts` reads the
 * attention feed out of `api/threads.ts`, and `api/threads.ts` decorates its
 * rows with the assignment. See migration 058 for why the table exists at all.
 */
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';

/**
 * How long a reservation holds an item against a second assign — and, on the
 * read side, how long it presents as a live "waiting for it to pick the work
 * up" rather than a lapsed one.
 *
 * Lives here rather than in `assign.ts` for the SAME reason this whole module
 * does: `assign.ts` (write) and `api/threads.ts` (read) both need it, and they
 * sit on opposite sides of an import cycle. One constant, so the write side's
 * upsert `WHERE` and the read side's presentation can never drift out of
 * agreement about what "stale" means.
 *
 * Long enough to cover what an assignment actually takes to become visible any
 * other way: the sweep admits the task within ~60s, the container boots, the
 * agent claims the work, and only then does `claimCoversPr` suppress the board
 * item. Short enough that an agent which never picked the work up does not
 * strand it — after the window the item is assignable again, to anyone, and
 * the read side must stop presenting it as assigned at the same moment.
 */
export const ASSIGN_DEDUPE_MS = 10 * 60 * 1000;

export interface ItemAssignment {
  agentGroupId: string;
  /** ISO-8601 UTC. */
  assignedAt: string;
  /** `users.id`. */
  assignedBy: string;
}

/** One assignment row, keyed by the item's NATURAL id (no `board:` prefix). */
export interface ItemAssignmentRow extends ItemAssignment {
  workgroupId: string;
  itemId: string;
}

/**
 * Reserve this item for `agentGroupId`, unless a fresher assignment stands.
 *
 * Returns `true` when the reservation is ours and the caller should go on to
 * dispatch. Returns `false` when an assignment newer than `windowMs` already
 * holds the item — the double-click case, and the "someone else just did this"
 * case, which are the same case.
 *
 * ONE statement, on purpose. A read-then-write would leave a window two clicks
 * can both pass through, and the whole point of moving this off the in-memory
 * map is that the window closes. The `WHERE` on the upsert is what makes an
 * OLD assignment re-assignable without making a fresh one overwritable: an
 * agent that never picked the work up must not strand it forever.
 *
 * Reserve BEFORE dispatching, then {@link releaseItemAssignment} if the
 * dispatch fails — the same reserve/apply order `steer-idempotency.ts` uses,
 * for the same reason: a record written after its side effect cannot prevent
 * the side effect happening twice.
 */
export function reserveItemAssignment(
  workgroupId: string,
  itemId: string,
  agentGroupId: string,
  userId: string,
  now: number,
  windowMs: number,
): boolean {
  const staleBefore = new Date(now - windowMs).toISOString();
  const res = getDb()
    .prepare(
      `INSERT INTO observatory_item_assignments
         (workgroup_id, item_id, agent_group_id, assigned_at, assigned_by)
       VALUES (@workgroup_id, @item_id, @agent_group_id, @assigned_at, @assigned_by)
       ON CONFLICT(workgroup_id, item_id) DO UPDATE SET
         agent_group_id = excluded.agent_group_id,
         assigned_at    = excluded.assigned_at,
         assigned_by    = excluded.assigned_by
       WHERE observatory_item_assignments.assigned_at < @stale_before`,
    )
    .run({
      workgroup_id: workgroupId,
      item_id: itemId,
      agent_group_id: agentGroupId,
      // ISO, never datetime('now') — see the CLAUDE.md timestamp rule.
      assigned_at: new Date(now).toISOString(),
      assigned_by: userId,
      stale_before: staleBefore,
    });
  return res.changes > 0;
}

/**
 * Drop a reservation whose dispatch never landed.
 *
 * Deletes rather than restoring whatever the row held before, and that is a
 * deliberate simplification: the alternative is carrying the previous row
 * through the dispatch so it can be put back, to preserve a record of an
 * assignment that is by definition older than the re-assign window and
 * therefore already re-assignable. Losing it costs nothing the operator can
 * see; leaving a reservation behind for work that was never queued costs them
 * the ability to try again.
 *
 * ponytail: unconditional delete. Make it a compare-and-delete on
 * `assigned_at` if a cross-process host ever serves this endpoint.
 */
export function releaseItemAssignment(workgroupId: string, itemId: string): void {
  try {
    getDb()
      .prepare(`DELETE FROM observatory_item_assignments WHERE workgroup_id = ? AND item_id = ?`)
      .run(workgroupId, itemId);
  } catch (err) {
    log.warn('observatory assign: could not release a failed reservation', { workgroupId, itemId, err });
  }
}

/** The standing assignment for one item, or null. */
export function readItemAssignment(workgroupId: string, itemId: string): ItemAssignment | null {
  try {
    const row = getDb()
      .prepare(
        `SELECT agent_group_id, assigned_at, assigned_by
           FROM observatory_item_assignments
          WHERE workgroup_id = ? AND item_id = ?`,
      )
      .get(workgroupId, itemId) as { agent_group_id: string; assigned_at: string; assigned_by: string } | undefined;
    if (!row) return null;
    return { agentGroupId: row.agent_group_id, assignedAt: row.assigned_at, assignedBy: row.assigned_by };
  } catch (err) {
    log.warn('observatory assign: could not read an item assignment', { workgroupId, itemId, err });
    return null;
  }
}

/**
 * Every assignment across a set of workgroups, keyed `<workgroupId>\n<itemId>`.
 *
 * One query per list build, never one per row — the list endpoint runs this on
 * every poll from every open console. A newline separator because item ids are
 * repo-scoped strings that legitimately contain `:` and `#`.
 *
 * Never throws: a host running an older schema must still render its queue
 * rather than blanking it, exactly as `decorateSteeredThreads` does for
 * migration 050.
 */
export function readItemAssignments(workgroupIds: string[]): Map<string, ItemAssignmentRow> {
  const out = new Map<string, ItemAssignmentRow>();
  if (workgroupIds.length === 0) return out;
  try {
    const rows = getDb()
      .prepare(
        `SELECT workgroup_id, item_id, agent_group_id, assigned_at, assigned_by
           FROM observatory_item_assignments
          WHERE workgroup_id IN (${workgroupIds.map(() => '?').join(', ')})`,
      )
      .all(...workgroupIds) as {
      workgroup_id: string;
      item_id: string;
      agent_group_id: string;
      assigned_at: string;
      assigned_by: string;
    }[];
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

/** The key {@link readItemAssignments} maps on. */
export function assignmentKey(workgroupId: string, itemId: string): string {
  return `${workgroupId}\n${itemId}`;
}

/**
 * Display names for a set of `users.id`, for whoever fired an assignment.
 *
 * Resolved at READ time, never frozen into the assignment row — a rename must
 * show. A user row that has since been deleted, or one with no display name,
 * simply has no entry and the caller falls back to the raw id: knowing an item
 * was assigned matters more than knowing who by.
 */
export function readUserDisplayNames(userIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (userIds.length === 0) return out;
  try {
    const rows = getDb()
      .prepare(`SELECT id, display_name FROM users WHERE id IN (${userIds.map(() => '?').join(', ')})`)
      .all(...userIds) as { id: string; display_name: string | null }[];
    for (const r of rows) if (r.display_name) out.set(r.id, r.display_name);
  } catch (err) {
    log.warn('observatory assign: could not resolve assigner display names', { err });
  }
  return out;
}
