# Release choice receipts

**Status:** Execution is authorized under the user's explicit autonomous
mandate. This records the technical contract; it does not assert that the user
read or approved this document.

## Outcome

`request_choice` can opt into one canonical `release_ship` scope. The host,
not an agent's prose or arbitrary labels, renders the resulting Ship/Hold card
and persists its scope and decision instant in a one-time receipt. An external,
read-only release consumer can then bind a card-derived ship to exactly one
repository, PR, base, head, authorized human, trusted group, and trusted route.

## Scope contract

The optional `approvalScope` object has exactly five keys:

```json
{
  "purpose": "release_ship",
  "repository": "owner/repository",
  "pullRequest": 42,
  "base": "main",
  "headSha": "0123456789abcdef0123456789abcdef01234567"
}
```

Both the runner and host reject invalid/unknown fields without coercion:
literal purpose; a bounded owner/repository pair without whitespace/control
characters; safe positive integer PR; bounded non-whitespace base; and an
exact lower-case 40-hex head. An unscoped request preserves the existing
title/question/options contract. A scoped request's agent-provided display
fields are ignored and the host stores/renders exactly:

```json
[
  { "label": "Ship", "value": "ship", "style": "primary" },
  { "label": "Hold", "value": "hold", "style": "danger" }
]
```

The existing generic `choice_response` line remains byte-for-byte compatible.
Only after a valid scoped card is resolved does the host append
`release_scope=<encodeURIComponent(canonical JSON)>`, after `user_name`. The
value is recomputed from the saved pending payload, not from agent display
text. Consumers accept it only on a message marked both `origin="host"` and
`event="choice_response"`, decode it, and still re-check the immutable receipt
below; the transport field is not authority on its own.

## Host receipt invariant

On the successful authorized `pending -> approved` CAS, the host captures one
ISO-UTC decision instant before it awaits session resolution, handler delivery,
card editing, or notification. That instant is passed to the receipt writer;
the writer never re-reads the clock. A failed delivery returns the pending row
and writes no receipt; a later successful click is a new decision. Once
written, a receipt is immutable, keyed by its host-minted approval ID, and
contains nullable `release_scope_json` for backward-compatible generic choices.

Migration 080 is additive: it adds the nullable column and rejects receipt
updates while retaining the existing intentional agent-group teardown delete.
No backfill is permitted.

## External consumer invariant

The private consumer opens the host database only with a WAL-aware SQLite
read-only connection. A scoped card-derived ship counts only when its receipt
ID, request ID, action, `ship` value, canonical scope, human identity, trusted
group/route, and current PR target/base/full head all match. Missing, malformed,
future, or mismatched evidence fails closed. It does not join an active session
because a receipt intentionally outlives session archival.

The host receipt instant is the only ordering time for a validated scoped card:
the private consumer creates an in-memory normalized entry before gate sorting,
replacing agent-written gate time with `resolved_at`. Exact duplicate approval
IDs coalesce; conflicting same-ID bindings are refused. Equal-instant holds win.
Typed Slack phase-1 behavior remains explicitly unchanged; this is not an
all-approval rewrite. A missing card hold receipt cannot loosen an existing
binding hold.

## Acceptance criteria

1. Runner test: valid scope transports without agent display fields; malformed
   types/PR/repo/base/SHA/purpose/extra fields emit no action; generic behavior
   is unchanged.
2. Host-card test: deceptive scoped title/question/options never reach the
   pending row or card; malformed scope posts nothing; generic cards retain
   arbitrary options.
3. Receipt test: scope and CAS-time are inserted before pending deletion;
   deferred delivery advancing the host clock cannot re-date the receipt;
   generic receipt scope is null and losing clicks add no receipt.
4. Migration test: pre-080 rows remain readable with null scope, new rows
   write scope, update is rejected, intended delete works, and fresh/live
   migration registries converge.
5. Cross-language fixture: a temporary actual database is written through the
   registered host delivery action and authorized response dispatcher, then its
   real host-origin response is decoded into the private Python consumer; no
   hand-authored receipt, response, or approval ID may stand in for host output.
6. Policy test: missing/malformed/wrong receipt evidence, wrong scope/head/
   actor/route, future receipt instant, and duplicate ID all fail closed;
   scoped receipt time cannot be re-dated past an ordinary hold, smoke NO_GO,
   or release-day boundary; equal-time hold wins; typed Slack remains phase 1.

## Rollout and rollback

Deploy producer/migration and consumer/recorder together after implementation
review. Restarting the host activates the runner snapshot and migration; no
manual policy/status invocation is proof. A rollback leaves the additive column
in place but must retain card-derived ships fail-closed rather than restoring an
allowlist-only bypass. A positive live proof requires a future genuine human
card click; no fabricated receipt, backfill, or synthetic click is valid.

## Operational-instruction footprint

A third, separately versioned group-instruction repository carries the release
agent's scoped-card recorder protocol. It directs the saved watcher prompt to
this protocol before a card-derived record is created, preserves generic
product decision cards as non-release decisions, and explicitly retains the
no-human-gate develop flow. Its text contains no installation identifiers; the
private consumer alone owns those bindings. Updating live task text or
regenerating host instructions is a later, explicit activation step.
