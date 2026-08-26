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
   state file's current `activeRunId`. A reclaim or a `--takeover` flips that
   field and nothing else, so without this check a displaced coordinator keeps
   writing markers into the run tree its successor is now using. Both variables
   must therefore be in every dispatched worker's environment.

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

The coordinator then runs `scripts/smoke-evidence-barrier.sh <run-dir> lanes`
and writes `coordinator/preliminary.md`. The challenger writes
`challenger/disposition.md` first. Neither parent reads the other file before
its own conclusion is durable.

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

**The floor list is deployment configuration, like every other concrete
identity in this skill.** It lives in the deploying group's standing
instructions beside the repo, environment, QA channel, run root, and credential
locations — never here, because the journeys that matter belong to the
deployment, not to the skill. What lives here is the contract the list must
satisfy. Each floor entry declares six things:

| Field | What it must say |
|---|---|
| `id` | a stable lane id, unchanged for the life of the journey — staleness is computed on this key, so renaming it silently resets the clock |
| `journey` | the ordered steps at a named grain, ending in an observable end state; written once here, never re-derived per campaign |
| `proves` | the one claim the walk proves, phrased as "if this were broken, <which consequence below>" |
| `seed` | the account, seat, tier, fixture, or data row the walk needs, and where it comes from |
| `max_interval` | the longest this deployment tolerates going without this journey proven on a deployed build |
| `restore` | how the walk's mutations are reverted, since it runs repeatedly against live-shaped data |

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
it. Adding to the floor is a standing-instruction edit and therefore a human's
call: a coordinator that can extend its own floor can also quietly shrink it.

**Cadence: every campaign walks at least one floor entry, least-recently-passed
first.** The flat option — walk the whole floor every campaign — was rejected on
two grounds. At about three campaigns a day a five-entry floor becomes fifteen
full browser journeys a day, which is exactly the re-derivation cost the skip
rule below was written to remove; and a walk repeated ninety times a month
without ever failing stops being walked carefully. A pure staleness budget with
no per-campaign obligation was rejected too: it leaves the mechanism cold for
days, and a mechanism nobody exercises is one nobody notices has broken. So,
both, bounded:

- **Every campaign declares at least one lane of kind `floor` in the contract,
  one lane per entry it walks, with the entry's `id` as the lane id. Never
  zero** — not on a backend-only diff, not on a one-line change, not on a
  campaign that found nothing.
- **Which entries are due is computed, not chosen.** Every entry past its
  `max_interval` is due, all of them, however many that is — the ceiling is the
  deployment's own stated tolerance and nothing overrides it. If none are
  overdue, the single least-recently-passed entry is due. A coordinator does not
  get to pick the convenient one.
- **"Last passed" is read off the run root, not off a ledger.** An entry's last
  exercise is the newest `pass` marker carrying its lane id, anywhere under the
  run root. Markers are already durable, already SHA-bound, and already survive
  media retention, so this needs no new artifact and cannot be asserted without
  leaving one:

  ```bash
  jq -r 'select(.status == "pass") | "\(.completedAt) \(input_filename)"' \
    <run-root>/*/markers/<entry-id>.json 2>/dev/null | sort | tail -1
  ```

At one entry per campaign a five-entry floor comes fully around every day or
two. Against a measured once in seventy-four runs, that closes the whole gap.

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
- **A blocked entry that is also past its `max_interval` is `HUMAN_DECISION`,
  not a gap.** Nobody has proven that journey works in longer than the
  deployment said it would tolerate, and this run cannot either — on a surface
  that by construction moves money, destroys data, crosses an authorization
  boundary, or is a customer's first impression. That is the "nobody knows
  whether this is safe" case §8 reserves `HUMAN_DECISION` for, and it holds
  promotion until a human answers.

**Checkable after the fact**, from a finished run's artifacts alone:

- **The contract carries at least one lane of kind `floor`.** A contract with
  none is a campaign that ran with no floor at all, visible in one `jq` before
  any evidence is read.
- **Every floor lane has a terminal marker.** The synthesis barrier enforced
  that to publish, so a published run structurally has one; a missing or `void`
  marker beside a published verdict means the barrier was bypassed.
- **Each entry walked carries its own screenshot evidence on the frozen SHA**,
  named in the marker's evidence list — the same bar as any other browser lane.
- **Selection is recomputable.** Re-run the least-recently-passed query above as
  of that run's timestamp. A run that walked a freshly-passed entry while
  another sat past its ceiling shows up as a mismatch between what was due and
  what the contract declared.
- **The cross-run sweep is the one that matters.** For every declared entry,
  find its newest passing floor marker anywhere under the run root. Any entry
  whose newest is older than its `max_interval`, or that has none at all, is a
  live coverage breach no matter how many green runs sit on top of it. That
  single sweep is what surfaces a money-adjacent flow tested once in
  seventy-four campaigns in the week it goes stale, rather than a year later.
- **Post count is unchanged.** A floor lane is a browser lane, so the posting
  contract's "one reply per browser lane whose evidence became durable" already
  accounts for it. The floor earns no extra messages.

**A deployment that has declared no floor still says so out loud.** Standing
instructions with no floor list mean the coordinator cannot compute a due entry;
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

Use different model families for diversity. The coordinator assigns bounded
coverage slices to native Sonnet workers — one lane for the diff-derived
manifest (backend and specification verifier), one for stated intent
(acceptance verifier). The challenger assigns independent replays and attacks
to native Luna workers (UI adversary). More workers usually add coordination
cost before they add signal, so every assignment must name non-overlapping
manifest IDs.

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

The coordinator normally assigns this lane to a native Claude Sonnet 5 worker
at xhigh effort, the same tier as the backend lane. Declare it in the contract
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
used to notice. Before recording `claim absent`, check whether the diff touched
user-facing surface (the frontend path prefixes this deployment already
configures for deploy-lag scoping are the same prefixes that matter here, plus
any template, copy, or served-payload change). If it did:

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
- **Every `claim absent` result on a diff that touched user-facing paths
  carries the `(unstated user-facing change: …)` note and a matching widening
  of the UI adversary's manifest scope.** A bare `claim absent` next to a diff
  full of frontend paths is the failure this cross-check exists to surface.
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

All three lanes may share specifications, never conclusions. Each writes its
own evidence before seeing another lane's verdict. The challenger must also
sample checks that passed — including acceptance claims marked `met` — not
only reported failures; otherwise it cannot challenge false clears.

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
| `HUMAN_DECISION` | Needs a human call — **holds promotion until answered** |
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
- Floor: <entries walked and their outcome; each blocked entry with its
  blocker; or "floor undeclared">
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
  assemble yourself. Only the gate knows what separates one incident from the
  next for a given trigger: the freeze helper, for instance, emits the same
  `reason` text for every branch collision on every SHA, so the reason alone
  would silence unrelated future collisions. Triggers with no `fingerprint`
  field are not silenceable; pass their most specific identifier
  (`holdRunId`, `runId`, the missing variable name) for the record.
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
coverage floor (§2) runs in every campaign regardless of the diff, including
this one. Run `full` for a
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

Commands: `poll` (default), `check <pr>` (read-only, mirrors the develop
gate's `check`), `claim <run-id> <pr> <sha>`, `progress <run-id>`,
`release <run-id>`, `finish <sha> <run-id> <verdict>`. `progress`/`release`/
`finish` take no PR argument — the gate recovers it by locating whichever
PR's state currently holds that run id. That resolution is only unambiguous
if run ids are unique across the whole gate, not just within one PR, so
`claim` enforces it: it refuses a run id that is already active on a
*different* PR, so a caller-chosen id (from `claim`) is always safe to pass
to `progress`/`release`/`finish` exactly like a gate-generated one.

`claim` also refuses a *new* run id on a PR whose current run is still
stamping `progress` — same PR and same frozen SHA included, which is precisely
how a rival campaign once displaced a live coordinator. Only a human passing
`--takeover`, and only once the active run is past
`SMOKE_GATE_ACTIVE_STALE_SECONDS`, can override that; the success line then
carries `tookOverFrom`. `poll` never takes over.

A PR settles when: it is open and carries `SMOKE_GATE_LABEL` (default
`render-preview`); its backend preview exists, is `live`, and its deploy
commit equals the PR head SHA; the frontend preview additionally matches when
the diff touches `XZO-FRONTEND/`; CI is green on the head — **except** a
freeze PR (see below), where CI is checked on the head's *parent* commit,
since freeze commits get no path-filtered CI of their own; and the backend's
`/healthz` returns 200 (a fresh preview can read `{"status":"warming"}` for
~6-10 minutes after `live` — the gate never sleeps waiting this out, it just
reports not-settled and lets the next poll catch it). Any labeled PR whose
diff touches `XZO-BACKEND/migrations/` is refused outright (one throttled
`pr_migrations_refused` alarm, never a settle) — a preview boot runs
migrations against the **shared** dev Postgres. `finish` records a per-PR
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
`pr_warmup_stuck` alarm instead of polling silently forever).

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
