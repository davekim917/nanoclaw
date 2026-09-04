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

## Three ways in

There is exactly ONE spelling for the mailbox session — `withMailboxSession` /
`withExistingMailboxSession`, from `session-manager.ts`. The
`withNanoclawSession` / `withExistingNanoclawSession` aliases are gone: they
were pure pass-throughs whose `as NanoclawMailboxSession` casts were no-ops,
because `session-manager.ts` already types its action that way.

- `withMailboxSession` / `withExistingMailboxSession` (`session-manager.ts`) —
  the read-write mailbox session, keyed on **inbound.db**. Opens inbound
  read-write and runs the legacy migrations on the first touch of a path in a
  process. Everything that writes to inbound goes here; a read that must not
  provision uses the `Existing` form and reads `undefined` as "no mailbox".
- `readSessionInbound` / `readSessionOutbound` (`read-only.ts`) — the operator
  surfaces' read path, and the only synchronous one. A `readonly` handle, no
  schema-ensure, no migration, no provisioning, and a 1s busy_timeout by
  default. `read-only.ts` states the full rationale.
- `withExistingNanoclawOutbound` (`index.ts`) — the **outbound-keyed** session,
  for outbound-only work: the thread-close force-clear, the router's two
  notices, the done-proposal read. The action receives the module's TYPED
  outbound ops, never a raw handle. Deliberately not the mailbox session: that
  one's existence check is inbound-keyed, so it answers `undefined` for a
  session whose inbound.db is gone while outbound.db remains. It sits in
  `index.ts` rather than beside the read funnels because it is composed from
  `composeOutboundOps`, and `read-only.ts` cannot import that without a static
  cycle through the barrel.

All three are existing-only and answer absence the same way: an absent DB is
`undefined`; a present-but-unopenable one raises `SessionDbUnopenableError`
whichever funnel opened it. **The existence question a funnel asks is keyed to
the file the action actually touches** — four separate review findings across
this series were one violation of that rule, and both mailbox-seam ratchet
rules exist to keep it.

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
