# `src/modules/mailbox/` — the fork's mailbox implementation

`NanoclawAgentMailbox` (index.ts) extends upstream's `SqliteAgentMailbox` and
owns **every** session-DB SQL statement on the host: openers, schema and
migrations, the repository-ingress fence, ingress, delivery and sweep ops.

- `src/mailbox/` is upstream's seam, byte-identical to upstream and never
  edited. `src/mailbox/compose.ts` is the one sanctioned edit point and
  registers this class.
- `src/db/session-db.ts` is a transitional re-export façade so the existing
  callers keep working while they move behind `withMailboxSession`
  (docs/specs/upstream-mailbox-seam/plan.md PRs 3-6). PR 7 deletes it.
- No on-disk schema change: the shape here is exactly what the live fleet
  already carries.

## Two ways in

- `withMailboxSession` / `withExistingMailboxSession` (session-manager.ts) —
  the read-write session. Opens inbound read-write and runs the legacy
  migrations on the first touch of a path in a process. Everything that writes
  goes here.
- `readSessionInbound` / `readSessionOutbound` (`read-only.ts`) — the
  operator surfaces' read path. A `readonly` handle, no schema-ensure, no
  migration, no provisioning, and a 1s busy_timeout by default. Used where a
  console request fans out across the whole fleet and must never be what
  migrates or writes a session it is only listing. `read-only.ts` states the
  full rationale.
