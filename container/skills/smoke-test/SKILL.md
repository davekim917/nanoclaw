---
name: smoke-test
description: Run evidence-backed frontend and full-stack smoke testing against an immutable dev build. Use when asked to smoke test, QA a feature, push every button, act like a user, try to break a release, verify a fix, prove behavior through screenshots, or continuously test new develop builds.
---

# Full-stack smoke test

Treat a smoke run as a bounded investigation of one immutable build, not an
open-ended swarm. The result is a reproducible verdict with evidence, explicit
gaps, and verified fixes when fix authority was granted. The default deployment
uses two separately branded frontier parents: a **coordinator** that owns
coverage and the verdict, and a **challenger** that independently tries to
prove the result wrong. Their concrete identities — agent names, QA channel,
repo, environment, credential locations — are deployment configuration and live
in the deploying group's standing instructions, never in this skill.

## Invocation

```text
/smoke-test audit repo=<repo> ref=<ref> env=<dev-url> feature=<scope>
/smoke-test full repo=<repo> ref=<ref> env=<dev-url> feature=<scope>
/smoke-test fix run=<run-id>
/smoke-test verify run=<run-id>
```

- `audit` is the default. Test and report; do not edit.
- `full` expands the UI manifest to every reachable in-scope control and runs
  the full relevant backend suite.
- `fix` may repair confirmed findings. It does not authorize merge, production
  deploy, destructive test data, or unrelated changes.
- `verify` reruns the recorded reproductions against the deployed fix.

If repo, ref, environment, feature boundary, authentication, or write authority
is materially ambiguous, ask once before the run. Never silently test production.

## Leadership and worker topology

Keep each internal worker tree provider-native. Do not put a Claude wrapper in
front of a headless Codex worker, or a Codex wrapper in front of a Claude worker.

| Role | Default runtime | Responsibility |
|---|---|---|
| Coordinator parent | Claude Opus 5, high effort | Visible run controller. Freezes the build, owns the coverage manifest, dispatches native Claude workers, reconciles evidence, and publishes the one consolidated verdict. |
| Challenger parent | GPT-5.6 Sol, high effort | Visible independent challenger. Dispatches native Codex workers, attempts to falsify coverage and findings, and returns `CLEAR`, `DISSENT`, or additional evidence before the coordinator synthesizes. |
| `qa-smoke-worker` under the coordinator | Claude Sonnet 5, high effort | Executes bounded manifest slices and records evidence without seeing other workers' conclusions. |
| `qa-smoke-worker` under the challenger | GPT-5.6 Luna, xhigh effort | Independently replays and attacks claims, with multimodal browser evidence when applicable. |

The same role name intentionally resolves to a provider-native definition in
each runtime. The coordinator asks the challenger for an independent pass; the
challenger owns its native Codex worker tree. The coordinator never directly
launches Codex through `worker-codex`.

Every worker records its conclusion before reading another worker's verdict.
The coordinator and challenger then record their parent-level conclusions
independently before cross-synthesis. Worker count, model confidence, and
parent agreement are not evidence; reproductions, requests, source paths,
tests, and immutable artifacts are evidence.

Independence must survive a container or thread handoff. Conversation state is
not the handoff surface. Before dispatch, the coordinator writes
`completion-contract.json` in the canonical run directory with the frozen
`sourceSha` and every required lane marker. Each worker writes its own marker
only after its evidence is durable; terminal statuses are `pass`, `fail`,
`blocked`, `void`, or `completed`. The coordinator runs
`scripts/smoke-evidence-barrier.sh <run-dir> lanes` (mounted in containers
at `/app/skills/smoke-test/scripts/`), then writes
`coordinator/preliminary.md`. The challenger writes `challenger/disposition.md`
before checking only for the existence of the coordinator's preliminary file.
Neither parent reads the other file before its own conclusion is durable.

The coordinator is the sole verdict writer. The challenger posts one challenger
disposition in the run thread, and any dissent must remain visible in the
coordinator's final verdict. If the parents still disagree after one concrete
cross-check, escalate rather than letting them debate indefinitely.

All artifacts live under exactly one workgroup run root — default
`/workspace/workgroup/qa-smoke/runs/<run-id>/`, unless the deploying group's
standing instructions pin a different existing root. Never create sibling run
trees beside it. The per-thread coordinator synthesis session must run
`scripts/smoke-evidence-barrier.sh <run-dir> synthesis` and receive
`ready:true` before publishing. A missing marker means the lane is still
running or failed to report; inspect or redispatch it. Never infer completion
from process age, a screenshot timestamp, a chat status, or an absent process.

## Non-negotiable frontend rule

For every user-visible feature, execute its primary journeys in a real browser
against the deployed dev build. Backend tests, API calls, source inspection,
DOM snapshots, and a page that merely loads supplement this lane; none can
replace it. If authentication or browser execution is unavailable, record
`BLOCKED_FRONTEND` and do not issue a full `PASS` or `GO` verdict.

Act like the actual user: move through connected workflows, create or select
entities at realistic grains, switch markets or other scopes, edit and save,
reload to prove persistence, use guidance and notes, exercise budget/forecast
or equivalent modes, and restore test data. Prove visible transitions with
screenshots. Do not reduce frontend smoke testing to isolated component probes.

When browser credentials are shared, assign one explicit browser owner and an
authentication lease before anyone attempts login. Other workers use API,
source, or automated-test lanes until the lease is transferred explicitly.
Never let parallel login retries extend a lockout or invalidate the live run.
Resolve the approved credential location from the deploying group's standing
instructions and mounts before declaring auth unavailable. Never print or copy
credential values, search other agent folders for them, or reset a shared
account merely because a legacy path is absent.

## 1. Freeze the run

Create a run record before testing:

```text
run_id, repo, base_sha, deploy_sha, environment, feature, mode,
spec_sources, started_at, orchestrator, lane_models, frontend_owner,
auth_account_alias
```

Resolve the remote default branch rather than assuming `main`. Fetch the target,
record its full SHA, and confirm that the dev deployment serves that SHA. If the
deployed SHA cannot be proved, report the run as `BLOCKED_BUILD_IDENTITY`; do not
attach a confident verdict to an unknown build.

Recheck source, frontend deploy, and backend deploy immediately before the
public run root, immediately before each worker starts, and when evidence is
captured. A deploy that changes after the gate wake voids the frozen run even
when changed feature files are byte-identical. Stop workers, record the timing,
close the gate with a non-clear verdict, and let the watcher debounce the
successor SHA; a synthesis session never starts a replacement campaign itself.

Use a managed isolated worktree. Before every test, edit, or commit batch:

1. print the current SHA;
2. require a clean status except for named run artifacts;
3. verify the worktree still belongs to this run.

If another agent changes or replaces the worktree, invalidate results obtained
after the last clean check and rerun them. A green suite from contaminated source
is not evidence.

Read every named specification, workbook note, acceptance criterion, and release
brief end-to-end. Record contradictions instead of choosing one silently.

## 2. Build the coverage manifest

Give every check a stable ID. At minimum cover the applicable surfaces below:

| Surface | Required checks |
|---|---|
| User journeys | end-to-end workflows at realistic grains and scopes; create/select, edit, save, reload, compare, clear, and clean up |
| Navigation | every in-scope route, entry point, back/forward path, deep link |
| Controls | every visible button, menu item, tab, filter, form, upload, export, undo, reset |
| State | empty, loading, populated, changed, saved, refreshed, restored, failed |
| Permissions | relevant roles, unknown/expired session, forbidden mutations |
| Display | supported viewport sizes, overflow, labels, units, dates, currency, accessibility tree |
| Parity and polish | sibling modules/reference implementations, naming, years, formatting, contrast, tooltips, confirmations, responsive/mobile behavior |
| Network | feeding request status/body, retries, console errors, partial/slow failure |
| Backend | targeted and full relevant tests, API contracts, persistence, concurrency, rollback |
| Business logic | source formula, boundary cases, clamps, grain, recursion, served-payload parity |
| Cleanup | reverted mutations, retained labeled fixtures, residues, lockouts, and session ownership |

`Push every button` means `checks_executed / checks_planned`, with the manifest
attached. Never call a run 100% complete when anything is blocked, skipped, or
outside the stated scope.

## 3. Run two independent provider-native lanes

Use different model families for diversity. The coordinator assigns bounded
coverage slices to native Sonnet workers. The challenger assigns independent
replays and attacks to native Luna workers. More workers usually add
coordination cost before they add signal, so every assignment must name
non-overlapping manifest IDs.

### UI adversary

The challenger normally assigns this lane to a native GPT-5.6 Luna worker at
xhigh effort. Use the `agent-browser` skill.

- Start from a clean browser state, then repeat important paths with saved auth.
- Own the browser authentication lease. If another lane owns it, do not retry
  login; work the API/source lane until a documented transfer.
- Run connected user journeys before isolated controls. Cover realistic scope
  changes, edits, calculations, guidance, notes, budgets/forecasts or analogous
  modes, save/reload persistence, and cleanup wherever applicable.
- Snapshot before interacting and after navigation or major DOM changes.
- Exercise every manifest control with valid, invalid, boundary, repeated, and
  interrupted inputs where safe.
- Capture screenshots at the initial state, material action, saved state,
  post-reload proof, observed failure, and restored final state. Give each
  artifact the run ID and check ID. A pass without the required visible-state
  evidence is unproved.
- Capture the feeding request, response status/body summary, URL, visible state,
  and console/network errors. A screenshot alone rarely proves root cause.
- Wait for the request and UI to settle. Use bounded polling; never infer failure
  from one fixed sleep. On timeout, preserve the timed-out state as evidence.
- Compare equivalent workflows and working sibling modules when they exist.
  Treat mismatched names, dates, fiscal years, labels, interaction affordances,
  confirmation behavior, accessibility, and visual hierarchy as testable parity
  candidates rather than subjective nits.
- Restore mutated test data or list every residue that could not be restored.

### Backend and specification verifier

The coordinator normally assigns this lane to a native Claude Sonnet 5 worker
at high effort.

- Trace the changed source and its production-relevant call path.
- Run focused tests first, then the full relevant suite. Record exact commands,
  SHA, counts, failures, skips, duration, and environment limitations.
- Test the error path, boundary inputs, authorization, persistence, and rebuild
  or async-completion barriers—not only the happy path.
- For business math, prove both the independent calculation and the actual
  served API/UI payload. Source-code inspection or a workbook-only comparison is
  not enough.
- Separate product defects from infrastructure failures such as OOM or a missing
  dependency. Do not quietly convert either into a pass.
- Trace incomplete or stale dev data through generation, storage, read path,
  payload, and display. Reclassify the data cause precisely, but keep silent
  presentation of incomplete data as a product finding when the UI makes it look
  complete. Never blame the frontend for fields absent from the served payload.

The two lanes may share specifications, never conclusions. Each writes its own
evidence before seeing the other's verdict. The challenger must also sample
checks that passed, not only reported failures; otherwise it cannot challenge
false clears.

## 4. Challenge every candidate finding

Track a finding through these states:

```text
candidate -> confirmed | refuted | reclassified | blocked
confirmed -> planned -> fixed -> deployed -> verified
```

For every candidate, have the challenger or one of its independently briefed
workers try to disprove it using the exact build and reproduction. The
coordinator performs the same challenge on challenger-originated candidates.
Append corrections; never delete the original claim.
Record:

```text
finding_id, severity, scenario, expected, actual, build_sha,
repro_steps, evidence, code_path, challenger, verdict, confidence
```

A disagreement is useful evidence, not a vote. Resolve it by tracing the request,
state transition, specification, and current source.

## 5. Escalate selectively

Use one frontier adjudicator only when at least one condition holds:

- P0/P1 impact;
- the two regular lanes disagree after a concrete cross-check;
- business rules or source specifications conflict;
- the fix crosses multiple subsystems or changes authorization/data semantics;
- the proposed repair could mask the symptom without restoring the invariant.

First raise the existing frontier parent's effort: the coordinator may use Opus
xhigh and the challenger may use Sol xhigh. If the dispute remains
cross-provider or specification authority is still unclear, the coordinator
dispatches its native `qa-adjudicator` role — Claude Fable 5 at xhigh effort —
exactly once per dispute. The challenger requests adjudication through the
coordinator; it never spawns the adjudicator itself. Do not run every frontier
model routinely. Give the adjudicator the frozen run record, full finding
evidence, relevant source, tests, and both parent arguments.

Reject placeholder business math, spinners that merely hide missing completion
barriers, route-only patches for user-scoped state bugs, and any repair that makes
the UI look healthy while the underlying request still fails.

## 6. Fix confirmed findings without stalling

Only enter this section in `fix` mode or after explicit fix authority.

- Assign one writer per file or seam. Other agents review or test; they do not
  edit the same surface concurrently.
- Group related confirmed findings into a bounded batch on a dedicated branch.
- A product decision or high-risk blocker must not stall unrelated obvious fixes.
- Recheck SHA and worktree cleanliness before editing and before committing.
- Never place credentials in scripts, prompts, Git, screenshots, logs, or chat.
  Load them from the approved private store and fail closed when unavailable.
- Run focused and full relevant tests on the final diff, not on a previous head.
- Submit a PR for review. Do not merge or deploy to production under this skill.
- The workgroup's domain-expert agents may debug or implement a confirmed
  finding, but an implementer cannot close or certify its own fix. The
  coordinator and challenger own independent re-verification.

If a reviewer challenges a fix, trace the entire path and classify the challenge
as accepted or rejected with source/test evidence before changing code.

## 7. Deploy to dev and verify

A commit is not a verified fix. After the exact fix SHA reaches the dev build:

1. prove the deployed SHA;
2. rerun every original reproduction;
3. rerun its adjacent happy path and one failure path;
4. capture before/after screenshots plus request evidence;
5. rerun the applicable automated tests;
6. update the finding to `verified` only when all required checks pass.

If deployment is unavailable, stop at `fixed_not_deployed`. State that limitation
plainly; do not say the bug is fixed in the environment.

## 8. Report one verdict

Post a compact channel summary and attach the detailed manifest/evidence:

```text
SMOKE <run_id> — PASS | PASS_WITH_GAPS | FAIL | BLOCKED
Build: <sha>  Environment: <url>  Scope: <feature>
Coverage: <executed>/<planned>; <passed> pass, <failed> fail,
          <blocked> blocked, <skipped> skipped
Tests: <exact counts and limitations>
Findings: <confirmed/refuted/reclassified/blocked by severity>
Fixes: <PRs and deployed SHAs, or none>
Evidence: <artifact/index link>
Frontend proof: <journeys completed, screenshots, viewport coverage>
Untested: <explicit list>
Ship recommendation: GO | NO_GO | HUMAN_DECISION, with one sentence why
```

The coordinator synthesizes recorded evidence; it must not invent a result,
suppress a challenger dissent, or upgrade another lane's confidence. The
challenger posts exactly one pre-synthesis `CLEAR`/`DISSENT` disposition rather
than a competing summary. The synthesis barrier is mandatory even for `BLOCKED`
or `NO_GO`: a blocked lane still writes a terminal marker, so fail-closed does
not require racing its worker.

## Continuous channel profile

Continuous QA does not mean keeping models running continuously. Use a recurring
task with a token-free script gate:

1. poll the remote `develop` SHA;
2. return `wakeAgent:false` when it matches the last completed or active run;
3. wait for CI and the dev deployment to settle;
4. debounce merge bursts into one immutable SHA;
5. create one channel root thread per SHA and return `wakeAgent:true` once;
6. persist the run state so a restart cannot duplicate work.

Use `scripts/smoke-develop-gate.sh` for this. It is configured entirely
through `SMOKE_GATE_*` environment values — repo, branch, frontend/backend
deploy service IDs, dev URL — and has no tenant defaults: a missing required
value produces a throttled `gate_misconfigured` wake instead of silent
no-wakes. Deploy it as a thin wrapper script in the agent folder that exports
the group's values and execs the skill copy at
`/app/skills/smoke-test/scripts/smoke-develop-gate.sh`, so gate fixes
propagate without touching the deployment. The gate requires GitHub checks to
settle and the live frontend and backend deploy commits (read from the Render
API; adapt the wrapper's env or the fetch block for other deploy hosts) to
equal the exact branch SHA across two observations before it wakes. It records
candidate, active, and completed SHAs in the agent workspace, refuses
duplicates, and permits a recovery wake only after an active run has been
abandoned for 12 hours.

On every terminal verdict, the coordinator closes the gate atomically:

```bash
bash /workspace/agent/smoke-develop-gate.sh finish \
  <40-character-sha> <run-id> <GO|NO_GO|HUMAN_DECISION|BLOCKED>
```

The scheduled-task registration is runtime state created through `ncl`, not an
in-tree core reach-in. Verify that integration with `ncl tasks get` plus one
live gated fire that completes with no provider output; never reproduce the
registration through raw SQL. Configure `quietStatus: true` and `chatLimit: 1`
so the scheduled controller emits one consolidated root without streaming its
internal work log into the channel.

Run a changed-surface `audit` for each settled develop SHA. Any user-visible
change must include a real-browser frontend lane even when the diff looks
backend-only. Run `full` for a
release candidate, a manually named feature, a high-risk label, or a scheduled
nightly/weekly sweep. This preserves continuous coverage without paying for idle
turns or rerunning an unchanged build.

The QA channel owns execution and evidence. The coordinator creates one root
thread per SHA; all workers and the challenger report into that thread. The
release channel remains the ship authority: send it the final verdict, PRs,
deployed SHA, and remaining decision. Never let the smoke task auto-merge or
promote production.

## Cost controls

- Two provider-native worker lanes by default: Sonnet/high under the
  coordinator and Luna/xhigh under the challenger. The frontier parents stay
  sparse: assign, challenge, synthesize.
- Raise parent effort or add one `qa-adjudicator` pass only on the escalation
  conditions above.
- Spawn fixers only for confirmed findings and give each a non-overlapping seam.
- Use changed-surface runs per SHA; reserve full sweeps for release gates or a
  bounded schedule.
- Cache immutable specifications and dependency setup, but never cache verdicts
  across SHAs.
- Cap retries, agent-to-agent debate, screenshots, and browser waits. After two
  failed cross-checks, escalate or mark blocked instead of looping.
