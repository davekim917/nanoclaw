import { getDb } from './connection.js';

/**
 * `UPDATE <table> SET <each defined key> WHERE id = @id`; a no-op when every value is undefined.
 * Keys are interpolated into the SQL, so callers pass only typed column names, never user input.
 */
export async function updateColumnsById(table: string, id: string, updates: object): Promise<void> {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  await getDb().run(`UPDATE ${table} SET ${fields.join(', ')} WHERE id = @id`, values);
}
