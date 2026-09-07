# Preserve scheduled-task waits

## Problem

The spent-task-session collector only considered live task rows and a running
container. A one-shot task can complete, release its idle container, and still
hold an inert recall-paired wait in the same session. Closing that session
before the wait becomes due removes it from the active-session sweep, so due
admission and its normal same-session respawn never run.

## Design

Keep the existing per-session sweep and admission flow. Add one mailbox query
for a pending non-system primary that still has its pending `recall-<id>`
partner. That identifies both future deferred waits (`trigger = 0`) and due
turns already admitted (`trigger = 1`). The collector also treats a readable
durable work continuation as unfinished work.

The collector reads all three predicates from the mailbox before its existing
move-intent read and rechecks them after that await. A recall marker without a
pending primary, completed or expired primary rows, and unpaired inert context
do not retain a session. Existing recurrence, move-intent, idle-reap, and
due-wake ownership rules are unchanged.

## Acceptance

- A task session with a future recall-paired wait remains active after its
  original task and container are gone.
- A due paired wait is admitted, leaves the session active, and invokes the
  normal wake path for that same session.
- A valid unfinished continuation remains active.
- A completed task session with only historical recall context, expired rows,
  or unrelated inert context still closes.
