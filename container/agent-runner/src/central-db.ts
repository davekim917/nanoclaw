/**
 * Central DB — read-only from the container. Mounted at /workspace/central.db.
 *
 * Not mailbox state: this is the host's central database, not one of the two
 * session DBs, so it deliberately lives outside modules/mailbox/ (which owns
 * every fork customization of inbound.db/outbound.db and nothing else).
 */
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
