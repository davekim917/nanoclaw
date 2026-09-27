/**
 * Records which `<session>/.host/inbound.db` files THIS HOST created (migration 079). The table lives in the
 * host-only central DB: a container can forge a convincing `.host/inbound.db` on disk but cannot write a row here, so
 * "the host made this" stays unforgeable.
 * Async through `withCentralSync(() => withRawDb(...))`, never a bare `getRawDb()` read: the raw-db ratchets forbid
 * new call sites, since a raw statement issued while `centralTransaction`'s `BEGIN IMMEDIATE` is open silently joins
 * that transaction.
 */
import fs from 'fs';

import { withCentralSync, withRawDb } from './central-lease.js';

export interface HostInboundProvenanceRow {
  agent_group_id: string;
  session_id: string;
  /** `st_dev` as a decimal string (see migration 079 on why not INTEGER). */
  device: string;
  inode: string;
  created_at: string;
}

export interface FileIdentity {
  device: string;
  inode: string;
}

/**
 * `bigint: true` is load-bearing: `st_ino` can exceed 2^53, and a rounded inode compares equal to its neighbours,
 * failing OPEN. Null means the file is gone; callers must read that as "vanished", never "failed provenance".
 */
export function fileIdentityOf(filePath: string): FileIdentity | null {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    return { device: String(stat.dev), inode: String(stat.ino) };
  } catch {
    return null;
  }
}

export async function recordHostInboundProvenance(
  agentGroupId: string,
  sessionId: string,
  identity: FileIdentity,
  now: string = new Date().toISOString(),
): Promise<void> {
  await withCentralSync(
    () =>
      withRawDb((db) => {
        db.prepare(
          `INSERT INTO host_inbound_provenance (agent_group_id, session_id, device, inode, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(agent_group_id, session_id)
           DO UPDATE SET device = excluded.device, inode = excluded.inode, created_at = excluded.created_at`,
        ).run(agentGroupId, sessionId, identity.device, identity.inode, now);
      }),
    'recordHostInboundProvenance',
  );
}

export async function readHostInboundProvenance(
  agentGroupId: string,
  sessionId: string,
): Promise<HostInboundProvenanceRow | null> {
  const row = await withCentralSync(
    () =>
      withRawDb(
        (db) =>
          db
            .prepare('SELECT * FROM host_inbound_provenance WHERE agent_group_id = ? AND session_id = ?')
            .get(agentGroupId, sessionId) as HostInboundProvenanceRow | undefined,
      ),
    'readHostInboundProvenance',
  );
  return row ?? null;
}

export async function deleteHostInboundProvenance(agentGroupId: string, sessionId: string): Promise<void> {
  await withCentralSync(
    () =>
      withRawDb((db) => {
        db.prepare('DELETE FROM host_inbound_provenance WHERE agent_group_id = ? AND session_id = ?').run(
          agentGroupId,
          sessionId,
        );
      }),
    'deleteHostInboundProvenance',
  );
}
