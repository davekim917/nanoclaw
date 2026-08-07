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
  deploy, destructive test data, or unrelated changes. `fix` authority gates
  only the QA agents editing code THEMSELVES — handing a confirmed finding to
  a domain fixer is that fixer's normal development work and needs no smoke
  authority; never tell a fixer to stand by. The one restriction to pass
  along: a fixer never certifies its own fix — the QA pair re-verifies the
  deployed SHA.
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
| `qa-smoke-worker` under the coordinator | Claude Sonnet 5, xhigh effort | Executes bounded manifest slices and records evidence without seeing other workers' conclusions. |
| `qa-smoke-worker` under the challenger | GPT-5.6 Luna, max effort | Independently replays and attacks claims, with multimodal browser evidence when applicable. |

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

Use a managed isolated worktree, and only a managed one: obtain it with
`create_worktree` (it lands under `/workspace/worktrees/<repo>`), or use an
agreed long-lived checkout under `/workspace/workgroup/.worktrees/`. Never
`git clone`, copy a repo, or build scratch checkouts under `/workspace/agent/`
— nothing manages or reclaims that directory, and ad-hoc checkouts there are
process violations subject to deletion without notice (owner decision
2026-08-06; 28GB of orphaned QA checkouts motivated it). A broken or partial
`node_modules` is deleted in-run and reinstalled — never renamed and kept
(`node_modules-bad-*` dumps are the anti-pattern). At run end, remove any
scratch the run created outside the run directory.

Before every test, edit, or commit batch:

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
max effort. Use the `agent-browser` skill.

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
- Record a short clip of each candidate finding's reproduction. See below.
- Restore mutated test data or list every residue that could not be restored.

### Reproduction clips

A screenshot cannot show a transition, a state that flashes and disappears, or
how long a spinner ran. A short clip can. `agent-browser` records the live
session itself:

```bash
mkdir -p <run-dir>/clips
agent-browser record start <run-dir>/clips/<finding-id>.mp4
#   ... the reproduction steps, and nothing else ...
agent-browser record stop
```

Name the file `.mp4` — that yields H.264/yuv420p, which every chat platform
plays inline. `.webm` also works but previews less reliably.

Scope, because an unwatched artifact is worse than none:

- **Record the reproduction, never the campaign.** Start recording at the last
  known-good state, run only the steps that produce the defect, stop. Target
  20–60s. A recording that spans a whole lane is unwatchable and nobody opens
  it.
- **Clip defects, not passes.** Record while you reproduce a candidate — that is
  the moment the repro is already in your hands. Delete the clip if the finding
  is later refuted; attach only clips of confirmed findings. At most one clip
  per finding plus its section 7 after-clip, and at most five clips per run.
- **Never record authentication.** Recording captures typed keystrokes, so a
  clip that spans a login publishes the password. Authenticate first, then
  start recording. Any clip that captured a credential field gets deleted, not
  trimmed. Authenticating first is necessary but NOT sufficient: `record start`
  opens a fresh context that drops `localStorage`, so on a token-in-storage app
  the clip begins logged out. Follow the capture/restore recipe in the
  `agent-browser` skill, and prove the session survived `record start` before
  walking the reproduction.
- **A clip is supplementary and never substitutes for evidence.** The
  screenshots, request/response capture, and console errors above remain
  required. A clip alone never moves a candidate to `confirmed` — it shows what
  happened, not why.
- **Never block on it.** If `record start` errors (missing `ffmpeg`, no browser
  lease), note it in the run record and continue. A clip is never a gate.

Attach clips with `send_file` to the run thread. Files under the run root are
already inside the allowed prefixes, and the 50MB attachment cap is far above a
60s clip.

### Backend and specification verifier

The coordinator normally assigns this lane to a native Claude Sonnet 5 worker
at xhigh effort.

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
dispatches its native `qa-adjudicator` role — Claude Fable 5 at high effort —
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
4. capture before/after screenshots plus request evidence, and re-clip a
   finding that was clipped when it was found;
5. rerun the applicable automated tests;
6. update the finding to `verified` only when all required checks pass.

If deployment is unavailable, stop at `fixed_not_deployed`. State that limitation
plainly; do not say the bug is fixed in the environment.

When the deployment configures an issue tracker, each confirmed finding gets one
issue there and the tracker — not a chat thread — is the cross-run record. Three
rules make it consistent with the lifecycle above:

- **The coordinator closes the issue, and only at `verified`.** A fix PR
  references the issue (`Refs #N`), never with a closing keyword: auto-close on
  merge records `fixed` as `verified` and lets the implementer certify its own
  work, which this skill forbids. Tracker state then needs no status labels —
  open with no linked PR means unfixed, open with a merged PR means awaiting
  re-verification, closed means verified on a deployed build.
- **Classify regression versus gap at filing time.** A regression has evidence
  of prior working behavior and may be fixed autonomously. A gap — behavior
  never specified — is a product decision: mark it as such and do not hand it
  off as fix work. If the two cannot be told apart, it is a gap.
- **A surface with no deployed-verification path stays out of the lifecycle.**
  If nothing in the environment can prove a fix for that surface reached a
  deployed build, its findings cannot reach `verified`; report them and route
  them to planning rather than opening an unclosable loop.
- **Re-verification is a lane every run opens, never a side effect.** Testing
  this build's changed surface does not re-test an earlier finding, so without
  an explicit lane nothing reaches `verified` and open findings accumulate
  indefinitely. At freeze, take every open finding whose fix has already
  merged and re-run only its recorded reproduction against the frozen deployed
  build: close what passes, record a failure count on what does not. These are
  narrow scripted repros, so the lane is cheap.
- Cap autonomous repair: after two failed re-verifications of the same finding,
  stop, mark it escalated, and hand it to a human.

## 8. Report one verdict

Outcome tokens (`PASS`, `NO_GO`, `BLOCKED_BUILD_IDENTITY`, `CLEAR`, finding
IDs) are machine values. They belong on machine surfaces only: the gate
`finish` arguments, JSON markers, and run-directory records. A chat message a
human reads never shows a bare token — it shows the translation:

| Machine token | Chat language |
|---|---|
| `PASS` | ✅ Cleared — everything tested held |
| `PASS_WITH_GAPS` | 🟡 Cleared where tested — named surfaces untested |
| `FAIL` | 🔴 Confirmed defects |
| `BLOCKED` | ⛔ Could not test honestly |
| `GO` | Safe to ship |
| `NO_GO` | Do not ship this build |
| `HUMAN_DECISION` | Needs a human call |
| `CLEAR` (challenger) | ✅ Challenge found no material contradiction |
| `DISSENT` (challenger) | ⚠️ Challenge disputes specific findings |
| `BLOCKED` (challenger) | ⛔ Challenge could not verify |

Reason codes become plain sentences — "the deployed build changed mid-run, so
the frozen build could no longer be proven", never `BLOCKED_BUILD_IDENTITY`
in prose. The run ID and short SHA stay verbatim (they anchor the thread).

Post a compact, human-formatted channel summary (platform bold/bullets, no
key-value dump) and attach the detailed manifest/evidence plus the key
screenshots:

```text
**Smoke <run_id> — <chat language from the table>**
*<one-sentence reason a non-operator understands>*
- Build `<sha12>` on <environment> — <scope in words>
- Coverage: ran <executed> of <planned> checks (<passed> passed, <failed>
  failed, <blocked> blocked) — plus exact test counts and limitations
- Frontend: <journeys completed>, <n> screenshots and <n> clips (attached)
- Findings: <each in one plain-language line with severity, or "none confirmed">
- Fixes: <PRs and deployed SHAs, or none>
- Untested: <explicit list, or "nothing in scope">
- Challenge: <challenger chat language> — <one clause of substance>
**Recommendation: <chat language> — <one sentence why>**
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
duplicates, and reclaims an abandoned active run through two independent
signals: a liveness window (no `progress` stamp for 30 minutes,
`SMOKE_GATE_PROGRESS_STALE_SECONDS`) and a hard age ceiling (4 hours,
`SMOKE_GATE_ACTIVE_STALE_SECONDS`). A container killed mid-run simply stops
stamping, so the gate recovers the SHA on the next poll past the window.

The coordinator must therefore stamp liveness — after the freeze, then at
least every 15 minutes while lanes run:

```bash
bash /workspace/agent/smoke-develop-gate.sh progress <run-id>
```

An `ok:false` response means this run is no longer the active one (reclaimed
or finished): stop the campaign immediately instead of double-running the SHA.

When `SMOKE_GATE_PUBLISH_FILE` is set in the wrapper, `finish` also writes the
terminal verdict as a small JSON artifact (`{sha, runId, verdict, finishedAt}`)
at that path. Downstream gates — e.g. a release-promotion checklist — consume
the artifact, never a chat message: durable files can carry gate semantics,
bot chat cannot.

Two further wrapper-optional artifacts and behaviours:

- `SMOKE_GATE_ACTIVE_FILE` — a live-run marker written on claim, refreshed by
  `progress`, removed by `finish`. It carries `holdMergesUntil`
  (`SMOKE_GATE_MERGE_HOLD_SECONDS`, default 90 min from run start) so a merge
  queue can pause while a run owns the environment without ever stalling on a
  run that died: the cap expires on its own.
- `SMOKE_GATE_FRONTEND_PATHS` / `SMOKE_GATE_BACKEND_PATHS` — comma-separated
  path prefixes a service actually builds from. When a host skips a deploy
  because nothing under its root changed, that service's live SHA lags the
  branch head and strict three-way equality can never settle. With paths set,
  a lagging deploy is accepted only when it is a strict ancestor of the head
  AND no file changed between them falls under that service's paths — so the
  deployed artifact is what a fresh deploy would produce. Fail-closed on any
  fetch error, non-ancestor state, or a truncated compare. The wake payload
  reports `deployLagAccepted`; the coordinator then freezes the build as a
  documented SHA **pair** and says so in the run record. Unset = strict
  equality.
- A head that stays unsettled beyond `SMOKE_GATE_UNSETTLED_ALERT_SECONDS`
  (default 45 min) produces exactly one `develop_unsettled` wake naming the
  failing workflows and lagging deploys — one per SHA, never a re-spam. A red
  or hung branch must never be silent.

When `SMOKE_GATE_HOLD_FILE` is set, `finish` additionally maintains an
explicit, default-open block flag for promotion gating: a `NO_GO` verdict
writes the file, a later `GO` removes it, and `BLOCKED`/`HUMAN_DECISION`
leave it untouched (an infra-blocked run neither raises a false hold nor
clears a real one). Downstream rule: flag present → automatic hold on
promotion; flag absent → no smoke objection. Absence semantics make rollout
safe — history predating the smoke watcher never gates anything.

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

- Two provider-native worker lanes by default: Sonnet/xhigh under the
  coordinator and Luna/max under the challenger. The frontier parents stay
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
