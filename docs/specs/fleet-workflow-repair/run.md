# Fleet workflow repair execution

Operator approved implementation of the proposed fleet workflow contract and
requested completion only when all workgroups are repaired with evidence.

Isolated branch: fix/fleet-workflow-repair, based on origin/main at f9be71a64.
Production source checkout remains untouched. The initial private audit is
being refreshed before migration; its findings are leads, not current proof.

Implementation lanes: shared authoring defaults; staged task repair; expanded
event/timer/continuation coverage. Detailed private evidence is kept outside
the public repository. Cross-family review and activation remain pending.

Plan review: requested Claude Fable 5.1/high with required safe-mode, no-session,
plan-permission, no-tools and strict-MCP flags, schema-enforced JSON and 3600s
foreground deadline. It returned a model usage-limit error. Used the one permitted
configured other-family fallback, Claude Opus 5[1m]/high, with identical transport
and schema. Completed successfully; modelUsage confirmed the requested Opus model
(an auxiliary Haiku call also appeared in CLI metadata).

Adjudication: accepted explicit migration quiescence plus shared lock/CAS,
state-preserving rollback, positive fire receipts and prior-work check before
duplicate retirement. Accepted enumeration/review before new coverage repairs.
Rejected the suggested unconditional model wake on script error: source already
distinguishes errors from false and applies bounded backoff/pause. Documented
that contract and retained its tests rather than weakening it. The proposal's
observation-failure acceptance already required error tests; no scope change.

Live progress: obsolete duplicate pending schedule paused through ncl after exact
backup; alternating replacement preserved. Static duplicate-health-timer finding
corrected after inspecting runtime: host timer disabled, so container measurement
remains the live owner and is retained.

Shared source checks: task CLI suite 61/61 and instruction composition suite
22/22 passed. Host and scripts typechecks passed. Changed task CLI lint passed.
Public boundary worktree scan passed. Markdown formatting corrected on the
modified customization guide; final formatting check follows integration.

Ratchet growth explicitly accepted on the five modified upstream-owned paths:
common base, CLI instruction fragment, template docs, customization guide and
task CLI help. Reason: shared workflow authoring contract, pending/completed
recovery semantics, explicit reasoning exceptions, and correction of directly
conflicting instruction/config source guidance. No runtime authority expansion.

Expanded coverage now enumerates every registered group across all installed
workgroups, including channel/event ingress, waits, explicit continuations,
recovery and active host timers. No new transport or odd-week owner defect was
established. Historical campaign receipt loss was checked against the already
merged smoke recovery change: fresh durable evidence is required and old markers
are archived before redispatch. No speculative global replay mechanism is added.
The additional host mechanism suites passed 101 tests; runner continuation tests
passed 30 and runner wait tests passed 7 using existing dependencies temporarily
linked into the isolated worktree, then removed.

Source review completed on the configured other-family fallback. Its concerns
were documentation grounding and compactness, not a demonstrated runtime defect.
The common instruction block was shortened; host-script timing wording was
simplified. Task help now states the verified 120-second default and names its
environment override (both host config and runner share that default), replacing
the stale 30-second claim. Reader/write-path and mount grounding are being
collected in private review evidence. Final diff review follows integration.

Final source review returned only SHOULD-FIX suggestions. Confirmed the literal
environment key in both runtime readers; no mismatch existed. Corrected the same
stale timeout in the linked scheduled-task reference and removed repeated owner
and reasoning prose from the CLI fragment, retaining task-specific mechanics.
The detailed doc remains reachable through the unconditional project docs mount.
No material correctness finding remains after lead adjudication. The additional
scheduled-task doc ratchet acceptance corrects that directly linked contract.
Full host/scripts ESLint completed with no errors.

All three private monitor migrations are now applied through supported task CLI
updates. Each cutover paused only its future fire, verified inert input and no
active execution, dry-ran the exact new state reader, saved current forensic
state, and verified the resulting prompt/script plus unchanged schedule, owner,
script placement, per-fire flags and authoritative runtime-config hash before
resuming. The legacy receipt schema used positive stopped-session and exact
container-absence evidence instead of assuming a missing busy flag meant idle.
The unfinished reusable wrapper was not used; explicit lead-controlled cutover
receipts record the actual path. No state snapshot was restored.

Final monitor canaries passed: failed-turn retry, repeated acknowledgement,
newer-signal protection, timestamp retention, recurring observation generations,
reversion to current facts, concurrent discovery/ack, deployment-only wake and
malformed observation/state failures. Rare schedules are validated by these
isolated canaries and exact live task readback; a frequent monitor's next live
fire remains a separate receipt check.

The source branch was rebased onto the subsequently merged observatory change.
All-group composition passed again for all registered groups; typechecks,
public boundary and committed-source ratchet also passed after integration.
Publication approval, supported activation and live host verification remain
separate completion boundaries. No production source edit or build was made.
