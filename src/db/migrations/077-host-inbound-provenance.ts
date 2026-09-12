import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Migration 077 — `host_inbound_provenance`
 *
 * WHY. #749 moved the host's `inbound.db` into `<session>/.host/` and overlaid
 * that DIRECTORY read-only, which closes the planted-journal class for every
 * container spawned under the new mount set. It does not answer the reverse
 * question, and round 2 of the review proved the gap: under the PRE-deploy
 * mount set `/workspace` is read-write and `.host` does not exist, so nothing
 * is overlaid over it, and a container can simply `mkdir /workspace/.host` and
 * write its own `inbound.db` there. At that session's next spawn the migration
 * saw a host-owned file already present, found the inodes diverged, and
 * re-linked the legacy name onto the PLANTED inode — adopting the attacker's
 * database wholesale and orphaning the real one. Strictly worse than the
 * original defect: the whole authoritative store rather than chosen pages.
 *
 * WHY A RECORD, AND NOT A CONTENT RULE. Every filesystem signal available is
 * either forgeable or ambiguous. Ownership is no signal at all — host process
 * and container run as the same uid, so a container-created directory lands
 * host-side with identical ownership. Mode depends on whichever umask happened
 * to apply. Timestamps are chosen by whoever plants. Inode identity is the one
 * durable STRUCTURAL signal (a migrated file is a `link()` of the legacy name,
 * so same inode, `st_nlink >= 2`), but it only says "this was not produced by a
 * linkSync migration" — it cannot separate an attacker from the legitimate
 * rolled-back-host case the re-link branch exists to serve.
 *
 * Content rules are worse still, and were considered and rejected: the attacker
 * authors the entire planted file INCLUDING ITS SCHEMA, so a zero-row database
 * carrying a hostile TRIGGER or VIEW on `messages_in`/`delivered` wins any
 * "prefer the non-empty side" tie-break and then subverts every later host
 * write. "Empty of rows" is not "benign".
 *
 * The only question worth asking is "did THIS HOST create this file", and
 * nothing inside the file can answer it. So the answer is recorded out of
 * reach: this table lives in the central DB (`data/v2.db`), which is host-only
 * and is never mounted into any container.
 *
 * SHAPE. One row per session, written when the host itself creates
 * `.host/inbound.db`, carrying the identity of the file it created.
 * `device`/`inode` are TEXT holding decimal strings, not INTEGER: `st_ino` can
 * exceed 2^53 on real filesystems (XFS, and any 64-bit inode namespace), and a
 * JS number would round it silently — a rounded inode compares equal to its
 * neighbours, which would turn this gate fail-OPEN in exactly the rare case it
 * is meant to catch. They are read with `fs.statSync(p, { bigint: true })` and
 * stored via `String(...)`.
 *
 * NO FOREIGN KEY to `sessions` on purpose. The row must outlive, and be
 * readable independently of, whatever the sessions table happens to hold: a
 * session row can be recreated or reclaimed, and a provenance record whose
 * absence is a REFUSAL must never be deleted as a side effect of unrelated
 * cascade behaviour. Removal is explicit, from the mailbox's own `destroy`.
 */
export const migration077: Migration = {
  version: 77,
  name: 'host-inbound-provenance',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS host_inbound_provenance (
        agent_group_id TEXT NOT NULL,
        session_id     TEXT NOT NULL,
        device         TEXT NOT NULL,
        inode          TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        PRIMARY KEY (agent_group_id, session_id)
      )
    `);
  },
};
