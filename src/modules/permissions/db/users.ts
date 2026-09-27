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
 * Executed on the raw handle by pre-turn context, inside a synchronous block
 * that must not gain a suspension point.
 */
export const USER_BY_ID_SQL = 'SELECT * FROM users WHERE id = ?';

export async function getUser(id: string): Promise<User | undefined> {
  return getDb().get<User>(USER_BY_ID_SQL, id);
}

export async function getAllUsers(): Promise<User[]> {
  return getDb().all<User>('SELECT * FROM users ORDER BY created_at');
}
