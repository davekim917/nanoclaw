# `src/modules/mailbox/` — the fork's mailbox implementation

`NanoclawAgentMailbox` (index.ts) extends upstream's `SqliteAgentMailbox` and
owns **every** session-DB SQL statement on the host: openers, schema and
migrations, the repository-ingress fence, ingress, delivery, sweep, task,
admission and read ops.

- `src/mailbox/` is upstream's seam, byte-identical to upstream and never
  edited. `src/mailbox/compose.ts` is the one sanctioned edit point and
  registers this class.
- The transitional `src/db/session-db.ts` re-export façade is **gone** (mailbox
  seam PR 7), along with `session-manager.ts`'s raw openers and the module's
  own `legacy*Handle()` accessors. There is no way to reach a session DB on the
  host except through this module.
- No on-disk schema change: the shape here is exactly what the live fleet
  already carries.

## Two ways in

- `withMailboxSession` / `withExistingMailboxSession` (session-manager.ts) —
  the read-write session. Opens inbound read-write and runs the legacy
  migrations on the first touch of a path in a process. Everything that writes
  goes here; a read that must not provision uses the `Existing` form and reads
  `undefined` as "no mailbox".
- `readSessionInbound` / `readSessionOutbound` (`read-only.ts`) — the
  operator surfaces' read path, and the only synchronous one. A `readonly`
  handle, no schema-ensure, no migration, no provisioning, and a 1s
  busy_timeout by default. `read-only.ts` states the full rationale.

## Adding a read op

Name it after the QUESTION the caller asks, never after the table. Put the
statement in the closest `ops/*.ts` family (a new file only if none fits),
then expose it on `InboundSessionRead`/`OutboundSessionRead` in `read-only.ts`,
or on `NanoclawMailboxSession` in `index.ts` when a writer needs it in the same
session. There is deliberately no "run this SQL" escape hatch — that hole is
what every ratchet pattern exists to close.

## The one exemption

`src/storage-manager.ts` is the sole host entry on `src/mailbox/RATCHET.json`.
Its reclaim probes run in a worker thread over an **injected** sessions root,
which the `DATA_DIR`-keyed mailbox cannot address, and they are strictly
read-only. The rationale is at the top of that file; a second exemption needs
one written there first, and `src/mailbox-seam-ratchet.test.ts` pins the list.

Both read funnels share one failure classification: `read-only.ts`'s `openRead`
calls the same `assertQueryable` the read-write openers do, so a
present-but-unopenable session DB raises `SessionDbUnopenableError` whichever
way it was opened. What the read path deliberately does not share is anything
that writes — the hot-journal rollback stays opt-in, and inbound reads never go
through `openInboundDb`, which opens read-write and plants a reclaim-blocking
marker.
