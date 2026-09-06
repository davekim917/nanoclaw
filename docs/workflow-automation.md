# Workflow automation

This contract applies when authoring or changing a scheduled task, event-driven
monitor, continuation, recovery wake, or template task. It describes workflow
semantics, not new database fields or an automatic migration of existing work.
Inspect and migrate each existing workflow separately.

## Choose the execution path

Use deterministic code first when bounded data can decide whether work exists:
polling, normalization, comparison, debounce, duplicate-delivery detection,
and routine status publication belong there. A successful quiet observation
with no pending work or due recovery returns `wakeAgent:false` and does not
call a model. A meaningful change, due unresolved action, missing completion
receipt, recovery deadline, or failure that needs judgment wakes with compact
facts and evidence references.

Do not encode a timeout, malformed state, or failed fetch as a quiet result. A
task script may fail so its normal failure/backoff path remains visible, or it
may wake with a bounded failure record when an agent can investigate. Give each
failure path an owner, retry limit or trigger, and a recovery action before the
workflow is enabled.

Container task scripts are appropriate when their data, mount, or credential
boundary belongs in the container. A host script can avoid the container spawn
on a quiet fire, but it is an operator-only `--script-host` choice. Templates
carry only `schedule` and `script`; they cannot grant host execution. A host
script must have separately reviewed dependencies, authority, timeout and error
behavior. See [Scheduled Tasks](scheduled-tasks.md#script-gates) for the task
script transport and failure semantics.

Some periodic model work is deliberate. A requested briefing, research
synthesis, planning review, or full campaign may run without a gate when the
cadence itself requires judgment. State that reason in the workflow record; do
not add a script that always wakes just to imitate a monitor.

## Preserve observation and completion semantics

For a gated workflow, model work begins only after deterministic observation
says it is needed. That does not make the work complete. For each work item,
preserve these separate states in durable workflow-owned storage:

1. **Observed** — a source fact and stable observation or effect identity were
   captured.
2. **Pending** — the observation needs an action, acknowledgement, or
   verification. A queued or completed wake alone does not clear it.
3. **Completed** — the required outcome and its receipt are durable and match
   the observed identity.

These names describe the contract; use the state file, database record, claim,
or receipt that fits the workflow. Do not advance completion when a wake is
emitted. On a failed or killed turn, keep the item pending and inspect durable
receipts before retrying because an effect may already exist. Completion of an
older observation must not consume a newer one. Use stable identities and
atomic updates or existing claims to avoid concurrent or retry duplicate
effects.

The deterministic layer should pass changed facts, evidence references,
unfinished work, available authority, and the next verification to the agent.
It should not force the agent to reconstruct an unchanged inventory. The owner
decides and remains accountable, delegates substantial execution to the right
builder when useful, retains any required independent review, verifies the
result, and closes only the authorized outcome. Small mechanical work may stay
with the owner. Escalate only an action outside existing authority.

## Check for duplicate workflows

Before creating or enabling a workflow, inspect active scheduled series with
`ncl tasks list` and separately inspect the relevant event, continuation, and
recovery paths. Compare owner, cadence or trigger, canonical purpose, and
effect identity. A matching prompt is not enough to suppress a workflow: it
may represent independently authorized work or unfinished recovery.

For any overlap, write down whether the new workflow replaces the existing one
or runs in parallel, why it is safe, and how the old row or handler will be
retired. Retire only the proven redundant workflow, preserving its history,
active ownership, schedule, model pin, and recovery state unless the migration
explicitly changes them.

## Verify before enabling

Test a workflow with isolated state and mocks where possible, then collect the
appropriate runtime evidence before claiming its behavior:

1. **Quiet:** unchanged successful observation and no due work returns a quiet
   result. A container gate produces zero model turns; a host gate produces
   zero model turns and zero container spawns.
2. **New work:** a material observation wakes with compact evidence and remains
   pending until the required completion receipt is recorded.
3. **Completion:** a durable acknowledgement quiets a repeated observation;
   repeating the acknowledgement is harmless, and a newer observation remains
   pending.
4. **Failure and recovery:** failed observation stays visible and reaches its
   bounded retry or recovery path. A failed or killed agent turn leaves pending
   work eligible after receipt inspection.
5. **Duplicate delivery:** duplicate events or scheduler rows do not duplicate
   effects, while independently authorized work and unfinished continuation or
   recovery still run.

Review scheduled series, host timers, channel/event handlers, continuations,
and recovery wakes as separate entry points. A script's presence alone does
not prove quiet suppression, correct completion handling, or recovery.

## Runtime surfaces

Use `ncl tasks create` and `ncl tasks update` for scheduled task changes. The
task content owns its prompt and optional pre-task script; use `ncl tasks get`
to inspect the current task and its run history. Template task frontmatter
accepts only `schedule` and `script`, and template changes do not alter
already-created tasks. For providers using default agent surfaces, group standing instruction sources are
composed into generated instructions at spawn; edit the source files and verify
composition rather than editing generated files.

For a live migration, capture the targeted task and workflow state for review,
then pause only future pending fires; allow an already-active old writer to
finish. Coordinate the monitor and its completion acknowledgement with their
shared lock or compare-and-swap boundary — a reread before writing is not a
concurrency guarantee. After the old writer finishes, inspect current receipts
and apply one bounded change at a time. Never restore an old state snapshot
wholesale over newer observations, pending work, or receipts. Verify current
task content, pins, state and receipts afterward, preserving production,
credential, permission, and approval boundaries throughout.
