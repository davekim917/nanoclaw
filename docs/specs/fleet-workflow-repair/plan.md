# Fleet workflow defaults and recovery repair

Status: implementation authorized by the operator's explicit request to implement
the previously reviewed workflow-default proposal and repair the entire fleet
across all workgroups with evidence. This file records that approved scope and
its executable migration details; it does not add a new approval boundary.

## Outcome and scope

Every installed workgroup uses deterministic observation before model work when
the work is mechanically decidable. Substantive reasoning, explicit human
requests, required campaigns and unfinished recovery remain eligible. The owner
decides, delegates substantial execution, verifies the result and completes the
authorized action. All providers receive the same authoring default.

Inventory active scheduled series, host timers/cron, channel/event triggers,
waits, continuations and recovery wakes. Record explicit reasoning exceptions
per workflow rather than treating a missing script as an automatic defect.
Do not claim static inspection proves live no-wake behavior.

## Existing architecture

The task content owns script and scriptHost; ncl tasks update is the supported
writer. Host-script authorization remains operator-only. A false script result
completes a fire without a model turn; a container gate still pays startup cost.
container/CLAUDE.md is the shared provider-neutral base, flattened at spawn by
src/claude-md-compose.ts. cli.instructions.md supplies common task guidance.
Template task scripts are optional; existing tasks are not restamped by edits
to their originating template.

Script failures are not false/quiet success: runScript returns null for failed
execution, timeout or malformed output; scheduling records an error, applies
bounded backoff and eventually pauses repeated failures. Preserve this contract,
verify failure receipts and ownership, and use explicit monitor-level recovery
signals when judgment is useful. Do not blindly wake a model on every error.

## Invariants

- Preserve group ownership, workgroup isolation, model pins, schedules and
  explicit production/credential/permission boundaries.
- Observation does not equal completion. Discovery remains pending until the
  required outcome has durable acknowledgement. After partial effects, inspect
  receipts before retrying. Use existing claims/atomic state updates.
- Duplicate scheduler rows are retired narrowly; equal prompts alone never
  suppress an unfinished or independently authorized action.
- Unknown or failed observation has a bounded recovery path, never quiet success.
- No edits, builds or commits in the live production source checkout.
- No interruption of active work or fabricated production actions for testing.

## Implementation lanes

1. Shared authoring: concise fleet default in container/CLAUDE.md and CLI
   instruction fragment, detailed workflow contract in docs, template and host
   authoring links. Preserve valid time-based reasoning jobs and host privilege.
2. Live tasks: refresh inventory; retire the proven redundant legacy build row;
   repair pending/completed state for the three premature-ack monitors; remove
   redundant QA measurement only after proving live host replacement and alarms.
   Stage exact replacements, backups and rollback before applying via ncl.
3. Coverage: inspect every workgroup's event, continuation and recovery entry
   points and all scheduled/timer workflows; fix any demonstrated violation of
   the same invariants, recording concrete exceptions and evidence.
   Enumerate new defects first; lead reviews the exact repair and staged diff
   before applying through the same migration controls as the named repairs.
4. Review, publish source through an isolated PR, activate through supported
   paths, verify current task contents and composed provider instructions.

## Acceptance cases

- quiet_state_no_turn: unchanged observation with no due work emits false;
  live receipts establish zero model turns, plus zero spawns for host gates.
- new_signal_pending: a new signal wakes with compact evidence but does not
  advance completed acknowledgement.
- failed_turn_retries: discovery followed by failed/killed work remains eligible.
- acknowledged_signal_quiet: a durable successful acknowledgement suppresses
  repeat work; repeated acknowledgement is harmless.
- newer_signal_survives_old_ack: completion of older work cannot consume a newer
  observation; atomic updates/claims prevent concurrent state loss.
- observation_failure_visible: malformed state, timeout and failed data fetch
  remain distinguishable from successful empty results and have bounded recovery.
- duplicate_schedule_retired: the known overlap is removed while alternating
  owners, their cadence and pins remain unchanged. First prove the obsolete
  series has no running/unfinished turn or due recovery and its intended work
  is covered by the surviving schedule.
- shared_default_all_providers: composed instructions contain the fleet contract
  for every registered group/provider; legitimate reasoning exceptions remain.
- recovery_and_event_idempotency: duplicate events do not create duplicate work,
  while unfinished continuation and due recovery are still delivered.

Tests for script state transitions use isolated fixtures and mocks, not live
production effects. Prose changes receive diff/composition checks. Inventory and
private client identifiers remain in private operational evidence, never public
specs or commits. Source checks include affected tests/typechecks, lint, public
boundary and upstream ratchet. Cross-family review covers raw plan and final diff.

## Rollout and rollback

Back up each exact task/script/state before mutation. Re-read expected contents
under the available supported update boundary and abort on unexpected drift.
Apply one bounded task migration at a time, verify state and pins after each.
Pause future pending fires with ncl during a monitor migration; inspect running
work and wait for an old writer to finish instead of interrupting it. The new
monitor and its acknowledgement writer must share one lock or CAS primitive.
When legacy writers cannot share that primitive, migrate to distinct versioned
state only once the old writer is quiescent. Snapshot comparison alone is not
concurrency protection. Resume the original recurrence after verification.
Private artifacts use atomic replacement and appropriate local locks. Revert
source via a follow-up commit; restore only the targeted task configuration for
a failed migration, retaining discovered work and successful receipts. Host
activation is a separate verified step and retains the explicit restart gate.
Never restore a whole old state snapshot over later effects: any state repair
must merge only the affected fields under the same lock/CAS and retain pending
signals and completed acknowledgements. Backups are forensic evidence.

Live quiet claims require a positively identified completed post-migration fire
and a bounded before/after usage/spawn check. Use isolated fixture canaries for
rarely scheduled workflows, paired with exact live configuration readback;
never infer a successful quiet run merely from absence of activity.

Completion requires a current per-workgroup evidence matrix with no unresolved
required repair, published/activated shared defaults, and tested/live receipts
matching each claimed behavior. An unreviewed plan or partial audit is not done.
