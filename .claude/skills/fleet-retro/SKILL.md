---
name: fleet-retro
description: Run an on-demand, evidence-bounded host audit of one workgroup's multi-agent workflow. Use when the operator asks for a fleet retro, workflow evaluation, control-health review, or assessment of how a named workgroup has been behaving. Host session only; never run from a container agent.
---

# Fleet retro

Audit the named workgroup from a host session. This is a scoped evaluation, not a standing monitor, automatic full-fleet sweep, release action, or grant of authority.

Resolve the workgroup and its agent groups first. Read histories only when existing authority explicitly permits that workgroup scope; never collect credentials or unrelated personal data. Start with metadata—time window, work-item identities, session/container start times, message kinds, task occurrences, receipts and delivery acknowledgments—then inspect the smallest content sample needed to explain the evidence. Do not pull unrelated groups merely because the host can access them.

## Establish the question and sample

- Use the operator's requested window and concern. If either is absent, choose a recent bounded window and state it.
- Read prior decisions, machinery notes and retro records before re-deriving them. Treat agent-authored claims as leads until verified.
- Choose contextual samples for the question: a completed human work item, a current interrupt, a release/QA path when relevant, or a suspected noisy producer. Do not automatically walk every PR, campaign, task or room.
- Before proposing or assigning work, read the owning record or thread through its latest message. Do not dispatch unknown work or duplicate work already owned. A retro does not force delegation; retain the technical owner through build, test and repair while the coordinator verifies evidence. Keep required consequential independent review and dissent separate.

## Keep evidence layers separate

Report each claim at the strongest layer actually observed:

1. source implements the behavior;
2. the installed/runtime artifact contains it;
3. activation occurred;
4. a fresh container naturally exercised it;
5. the intended outcome or measured benefit was observed.

Do not collapse these layers. A restart, green test, merge or enabled flag is not proof of fresh behavior or lower human burden. A fresh container can reuse an old session id; determine freshness from container/runtime evidence rather than conversation-row novelty. Conversely, an old surviving container may retain an earlier runner snapshot.

Model, role and dispatch evidence also stays literal. Saved role pins, explicit model/effort arguments and Jev provenance describe intended selection; verify actual runtime metadata before claiming what ran. For a new bounded Codex worker, require the explicit native fresh-context control. Claude's native context/session mechanics are separate; do not infer one runtime's semantics from the other.

## Interpret records correctly

- `work_log` is a durable record, not a developer notification.
- Status rows and status edits are not counts of human notifications.
- Task/turn rows are not distinct scheduled wakes. Identify actual task occurrences and continuation chains.
- Zero native outcome receipts is a defect only when an eligible completed human work item should have produced one through that route. It can be expected when the sole release/QA reporter delivered instead; without a route-specific denominator, report the observation as inconclusive.
- A queued outcome is not delivered. Verify its native delivery acknowledgment or platform receipt.
- Native delivery receipts and the sole release/QA reporter's publication record are distinct evidence. Preserve the existing sole reporter; do not create a competing terminal post.

Evaluate reporting by human work item—feature, defect, PR, request or QA campaign—not by model turn, phase, worker or review round. Where the outcome contract applies, expect one concise contextual completion per finished work item: truthful implemented/merged/deployed/verified state, why it matters, remaining action and an evidence/detail link. Do not substitute a default digest. Keep detailed execution, dissent and corrections in durable records. Preserve genuine incidents, required approvals, explicit human replies, requested detail, actionable handoffs and explicitly requested report formats. Preserve brief receipt acknowledgments and occasional factual liveness updates during long-running work: the current step and whether it is active, waiting or blocked. Do not count these as noise merely because they are not completions. Detailed execution narration, repeated unchanged checks and agent-to-agent acknowledgment loops stay in records; never claim activity without current evidence.

## Inspect controls proportionally

Check only controls implicated by the question or sample. Examples include claims/ownership, required checks, verdict reconciliation, re-verification, scheduled tasks, release outbox, QA barriers and instruction budgets. Use authoritative stores and stored queries where available; never substitute a board, digest or filesystem artifact for its source of truth.

For a sampled lifecycle, compare the actual path with its current contract. Escalate to a broader sweep only when the sample exposes a concrete systemic failure or the operator requests it. Do not treat silence as settlement, approval or an independent evaluation. Operator invocation authorizes the audit itself; it does not make the operator an independent evaluator or authorize fixes, publication, deployment, messages, new timers or scheduled retries.

## Deliver the retro

Lead with the bounded conclusion. For each material finding, state:

- the affected human work item or control;
- observed evidence and its layer;
- impact on developers or delivery;
- current owner or the exact decision needed;
- uncertainty or the next observation required.

Distinguish healthy, drifting, defective and unproven. Record real interruptions and explicitly requested reports rather than counting them as noise. Recommend the smallest correction at the actual control seam, but mutate or dispatch only within existing authority. Never invent a deadline, timer, owner, approval, or at-head shipping permission.

Link the durable records instead of reproducing their detail. If measurement has a precommitted window or threshold, evaluate it only when due and preserve its original denominator. Otherwise label the result as an observation, not an outcome claim.

Useful implementation pointers when the audit concerns outcome reporting: `src/outcome-reporting-instructions.ts`, the record-only `work_log` path in `src/delivery.ts`, and the spawn-scoped flag in `container/agent-runner/src/outcome-reporting.ts`.
