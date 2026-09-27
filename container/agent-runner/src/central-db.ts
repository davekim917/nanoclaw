/** The host's central DB, read-only in the container; not session state, so it stays outside modules/mailbox/. */
import { Database } from 'bun:sqlite';

let _central: Database | null = null;
const CENTRAL_DB_PATH = '/workspace/central.db';

export function getCentralDb(): Database | null {
  if (_central) return _central;
  try {
    _central = new Database(CENTRAL_DB_PATH, { readonly: true });
    return _central;
  } catch {
    return null;
  }
}
