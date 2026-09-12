/**
 * Typed accessors over `host_inbound_provenance` (migration 079) — the record
 * of which `<session>/.host/inbound.db` files THIS HOST created.
 *
 * The table lives in the central DB (`data/v2.db`), which is host-only and
 * never mounted into a container. That is the entire point: a container can
 * create a convincing `.host/inbound.db` on the filesystem — round 2 of #761's
 * review proved it can, under the pre-deploy mount set — but it cannot write a
 * row here, so "the host made this" stays unforgeable. See migration 079 for
 * why no content-based or filesystem-based test can answer that question.
 *
 * ASYNC, THROUGH THE LEASE, AND NOT `getRawDb()`. The obvious shape for a gate
 * called from a synchronous migration would be a bare synchronous read. Two
 * standing ratchets forbid adding one, and both only ever shrink:
 * `raw-db-ratchet.test.ts` pins the SET of files naming `getRawDb`, and
 * `raw-outside-lease.test.ts` pins the CALL sites, because a raw statement
 * issued while `centralTransaction`'s async `BEGIN IMMEDIATE` is open silently
 * joins a transaction it knows nothing about. So these go through
 * `withCentralSync(() => withRawDb(...))` like every other central read the
 * fork added after the seam, and `migrateInboundDbToHostDir` became async to
 * match — its one production caller, `buildMounts`, was already async and holds
 * no lease at that point.
 */
import fs from 'fs';

import { withCentralSync, withRawDb } from './central-lease.js';

export interface HostInboundProvenanceRow {
  agent_group_id: string;
  session_id: string;
  /** `st_dev` as a decimal string — see migration 079 on why not INTEGER. */
  device: string;
  /** `st_ino` as a decimal string. */
  inode: string;
  created_at: string;
}

/** The identity of a file on disk, in the exact spelling the table stores. */
export interface FileIdentity {
  device: string;
  inode: string;
}

/**
 * Identify a file precisely enough to compare it later.
 *
 * `bigint: true` is load-bearing: `st_ino` can exceed 2^53, and a rounded
 * inode would compare equal to its neighbours — a fail-OPEN in the rare case
 * this gate exists to catch. Returns null when the file is not there, which
 * callers must read as "vanished", never as "failed provenance".
 *
 * Stays synchronous: it touches the filesystem, not the central DB.
 */
export function fileIdentityOf(filePath: string): FileIdentity | null {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    return { device: String(stat.dev), inode: String(stat.ino) };
  } catch {
    return null;
  }
}

/** Record that this host created `.host/inbound.db` for a session. */
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

/** The recorded provenance for a session, or null when this host recorded none. */
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

/**
 * Does the file at `filePath` carry provenance recorded by this host?
 *
 * Fails closed on every unanswerable case: no row, or a file that cannot be
 * identified. A row whose identity does NOT match the file on disk is the
 * strongest negative of all — something replaced the file this host created.
 */
export async function hostInboundProvenanceMatches(
  agentGroupId: string,
  sessionId: string,
  filePath: string,
): Promise<boolean> {
  const row = await readHostInboundProvenance(agentGroupId, sessionId);
  if (!row) return false;
  const identity = fileIdentityOf(filePath);
  if (!identity) return false;
  return row.device === identity.device && row.inode === identity.inode;
}

/** Forget a session's provenance, for a session being destroyed. */
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
