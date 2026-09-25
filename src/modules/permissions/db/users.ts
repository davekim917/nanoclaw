import type { User } from '../../../types.js';
import { getDb } from '../../../db/connection.js';

export async function createUser(user: User): Promise<void> {
  await getDb().run(
    `INSERT INTO users (id, kind, display_name, created_at)
       VALUES (@id, @kind, @display_name, @created_at)`,
    user,
  );
}

export async function upsertUser(user: User): Promise<void> {
  await getDb().run(
    `INSERT INTO users (id, kind, display_name, created_at)
       VALUES (@id, @kind, @display_name, @created_at)
       ON CONFLICT(id) DO UPDATE SET
         display_name = COALESCE(excluded.display_name, users.display_name)`,
    user,
  );
}

/**
 * The one-row lookup `modules/memory/pre-turn-context.ts` executes on the raw
 * handle: `buildPreTurnContext` runs inside `writeSessionMessage`'s
 * synchronous recall block, which must not gain a suspension point (seam-3
 * plan §4.5, I-1). One constant, two executors — not a `*Sync` twin.
 */
export const USER_BY_ID_SQL = 'SELECT * FROM users WHERE id = ?';

export async function getUser(id: string): Promise<User | undefined> {
  return getDb().get<User>(USER_BY_ID_SQL, id);
}
