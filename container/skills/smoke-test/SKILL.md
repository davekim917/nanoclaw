---
name: smoke-test
description: Run evidence-backed frontend and full-stack smoke testing against an immutable dev build. Use when asked to smoke test, QA a feature, push every button, act like a user, try to break a release, verify a fix, prove behavior through screenshots, or continuously test new develop builds.
---

# Full-stack smoke test

Treat a smoke run as a bounded investigation of one immutable build, not an
open-ended swarm. The result is a reproducible verdict with evidence, explicit
gaps, and verified fixes when fix authority was granted. The default deployment
uses two separately branded QA sides: a **coordinator** that publishes the
sole verdict and a **challenger** that independently tries to prove it wrong.
Each outer agent delegates substantive QA to its own retained frontier owner. Their concrete identities — agent names, QA channel,
repo, environment, credential locations, and the coverage floor (§2) — are
deployment configuration and live in the deploying group's standing
instructions, never in this skill.

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
| Coordinator outer agent | Claude Sonnet 5, xhigh effort | Routes inputs, holds the run's gate authority, and publishes the retained owner's one consolidated verdict after the evidence barrier. |
| Challenger outer agent | GPT-5.6 Terra, xhigh effort | Routes an independent assignment, checks the disposition barrier, and publishes its owner's one challenge reply. |
| Retained `qa-smoke-worker` on Claude | Claude Fable 5.1, medium effort | Owns its assigned side's investigation, coverage, execution, findings, severity, and preliminary/disposition/synthesis. |
| Retained `qa-smoke-worker` on Codex | GPT-6 Astra, medium effort | Owns the same responsibilities in a separate provider-native context. |

The same role name resolves to its provider-native definition. Use one retained
technical owner per side and cohesive assignment; owners execute tools directly
and never re-delegate. Keep the independent QA pair, not a worker tier ladder.
The outer agents do brief logistical/mechanical work, not substantive source
analysis or verdict adjudication. Throughout this skill, a side's testing and
judgment duties belong to its retained owner; chat, routing and final gate
publication remain the outer agent's responsibility. Technical owners may write
their side's declared evidence and conclusions under the existing ownership
rules. They do not send chat, file issues, mutate labels or finish the gate.
The coordinator never launches the other provider through a wrapper; ask the
paired challenger for the independent cross-family pass instead.

**Dispatch and effort are runtime settings.** Start the owner with the installed
native QA profile, or with a scoped CLI invocation of the provider when an
explicit effort or an exact-session resume is needed. Give a CLI-started owner
the full installed QA role body, this skill, standing instructions, exact scope
and authority in its stdin brief; nothing selects the QA role for you.
Use `CLAUDE_CODE_EFFORT_LEVEL=medium claude -p --model 'claude-fable-5-1[1m]' --effort medium`
or `codex exec -m gpt-6-astra -c model_reasoning_effort=medium`, run from the
actual working directory. An explicit effort change repeats the flag on the
same CLI session's resume, or uses a verified supported native runtime field.
Claude's native Agent tool has no per-call effort input; use the installed
medium profile or a child-scoped `CLAUDE_CODE_EFFORT_LEVEL`. Do not set a
fleet-wide environment override, describe effort only in prose, or silently
switch models. A scoped CLI invocation adds no permission bypass.

Record default, requested and actual model/effort separately in the existing
run record, plus transport, parent session, runtime home, owner handle, and
assigned scope. Mark unavailable runtime metadata unverified. Retain the same
owner for corrections and remaining work. Native handles resume only through
the spawning parent; a CLI session resumes only on its own session UUID with
the same runtime home and accessible history. A matching home path in another container
is insufficient: NanoClaw mounts per-session Claude project history
(`src/session-claude-mounts.ts:56`), and provider session state may be isolated.
Do not copy credentials or histories across those boundaries.

When the task deliberately transfers from a scheduled session to a thread
whose runtime cannot resume the owner, make an explicit handoff in the run
record: old owner, why resume is unavailable, preserved preliminary/evidence,
and exact remaining work. Start one replacement frontier owner for that
remainder; do not restart completed lanes or pretend its inherited evidence is
new. A failed resume is not authority to silently replay or switch transports.
Other owner replacements require the same explicit, evidence-backed recovery
decision and the existing run-ownership rules. No parallel duplicate owner.

Each side starts with a context independent of the opposite side and of any
artifact author/fixer. It records its own preliminary or disposition before
reading the other's conclusion. Checks performed by one owner remain one
source of evidence even when split into several manifest lanes; do not claim
those lanes independently corroborate one another. The paired owner provides
the fresh independent challenge, including purported passes. Record and
disclose insufficient cross-family independence when actual owner models share
a family on fallback. A nominal coordinator/challenger pairing is not proof
of model diversity. Preserve independent-context results and apply the existing
proof/verdict contract or its specifically recorded same-family exception;
never silently certify full cross-family review. Worker count,
model confidence and agreement are not evidence; reproducible checks and
immutable artifacts are.

Independence must survive a container or thread handoff. Conversation state is
not the handoff surface.

**Never hand-write the contract or a marker.** Both come from
`scripts/smoke-run-scaffold.sh` (mounted in containers at
`/app/skills/smoke-test/scripts/`), because a freehand artifact drifts from
what the barrier validates and the barrier's failure mode is silent — it
returns `ready:false` forever while the run proceeds on self-discipline,
reporting a governed posture it does not have. That is not hypothetical: it
is what happened on 2026-08-07.

**The contract and `markers/` are coordinator-owned, and the scaffold enforces
that, not the briefs.** Every invocation checks two things and fails closed on
both:

1. **`SMOKE_LANE_ROLE`** must name the writing worker's role, and only
   `coordinator` may write. Brief every worker on both sides with its role
   exported; an unset role is refused. That is the safe direction — a missing
   marker is loud (the barrier names it in `missing[]`), a wrongly attributed
   one is silent. Challenger output goes under `challenger/`, and the barrier
   never waits on it.
2. **The run must still hold the gate.** The scaffold reads
   `$SMOKE_GATE_STATE_DIR` and requires the run directory's basename to be some
   state file's current `activeRunId`. For a PR campaign it also requires the
   live owner lease under the shared workgroup mount, and holds the shared PR
   and run locks through the artifact write. Export the poll-provided
   `coordinatorOwnerToken` as `SMOKE_GATE_OWNER` in the coordinator, every
   native lane worker, and the later synthesis continuation. Never derive it
   from mutable gate state. The completion contract binds the token so a stale
   owner cannot write into the same run tree after a successor reclaims it.
3. **The artifact SHA must still be the claimed SHA.** Contract, marker, and
   redispatch writes compare the contract/source SHA with the active gate slot
   while the ownership locks are held. A changed claim cannot inherit evidence
   from the previous build.

**A certification, re-verification, or evidence-recovery run has no PR.**
Never hand-compose the contract or a marker for one just because there is no
freeze PR to `claim` against — that reproduces the exact incident this scaffold
exists to prevent, only on a run the barrier can never see as governed. Claim
the run itself instead, through the same deployed wrapper a PR campaign
`claim`s through — **never the raw skill script directly.** The wrapper is
what sets `SMOKE_GATE_STATE_DIR`/`SMOKE_GATE_LEASE_DIR` to this install's real
paths; calling `/app/skills/smoke-test/scripts/smoke-pr-gate.sh` bare instead
falls through to the gate's hardcoded defaults, which a PR campaign's state
and locks do not live under, and neither will anything this run writes later:

```bash
bash /workspace/agent/smoke-pr-gate.sh task-claim <run-id> <deploy-sha>
```

This opens the same door a PR `claim` does: a shared, cross-container lease
under the workgroup mount, which `begin_active_run_fence` accepts as a third
active-slot shape alongside `pr` and `develop`. `task-progress <run-id>`
renews it during a long run and `task-release <run-id>` drops it when the run
ends; `--takeover` on `task-claim` may reassign a live lease to a new owner,
same as a PR claim, but the deploy SHA itself binds **permanently** at claim
in a retained shared `task-binding-<run-id>.json` and has no takeover escape —
a different build always gets a different run id. Release removes the live
lease but retains that binding. A finished run id is terminal: once
`task-finish` has recorded its exact verdict facts in the shared binding,
`task-claim` refuses that id for every build, the claimed one included. An
interrupted exact `task-finish` resumes directly, including after its lease was
already removed; it does not re-claim a terminal identity.
`task-finish <run-id> <deploy-sha> <verdict>` is the terminal step: only the
run's current lease owner may call it, only for the SHA it claimed, and it
commits exact terminal facts to the shared binding, writes the matching
private write-once verdict, releases the lease, and commits private terminal
state. Exact retries reconcile a crash between those writes without changing
the verdict, timestamp, or digest; a second, different verdict is always
refused.

`smoke-run-scaffold.sh` and `smoke-evidence-barrier.sh` are always invoked
directly (never through a wrapper) and read those same two env vars from
whatever process calls them — they do not inherit anything the wrapper
exported in its own, separate process. An install solves this with its own
versioned env file (exporting everything its wrapper exports) that the
wrapper itself sources and that a coordinator also sources before every
direct scaffold/barrier call — one file both paths read, never a fresh
per-run copy of the same values. Source that same install env file before a
task-scoped run's own contract/marker/barrier calls too. Skipping this does
not fail loudly — it fails exactly like the bare-script case above, into a
state dir the claim itself never wrote to.

Before dispatch, the coordinator writes the contract with the frozen SHA and
every lane it is committing to:

```bash
SMOKE_LANE_ROLE=coordinator \
bash /app/skills/smoke-test/scripts/smoke-run-scaffold.sh contract \
  <run-dir> <source-sha> B1:browser:'Program master' S1:source:'Fund ledger' ...
```

Each worker writes its own marker only after its evidence is durable:

```bash
SMOKE_LANE_ROLE=coordinator \
bash /app/skills/smoke-test/scripts/smoke-run-scaffold.sh marker \
  <run-dir> <lane-id> <pass|fail|blocked|void|completed> '<summary>' '<evidence,paths>'
```

`pass` is an affirmative certification, so its comma-separated evidence paths
must name one or more nonempty, regular files already under `<run-dir>`. The
evidence barrier verifies that invariant; a screenshot path that was never
written, an empty placeholder, an absolute path, or a path escaping the run
root cannot clear a lane. `fail`, `blocked`, `void`, and `completed` may record
their concrete reason with no success evidence — do not manufacture a passing
artifact merely to satisfy a schema.

`does not hold the gate` from either verb means **this campaign is over**. Stop
every lane, write nothing further, and do not publish — a successor run owns
the environment.

The marker takes its `sourceSha` from the contract, never from the caller, so
a worker cannot certify a build it was not assigned — and an undeclared lane
is refused rather than leaving the real lane forever missing. Re-freezing on a
new build rewrites the contract, which invalidates every marker bound to the
old one: stale lanes cannot vouch for a build they never touched.

**Re-running a lane, or redefining one, on the SAME build.** A sourceSha change
retires the old markers by itself; a same-SHA change does not, and a freeze PR
pins one SHA for a whole campaign. So a lane re-dispatched mid-run, or a lane id
repurposed by a second `contract` call, would otherwise keep its OLD terminal
marker — still SHA-correct, still terminal — and the barrier would report
`ready` while a live worker was mid-flight. Two verbs close that:

```bash
# Re-running ONE lane: retire just that lane's evidence, keep the rest counting.
SMOKE_LANE_ROLE=coordinator \
bash /app/skills/smoke-test/scripts/smoke-run-scaffold.sh redispatch <run-dir> <lane-id>

# Redefining lanes on the same SHA: retire EVERY existing marker at once.
SMOKE_LANE_ROLE=coordinator \
bash /app/skills/smoke-test/scripts/smoke-run-scaffold.sh contract \
  <run-dir> <source-sha> <lane>... --regenerate
```

Both bump a lane `generation` in the contract, which markers inherit; the
barrier then names the stale marker in `invalid[]` with a `stale generation`
reason until a fresh one lands. **A same-SHA `contract` call is refused whenever
this run already has a contract, `--regenerate` or nothing** — marker count is
irrelevant, because lanes get redefined before any marker lands. A contract file
that exists but cannot be parsed is refused too. That refusal is the guard, so
read it rather than working around it.

**A generation retires markers that are already WRITTEN; it cannot retire work
already IN FLIGHT.** A worker still briefed on the old lane definition writes
its marker at whatever generation the contract carries when it writes — so bump
*before* re-briefing, never after. The refusal above is what forces that
ordering; it is not a substitute for it.

The coordinator runs `scripts/smoke-evidence-barrier.sh <run-dir> lanes`
and obtains its retained owner's `coordinator/preliminary.md`. The challenger
owner writes `challenger/disposition.md` first. Neither side reads the other
file before its own conclusion is durable.

**The run thread is a contamination channel, and it is gated.** A disposition
posted with a mention injects its full contents into the other parent's context
whether or not that parent has written a line — files ordered correctly cannot
save you from a chat transport that ignores the ordering. The challenger
therefore asks before it posts:

```bash
bash /app/skills/smoke-test/scripts/smoke-evidence-barrier.sh <run-dir> disposition
```

`ready:true` means both conclusions are durable — the challenger's own, and the
coordinator's preliminary — so the post can no longer contaminate a conclusion
that does not exist yet. Anything else names what is missing; wait and re-ask,
do not post. The gate deliberately does NOT require the coordinator's lane
markers: the challenger must never queue behind the lanes it exists to
challenge.

The coordinator's own publish gate is the `synthesis` phase, which additionally
requires every declared lane marker. Neither parent posts conclusions to the
thread on a `ready:false`.

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
running or failed to report; inspect it, and if you re-run it call
`smoke-run-scaffold.sh redispatch` FIRST so its old marker cannot answer for the
new attempt. Never infer completion
from process age, a screenshot timestamp, a chat status, or an absent process.

**Lost receipts are recovered forward, never reconstructed backward.** Preserve
the original marker, conclusion, and timestamps. Before a replacement pass,
redispatch the affected lane and re-run the recorded check against the frozen
build; the fresh marker must carry its fresh, durable evidence. Write
`coordinator/recovery-addendum.md` alongside it with the original run and
marker, recovery start/completion timestamps, exact replayed checks, new
evidence paths and SHA-256s, outcome, and remaining limitations. Set
`not_backfilled: true` in the addendum's frontmatter or JSON block. If the
frozen build is no longer available, create a new linked run instead. Never add
evidence to an old pass marker, change its `completedAt`, or present a later
replay as evidence gathered during the original campaign.

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
spec_sources, intent_sources, started_at, orchestrator, lane_models,
frontend_owner, auth_account_alias
```

**Freeze the intent text the same way you freeze the SHA.** §1 pins the build;
nothing used to pin the prose the acceptance lane reads, so extraction ran
against whatever the PR body said at that moment. Someone reordering or
narrowing a claim mid-campaign got it verified in its easier form — and the
lane's own after-the-fact check ("every quoted source line appears verbatim in
the PR body") then validated against the edited text, so the audit passed too.
A mutable intent source audited against itself proves nothing.

So at freeze time, before any lane starts, copy each intent source into the run
directory and hash it:

```bash
mkdir -p <run-dir>/intent
gh pr view <pr> -R <repo> --json body --jq '.body' > <run-dir>/intent/pr-body.md
gh issue view <n> -R <repo> --json body --jq '.body' > <run-dir>/intent/issue-<n>.md
sha256sum <run-dir>/intent/*.md
```

Record each path and its `sha256` in the run record's `intent_sources`. **The
frozen copies are the intent of record**: the acceptance lane extracts from
them, quotes from them, and the after-the-fact check verifies against them —
never against the live body.

Re-hash the live bodies when the acceptance lane runs. A mismatch is **not**
fatal and does not void the run: record it on the acceptance result as
`intent_drift: <path> (frozen <sha8> → live <sha8>)`, name it on the report's
Untested line, and keep verifying the frozen text. Absorbing it silently is the
only forbidden response — an intent edit mid-campaign is a fact about the run
that the reader has to see, whether it was innocent or not.

Resolve the remote default branch rather than assuming `main`. Fetch the target,
record its full SHA, and confirm that the dev deployment serves that SHA. If the
deployed SHA cannot be proved, report the run as `BLOCKED_BUILD_IDENTITY`; do not
attach a confident verdict to an unknown build.

**Prove build identity with `scripts/smoke-build-identity.sh`, not a browser.**
Fetching the served bundle and grepping it for the expected backend host used
to be hand-driven browser work repeated on every campaign — deterministic work
burned as LLM browser time. Run it once the frontend and backend previews are
both live:

```bash
bash /app/skills/smoke-test/scripts/smoke-build-identity.sh <frontend-base-url> <backend-base-url>
```

It fetches the served HTML, extracts the hashed JS bundle, confirms the
expected backend host appears in it and no configured stale host does
(`SMOKE_BUILD_ID_STALE_HOSTS`), and separately curls the backend's own
`/healthz` to prove it is reachable and bound — not just that the frontend
happens to serve. That last check is the one that would have caught a real
2026-08 run: a frontend that served fine while its API host resolved to
nothing, which cost the coordinator three discarded browser lanes and zero
coverage. **Browser lanes must not start if this script
exits non-zero.** Treat that exit as `BLOCKED_BUILD_IDENTITY` and stop — do not
dispatch the UI adversary or backend verifier lanes against an unproven build.

**Freeze the deployed PAIR with `scripts/smoke-pair-identity.sh`, not a
per-run ad hoc script.** `smoke-build-identity.sh` proves the bundle/host
binding once; it does not re-prove the environment still serves the SAME
build a minute, or an hour, into a long run. A shared dev environment can be
replaced under a live run by an unrelated deploy — a different failure from
`smoke-build-identity.sh`'s bundle-host seam and not caught by it. Configure
`SMOKE_GATE_FRONTEND_SERVICE` / `SMOKE_GATE_BACKEND_SERVICE` (the same names
`smoke-develop-gate.sh` reads — one wrapper env file configures both) and:

```bash
bash /app/skills/smoke-test/scripts/smoke-pair-identity.sh start <run-dir>
bash /app/skills/smoke-test/scripts/smoke-pair-identity.sh check <run-dir> <label>
bash /app/skills/smoke-test/scripts/smoke-pair-identity.sh finish <run-dir>
```

For a PR-owned completion contract, those service ids must be the PR preview
pair: `start`, `check`, and `finish` require both live commits to equal
the contract's `sourceSha`. The shared develop ids in the wrapper env are not
a safe fallback for a PR campaign; a source mismatch is exit 2 at `start`
(nothing frozen) and exit 3 at `check`/`finish` (BLOCKED). Resolve the PR
preview ids first rather than overriding or ignoring that refusal.

Every run, from the coordinator freezing before dispatch: `start` before any
lane runs; every lane (worker, challenger, coordinator) `check`s at its own
start and end; the coordinator `finish`es before publication. `check`/`finish`
exit 3 on drift or a PR-contract source mismatch — finish the run **BLOCKED**,
never a scored verdict — exit 2
means the identity itself is unreadable/invalid (refuse, do not proceed), and
exit 4 from `start` means this run already froze an identity: never re-freeze
by calling `start` again. Reachability checks (`smoke-build-identity.sh`'s
bundle/host and `/healthz`) stay separate from identity — they answer "is
something serving", not "is it the pair this run claimed."

**On drift, the coordinator may re-freeze exactly once per run** with
`refreeze <run-dir> <reason>`, instead of finishing the whole run BLOCKED for
what may be one unrelated redeploy:

```bash
bash /app/skills/smoke-test/scripts/smoke-pair-identity.sh refreeze <run-dir> "<reason>"
```

This is bounded, not a way to paper over drift: a second `refreeze` call in
the same run — whether or not another drift is ever detected — is refused
(exit 4), so a run gets at most one do-over. `refreeze` records the OLD pair,
the NEW pair, the reason, and a timestamp in `identity.json`'s `history[]`
(cite both pairs in the run record and the verdict, never just the new one)
and bumps an internal `freezeGeneration`. Every `check`/`finish` receipt from
before the re-freeze stays on disk as an honest record that the drift
happened, but `finish` only looks at receipts recorded at the run's CURRENT
freeze generation — a stale-generation receipt neither blocks nor clears
publication.

**A re-freeze does not make old lane evidence current: every lane must be
redispatched after it, and `finish` refuses until each one is.** `refreeze`
snapshots the completion contract's lane generations into `identity.json`
(`refreezeLaneSnapshot`) — the same `generation` field `smoke-run-scaffold.sh`
uses for a re-run lane (see "Re-running a lane" above). `finish`, and
`smoke-evidence-barrier.sh`'s `lanes` and `synthesis` phases, then refuse
while any required lane's contract generation is still at or below its
snapshot, and name those lanes. Only `redispatch` (or `contract
--regenerate`, which retires every lane at once) moves a generation, so the
coordinator's own post-re-freeze `check` cannot stand in for the lanes.
Concretely, after a `refreeze`:

1. `redispatch` every lane the contract declares — including one not started
   yet, since nothing on disk tells an in-flight lane from an unstarted one:
   `smoke-run-scaffold.sh redispatch <run-dir> <lane-id>` for each, then
   re-brief and re-run it (bump before re-briefing, as above);
2. each redispatched lane calls `check <run-dir> <label>` again at its new
   start/end — `finish` refuses (exit 2) while any lane is still not
   redispatched, and while no receipt exists at the CURRENT generation;
3. a second drift after the one allowed re-freeze finishes the run BLOCKED,
   exactly like an unhandled first drift would.

A `refreeze` before the contract exists snapshots no lanes, because none was
dispatched yet. One with lane markers on disk but no contract is refused. A
contract re-scaffolded on a different `sourceSha` after the re-freeze
satisfies the snapshot, because the barrier's sourceSha check already refuses
every marker written before it.

A run re-frozen under a script older than `refreezeLaneSnapshot` has no
snapshot to check, so `finish` and the barrier now refuse it (a re-freeze
with no lane snapshot reads as an unreadable identity, not as "nothing to
redispatch") and `refreeze` itself has no repair verb for it — a second call
is always refused (exit 4). Such a run must be re-scaffolded, not repaired.

A scheduled run arrives with the head already proven settled by the gate. A
campaign someone asked for in chat does not, and must prove it before freezing
and claim the environment after — see "Human-requested campaigns" below.

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
| Permissions | relevant roles, unknown/expired session, forbidden mutations — score crossings by the rule below, never by whether the run completed |
| Display | supported viewport sizes, overflow, labels, units, dates, currency, accessibility tree |
| Parity and polish | sibling modules/reference implementations, naming, years, formatting, contrast, tooltips, confirmations, responsive/mobile behavior |
| Network | feeding request status/body, retries, console errors, partial/slow failure |
| Backend | targeted and full relevant tests, API contracts, persistence, concurrency, rollback |
| Business logic | source formula, boundary cases, clamps, grain, recursion, served-payload parity |
| Cleanup | reverted mutations, retained labeled fixtures, residues, lockouts, and session ownership |

`Push every button` means `checks_executed / checks_planned`, with the manifest
attached. Never call a run 100% complete when anything is blocked, skipped, or
outside the stated scope.

### Journeys — saved walks, matched to the change before any model wakes

An install may keep a **journey catalogue**, `journeys.json`, beside its
standing instructions (shape and a fictional example:
`references/journeys.example.json`; check one with `smoke-journeys.py validate`).
A journey is a saved plain-English walk — `id` (its lane id, for life), `title`,
`proves`, `evidence` (`browser` | `api` | `native-manual`), `entryPath`,
`steps[]`, `endState` (including persistence after reload where claimed),
`seats`, `seed`, `restore`, `checkpoints[]` (screens captured *during* the walk)
— plus `consumes[]`, globs over the **whole repo**, not just its frontend: the
migration, route file or taxonomy table whose change makes this walk relevant.
A worker walks a journey from the catalogue alone — nobody re-derives how to
reach a screen — and a backend-only change selects the screens that consume it.

For a freeze campaign the gate matches `campaignRange`'s file list against the
catalogue and states the result once, as `journeys`, in `check` and the
`pr_build_settled` wake — pinned, with a snapshot of the catalogue and its
sha256, by the first settled poll, so neither a catalogue edit nor a recovery
wake can change a run's contract. No catalogue: no `journeys` key, and none of
this applies. At intake:

1. `smoke-journeys.py pin-run <run-dir> <journeys.pinFile>` copies the pin and
   the snapshot into `<run-dir>/journeys/`. Workers and siblings read journeys
   from that run copy, never from a group's private live file.
2. **Every `matchedJourneys[]` entry becomes a contract lane with the journey
   id as its lane id** — `reason` says why it is there (`changed`, `floor`, or
   `range-unknown`). An `evidence: api` journey is scaffolded `--evidence
   <id>=api`; nothing else may be. `selection: "full"` (range unknown, or the
   catalogue unusable — `reason` says which) selects every walkable journey,
   and `unassessedNativeJourneys[]` go on the Untested line by name.
3. **Every frozen `unmappedPaths[]` entry gets a scope disposition** in
   `<run-dir>/journeys/scope-dispositions.json` — `{"dispositions":[{"paths":
   [...], "disposition": ...}]}`, one rationale may cover related paths:
   `mapped-to-journey` or `new-journey` (+ `journeyId`, which must be a lane),
   `no-user-facing-consumer` (+ `changedBehaviour`, and `evidence[]` citing at
   least one file saved in the run, normally the search below), or `unresolved`
   (+ `reason`) — uncertainty terminates honestly rather than inventing an
   answer. Adding a glob to the catalogue later does not erase the obligation.
4. **Search the source even when globs matched.** For each changed backend
   route, payload field, taxonomy id or feature flag, search the web and native
   clients for the literal identifier and save the identifier, command and call
   sites under the run. A broad glob (every migration → one journey) can hide a
   second consumer. Hits suggest consumers; zero hits do not prove absence.
5. **Preflight demonstrability and fixtures before dispatch**: deployed data and
   flags (`PREVIEW-STALE`, below), seat capability, fixture availability.
   Fixtures are allocated per run **and side** — `QA-<runId>-<side>-*` — so two
   owners on one seat cannot collide, and are cleaned up after a failure too.
   Every worker brief carries this sentence verbatim: "creating/deleting objects
   named QA-<runId>-* inside the QA tenant with a QA seat is pre-authorized;
   nothing else is."

**`route: "native-manual"`** — a non-empty change claimed entirely by
`native-manual` journeys — spends nothing on a web campaign: source and CI
review, any overdue floor lane the gate listed, and one **manual packet** per
journey: the actual app artifact and version, backend identity, scoped account
and fixtures, the journey's steps and expected result, what to capture, the
**named** tester, where the result is recorded, and the release boundary it
gates. Issuing a packet is `completed`, never `pass`; `pass` needs the tester's
recorded result under `<run-dir>/manual-results/`, filed against the journey id.

`smoke-evidence-barrier.sh` enforces the **completeness** of all this — the
gate's pin held byte-for-byte by the run (skipping `pin-run` is a refusal, not
a way out), a lane per matched journey, a valid disposition per frozen path,
the run's catalogue still hashing to its pin — and nothing about its truth.
**Substance is the challenger's**: it reviews every exclusion and every
backend/data scope disposition, and samples the positive matches — a broad glob
hides an omission as well as "no consumer".

**Maintenance is reviewed, not append-only**: journeys are corrected, replaced
and retired, with history in git. A first successful walk *qualifies* a new
journey for promotion; it does not certify that its assertions test the claim.
Owners and challengers propose changes as files in their run; **one publisher —
the group's coordinator — applies them**: `SMOKE_LANE_ROLE=coordinator
smoke-journeys.py publish <catalogue> <proposed> --expect-sha256 <digest the
proposal was based on> --lock <state-dir>/control.lock` (schema and ids
validated, stale digest refused, atomic replace). Deliberately absent: a runner,
a step DSL, a replay cache, golden baselines, a dependency graph.

### The coverage floor — the part of the manifest the diff does not get a vote on

The manifest above is derived from the diff, every lane in §3 scopes from this
campaign's own change — the acceptance lane included, since a PR body describes
the PR — and a manifest built only that way tests whatever is actively
regressing. Measured across one deployment's first 74 campaigns: a
money-adjacent approval flow was walked in a browser **exactly once, ever** —
that run's own manifest called it "never browser-tested before" — and never
functionally again. A planning surface appeared in 22 of the 74, every
appearance incidental to a style change that happened to touch the file, never
once as a functional lane. An in-app assistant surface: 2 of 74, one of those an
explicit full sweep rather than a campaign. Nothing regressed on those surfaces
in that window; nothing was watching either. A very fast green suite over the
same blind spots is what this section exists to prevent.

So: **changed-surface scoping decides what runs *extra*. It never decides what
runs at all.** A small declared set of journeys is exercised against the
deployed build on a fixed cadence whether or not this campaign's diff came
anywhere near them.

**A floor entry is a journey that carries `maxIntervalDays`** — the longest
this deployment tolerates going without it proven on a deployed build. It is
deployment data, never skill text. (An install that still keeps its floor as a
table in its standing instructions reads the same fields from there.) Its `id`
never changes: staleness is computed on that key, so renaming it silently
resets the clock. Its `proves` is phrased "if this were broken, <which
consequence below>". `evidence: api` means the proof is an API contract by
design — a guard that must not be exercised through the UI. That is a catalogue
declaration, never a coordinator's after-the-fact call, and it is inert until
the contract carries it:

```bash
bash /app/skills/smoke-test/scripts/smoke-run-scaffold.sh contract \
  <run-dir> <source-sha> <entry-id>:floor:'<title>' --evidence <entry-id>=api
```

Omit the flag and the barrier refuses the pass marker for lacking browser
evidence it was never going to have; add it to a journey that is not `api` and
the barrier refuses that too.

**What earns a place on the floor — two questions, both answered with a
citation rather than an adjective.**

First, the **consequence test**. A silent failure of this journey would, before
the next campaign could plausibly notice, cause at least one of:

1. money or credit to move wrongly, or to fail to move — payments, ledgers,
   accruals, payouts, refunds, wallets, invoices, entitlements;
2. data to be destroyed, overwritten, or put beyond the reach of the person who
   owns it;
3. one tenant, role, or seat to read or write another's data — an authorization
   or scope boundary, scored by the crossing rule below;
4. a customer's first successful use to fail — signup, login, checkout, the
   first screen after purchase;
5. an irreversible outbound effect to fire wrongly — an email sent, a webhook
   delivered, a document filed, a record published.

Second, the **silence test**: name what watches this journey today. If its
failure is *loud* — CI goes red, an exception pages somebody, the app is
visibly broken on the landing screen — it does **not** belong on the floor,
however important it is. The floor buys coverage where nothing else is looking.
Spending it where something already looks is how a floor turns into a
regression suite, and a floor nobody can afford to run is the same as no floor.
If the declared list cannot be walked end to end in an ordinary lane or two,
cut it with the silence test until it can.

Both tests must hold, and together they settle an unlisted journey without
anyone having to ask: name the consequence, name the watcher. If none of the
five fit, it is ordinary changed-surface scope. If one fits and nothing watches
it, it is floor-worthy but **not yet on the floor** — record it as a floor
nomination in the run record, name it on the report, and do not start running
it. Changing the floor is a human's call — `publish` refuses one without
`--floor-authority` — because a coordinator that can extend its own floor can
also quietly shrink it.

**Cadence is computed, not chosen.** Every entry past its `maxIntervalDays` is
due, all of them — the ceiling is the deployment's own stated tolerance. If none
is overdue, a standard or full campaign still owes the single
least-recently-proven entry, and a light campaign owes nothing: walking the
whole floor every campaign makes a walk nobody performs carefully, and a pure
staleness budget leaves the mechanism cold for days. "Last proven" is read off
the run root, not a ledger: the newest `pass` marker carrying the lane id, and
only one that carries proof — browser media, or a run whose contract declared
that lane `evidence: api`. The gate reports the answer as `journeys.floor`, and
anyone can recompute it for any moment:

```bash
python3 /app/skills/smoke-test/scripts/smoke-journeys.py floor-due \
  <catalogue> <run-root> [--size light] [--as-of <run timestamp>]
```

**Each due entry is one contract lane of kind `floor`, with the entry's `id` as
the lane id. A standard or full campaign never declares zero** — not on a
backend-only diff, not on a one-line change, not on a campaign that found
nothing.

**The skip rule below does not apply to floor entries, and this is not an
exemption carved out of it.** That rule lets a browser check go unwritten when
a source lane in the same campaign already proves the identical claim with a
green spec. A floor entry's claim is composition on a deployed build: whether
the connected flow still works end to end, through storage and the network, on
the build actually being served. The counter-rule already names composition,
deploy identity, persistence across reload and permission crossings as claims a
green spec structurally cannot observe, and a floor entry is made of precisely
those — there is no line in any spec that would have failed had the floor
journey been broken in the browser. A floor entry whose claim *looks*
spec-covered is the most tempting skip and the most expensive one: the unit
assertion is green, nobody has walked the flow in weeks, and the run reports
coverage it does not have.

**A floor entry that cannot run must not vanish from the campaign.** It is a
declared contract lane, so the synthesis barrier already refuses to publish
until it carries a terminal marker, and `blocked` is one:

```bash
SMOKE_LANE_ROLE=coordinator \
bash /app/skills/smoke-test/scripts/smoke-run-scaffold.sh marker \
  <run-dir> <entry-id> blocked '<blocker>' '<artifact,paths>'
```

The standard around it is the acceptance lane's `not demonstrable` standard,
because it is the same failure wearing a different name:

- **`blocked by:` names the specific missing thing** — the seat nobody
  provisioned, the seed row that does not exist, the credential that expired.
  "Could not run" and "environment issue" are the absence of a blocker, not one.
- **Attach the artifact for the furthest state the walk did reach**, or the
  command and output proving nothing was reachable.
- **A blocked entry does not reset its staleness clock.** It was not exercised.
  Otherwise blocking is the cheapest way to make a journey look fresh, which is
  the whole failure this section is about.
- **The entry goes on the report's Untested line by name** and the run is at
  most `PASS_WITH_GAPS`. Two entries blocked by the same thing are one blocker;
  name it once, as the acceptance table already requires.
- **An overdue blocked entry is an owned floor-coverage breach, not an
  automatic human-decision verdict.** Write
  `coordinator/floor-breach-<lane-id>.json` with `floorId`, `sourceSha`,
  `discoveredAt`, `blocker`, the entry's concrete consequence, an `owner`, a
  safe `remediation` action and expected artifact, `affectedPromotions`, and
  `humanDecisionRequired:false`. The coordinator assigns or starts the bounded
  remediation: seed/fixture repair, a safe harness change, a narrowly scoped
  code fix, or a fresh replay once the prerequisite exists. Never attempt a
  production publish merely to force the unsafe branch.
- **Finish `NO_GO` while the mandatory breach remains open.** This is a
  demonstrated release-readiness deficiency, not a claim that the product has
  a defect and not a `HUMAN_DECISION`: the existing gate therefore raises its
  durable hold. Scope that hold to the record's `affectedPromotions`; it does
  not block unrelated `develop` work or turn routine QA setup into a ticket for
  a human. The breach clears only after its newly dispatched lane records a
  fresh `pass` marker with durable evidence, never because someone relabeled it
  or acknowledged the remediation plan.
  `HUMAN_DECISION` remains reserved for a concrete production, privacy, money,
  authorization, or irreversible action whose safe outcome cannot be chosen
  from the evidence. In that case set `humanDecisionRequired:true`, name that
  exact action, and preserve the autonomous remediation work already underway.

**Checkable after the fact**, from a finished run's artifacts alone:

- **`floor-due --as-of` the run's timestamp equals the contract's `floor`
  lanes.** A non-light contract with none ran with no floor at all; a run that
  walked a fresh entry while another sat past its ceiling shows as a mismatch.
- **Every floor lane has a terminal marker, and every floor `pass` names browser
  media that exists under the run root** unless its contract entry carries
  `evidence: "api"` — the barrier enforces both, so a published run without them
  means the barrier was bypassed, not that the entry was legitimately API-only.
- **The cross-run sweep is the one that matters.** `floor-due` as of now: any
  entry overdue, or never proven, is a live coverage breach no matter how many
  green runs sit on top of it. That is what surfaces a money-adjacent flow
  tested once in seventy-four campaigns in the week it goes stale.
- **Post count is unchanged.** A floor lane is a browser lane; the posting
  contract already accounts for it.

**A deployment that has declared no floor still says so out loud.** No floor
journeys (and no floor table) mean the coordinator cannot compute a due entry;
record `floor undeclared` on the run record, name it on the report's Untested
line, and cap the run at `PASS_WITH_GAPS`. Do not invent a floor from the
product — inventing one is the coordinator picking its own floor, which the
nomination rule above exists to prevent. `PASS_WITH_GAPS` is deliberate rather
than blocking: an install picking up this version keeps shipping, but never
again reports an unqualified `PASS` while nobody has said which journeys must
not silently break.

### Scoring permission crossings — a success is the defect

Permission checks invert the usual scoring, and getting this backwards makes a
run report a clean pass on exactly the defects it was convened to find.

Write every permission check as an attempt to do **somebody else's job** — one
scope reaching for another's data or money — and score the attempt, never the
run's completion:

| Outcome | Meaning | Verdict |
|---|---|---|
| `REFUSED` | the server refused it | **pass** |
| `ALLOWED` | the server performed it | **defect**, whether or not the screen offered the control |
| `HIDDEN_ONLY` | the screen offered no control, and the same request sent directly succeeded | **defect**, and the most dangerous shape |

**Never record `HIDDEN_ONLY` as `REFUSED`. A hidden control is not a control.**
It is the shape a browser-only lane always records as a pass, because the
tester never tries what the UI does not offer.

This has teeth only when the seats are real. Requirements:

- **Two or more seats, scoped and non-overlapping**, and no seat holding the
  admin/superuser flag the product genuinely enforces — an all-powerful seat
  returns a meaningless pass on every crossing.
- **The scope of each seat is read back by an agent that did not create it.**
  A mis-scoped seat turns a real permission failure into a silent pass and the
  screenshot looks identical either way. Whoever provisioned the accounts
  cannot be the one who certifies their scope.
- **Write the scoring rule into the manifest before anyone logs in.** After the
  fact, every screenshot looks the same and nobody can tell which seat produced
  which.
- Where a module has many unguarded routes, played naturally both seats will do
  everything, nothing will error, and the run will look clean. That appearance
  is the failure mode this section exists to prevent.

### Skip a browser check only when this campaign's own spec already proved it

Before assigning a manifest ID to a browser check, ask whether a source lane
in this same campaign already names and runs an automated spec that asserts
the exact same claim — the coordinator does not need to go looking for this;
its own source-lane assignments are where the answer already lives. Skip the
browser check, and record the skip on the manifest with a one-line note
naming the covering spec, only when both hold:

1. a source lane names a spec file/test whose assertion is the same claim the
   browser check would otherwise exercise; and
2. that spec ran green in this campaign, on the frozen build — not a stale
   prior run, and not CI on a different SHA (see the CI-reuse rule under
   "Backend and specification verifier" below).

**The skip note carries the same evidence the CI-reuse rule demands, on the
manifest row itself.** That rule requires citing a conclusion, counts and a run
URL because a claim of "already green" without them is indistinguishable from a
guess. Condition 2 asserted exactly that and required nothing, so a skip that
was fabricated, mistaken, or based on a stale run left an identical record to a
correct one. There is a live drift chain: the backend lane cites CI for its
source work ("already ran green on this SHA"), so no spec actually executes
in-campaign, so condition 2 has no basis — and nothing mechanical notices. The
skip row must therefore name all three:

- **the spec file and test name** — `src/foo/bar.spec.ts › renders the dash`,
  not "the forecast specs";
- **how it was proven green THIS campaign** — either the lane ID that ran it
  plus the command and its counts, or the CI check-run reference (conclusion,
  counts, run URL) for the **frozen SHA**; and
- **the manifest ID of the browser check being skipped**, so the skip and the
  thing skipped are the same row.

No citation, no skip: run the browser check. A skip is a claim about evidence,
and a claim about evidence is held to the evidence standard it is claiming.

**The counter-rule is as binding as the rule.** A browser check is never
redundant when the claim is something a green spec **structurally cannot
observe** — that test is the rule, and the list below names instances of it,
not its boundary. If you cannot say which line of the spec would have failed
had the claim been false in the browser, the spec does not cover the claim.
Including, and not limited to:

- **composition** — whether the whole connected flow works end to end, not
  whether one function returns the right value in isolation;
- **visual/layout** — spacing, contrast, overflow, responsive behavior;
- **deploy identity** — whether the browser is actually exercising the build
  under test;
- **persistence across reload** — a spec asserting state in memory says
  nothing about what survives a round trip through storage and back;
- **failure shapes** — what the user sees when the network is slow, the
  request 500s, or the response is partial; a spec that mocks the call away
  has asserted the mock;
- **permission crossings** — where a *success* is the defect (§2), so a green
  assertion that the action worked is the wrong-shaped evidence entirely.

The enum is open deliberately. A closed list of three was itself a way to skip:
everything it did not name — the three above among them — became skippable on
the coordinator's own judgment, and permission crossings already have a §2
subsection saying a success is the defect, which a closed list silently
contradicted.

The spec layer is known to lie on exactly these claims: one map-canvas test
has been observed passing green against both a working and a broken
implementation of the feature it names, and a dead hover tooltip shipped
"fixed" and green three consecutive campaigns before a browser lane caught it.
This rule skips only a check that re-asserts a spec's own assertion — never a
check that tests something the spec cannot see. Measured duplication varies
with how spec-shaped the changed surface is (as high as 81% of checks for a
backend seam that ships its own specs, as low as 31% for frontend composition
work), so apply the two conditions above per check, never as a blanket cut to
the browser lane.

## 3. Run the provider-native lanes

Use different model families for diversity. The coordinator's retained frontier
owner executes the diff-derived backend/specification lane and the separate
stated-intent acceptance lane, keeping their manifest IDs and evidence distinct.
The challenger's fresh retained frontier owner performs independent replays and
attacks, including the UI adversary lane. A lane is a coverage contract, not a
requirement to spawn a new worker. Retain the same owner for its side's work;
never collapse the required lanes or their evidence to reduce worker count.

### UI adversary

The challenger's retained frontier owner executes this lane at medium effort
by default. Use the `agent-browser` skill.

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
  **Any `agent-browser network requests`/`request`/`har stop` output that will
  touch disk — evidence file, run dir, chat, log — goes through
  `/app/skills/agent-browser/scripts/ab-net-redact.sh` first, never a raw
  redirect or a raw `har stop <path>`.** Its `headers`/`cookies`/`har stop`
  output all carry live `Authorization`/`Cookie` values verbatim; a bearer
  token or session cookie that reaches a shared path this way is burned same
  as a credential typed into chat.
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

**`smoke-evidence-barrier.sh` enforces this at the marker level.** A marker
declaring `confirmedFindings: ["<id>", ...]` must carry, per id, either
`clips/<id>.mp4` (a real, nonempty file) or a `clip-skipped: <id>: <reason>`
line in its `evidence` array — silence fails the barrier, exactly like the
`record start` failure above must still be recorded rather than dropped. A
`status:"pass"` uses the same valid clip-skipped form; it is not treated as a
missing file when it names one of that marker's confirmed findings and gives a
non-empty reason. Set
`confirmedFindings` with the scaffold, never by hand — `smoke-run-scaffold.sh
marker <run-dir> <lane-id> <status> [summary] [evidence-csv]
--confirmed-findings <id>[,<id>...]` — the same rule that forbids hand-written
markers elsewhere in this file applies here too, and the flag is optional
(omit it and the field is omitted, exactly as before this existed).

### Contact sheet

At kickoff, once previews are live, capture the selected journeys' screens at
desktop and phone width into one labelled image. `smoke-journeys.py shots
<run-dir>` prints the matched journeys' `captureRecipes` (`name`, `path`,
click/wait `steps`) as `shots.json`; a journey's English steps are never fed to
the capture script.
`smoke-contact-sheet.sh <run-dir> <base-url> <auth-state.json> <source-sha>`
— pass the campaign's frozen `sourceSha` as the fourth argument so
`manifest.json`'s `buildSha` records the SHA you already froze on rather
than whatever (if anything) the served page exposes; omit it only when no
frozen SHA is known yet, which falls back to sniffing the page for
`meta[name="build-sha"]`, `window.__BUILD_SHA__`, or a `data-build-sha`
attribute — the app may expose none of those, leaving `buildSha` empty. It
reads caller-provided `<run-dir>/contact-sheet/shots.json` (capped at 8; the
script itself is generic, no product knowledge) and writes `sheet.png` +
`manifest.json`. A failed screen is `failed: <reason>` plus a placeholder
tile, never dropped.

Post a campaign contact sheet as **two ordered sends to the same named channel
destination**: first send the text-only kickoff root with `send_message`, then
call `send_file` for `sheet.png` with no caption. Do not combine the kickoff
text and sheet in one `send_file` call. Slack uploads files before it posts a
caption; before the root exists that upload has no `thread_ts`, so it becomes
a second channel-root message. Delivery processes the two outbound rows in
order and attaches the second one under the fresh root's thread. A scheduled
campaign must reserve exactly one additional chat slot for that reply; it is
not permission for progress narration. Link the sheet from the verdict. A
deployment may also run a fresh, read-only design critic on the shot PNGs —
shadow only, posted but never gating the verdict.

**Every screen navigates in its own fresh `agent-browser` session** (never
one shared session for the whole sheet), with the same saved auth state
loaded fresh into each — never a fresh login. A shared session let one
screen's leftover DOM/localStorage state (e.g. a nav drawer a prior screen's
`steps` opened) bleed into later screenshots, which the shadow critic then
graded BROKEN as a pure capture artifact. Each screen's manifest entry
carries `freshNavigation: true` as the record of this.

**The phone capture waits for responsive transitions after its viewport
resize.** Do not replace that settle step with a screenshot immediately after
the 390px switch: a real PR campaign captured a drawer mid-slide and created a
false visual finding. If the settle wait itself fails, the mobile entry is
recorded as missing/partial instead of emitting timing-contaminated evidence.

**Auth state is a live session token — never put it in the run dir or under
the shared workgroup tree.** The script refuses both (`realpath`-checked
against `<run-dir>` and `$SMOKE_WORKGROUP_ROOT`, default
`/workspace/workgroup`) and never copies its content anywhere. Keep it at a
private path like `/tmp/contact-sheet-auth-<runId>.json` and delete it once
the sheet is captured — the script doesn't own that file and won't delete it
for you.

### Backend and specification verifier

The coordinator's retained frontier owner executes this lane at medium effort
by default.

- Trace the changed source and its production-relevant call path.
- **Read the CI check-run result for the frozen SHA before re-running a suite
  CI already ran.** Query the check runs for that exact SHA (e.g.
  `gh api repos/<repo>/commits/<sha>/check-runs`, or the platform equivalent)
  and cite the conclusion, counts, and run URL as evidence — that is proof,
  not a placeholder for it. Re-run a suite only when you can name which
  exception applies: the CI result is for a different SHA than the frozen
  build; the suite is path-filtered and CI's check list shows it did not run
  at all for this diff; or this is a focused re-run of one file/test to
  investigate a specific failure CI already reported. No stated exception, no
  re-run — typing `npm run test:unit` / `test:integration` (or an equivalent
  full-suite vitest pass) on a SHA whose CI already ran it green produces zero
  new evidence for real cost.
- When a re-run is warranted — a stated exception above applies, or new tests
  were written during `fix` mode that CI has not yet seen — run focused tests
  first, then the full relevant suite. Record exact commands, SHA, counts,
  failures, skips, duration, and environment limitations.
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

### Acceptance verifier

The coordinator's same retained frontier owner executes this lane at medium
effort by default. Declare it separately in the contract
like any other lane (e.g. `A1:acceptance:'Forecast column dash rendering'`) so
its marker gates synthesis the same way every other lane's does.

Every other lane in this skill scopes from the diff — files changed, source
touched, controls added. This lane scopes from stated intent instead, and
that source must never be the diff:

- **Read the FROZEN intent copies in full**, not the diff and not the live PR.
  `<run-dir>/intent/*.md` is what §1 pinned at freeze time; extract and quote
  from those files only. A findings issue's expected/actual fields are a second
  independent intent source when one exists, and it is frozen the same way.
- **Re-hash the live bodies before extracting.** If any `sha256` differs from
  the one in `intent_sources`, record `intent_drift: <path> (frozen <sha8> →
  live <sha8>)` on this lane's result and carry it to the report's Untested
  line. Then verify the frozen text anyway. Never re-extract from the live body
  and never drop the drift note — the whole point is that a mid-campaign edit
  is visible to the reader rather than quietly becoming the thing verified.
- **Extract every stated, user-visible claim** — something a person could
  observe in the running product (a value that renders differently, a state
  that becomes reachable, an error that becomes possible). Quote the source
  line for each claim in the run record.
- **Exclude implementation statements.** "Now uses a row lock," "refactored to
  share the helper," "added an index" describe how, not what a user sees —
  they are not acceptance criteria and belong to the backend lane's source
  trace, not here.

Verify each claim against the running dev build and record exactly one of
four verdicts, one row per claim:

| Verdict | Meaning |
|---|---|
| `met` | observed in the running app, evidence attached |
| `not met` | observed to be false — this is a finding; route it through §4 |
| `not demonstrable` | the claim is real but this environment/data cannot exercise it — a first-class outcome, never a silent pass. **Requires a blocker and an artifact** (below) |
| `claim absent` | the PR states no user-visible claims (refactor, dependency bump). **Cross-check it against the diff** (below) |

One screenshot per claim, not per interaction — this lane proves the claim,
it does not re-run the UI adversary's coverage.

**`not demonstrable` costs something to say.** It was the cheapest compliant
answer on this table: `met` needs a screenshot, `not met` routes through §4 and
gets challenged, and `not demonstrable` needed nothing at all — judged by the
same worker who benefits from not chasing the claim, and unauditable afterwards
except by redoing the work. Every `not demonstrable` row now carries both:

- **`blocked by:` naming the specific missing thing** — the seed row that does
  not exist, the branch no reachable input hits, the fixture the environment
  lacks, the account tier nobody provisioned. "Could not verify", "no data",
  and "environment limitation" are not blockers; they are the absence of one.
  A verdict meaning "I could not check" has to say what would have let it.
- **The artifact for the furthest state it DID reach** — the screenshot of the
  empty list, the form that would not accept the input, the API response that
  came back without the field. If genuinely nothing was reachable, attach the
  command or URL that proved that and its output.

Two rows in the same table with the same `blocked by:` text are one blocker,
not two verdicts; say so and name it once at the top of the run's Untested
line. That is a real environment gap worth fixing, not a per-claim excuse.

**`claim absent` is cross-checked against the diff, never taken on the PR's
word.** The cheapest compliant PR body is one that states nothing, and nothing
used to notice. Before recording `claim absent`, check whether the change has a
user-facing consumer: any `changed` journey in the run's pinned selection, any
scope disposition other than `no-user-facing-consumer`, or — with no catalogue —
any frontend, template, copy, or served-payload path in the diff. If it does:

- `claim absent` is still the honest verdict for THIS lane — the lane reports
  what the PR stated, and it must not invent claims (see anti-ceremony below).
- But record it as **`claim absent (unstated user-facing change: <paths>)`**,
  and tell the coordinator. That combination is a signal to **widen the UI
  adversary's scope over those paths**, never a reason to narrow the run. A
  user-facing change nobody wrote down is precisely the blind spot the
  diff-derived lanes exist to cover, and this is the moment it is visible.

**Anti-ceremony, same standard as the posting-contract rule above:**

- A PR with no user-visible claims produces a one-line `claim absent` result.
  Do not manufacture a claim to look busy, and do not pad the table with
  implementation statements reclassified as user-visible. The diff cross-check
  above does **not** loosen this: an unstated user-facing change makes the note
  longer and widens the UI adversary's scope; it never turns into a row in this
  table. This lane reports what the intent said, including when the answer is
  "nothing, and that is itself worth knowing".
- `not met` findings route through §4 like any other finding. `claim absent`
  is not a finding and needs no challenge — but `claim absent (unstated
  user-facing change: …)` is a scope input the coordinator must act on before
  the manifest closes.
- The lane's output is the claim table. No narration, no restating the PR, no
  summary of "what the PR was about" — the reader can read the PR themselves.

**Checkable after the fact**, entirely from the run directory:

- **Quotes resolve against the frozen copies.** Every row's quoted source line
  must appear verbatim in `<run-dir>/intent/*.md` — a claim without a quote is
  fabricated scope, not evidence. Checking against the live PR body is what let
  a mid-campaign edit launder itself; `intent/` cannot be edited after the fact
  without changing a hash the run record already published.
- **`intent/` must exist and its hashes must match `intent_sources`.** A run
  whose acceptance lane produced a claim table with no frozen intent files
  skipped the freeze — that is visible without rereading anything.
- **Every `met`/`not met` row carries an attached screenshot.** A bare verdict
  is not a verified one.
- **Every `not demonstrable` row carries a `blocked by:` naming a concrete
  missing thing, plus an artifact.** A row with neither, or with a `blocked by:`
  that only restates the verdict ("could not verify"), is an unaudited skip.
- **Every `claim absent` result on a change with a user-facing consumer
  carries the `(unstated user-facing change: …)` note and a matching widening
  of the UI adversary's manifest scope.** A bare `claim absent` next to matched
  journeys is the failure this cross-check exists to surface.
- **Row count against a reread.** Compare the claim table against a manual
  reread of the frozen intent files: a claim present in the text but missing
  from the table is a silently dropped claim, and the lane failed at extraction
  even when every listed row is honest.

**This lane runs in addition to the diff-derived lanes above, never instead
of them.** A claim nobody wrote in the PR or issue cannot be extracted, so
this lane has a blind spot the seam lanes cover — a defect never promised as
behavior (a broken button nobody claimed would work) is exactly what the UI
adversary and backend verifier exist to catch. The reverse blind spot is
theirs: a diff-derived manifest never asks whether the feature does what it
was asked to do, only whether the code is internally coherent, which is the
gap this lane exists to close. Neither lane substitutes for the other, and
neither should be cut in the name of simplifying the manifest.

**`not demonstrable` never rounds up to a pass.** A claim nobody could
confirm is not evidence the feature works; it is evidence the run cannot say.
Never call the run `PASS` while one is open — at most `PASS_WITH_GAPS`, with
the claim named on the report's Untested line. Apply the escalation
conditions in §5 to decide whether it needs more than that: a claim whose
absence of proof concerns data correctness or another P0/P1 surface is not
merely untested, it is exactly the "nobody knows if this is safe" case
`HUMAN_DECISION` exists for (§8) — raise it rather than letting an unprovable
claim quietly ship as `GO`. A low-stakes claim (a rarely hit empty state,
cosmetic copy) can stay at `PASS_WITH_GAPS` without escalation.

All lanes preserve their own claim sources and evidence. One owner's lanes are
not independent reviewers of one another. Across the coordinator/challenger
boundary, share frozen specifications and raw evidence, never conclusions before
each side's own conclusion is durable. The independent challenger must sample
checks that passed — including acceptance claims marked `met` — not only
reported failures; otherwise it cannot challenge false clears.

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

For a bounded finding on a dev-bound build, the coordinator's retained frontier
worker is the technical decision owner. It chooses and records one of: a narrow fix, a correction to an
overstated claim or PR description, or a tracked deferral with a recommended
default, owner, and re-entry condition. An unspecified behavior is evidence to
reason from — current product patterns, user impact, and the frozen intent —
not a reason to wait for a human by default. Preserve the dissent and give the
challenger a concrete adjudication target; do not convert an ordinary severity
or wording dispute into a release-desk question.

## 5. Escalate selectively

Use one frontier adjudicator only when at least one condition holds:

- P0/P1 impact;
- the two regular lanes disagree after a concrete cross-check;
- business rules or source specifications conflict;
- the fix crosses multiple subsystems or changes authorization/data semantics;
- the proposed repair could mask the symptom without restoring the invariant.

Outside those conditions, the retained coordinator-side owner decides the bounded disposition above
and continues with independent verification. A human decision is required only
when the decision itself would commit a production, privacy, money,
authorization, or irreversible external outcome that the evidence cannot safely
choose. It is not a substitute for an agent choosing a reversible dev remedy or
deferral.

When a listed condition holds, the outer coordinator dispatches one fresh
provider-native `qa-adjudicator`: Fable 5.1 or GPT-6 Astra, medium by default,
independent of both owners' sessions. This is a fresh review, not a higher tier;
there is no prerequisite parent-effort increase or model ladder. Give it the
frozen run record, full finding evidence, source, tests, and both owners'
arguments. The challenger requests this through the coordinator and never
spawns it itself. Return the review to the retained coordinator-side owner for
source-backed resolution, preserving the challenger's dissent in publication.
Any explicit effort override follows the supported transport above; it is not
an automatic escalation step. Do not add routine duplicate adjudicators.

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

- **A merged fix closes the issue; the coordinator verifies afterwards and
  reopens failures.** The fix PR carries a closing keyword (`Closes #N`, one per
  issue — a comma-joined list closes only the first), so the merge closes the
  finding. That close means `fixed`, never `verified`: the coordinator re-runs
  the recorded reproduction on the deployed build, records the evidence on the
  issue and marks it verified, or reopens it with the evidence when it still
  reproduces. **The implementer never certifies their own work** — that rule is
  unchanged; it binds who VERIFIES rather than who closes. Tracker state then
  needs no status labels — open means unfixed, closed-and-unmarked means fixed
  and awaiting verification, closed-and-marked-after-that-close means verified
  on a deployed build. Every close carries a pending verification, so a closed
  issue is never a silently erased defect.
- **Classify regression, implementation defect, or product gap at filing
  time.** A regression has evidence of prior working behavior; an implementation
  defect contradicts a stated claim or existing product pattern; a gap is a
  behavior never specified. All three may receive an autonomous bounded
  disposition: a narrow fix, correction of an overstated claim, or tracked
  deferral with a recommended default, owner, and re-entry condition. A gap is
  not automatically a human decision. Escalate only when choosing the behavior
  would commit production, privacy, money, authorization, or irreversible
  consequences outside the evidence.
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
| `HUMAN_DECISION` | Needs a human call — **holds promotion until answered** |
| `CLEAR` (challenger) | ✅ Challenge found no material contradiction |
| `DISSENT` (challenger) | ⚠️ Challenge disputes specific findings |
| `BLOCKED` (challenger) | ⛔ Challenge could not verify |

Reason codes become plain sentences — "the deployed build changed mid-run, so
the frozen build could no longer be proven", never `BLOCKED_BUILD_IDENTITY`
in prose. The run ID and short SHA stay verbatim (they anchor the thread),
on the post's last line — never in the headline a reader scans first.

Post a compact, human-formatted channel summary (platform bold/bullets, no
key-value dump) and attach the detailed manifest/evidence plus the key
screenshots:

```text
**<subject in words, e.g. PR #123 or Re-verification> — <chat language from the table>**
*<one-sentence reason a non-operator understands>*
- Scope: <scope in words>, on <environment>
- Coverage: ran <executed> of <planned> checks (<passed> passed, <failed>
  failed, <blocked> blocked) — plus exact test counts and limitations
- Floor: <entries walked and their outcome; each blocked entry with its
  blocker; or "floor undeclared">
- Frontend: <journeys completed>, <n> screenshots and <n> clips (attached)
- Findings: <each in one plain-language line with severity, or "none confirmed">
- Fixes: <PRs and deployed SHAs, or none>
- Untested: <explicit list, or "nothing in scope">
- Challenge: <challenger chat language> — <one clause of substance>
- Full run record: <durable link — publish `run-record.md` where this
  channel's readers can click it (a PR comment, an issue, a dashboard; the
  deployment's standing instructions name which) and link it here. Never
  paste the record inline: the post carries the verdict, the link carries
  the detail.>
**Recommendation: <chat language> — <one sentence why>**
Run `<run_id>` · build `<sha12>`
```

The retained coordinator-side owner synthesizes recorded evidence; the outer
coordinator publishes that decision. Neither may invent a result,
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
duplicates, and reclaims an abandoned active run on exactly one signal: the
liveness window (no `progress` stamp for 30 minutes,
`SMOKE_GATE_PROGRESS_STALE_SECONDS`). A container killed mid-run simply stops
stamping, so the gate recovers the SHA on the next poll past the window.

**A run that is still stamping keeps its slot, however long it has run.** The
hard age ceiling (4 hours, `SMOKE_GATE_ACTIVE_STALE_SECONDS`) used to override
liveness, and that produced two coordinators on one campaign: the ceiling
expired, the next poll started a rival on the same PR and the same frozen SHA,
and nothing told the original — which kept dispatching lanes, mutating the same
seat, and writing into the same run tree for hours. Past the ceiling the gate
now *refuses* new claims and names the overrun in `activeAgeSeconds`; a human
who has confirmed the prior coordinator is stopped can force the slot with
`claim … --takeover`. No automatic path passes that flag.

**The ceiling still rings — it was demoted from executioner to alarm.** Crossing
it wakes an agent once per overrun run (`pr_run_overrun` /
`develop_run_overrun`, carrying `runId` and `activeAgeSeconds`), with no rival
claim required. The case worth catching is a **zombie stamper**: a coordinator
whose heartbeat fires while its work is wedged in a retry loop, a stuck lane, or
a hung browser. On that wake, check whether the run is actually progressing —
lane markers landing, evidence files growing — and if it is not, stop its
coordinator and take the slot with `--takeover`.

**A `--takeover` does not stop the incumbent; it only stops it from *counting*.**
The gate records who it displaced, so the displaced run's next `progress`,
`release`, or `finish` returns `STOP THIS CAMPAIGN` naming the takeover instead
of a generic refusal. Until that call happens the old container is still running
— someone must stop it.

The coordinator must therefore stamp liveness — after the freeze, then at
least every 15 minutes while lanes run:

```bash
bash /workspace/agent/smoke-develop-gate.sh progress <run-id>
```

**Read `ok:false` carefully — two different things wear it.** Any gate verb can
answer `ok:false` for a transient reason as well as a terminal one, and only one
of them means stop:

| Response | Meaning | What to do |
|---|---|---|
| `retryable:true` and `error` starting `gate_lock_busy:` | Another gate invocation held the state lock. Says **nothing** about who owns the slot. | Wait ~10s and re-run the **same** command. Never stop the campaign. |
| `ok:false` with any other `error` | This run is no longer the active one (reclaimed, taken over, or already finished). | Stop the campaign immediately instead of double-running the SHA. |

Key the stop decision on the second row, never on bare `ok:false`. A mandatory
`progress` stamp that merely collides with a busy poll used to be indistinguishable
from "you were reclaimed", and stopping on it killed healthy campaigns — the exact
failure the liveness stamp exists to prevent. `SMOKE_GATE_LOCK_WAIT_SECONDS`
(default 15) tunes how long a gate call waits before giving up.

**Five `gate_lock_busy` answers in a row is an outage, and an outage has a
defined response — not "keep retrying".** Do this, in order, and do not treat any
of it as a reason to publish:

1. **Keep the campaign running and the lanes working.** Nothing about a wedged
   lock invalidates evidence already gathered. Do not stop, do not void lanes.
2. **Post one message in the run thread** naming the verb that is failing, the
   `phase` from the response, and the run id — so the stall is visible rather
   than inferred later from a gap in the stamps.
3. **Assume the liveness stamp is not landing.** After
   `SMOKE_GATE_PROGRESS_STALE_SECONDS` (default 1800) of unstamped silence the
   watcher may reclaim the slot and start a rival campaign on the same
   environment. Treat the environment as no longer reliably yours.
4. **Do not `finish`.** A verdict needs the slot, and you cannot prove you still
   hold it. Escalate to a human with the thread link instead; a run that cannot
   reach its gate has not earned verdict authority.

### Human-requested campaigns

A campaign someone asks for in chat gets no gate wake, so it inherits none of
the gate's guarantees: nobody has proved the head is testable, and the watcher
does not know the environment is taken. Both gaps are real. On 2026-08-07 a
requested campaign froze a pair by eye while the merge queue was draining;
four PRs landed and both services redeployed within five minutes, and every
browser observation in the run belonged to a build the run's own header did
not name. Run these three commands — the campaign is otherwise invisible to
the same machinery that protects a scheduled run.

**Before freezing, prove the head is settled** with the same rule the watcher
uses. `check` is read-only: it claims nothing, debounces nothing, and writes
no state.

```bash
bash /workspace/agent/smoke-develop-gate.sh check
```

Freeze only on `settled: true`, and record the returned `sourceSha`,
`backendDeploySha`, `frontendDeploySha` and `deployLagAccepted` in the run
record as the proof. Anything else — `ciReady:false`, a pending or failed
check, an unaccepted deploy lag, `gate_fetch_failed` — means the head is not
testable yet. Say so and wait; do not freeze on a build you cannot prove.
`settled: true` is a statement about this instant, so freeze immediately
after and recheck at every point §1 already requires.

**Then claim the slot**, using the frozen SHA:

```bash
bash /workspace/agent/smoke-develop-gate.sh claim <run-id> <source-sha> [true|false]
```

The claim is what makes the campaign visible: the watcher reports
`queued_behind_active_run` instead of starting a competing run on the same
environment, browser lease and worktree, and `progress` starts working —
without a claim it always answers `ok:false`, because it keys on the active
run. Stamp liveness from then on exactly as a scheduled run does; a campaign
that stops stamping for 30 minutes is reclaimed, which is correct.

The optional third argument is the merge hold, default `true`. Leave it true
while browser lanes are running — a build that moves under an open campaign
is the failure above. Pass `false` deliberately when the campaign wants merges
to continue: its browser lanes are blocked on something else, or a confirmed
fix should land now and the campaign will re-freeze on the new build. Either
way the watcher stays suppressed; only the merge queue is released. The choice
is persisted with the claim and echoed back by every `progress` response as
`mergeHold`, so a stamp can never quietly reinstate a hold the campaign opted
out of.

**End with `release`, never `finish`:**

```bash
bash /workspace/agent/smoke-develop-gate.sh release <run-id>
```

`release` frees the slot and does nothing else. `finish` is verdict authority —
it records a completed SHA, publishes the verdict artifact, and raises or
clears the promotion hold. A campaign that never routed through the gate has
not earned any of that, and a `GO` from one would clear a hold raised by a run
it never exercised. `claim` cannot write those artifacts at all, and neither
can `release`; that separation is deliberate, not a convention to be careful
about. `finish` additionally refuses any run that no longer owns the active
slot, so a campaign or a reclaimed run that revives late cannot overwrite a
successor's verdict — the same rule `progress` has always applied, extended to
the one verb that was still failing open.

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
- `SMOKE_GATE_WAKE_WINDOW` (`HH:MM-HH:MM`, may wrap midnight) with
  `SMOKE_GATE_WAKE_TZ` restricts **campaign starts** to quiet hours. Unset =
  always open, so an existing deployment is unchanged by picking up this
  version. Use it when the branch under test merges faster than a campaign
  runs: a full campaign needs the environment to hold still for an hour-plus,
  and on a branch taking dozens of merges a day the settle test rarely holds
  and a run that does start gets voided by the next deploy.
  Two properties make it safe, and both are load-bearing:
  - **It gates only `develop_build_settled`.** `develop_unsettled` and every
    gate-failure trigger still fire around the clock — an alarm you only hear
    at 3am is not an alarm.
  - **It is checked after the debounce and before any state is marked**, so a
    settled candidate stays a candidate. The first poll inside the window
    fires on whatever the branch has settled on by then, never on a stale SHA.
    Suppressing the wake after `activeSha` were set would strand the SHA as an
    active run with nobody testing it.
- `SMOKE_GATE_PREFLIGHT_CMD` runs one command immediately before a campaign is
  opened, for preconditions the gate cannot see: test-account liveness, a seeded
  fixture, a reachable dependency. **Exit 0 = go. Non-zero = the campaign never
  opens**, and the last non-empty line of the command's output becomes the
  `reason` a human reads. `SMOKE_GATE_PREFLIGHT_TIMEOUT` (default 120s) bounds
  it; a timeout is reported as a failure, never a hang. Unset = inert.
  - **The gate deliberately knows nothing about what the command checks.** That
    is what makes the seam durable: a deployment can change where its test
    credentials come from — a mounted file, a derived secret, a seed step — and
    this script never learns the difference.
  - **A failure wakes.** Everything above the check proves the *build* is
    testable; this proves the *harness* is. A campaign that opens without its
    test accounts still freezes the build, still holds the merge queue for its
    full window, and still produces a verdict-shaped nothing — so refusing it
    silently would stack a silent refusal on the silent failure the check
    exists to catch. The wake is `preflight_failed`, throttled by
    `SMOKE_GATE_PREFLIGHT_ALERT_SECONDS` (default 6h) and **re-armed the moment
    the reason text changes** — three dead accounts becoming eight is news. A
    pass clears the latch, so the next outage alarms immediately.
  - Like the wake window, it is checked after the debounce and before any state
    is marked: the settled candidate survives, and the campaign opens on the
    first poll after the precondition is repaired.
  - Origin: on 2026-08-09 eight QA seats went stale out of band. Three
    campaigns ran unattended 03:00-06:00, every browser journey failed at the
    login screen, zero findings were verified, and the open count went 54 → 61.
    Nothing in the fleet could distinguish "the product is broken" from "the
    tester cannot log in".

When `SMOKE_GATE_HOLD_FILE` is set, `finish` additionally maintains an explicit
block flag for promotion gating:

| Verdict | Hold file | `reason` |
|---|---|---|
| `NO_GO` | raised | `confirmed defects on this develop lineage …` |
| `HUMAN_DECISION` | **raised** | `needs_human_decision` |
| `GO` | removed | — |
| `BLOCKED` | untouched | — |

`HUMAN_DECISION` raises the hold as of 2026-08-25; it used to leave it alone.
A verdict whose literal meaning is "the system does not know whether this is
safe" cannot default open — that made it behave as `GO` on precisely the cases
flagged as needing judgment. A stalled queue is the correct consequence of
requiring a decision, and `reason` tells the release desk "somebody has to
choose" apart from "we found bugs". `BLOCKED` is unchanged: an infra-blocked run
asserts nothing about the build, so it neither raises a false hold nor clears a
real one.

Downstream rule: flag present → automatic hold on promotion; flag absent → no
smoke objection. Absence semantics make rollout safe — history predating the
smoke watcher never gates anything.

### Re-verification and other scheduled tasks: unsettled or red is BLOCKED, never FAIL

A scheduled re-verification, certification, or evidence-recovery task reads
`smoke-develop-gate.sh check` the same way a human-requested campaign does
(above), but it is usually not opening a campaign at all — it is re-checking a
specific closed finding against whatever develop currently deploys. That task
still has to decide what to do when `check` reports `settled:false` or a red
CI check on the head it was told to test.

**An unsettled or red environment is not a product result.** It answers "is
this build ready to look at", not "does the fix work" — scoring it PASS or
FAIL either way manufactures a verdict about a build nobody actually tested. A
`FAIL` recorded here reopens a closed issue over CI timing, not a regression,
and the next retry that finds the SAME build green makes that reopen visibly
wrong after the fact.

The correct outcome is **BLOCKED, with the reason named**, reached by waiting
and re-checking rather than checking once and giving up:

```bash
bash /workspace/agent/smoke-develop-gate.sh wait-settled
```

This polls `check` on `SMOKE_GATE_WAIT_INTERVAL_SECONDS` (default 5 min) up to
`SMOKE_GATE_WAIT_MAX_SECONDS` (default 45 min total), read-only throughout —
no claim, no state write. It exits 0 with `settled:true` the moment the build
settles, so the task simply carries on into its normal read/verify steps using
the SHAs the settled response names. If the environment never settles inside
the window, it exits non-zero with `timedOut:true` and the underlying check's
own diagnostic (`failedChecks`, `pendingChecks`, `deployLagAccepted`, …) still
attached — finish the task **BLOCKED** with that reason, post it plainly, and
schedule a follow-up rather than silently absorbing the wait: a build that is
still red 45 minutes later is itself worth naming, not just retrying forever
unannounced. Never issue PASS, FAIL, VERIFIED, or NOT VERIFIED off a
`timedOut:true` response — those verbs are for a build this task actually
observed.

`wait-settled` never claims the slot, so it composes with everything above:
a human-requested campaign still calls plain `check` once and freezes
immediately on `settled:true` per the campaign-open flow; `wait-settled` is
for a task that would otherwise have to hand-roll its own poll-and-sleep loop
around `check` — which is what produced a 20-minute cron job and a bespoke
wait script for one run on 2026-09-11, reinventing exactly this.

### An undecided hold stops the next round (`SMOKE_GATE_DECISION_LEDGER`)

Holding promotion and continuing to test are two different questions, and until
2026-08-26 the gate only answered the first. Nothing on the campaign-open path
read the hold — it was written by `finish` and read only by the tamper
reconciler. So while a human sat on a `HUMAN_DECISION`, develop kept moving,
`SMOKE_GATE_FREEZE_MIN_INTERVAL_SECONDS` kept expiring, and a fresh campaign
opened to re-derive the same verdict about findings the new build never touched.
On 2026-08-24/25 that ran four times in 24 hours — four `HUMAN_DECISION`s, four
preview pairs, sixteen browser lanes — and each `finish` overwrote the hold,
which also destroyed the `runId` the pending question was keyed to.

Point `SMOKE_GATE_DECISION_LEDGER` at the release desk's append-only gate ledger
(a directory of `*.jsonl`) and the develop gate will not open a **new** round
while a hold is up and unanswered. **Unset = inert**, byte-for-byte today's
behavior.

- **A decision is the newest line whose `target` is `smoke_hold:<the hold's
  runId>` and whose `action` is `override`.** Newest-line-wins is not cosmetic:
  a desk `correction` after an `override` on the same target means the override
  did not stand, and matching any override anywhere in the file would read a
  retracted one as decided.
- **The hold is never touched.** No path here deletes, rewrites or expires it,
  and there is no interval after which promotion un-gates. Promotion clears only
  the two ways it always did: a later `GO` finish, or a human override the
  release desk honours.
- **Three outcomes, not two.** `decided` / `undecided` / `unknown`. An unset
  path, a missing directory and an unreadable file are all `unknown` — "the
  check did not say yes" is not "the check said no". `unknown` **fails open**:
  the campaign proceeds exactly as if this were not deployed. The hold still
  blocks promotion either way, so the safe direction here is to keep testing,
  not to stop.
- **The wait is loud.** While undecided, `develop_hold_undecided` wakes on
  `SMOKE_GATE_HOLD_ALERT_SECONDS` (default 21600, matching the cadence floor)
  carrying `holdRunId`, `holdSha`, `holdReason`, `raisedAt` and `pendingSeconds`.
  It re-arms on an interval rather than latching once, for the same reason the
  overrun alarm does: while this is the only thing surfacing the pending
  decision, a latch that can go permanently silent is not a safety mechanism.
- **Re-opening is automatic.** The decision itself is the trigger — the next
  poll after an `override` lands opens the campaign on whatever develop has
  settled on by then. Nobody has to remember to un-pause anything. A
  human-requested campaign (`smoke-freeze-pr.sh` called directly) is unaffected:
  that IS a human asking for a re-test.

This reads the ledger where the containers can see it. The release desk's
`releases/` tree must live in the workgroup shared mount
(`/workspace/workgroup/releases`), not in one sibling's private group folder —
see `docs/workgroups.md`.

On every terminal verdict, the coordinator closes the gate atomically:

```bash
bash /workspace/agent/smoke-develop-gate.sh finish \
  <40-character-sha> <run-id> <GO|NO_GO|HUMAN_DECISION|BLOCKED>
```

### Every alarm wake ends in a disposition

`finish` closes a campaign. An **alarm** wake — any `wakeAgent:true` trigger
that is not `develop_build_settled` — closes with `ack` instead, and closing it
is not optional:

```bash
bash /workspace/agent/smoke-develop-gate.sh ack \
  <trigger> <fingerprint> <resolved|acked|escalated> ['<one-line note>']
```

- `<trigger>` is `scriptOutput.trigger` verbatim.
- `<fingerprint>` is `scriptOutput.data.fingerprint` **verbatim** — never one you
  assemble yourself, and never the `reason`. Only the gate knows what separates
  one incident from the next for a given trigger: the freeze helper emits the
  same `reason` text for every branch collision on every SHA, and two of the
  three preflight failure messages are fixed strings, so a reason-shaped
  fingerprint silences unrelated later incidents. Every silenceable alarm — from
  either gate — carries this field. Triggers with no `fingerprint` are not
  silenceable; pass their most specific identifier (`holdRunId`, `runId`, the
  missing variable name) for the record.
- **`resolved`** — the condition is gone because of something you did. It never
  silences: if the gate still sees the condition the claim was wrong, and the
  alarm fires again.
- **`acked`** — you looked, you posted, nothing more is owed and nobody needs
  paging. Silences this trigger for this exact fingerprint until the TTL
  (`SMOKE_GATE_ACK_MAX_SILENCE_SECONDS`, default 24h; `preflight_failed` uses
  a shorter 12h window, because two of its three failure messages are fixed
  strings). A changed or worsened condition is a different fingerprint and
  alarms normally.
- **`escalated`** — a human now owns it; say who you mentioned in the note.

The response tells you what you actually got: `silencedUntil` is `null` when
nothing was muted, and `silenceable:false` marks the alarms that are muted by
nobody on purpose (`gate_misconfigured`, `gate_fetch_failed`,
`develop_run_overrun`, `develop_hold_undecided`) — each of those is the only
thing chasing a human or a broken deployment, so it keeps ringing.

Why this exists: on 2026-08-25/26 one stuck freeze produced three identical
`develop_freeze_failed` wakes exactly six hours apart. Each re-verified the
same facts and posted the same message; none of them could close the incident,
because there was no way to. Ending a wake with no disposition is the bug.

The scheduled-task registration is runtime state created through `ncl`, not an
in-tree core reach-in. Verify that integration with `ncl tasks get` plus one
live gated fire that completes with no provider output; never reproduce the
registration through raw SQL. Configure `quietStatus: true` plus a `chatLimit`
sized to the run's real posting contract — the root, one reply per browser lane
whose evidence became durable, the verdict, and the fix hand-off. `chatLimit: 1`
contradicts that contract and physically drops the verdict; around 8 fits it.

Know what the cap does and does not reach before relying on it. It is a hard
send cap enforced at the write layer, so no instruction drift gets past it —
but it is **per turn, and it binds task sessions only**
(`applyChatBudget`, agent-runner `poll-loop.ts`). A campaign spans several
turns via `wait`, continuation and ceiling respawn, and each turn gets a fresh
budget; the challenger posts from interactive sessions woken by mention, which
the budget never sees at all. So this caps streaming narration, not the total
volume of a run — the coordinator/challenger exchange has to be bounded by the
posting contract itself.

**The posting contract itself:** every post to the run thread must carry
information nobody in the thread already has — new evidence becoming durable,
a lane completing, a verdict, or a decision the reader must act on. Acks,
restating a contract or plan just written, announcing what you are about to do
before doing it, and progress narration ("lane B1 is still running, barrier is
short three markers") are defects, not diligence — whether posted by the
coordinator, the challenger, or a worker relaying through either. The
legitimate posts for one run are exactly the ones already named above: the
root post, one reply per browser lane whose evidence became durable, the
verdict, and the fix hand-off. Nothing else earns a message; put it in the
final report instead, or not at all. This is checkable after the fact without
reading intent: count the thread's posts and subtract one for the root, one
per browser lane, one for the verdict, and one per fix hand-off — anything
left over is narration that should not have posted.

Run a changed-surface `audit` for each settled develop SHA. Any user-visible
change must include a real-browser frontend lane even when the diff looks
backend-only. Changed surface decides what a campaign runs *extra*; the
coverage floor (§2) runs in every standard or full campaign regardless of the
diff, including this one — a light campaign walks only whatever is already
past its `maxIntervalDays` (§2), usually nothing. Run `full` for a
release candidate, a manually named feature, a high-risk label, or a scheduled
nightly/weekly sweep. This preserves continuous coverage without paying for idle
turns or rerunning an unchanged build.

The QA channel owns execution and evidence. The coordinator creates one root
thread per SHA; all workers and the challenger report into that thread. The
release channel remains the ship authority: send it the final verdict, PRs,
deployed SHA, and remaining decision. Never let the smoke task auto-merge or
promote production.

### PR-scoped campaigns (Render preview environments)

`scripts/smoke-pr-gate.sh` is the develop gate's sibling for a labeled PR's
own Render preview instead of the shared develop environment. Because a PR
preview is immutable-by-construction from everyone except the PR author, the
develop gate's environment-serialization machinery does not exist here: no
wake window, no merge hold, no `qa/freeze` status, no develop-hold file. State
is split per PR (one state file, one `flock`, keyed by PR number) so unrelated
PRs never contend, and `poll` may find several PRs settled at once but emits
at most **one** wake per call — the coordinator that consumes it is serial.
Same conventions as the develop gate otherwise: env-only config, jq-composed
state, fail-closed on every fetch, one-line JSON stdout.

#### Campaign size

`check`/`poll` also emit `campaignSize` (`full` / `standard` / `light`) and
`sizeReason`, computed mechanically off the changed-file list against an
install-supplied rules file (`SMOKE_SIZING_RULES`, default
`/workspace/agent/campaign-sizing.json`) — never agent judgment; classification
fails closed to `full` on an unreadable or truncated file list, and a freeze
PR sizes off its `campaignRange` (below), never its own two-marker diff.
No rules file means `standard`, `sizeReason: "no sizing rules"` — unchanged
behavior for installs that never added one. A rules file that IS present but
unreadable (a dangling symlink included — the path exists, its target does
not), not valid JSON, not a JSON object, or wrongly shaped is a different
case and is never read as "no sizing rules": the classifier exits non-zero,
and the gate's own fail-closed guard turns that into `campaignSize: full`.
Wrongly shaped means `full`, `lightAllowed` or `lightDeny` present as
anything but a list of strings (a bare string `"backend/**"` would otherwise
read as one glob per character, matching nothing), `fullGlobsFrom` present as
anything but an object, or any of the four written out as an explicit `null`.
The install's own campaign prompt decides what each size actually runs; this
gate only classifies, never picks lanes.
A rules file's `full` list can also read a named constant out of the install's
own release-policy file via `fullGlobsFrom: {"path": ..., "name": ...}`,
unioned with any local `full` globs — so smoke never keeps a second, driftable
copy of that list. It reads the constant with `ast`/`literal_eval` rather than
importing the file, so the file is never executed; any problem (unreadable or
unparseable file, the name missing at top level, the name bound or mutated by
any other top-level statement (`+=`, `.extend`/`.append`, `del`, a second
assignment, an alias `X = NAME`, `from x import NAME`, `import x as NAME`, a
star import, `def`/`class NAME`, `except … as NAME`, a `match` capture), the
constant handed to a call that could mutate it in place (`_widen(NAME)`,
`list.append(NAME, …)` — anything but `len`/`sorted`/`tuple`/`list`/`set`/
`any`/`all`/`"…".join`, and not even those when the policy file binds that
name itself at module level, since `def len(globs)`, `class len`,
`from x import len` or `len = _widen` make the call something other than the
builtin), a top-level statement that reaches the namespace by
string (`globals`, `vars`, `setattr`, `exec`, `eval`, `__import__`,
`sys.modules`) or that calls a function whose body does, a computed rather
than literal value, or a mistyped value) fails closed to `full`. A plain READ
of the constant elsewhere in that file — `ALL = NAME + OTHER`, `len(NAME)` —
is not a problem and does not change the size: the one constant plus the
lines derived from it is what a real policy file looks like.

Commands: `poll` (default), `check <pr>` (read-only, mirrors the develop
gate's `check`), `wait-settled <pr> --head <sha> [--interval-seconds N]
[--max-seconds N]` (read-only pinned-preview waiter), `claim <run-id> <pr> <sha> [owner-token]`,
`progress <run-id> [owner-token]`, `release <run-id> [owner-token]`,
`finish <sha> <run-id> <verdict> [owner-token]`. `progress`/`release`/
`finish` take no PR argument — the gate recovers it by locating whichever
PR's state currently holds that run id. That resolution is only unambiguous
if run ids are unique across the whole gate, not just within one PR, so
`claim` enforces it: it refuses a run id retained by a task-scoped run, and
`task-claim` refuses one any active PR or develop campaign holds. The task/PR
checks use the shared ownership namespace and its per-run lock, rather than
depending on one container's private state directory, so a caller-chosen id
(from `claim`) is always safe to pass
to `progress`/`release`/`finish` exactly like a gate-generated one.
On upgrade, a surviving old task lease is enough SHA-bearing evidence to
establish the retained binding before any PR/develop claim is considered;
malformed or contradictory shared records refuse rather than being treated as
absence. A historical released run that left no SHA-bearing artifact cannot be
reconstructed and is not assigned invented identity.

`wait-settled` is for a scheduled re-verification or visual canary that needs
one particular preview to become ready without hand-rolling a sleep loop. It
reuses `check`, never claims a lease or writes PR state, and preserves that
check's `campaignSize`, `sizeReason`, source SHA, and CI SHA. `--head` is
required: a changed PR head exits immediately as `terminal:"head_moved"`, and
a closed, merged, wrong-base, or unlabelled PR exits as
`terminal:"ineligible"`; neither turns into a misleading timeout. A settled
result includes `checkIdentity` with the requested, observed, and CI SHA.
Temporary fetch failures and a preview that remains pending exit non-zero with
`timedOut:true,incomplete:true` and the underlying diagnostic intact, so the
caller reports **BLOCKED**, never PASS or FAIL. The limits are command options
with defaults of 300 and 2700 seconds; invalid values reject this waiter only
and cannot change the scheduled `poll` or ordinary `check` behavior.

`poll` claims the shared coordinator lease before it emits
`pr_build_settled`. Its payload includes `coordinatorOwnerToken`; treat that
opaque value as part of the run identity. Pass it explicitly to every gate
verb above and export it as `SMOKE_GATE_OWNER` for every
`smoke-run-scaffold.sh` contract, marker, and redispatch writer. Native lane
workers and the separate synthesis session receive the same token in their
briefs. A caller must never copy `.activeLeaseOwner` from mutable PR state:
after a reclaim that field names the successor, and adopting it would let a
stale process impersonate the new owner.

The shared lease lives under `/workspace/workgroup/qa-coordinator/leases`,
separate from each container's private `SMOKE_GATE_STATE_DIR`. Missing,
unmounted, aliased-to-private, malformed, unwritable, or un-lockable lease
storage fails closed. Task identities and exact terminal facts remain there in
retained `task-binding-<run-id>.json` records even when a private gate state or
verdict is invisible to another container. `claim`, `progress`, `release`,
`challenger-timeout`, and `finish` validate the caller token under shared
locks. `finish` holds those locks across preview suspension, run/PR verdict
receipts, promotion hold, publish record, ledger append, lease removal, and the
terminal state commit; an expired predecessor therefore cannot publish after
a successor reclaims.
One shared per-PR binding points to the current run and owner while the run
lease remains the only TTL authority. The lease also binds that run id to its
PR, so the same owner token cannot reuse one live run id on a different PR.
This prevents two private state roots
from opening different live run IDs for the same PR; only an explicitly
authorized `--takeover` may replace a live different-run binding.

The default lease lasts 15 minutes. While a coordinator is actively running,
call `progress <run-id> <owner-token>` at least every 10 minutes; a successful
progress atomically renews only that live owner's lease. Do not wake an LLM
only to heartbeat. When work yields to lanes or a later synthesis session and
the lease expires, resume with the existing run id and token:

```bash
bash /workspace/agent/smoke-pr-gate.sh claim \
  <run-id> <pr> <claimed-sha> <coordinator-owner-token>
```

That same-run claim safely reacquires an expired lease without a human. A
different token may reclaim only after expiry; it must then regenerate the
completion contract before writing markers. `lease-renew` and `lease-release`
never revive or remove an expired lease. Explicit operator `--takeover`
restrictions remain the only way to replace a still-active different run.
The low-level compatibility verb is `lease-claim <run-id> <owner-token> <pr>`
for a new lease. A same-owner renewal of an existing valid lease may omit the
PR; it is inferred from the immutable lease binding and never changed.

`claim` also refuses a *new* run id on a PR whose current run is still
stamping `progress` — same PR and same frozen SHA included, which is precisely
how a rival campaign once displaced a live coordinator. Only a human passing
the explicit `--takeover` flag can override that, at any age; the success line
then carries `tookOverFrom`. `poll` never takes over.

A PR settles when: it is open and carries `SMOKE_GATE_LABEL` (default
`render-preview`); its backend preview exists, is `live`, and its deploy
commit equals the PR head SHA; the frontend preview additionally matches when
the diff touches `XZO-FRONTEND/`; CI is green on the head — **except** a
freeze PR (see below), where CI is checked on the head's *parent* commit,
since freeze commits get no path-filtered CI of their own; and the backend's
`/healthz` returns 200 (a fresh preview can read `{"status":"warming"}` for
~6-10 minutes after `live` — the gate never sleeps waiting this out, it just
reports not-settled and lets the next poll catch it). Any labeled **ordinary**
PR whose own diff touches `XZO-BACKEND/migrations/` is refused outright (one
throttled `pr_migrations_refused` alarm, never a settle). A **freeze PR is
never refused on migrations**: its target is already on the tracked branch, so
a migration in its range is campaign scope, reported in `migrationsInRange`,
not a readiness fact — target identity, CI, deploy identity, frontend readiness
and `/healthz` still gate it, and a backend that cannot boot is caught there.
`finish` records a per-PR
verdict JSON under the state dir, then suspends the backend preview
(`POST .../suspend`) so a finished PR stops billing compute while it waits on
merge/close; a failed suspend is logged in the JSON, never fails the finish.
Teardown itself is Render's job (auto-delete on PR close) — this gate and
`smoke-freeze-pr.sh` never delete services.

**`finish` takes the SHA the run CLAIMED, and refuses anything else.** For a
freeze PR that is the *marker* SHA (the PR head), never the target develop SHA
the marker froze — the gate derives the target itself by walking the marker's
first parent. Passing the target walks one commit too far, and the hold,
publish file and ledger line then all name a build the campaign never
examined. A mismatch is refused before any side effect, with `claimedSha` in
the response and the slot left held, so re-running `finish` with that SHA
completes normally. There is no legitimate case for a difference: a PR head
that moved mid-campaign does not change which build was tested. Origin:
2026-08-25, freeze PR #1211 — the wrong argument raised a promotion hold
naming PR #1199's commit and exited `ok:true`.

**Freeze PRs** turn the same mechanism into an on-demand frozen environment
for an arbitrary develop SHA — useful when a campaign needs a still target
without waiting on (or being voided by) develop's own merge volume.
`scripts/smoke-freeze-pr.sh <target-sha>` brands a branch at that SHA with one
marker commit (`.render-freeze`, containing the target SHA, under both
service rootDirs — a real diff, since an empty commit triggers no preview),
opens it as a draft PR against `SMOKE_GATE_BRANCH` with the preview label, and
prints `{prNumber, branch, freezeSha, targetSha}`. `smoke-pr-gate.sh` polls it
like any other labeled PR; close the PR when the campaign is done.

#### Freeze campaign range (`campaignRange`)

A freeze target sits on the tracked branch, so "branch...target" is always
empty. The range a freeze campaign covers is **last certified build ...
target**, and the gate states it once, in the facts (`check`) and the
`pr_build_settled` wake, for freeze PRs only:

- `campaignRange{baselineSha,targetSha,determinable,reason}` — `baselineSha` is
  the `targetSha` of the newest handoff-ledger `GO` whose receipt validates
  (digest matches its run `verdict.json`, and the freeze commit / freeze PR
  really bind to that target). `BLOCKED`, `NO_GO` and `HUMAN_DECISION` never
  move it. It is pinned per freeze head SHA, so every poll and recovery wake
  of one campaign reports the same range. `baselineRunId`, `baselineResolved`
  and `baselinePinned` say where it came from.
- `migrationsInRange` — the migration files in that range, or **`null`** (never
  `[]`) when the range is unknown.

`determinable:false` (no validated GO, target behind/diverged from the
baseline, a malformed or ≥300-file comparison, a failed fetch) means the range
is **unknown**: `campaignSize` is `full` and `reason` says why. It does not
block the campaign. **Quote this range** — for the manifest and any range shown
to a human — never one re-derived by hand. Journey selection (§2) already
consumes it and nothing else; an unknown range selects `full`, never nothing.

#### Freeze intake: read the bound preview's deploy log first

Before spending a freeze campaign, the owner reads the deploy log of the
**exact preview deploy the gate bound** (`backendPreviewId` / `backendDeploySha`):

- a `PREVIEW-STALE` line with a pending-migration list ⇒ every claim that
  depends on those migrations is classified `not demonstrable` **up front** and
  carried as an explicit coverage gap through to the verdict;
- the "pending set could not be determined" variant, or no marker at all ⇒ the
  schema state is **unknown** — say so; absence is not proof of compatibility;
- `[migrate] up →` on a preview ⇒ **stop and escalate** as "migration execution
  attempted against shared dev". It is logged before execution, so it is not
  proof anything was mutated.

Config: `SMOKE_GATE_REPO`, `SMOKE_GATE_BRANCH` (default `develop`),
`SMOKE_GATE_BACKEND_SERVICE` / `SMOKE_GATE_FRONTEND_SERVICE` (the **base**
Render service ids — previews are discovered per PR by matching
`serviceDetails.parentServer.id` plus a `PR #<n>` name suffix, never
hardcoded preview ids), `SMOKE_GATE_LABEL`, `SMOKE_GATE_STATE_DIR`,
`SMOKE_GATE_RUN_PREFIX`, `SMOKE_GATE_PREFLIGHT_CMD` / `_TIMEOUT` (same
seam and semantics as the develop gate — one readiness command run once per
poll, immediately before a settled candidate is actually claimed), and
`SMOKE_GATE_WARMUP_TIMEOUT` (default 600s — a backend stuck past this long
without a healthy `/healthz` after going `live` raises one throttled
`pr_warmup_stuck` alarm instead of polling silently forever — but never for a
SHA this gate's own `finish` already completed and suspended: `finish`
suspending its preview by design produces the identical
backendReady-true/healthzReady-false shape, and is checked first).

**Preview identity is never a positional pick.** Render has provisioned two
services sharing one display name under the same parent more than once (a
`renderer` retry, a stale service left behind) — `check`/`poll` facts carry
`backendCandidates` / `frontendCandidates` (every match, not just the first),
`backendSelectionMethod` / `frontendSelectionMethod` (`none` / `single` /
`bundle-disambiguated` / `ambiguous`), and `previewAmbiguous` /
`previewAmbiguityReason`. On exactly one match, selection is unchanged. On
2+ backend candidates, the gate fetches the served frontend HTML, extracts
the hashed JS bundle path (`SMOKE_GATE_BUNDLE_PATTERN`, same technique and
knob-naming as `smoke-build-identity.sh`'s `SMOKE_BUILD_ID_BUNDLE_PATTERN` —
this one's default already accepts the `-` that base64url content hashes
legitimately contain, e.g. `index-Cg8w-v89.js`; `SMOKE_BUILD_ID_BUNDLE_PATTERN`
still lacks it, tracked separately as #1366), fetches the bundle, and prefers
whichever candidate's host the
bundle actually references — but ONLY when that resolves to exactly one
candidate. Any other outcome (no frontend URL to check against, the fetch
failing, the bundle naming zero or 2+ candidates) is a REFUSAL: no id/url is
selected, `fetchOk` goes false so the stall alarms as `pr_facts_unavailable`
rather than retrying forever in silence, and `previewAmbiguityReason` names
every colliding service. There is no oracle for a frontend-side duplicate —
2+ frontend candidates is always a refusal: no frontend id/url is selected and
`previewAmbiguous`/`previewAmbiguityReason` record it on every PR, but only a
PR that requires the frontend is held by it (`fetchOk:false`); a backend-only
PR still settles on its backend. The exact same resolution runs at
the mutating `finish`/suspend call site, so a wrong-twin pick can never POST
`.../suspend` against a service nobody chose; on ambiguity there, `finish`
attempts no suspend, records the reason in the verdict receipt, and still
completes rather than stranding the run. `SMOKE_GATE_IDENTITY_TIMEOUT`
(default 10s) bounds each disambiguation fetch.

A `frontendEvidenceGap: true` fact marks a null `frontendPreviewUrl` as a
gap in the evidence available for browser-lane build-identity attestation
(`smoke-build-identity.sh` needs that URL), not a silent "not applicable" —
the frontend preview is now looked up on every PR regardless of whether its
diff touched `XZO-FRONTEND/`, since the disambiguation oracle above needs it
even on a backend-only PR.

Full design and the live Render verification behind every rule above:
`groups/_ops/specs/fleet-hardening/phase5-preview-envs.md`.

### Develop-gate freeze handoff

`smoke-develop-gate.sh` can hand its campaigns to this PR-scoped machinery
instead of opening them against the shared dev environment — the actual fix
for the original mid-run-merge problem, since a frozen preview is nobody
else's to move. Opt in with `SMOKE_GATE_FREEZE_HANDOFF=true` (default unset =
unchanged behavior, byte-for-byte) plus `SMOKE_GATE_FREEZE_HELPER` (path to
`smoke-freeze-pr.sh`; required and fail-closed once handoff is on). At the
exact point `poll` would otherwise emit `develop_build_settled`, handoff mode
instead cuts a freeze PR for the settled SHA, records the handoff, and emits
`wakeAgent:false` / `develop_freeze_opened` — zero agent tokens on the trigger
step. A settled SHA while a handoff is open queues like any other
`queued_behind_active_run` (one freeze at a time); a freeze PR closed with no
verdict ever recorded wakes `develop_freeze_abandoned` once and frees the
slot; a failing helper wakes `develop_freeze_failed`, throttled like a
failing preflight command. In handoff mode the develop gate also refuses `claim`: chat-requested campaigns cut a freeze PR (`smoke-freeze-pr.sh`) and claim on the PR gate — shared dev is never a campaign environment.

The other half lives in `smoke-pr-gate.sh`'s `finish`: `SMOKE_GATE_PUBLISH_FILE`
/ `SMOKE_GATE_HOLD_FILE` / `SMOKE_GATE_HANDOFF_LEDGER` (all no-ops unless set,
and only ever act on a freeze PR) make a freeze-PR finish write the develop
gate's exact publish/hold artifacts, keyed to the *target* develop SHA, and
append the outcome to a ledger the develop gate reads before its own
hold-integrity check runs each poll — the mechanism that keeps a legitimate
freeze-run hold from ever reading as `gate_hold_tampered`. **All three
PR-gate vars and develop-gate handoff mode must be set together in the same
deployment's wrappers** — any one missing silently breaks the tamper-shield,
not just the publish/hold write.

The hold and the ledger live on different mounts (the hold on the shared
workgroup mount the release desk reads, the ledger in the gate's own state
dir), so they can go out of step. Two rules cover that:

- **`handoff.written` reflects every artifact, not just the ledger.** Each
  publish/hold write is verified after the fact; a write that did not land
  reports `written:false` with a reason naming the file — including the
  fail-open case, a `NO_GO`/`HUMAN_DECISION` whose hold never went up. It used
  to report `written:true` and `reason:null` regardless.
- **A divergence is captured before it is overwritten.** On a freeze-PR
  `finish`, the gate compares the standing hold against the newest
  hold-affecting ledger line (`BLOCKED` lines are not hold-affecting — they
  deliberately leave the hold alone) and, on disagreement, writes both sides
  to `<state-dir>/hold-divergence-<ts>-pr<n>.json` before touching anything.
  The path comes back as `handoff.divergenceSnapshot`. Detection already
  existed — the develop gate's `gate_hold_tampered` — but the next `finish`
  destroyed the evidence, which is why the 2026-08-18, -22 and -25
  occurrences are all un-diagnosable. Nothing prunes these files.

A crash between the two writes still diverges: bash cannot make a write across
two files on two mounts atomic. The ordering is the mitigation — the hold is
raised *before* the ledger line lands, so a crash over-holds (safe) rather
than leaving a recorded `NO_GO` with promotion open.

## Evidence retention

Run evidence is never pruned automatically by anything in this skill. Nothing
here schedules `scripts/smoke-evidence-retention.sh` — deploy it as a periodic
task (e.g. weekly `ncl tasks`) if the run root is expected to grow unbounded,
which it otherwise will: screenshots and clips accumulate per lane per run
with nothing to bound them.

The script prunes media (screenshots, clips, other binaries — by extension)
older than `SMOKE_RETENTION_MEDIA_DAYS` (default 14). The markdown/JSON record
(`run-record.md`, lane files, markers, manifests, dispositions, verdicts) is
the audit trail and survives independently — forever unless
`SMOKE_RETENTION_RECORD_DAYS` is explicitly set to also remove the whole run
directory past that age. It never touches a run that is currently active (per
the gate's own state), or one named by the current published verdict, the
current promotion hold, or a recent handoff-ledger entry — see the script's
header comment for the exact protection rule.

**It is dry-run by default.** Run it without `--delete` first and read the
JSON report — `runsPruned`, `mediaBytes`, `oldestAffectedRun`/
`newestAffectedRun`, and the `affected` array name exactly what a real run
would remove. Only pass `--delete` once that looks right.

```bash
bash /app/skills/smoke-test/scripts/smoke-evidence-retention.sh <run-root>            # dry run
bash /app/skills/smoke-test/scripts/smoke-evidence-retention.sh <run-root> --delete   # actually prune
```

Evidence that matters past the media window — a confirmed finding a fix PR
still references, a disputed verdict — belongs in long-term storage outside
this run root, not in an extended local retention window. That archival path
is not implemented by this script; it is a separate, later decision.

## Cost controls

- One retained frontier owner per QA side, Fable/Astra at medium by default.
  Sonnet/Terra outer coordinators stay on logistics and gated publication.
  Preserve every required coverage lane and the independent cross-family pair.
- Resume the same owner for corrections; use a documented remaining-work
  handoff only when the session boundary prevents valid resume.
- Use one fresh `qa-adjudicator` only on the dispute conditions above. No cheap
  worker tier, parent-effort ladder, or automatic model escalation.
- Spawn fixers only for confirmed findings and give each a non-overlapping seam.
- Use changed-surface runs per SHA; reserve full sweeps for release gates or a
  bounded schedule.
- Cache immutable specifications and dependency setup, but never cache verdicts
  across SHAs.
- Cap retries, agent-to-agent debate, screenshots, and browser waits. After two
  failed cross-checks, escalate or mark blocked instead of looping.
