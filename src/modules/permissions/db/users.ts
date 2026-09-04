import type { User } from '../../../types.js';
import { getRawDb } from '../../../db/connection.js';

export function createUser(user: User): void {
  getRawDb()
    .prepare(
      `INSERT INTO users (id, kind, display_name, created_at)
       VALUES (@id, @kind, @display_name, @created_at)`,
    )
    .run(user);
}

export function upsertUser(user: User): void {
  getRawDb()
    .prepare(
      `INSERT INTO users (id, kind, display_name, created_at)
       VALUES (@id, @kind, @display_name, @created_at)
       ON CONFLICT(id) DO UPDATE SET
         display_name = COALESCE(excluded.display_name, users.display_name)`,
    )
    .run(user);
}

export function getUser(id: string): User | undefined {
  return getRawDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}

export function getAllUsers(): User[] {
  return getRawDb().prepare('SELECT * FROM users ORDER BY created_at').all() as User[];
}

export function updateDisplayName(id: string, displayName: string): void {
  getRawDb().prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, id);
}

export function deleteUser(id: string): void {
  getRawDb().prepare('DELETE FROM users WHERE id = ?').run(id);
}
