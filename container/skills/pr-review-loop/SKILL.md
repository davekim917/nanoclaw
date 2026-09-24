---
name: pr-review-loop
description: Drive a PR to merge through Codex's automated review in batched rounds — collect every open comment, accept or reject each with evidence, fix them in one commit, reply and resolve every thread, then let the reviewer decide whether another round is warranted. Use this whenever a PR has Codex review comments to work through, right after opening a PR that Codex will auto-review, and any time the user says "address the codex comments", "work the review", "resolve the PR comments", or "get this PR merged". Use it especially when a PR is on its third round of review and isn't converging.
---

# PR review loop

Codex (`chatgpt-codex-connector[bot]`) reviews a PR when it opens, and afterwards decides for itself whether a new head commit warrants another look. Worked one comment at a time, that is an unbounded loop: patch → new review → patch → new review. Worked in rounds, it converges in two or three.

**The whole skill is one rule: a round is a batch.** Collect every unresolved comment, decide on all of them, fix all the accepted ones in one commit, push once. Never push a commit for a single comment.

**Then stop, and do not ask for a re-review.** The reviewer decides whether your commit warrants another look; a bounded observation supplies the result or routes an unavailable reviewer under [Review availability](../../../docs/review-policy.md#review-availability) (in a container: `/workspace/project/docs/review-policy.md#review-availability`). A `@codex review` comment overrides that judgment and manufactures a round nobody wanted. On 2026-08-09 one deployment drove a 213-line PR to four requested rounds in two and a half hours, then blocked its own merge on the count; four PRs sat frozen with CI green, one with every thread already resolved. If a repo genuinely has no automatic reviewer, that is a deployment fact its instructions should state — it is not a reason to start pinging.

**Risk-scoped repos are the exception** — see [Risk-scoped repos](#risk-scoped-repos). Automatic review is off there, and `codex-review.sh request` is the only way a round starts; `codex-review.sh scope` tells you which kind of repo you are in.

## When to enter, and at what round

**Entering is not optional and not only for assigned work.** A review landing on
your own PR is a signal, not an assignment — it puts you in this skill too. The
mandatory first action either way is to query the API for the review count.
Never trust the ping, the assignment text, or your memory of how many rounds
have happened. Round N = that count. If someone hands you review work and names
a round, the count still wins.

## Reading the rounds you actually get

A round is one full batch, and only batched rounds count. Ten pushes of one comment each are not ten rounds of evidence — they're one round stretched over ten pushes, which is the most common way this loop runs away.

Rounds are something you RECEIVE, not something you spend. Track how many have
arrived and say it out loud in each status message — the count is evidence about
the change, not a budget.

- **Rounds 1–2** — normal. Batch, fix, push, wait.
- **Round 3** — before pushing, reread the entire diff yourself and run the full
  suite. Land your own findings in the same batch.
- **Third arriving review and still not converging** — first ask whether the
  findings actually block anything (below). A trend of non-blocking findings is
  not an escalation; it is a queue of things to record so the PR can move.
  If the trend IS in the blocking class — same subsystem, same invariant,
  severity flat or rising — stop and diagnose out loud before touching code.
  Post your read to the PR thread and mention the PR owner and whoever owns
  release calls in this deployment, then act on that diagnosis. What you must
  not do is push another patch because a patch is what you pushed last time —
  "address the Nth review" as a commit message is the anti-pattern this skill
  exists to stop, and it is how #299 reached round 18.

### Correct is not the test — blocking is

**Most findings should not stop a merge, including real ones.** The full
severity contract — what blocks, what gets recorded-and-merged, the PR-body
contradiction exception, and the do-not-report list — is
`docs/review-policy.md` (inside a container: `/workspace/project/docs/review-policy.md`).
That file governs; read it before classifying, and state the classification
in one line in the thread — an unnamed call cannot be overruled, and a human
overruling you is the point.

There is no round number that forbids a push. There used to be, and it froze
four PRs with CI green — one with every thread already resolved — because the
rounds being counted were ones the fleet had asked for. Now that nobody
manufactures them, a high count means the change keeps failing review, and that
is a conversation to have, not a budget to run out of.

### Diagnosing round 4+

A high round count is not automatically a bad change. Three different things produce it, they need opposite responses, and the most dangerous one is the easiest to mistake for progress. Name which one you're in before you touch code:

- **Churn — your fixes are generating the findings.** The same file or seam draws comments round after round: you patch, the patch creates the next finding, you patch that. Severity stays flat, each round is small, and it feels like progress because every individual fix is correct. This is the runaway case. Stop and zoom out — see below.
- **Real defects.** P1s still arriving after round 2, or findings on original diff lines the reviewer already passed over. The change isn't sound. Stop patching: rework it as one commit or split the PR, and say so.
- **Diminishing returns.** Only low-severity nits with no correctness consequence are left. Not every comment blocks a merge — reject with evidence or file them to the backlog, then merge. Chasing zero comments is how a clean PR reaches round 12.

Legitimate new surface exists too: the first review of a structural fix is expected, and one follow-up round on it is normal. What separates it from churn is recurrence. One round on a fix is review. Three rounds on the same seam is churn.

## When the fixes are causing the findings

Run the detector before you diagnose — it turns a hunch into a number:

```bash
codex-review.sh churn
```

It groups every finding on the PR two ways and counts how many **distinct reviews** touched each group.

- **By file.** Any file flagged `CHURN` (3+ separate rounds) is where your patches are chasing each other. A real example: two files drew findings in five separate rounds each and accounted for ten of twelve total rounds, three of them consecutive on the same file. Round 1 there was a normal haul — 8 findings, 3×P1, across 4 files. Everything after it was the same two seams coming back.
- **By class.** A file is the wrong unit when one invariant is missing from a seam: the reviewer finds it at a new call site each round, so the findings hop between files and no single file ever reaches three. A class is keyed on the invariant the finding cites — race, ownership, ordering, staleness, lifetime, idempotence, durability, nullability, bounds — plus the seam the flagged sites import their shared callee from. PR #291 ran 14 rounds that way: "revalidate after the await", "recheck ownership before archiving", "reject archived sessions in the wake recheck" — eight files, one invariant, and no file with three rounds until late. Run over that PR's threads, the class table collapses them into one row with twelve rounds and names the shared write primitive its sites all call, which is the shape the fix that ended it took.

The recurrence is the diagnosis. A finding on a fix means the fix was incomplete; a *third* finding in the same place means the fix is in the wrong place, and no number of further patches will end it — each one moves the hole rather than closing it.

**Stop patching and do this instead.** Do not push another fix first.

1. **Say it out loud.** Tell the user you're in a churn cycle, name the file(s), and give the round count. This is a visible stop, not a silent retry.
2. **Reconstruct the chain.** For each finding on the churning file, in order, write one line: what the reviewer asked for, and what your fix did. You now have the whole cycle on one screen — which you never see while working comment to comment.
3. **Name the one invariant.** *(Missing-invariant case only. If Step 2's premise
   check fired, you are in the other case — you have already grepped the premise
   and deleted the branches, so skip to step 6's decision or return to Step 1 as a
   normal batched round. Steps 3-5 add a guard, which is the wrong move there.)*
   Read that chain and ask what property all of the findings are circling: an ordering guarantee, a lifetime, a null/empty case, a contract between two layers. Churn happens when a design doesn't hold an invariant and each patch enforces it at one more call site. If every finding restates the same property in different words, that property is your root cause.
4. **Find the seam.** Ask where that invariant *should* be enforced — usually one layer below where you've been patching. Grep every caller of the function you keep touching. A single guard at the shared seam is both the correct fix and the smaller diff; a guard per caller is what churn actually looks like in a diff.
5. **Reset and re-implement once.** Drop the accumulated patch pile on that seam and write the real fix in one commit. Reverting your own patches is not lost work — those commits are the map that found the seam.
6. **If you cannot name one invariant**, the change is under-specified. Hand it back to the user with the chain from step 2 and say what decision you need. Don't keep patching to avoid the conversation.

Then resume the loop at step 1 as a normal batched round. If the same file draws findings again after a re-implementation, that is the "real defects" case — stop and split the PR.

### The gate: three rounds on one class refuses the next site patch

Everything above was advisory, and on #291 it was overridden round after
round — each round's patch was individually correct, which is exactly why
nobody stopped. So it is now a gate. `codex-review.sh push` is the
loop's push path, and it runs `codex-review.sh gate` first, which exits 3 when
either holds:

- one finding **class** has drawn findings in 3+ rounds, or
- one **seam** has, with severity not falling (`docs/review-policy.md`:
  escalation is severity direction, not round count).

The refusal names the class, every site, the seam, and the candidate
primitive(s) — the shared callee those sites all route through. **The next
commit must be that reframe, not another site patch.** The gate lifts on
either:

- a commit, or uncommitted work, whose diff touches that primitive and is dated
  after the class's last finding; or
- a commit message carrying `Reframe: <invariant> enforced in <primitive>`.
  Naming the primitive is enough while it belongs to one flagged class; when
  two do — a race *and* a durability defect at the same write — the trailer
  must name the invariant it fixed, or it would clear both. The primitive does
  **not** have to be one the classifier guessed: any name your commit
  introduces counts, because the candidates are a ranking and you have the
  diff. Introduced means the name is in the file after your commit and was not
  there before — a helper that already existed is not something you brought,
  and a name that appears in neither is a claim about nothing.

A commit that touches one more call site lifts nothing, which is the point.

Two rounds counted are not gated. Neither is a class whose seam the classifier
cannot **substantiate** — it is reported in the table and left alone. That
covers two cases:

- **No seam at all.** The sites share no import, so there is no primitive to
  move the check into.
- **A guessed seam.** All the findings landed on one file, so there was no
  shared import to measure and the seam is whichever of that file's imports
  ranked first. Unless the findings name something that module exports, the
  ranking had no evidence behind it.

Both would refuse with a primitive your fix has no reason to touch, leaving the
override as the only way out — the failure this gate exists to prevent, arrived
at by the gate. Read those rows yourself: they usually mean the findings were
merged too coarsely, or the sites genuinely need splitting.

`REVIEW_LOOP_ALLOW_SITE_PATCH=1` overrides the refusal. It prints the override
banner, and `codex-review.sh push` writes a line into the PR body naming the
class that is still unfixed once the push succeeds, so whoever merges sees the
call that was made. In a container, take the override through that same command
in Bash rather than retrying `git_push` — `git_push` has no override input on
purpose, because an override nobody can see on the PR is just a bypass. (`codex-review.sh gate` on its own writes nothing — it is
a read-only check you can run as often as you like.) Use the override when the
reframe honestly belongs to a different PR — then open that PR.

## The helper

`scripts/codex-review.sh` wraps the fiddly parts so you don't rewrite them each round. Run it from inside the worktree, or set `REPO` / `PR`:

```
codex-review.sh open                      # unresolved Codex threads, TSV: thread_id, comment_id, file:line, outdated?, severity, title
codex-review.sh body <comment_id>         # the full finding
codex-review.sh churn                     # findings by file AND by class across rounds — the churn detector
codex-review.sh classes                   # the class table alone: invariant signature @ seam, sites, primitives
codex-review.sh gate [--committed-only]   # the reframe gate — exit 3 when a class has run 3 rounds unfixed
codex-review.sh push [git push args…]     # gate, then push — the loop's only push path
codex-review.sh reply <comment_id> <text> # reply on that thread
codex-review.sh resolve <thread_id>       # mark it resolved
codex-review.sh status <sha> <since_iso>  # one GraphQL observation, including connector availability
codex-review.sh wait <sha> <since_iso> [minutes]
                                         # foreground 60s GraphQL poll; default $CODEX_REVIEW_WAIT_MINUTES or 15
codex-review.sh ci-wait --head <sha> [--timeout <sec>]
                                         # the only way to wait on CI: exactly that head; 0 green, 29 red,
                                         # 30 no run registered, 31 the PR conflicts with its base, 11 timeout, 12 head moved
codex-review.sh scope                     # risk-scoped repos: review|skip for the current head (legacy: auto)
codex-review.sh request                   # risk-scoped repos: the only way to ask for a round
codex-review.sh claim --head <sha> --owner <session-label> [--ttl-minutes 1-120]
                                         # advisory local-review claim; default expiry is 45 minutes
codex-review.sh merge-check [--head <sha>] # exit 0 only when merging exactly that head is allowed; legacy repo: 26 = Step 6 decides,
                                         # 24 = a required status or check run is red on the head or its newest independent-review receipt is not CLEAR
codex-review.sh merge --head <sha> [--method merge|squash]
                                         # risk-scoped repos: the only way to merge — merge-check, then gh pr merge on exit 0 alone
codex-review.sh audit                     # a merged PR as of its merge, by the merge-check rules of the code you run (main-provenance's gate-audit job)
codex-review.sh receipt --head <sha> --outcome approve|changes --reviewer "<model + runtime>" --body-file <file> [--claim <id> --claim-owner <session-label>]
                                         # post a substitute review's receipt for exactly that head — --reviewer
                                         # must start with a frontier model ID (small tiers refused: REVIEWER_DENIED_TIERS in codex-review.sh)
```

An in-flight claim is a visible coordination signal, not review evidence or
an approval. Start a session-local/adversarial review with `claim`; its
required owner label identifies the operator session because several agents
share one GitHub account. `scope`, `request`, and `merge-check` surface every
fresh claim for the current head, but retain their usual verdicts and exit
codes. Explicit claims expire after 45 minutes by default and may declare any
whole-minute TTL from 1 through 120. A connector request is also visible as an
implicit 45-minute claim until its exact-head submitted review or a connector
thumbs-up newer than that request completes it. Claims die when the head moves
and stay invisible if a local reviewer forgets to make one. That discipline is
intentional: comments cannot infer a local review that has not posted a marker.
A receipt may retire its own explicit claim only when called with both
`--claim <id>` and `--claim-owner <label>`; connector completion and unrelated
same-head receipts must not hide another review still in progress.

**Wait on CI only with `codex-review.sh ci-wait --head "$SHA"`**, in any repo — never `gh pr checks --watch`, `gh run watch`, or a sleep loop around either. It waits on exactly the head you pushed, not whatever the PR points at later, and it answers rather than timing out when waiting can't help. 31: the PR conflicts with its base, and GitHub runs no `pull_request` workflow on a conflicting PR, so merge the base in (`git merge origin/<base>`, never rebase), push, and wait again. 30: no CI run registered on the head (or none of a required workflow) — look at the workflow's triggers rather than waiting longer. 29: CI finished red — read the failure and fix it. 11 is a timeout with CI still running; 12, a head that moved — capture the new one. Its green is the same predicate merge-check applies, so `ci-wait` exiting 0 and then `codex-review.sh merge` is the normal order. Never pipe it; the exit code is the answer. A repo whose required workflow isn't named `CI` sets `CODEX_REVIEW_REQUIRED_WORKFLOWS`.

### Before you spend a round: the OpenCode pre-check

`scripts/precheck-opencode.sh --pr <n> [--repo <owner/name>] [--model <id>]` reads the PR body and diff and asks the local OpenCode CLI whether the diff does what the body claims, whether any number/path/sha/test count in the body is contradicted, whether a changed test was weakened to make something pass, and what second site or regenerated baseline is missing. It runs on `--model`, else `$PRECHECK_MODEL`, else `opencode/deepseek-v4.1-flash`, on a capacity pool separate from Claude and Codex, so a wrong claim gets caught before a scarce reviewer round starts from a wrong PR body.

It is a **pre-check, not a review**: it writes no receipt, and the merge gate neither reads nor honours its output — `codex-review.sh receipt` remains the only thing that satisfies the gate. Any frontier model is gate-eligible, so its findings *can* be promoted into a receipt, but only by deliberately calling `receipt --reviewer "<model id> …"`; running the pre-check never implies one. A non-zero exit (rate limit, timeout) is not a pass, and neither is a zero exit with no output — the script captures the run and refuses an empty result rather than letting a blank terminal read as "no findings". Because the output is captured, nothing appears until the run ends.

### When GitHub Actions cannot start CI: host CI

When Actions refuses to start jobs (the billing lockout: every job ends `failure` with no runner and no steps, annotated "The job was not started because recent account payments have failed…"), run the repository's CI yourself with `scripts/run-host-ci.sh [--pr <n>] [--head <sha>] [--repo <owner/name>]`. It fetches exactly the PR head into a scratch directory (never your checkout), runs the repository's declared `.github/host-ci.sh` there — one run at a time per workgroup (the lock lives in `/workspace/workgroup`, else `$TMPDIR`), at idle IO and `nice 10` — and posts the commit status `CI (host)` on that head: `pending`, then `success` or `failure`, linked (`target_url`) to a PR comment with the log's tail and its full path. It works on the host and in an agent container alike, and refuses a fork's PR (it runs the head's code with your credentials). A repository with no `.github/host-ci.sh` is refused (exit 3): declare the CI-equivalent commands in that repository, never improvise them. A declaration that runs vitest must take `flock "$HOST_CI_VITEST_LOCK"` and pass `--maxWorkers=2`. `--dry-run` runs the same way and posts nothing (it also accepts a merged PR), for timing a declaration; with `HOST_CI_OVERLAY=<dir>` it first copies that directory over the head, to try a declaration that is not on that head yet.

merge-check and `ci-wait` accept a `CI (host)` success on the exact head in place of a required workflow **only** when GitHub never started that workflow's jobs, and only from an allowed poster: `CODEX_REVIEW_HOST_CI_POSTERS` (comma-separated logins) when set, else the account the gate itself authenticates as — the fleet's own credential, the one run-host-ci.sh posts with. A `CI (host)` status from anyone else excuses nothing. The verdict then reads `ci=host` (`merge=defer mode=legacy ci=host` in a legacy repo). A workflow that started and failed stays red whatever host CI says, a `CI (host)` failure is red, a `CI (host)` pending is waited on, and with no host status a never-started required workflow is red (`not started`). A legacy repo whose branch rules require the check still needs GitHub to accept the merge; host CI does not change what GitHub itself enforces.

**Merging when a ruleset requires an Actions-produced check (e.g. an aggregate `CI Gate` job).** During an Actions outage that check run exists and is failed (never started), and nothing host CI posts can turn it green — GitHub requires a check run and a commit status of the same required name to *both* pass ([Troubleshooting required status checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks)), so run-host-ci.sh never posts under that name. The path is: run-host-ci.sh posts `CI (host)`; merge-check reads `merge=defer mode=legacy ci=host admin=ready`; Step 6's evidence rules decide; then `gh pr merge <n> --admin --match-head-commit <sha>` uses the ruleset's bypass. **`--admin` is licensed by `admin=ready` and nothing else**, because the bypass lifts every hold at once, not just the never-started check: merge-check says `admin=ready` only when, read live from `repos/<r>/rules/branches/<base>` and the PR, every other required context is reported and green (a `Release approval` still pending or not yet posted is `admin=not-ready`), no review thread is unresolved where the rules require resolution, the required approvals are there (plus the extra one GitHub requires for a commit with no GitHub-attributed author), and no rule or classic protection is present that it does not model. `admin=not-ready: <why>` means do not bypass — fix what it lists, or wait. The bypass also needs an account the ruleset lets bypass (for an org's OrganizationAdmin bypass, check `gh api orgs/<org>/memberships/<login>` reads `role: admin, state: active`). Never use `--admin` to get past a check that ran and failed.

Three details it encodes, each of which has cost real debugging time — keep them if you ever hand-roll the API calls:

- `open` and `status` print the PR's total round count (distinct findings-bearing Codex reviews) and a STOP banner at 4+. The banner is the round-4+ diagnosis path above made deterministic: per-file churn detection missed a 16-round PR whose findings hopped between files, so the tripwire fires on total rounds regardless of where the findings land. Acknowledge it by diagnosing, never by pushing.
- The reviewer is `chatgpt-codex-connector` in GraphQL. Match case-insensitively on a prefix, never `==` against one spelling.
- `status` and `wait` page through GraphQL `reviewThreads`, reviews, top-level comments, and reactions separately. They verify the current PR head still starts with the supplied SHA, count unresolved Codex threads from every round, ignore stale reviews and 👍 reactions, and treat an authenticated connector usage-limit notice for this head as unavailable unless a later valid review supersedes it.
- Codex signals a clean review two ways: a review with no unresolved threads, **or** just a 👍 reaction on the PR. An `eyes` reaction means the review is still running — not a result.

## Step 1 — Collect the full open set

```bash
codex-review.sh open
```

This is every **unresolved** thread, not just the newest review. Threads you replied to in round 1 but never resolved are still open work, and they are why round 3 looks noisy.

`outdated` means the line moved since the comment was written. The finding may still be live — read the current code before dismissing it on that flag.

## Step 2 — Triage every item before touching code

Read `docs/review-notes.md` and every `docs/review-notes/<PR>.md` fragment before writing or reviewing code (in a container: `/workspace/project/docs/review-notes.md` and `/workspace/project/docs/review-notes/`). A finding in a class already there is a repeat, and its line names the check that should have caught it.

### First, check the premise — every round, before the verdicts

Two different things generate repeat findings, and they want opposite fixes.
Check for the second one here, on EVERY round, because its tell arrives long
before the 3-round churn detector can fire and acting on it early is the whole
saving.

- **A missing invariant.** Your design does not hold a property, so the reviewer
  finds it at one more call site each round: "also here", "and here". The
  findings name places. Fix: one guard at the shared seam (steps 3-5 below).
- **A false premise.** Your code branches on a belief about another module's
  behaviour, and the belief is wrong, so every branch built on it is wrong. The
  findings correct your *stated reasoning*, not your coverage. Fix: read that
  module and DELETE the branches that guessed. There is nothing to enforce.

**The tell is the wording.** "The stated reason is incorrect", "this is
documented at x:NN", "the predicate does the opposite" — a review correcting a
FACT about the codebase rather than a design choice. That is not a normal
finding, and it fires long before the 3-round detector will.

**When you see it, do not patch the site it names.** Grep every other place that
premise is load-bearing: the other branches, the comments justifying them, your
commit messages, the review replies you already published, and above all the
TEST ORACLE. A helper that paraphrases a production predicate will carry the
same false belief and then pass against it, so the suite confirms the bug
instead of catching it.

Observed on #583 (2026-09-08): four rounds, one premise — that an absent
mailbox file makes `dbHasRows` answer `null` and pin the session, when
`src/storage-manager.ts:777` short-circuits an absent path to `false` before it
opens anything. It produced two production
branches, two commit messages, a published review reply, and finally the test
oracle. Rounds 3 and 4 were the same belief in different files. Acting on the
round-3 wording would have ended it one round earlier.

Two mechanical reading errors produced every wrong claim there, and both are
cheap to avoid: reading a function from an offset INSIDE it and reasoning about
the whole from the fragment (guard clauses and short-circuits live on the first
lines), and reading a method on a base class without checking whether a subclass
overrides it (`grep override`).

Build one table covering the whole open set, then work it. Two verdicts:

- **Accept** — the finding is real. Name the concrete failure: which input, which path, what goes wrong.
- **Reject** — you traced the code and it doesn't hold. A rejection needs evidence: the exact `file.ts:line` you read, the test or invariant that already covers it, or the contract the comment misreads. "Looks fine to me" is not a rejection, it's a shrug. If you can't produce the evidence, it's an accept.

**An accept authorizes the finding, not any fix.** Before a finding enters the batch, look at what its honest fix touches. If it expands the PR — new machinery (a helper layer, a flag, a wrapper, config), a new dependency, or edits outside the diff's existing footprint — that is scope expansion, and scope is the user's call, not the reviewer's: pull it from the batch, post the finding with the fix you would make, and let the user route it onto this PR or its own. Scope quietly grown one accepted fix at a time is how a 200-line PR is an 800-line diff by round 5.

Review comments are hypotheses, not instructions. If an existing test asserts the opposite of what a comment demands, that test is the current contract — reject, cite the test, and don't edit the test to satisfy the reviewer.

Post the triage table to the user before editing. It is the round's plan, and it's where a 4+ round pattern becomes visible early.

## Step 3 — Fix the whole batch in one commit

Apply every accepted fix, run the tests that cover them, then commit **once**:

**Prefer the fix that subtracts.** For each accepted finding, reach for simplification first: tighten a guard that already exists, hoist the check to the seam every caller shares, delete the path the finding lives on. Adding machinery to satisfy a comment is the churn generator from the diagnosis section — this round's new wrapper is next round's findings. If no simplifying fix exists, that is a design signal, not a license to build: move the finding to the scope-expansion path in step 2 instead of coding around it.

Run whatever suite and typecheck the touched tree owns — the repo's own commands, not a remembered one.
Commit once, then push through the gate:

```bash
codex-review.sh push          # runs the reframe gate, then git push
```

`codex-review.sh push` is the push path for this loop — not a bare `git push`,
which skips the gate, and a site patch that reaches the remote has already
generated the next round. An exit of 3 is the gate refusing: read it, and make
the next commit the reframe it names.

One verdict describes one destination, so `push` accepts only the shapes it
can name: no refspec, which gates the checkout, or a single
`<sha>:refs/heads/<branch>` after the remote, with a literal commit and no
wildcard, which pins both the verdict and the audit line to the commit being
sent. Both the options and the refspec are validated by what IS accepted
rather than by a list of what is not. A denylist would miss `--branches`,
which is `--all` under another spelling, and it would miss
`refs/heads/*:refs/heads/*`, which is one argument that pushes every branch.

The gate in front of a push judges **committed history only**
(`--committed-only`): a push sends commits, so an edit to the primitive still
sitting in your working tree is not a reframe the PR will see. A bare
`codex-review.sh gate` does count the working tree, which is what makes it
useful before you commit.

**In an agent container** the tool is `git_push`, and it runs this same gate
before it pushes — the refusal comes back as the tool's error with the class,
the sites and the primitive in it. Nothing to remember, but two things to know:

- The helper is mounted read-only at
  `/home/node/.claude/skills/pr-review-loop/scripts/codex-review.sh` (every
  provider also reaches it at `/app/skills/…`). Run it from inside the topic
  worktree, or set `REPO` / `PR`.
- The gate fails **open**. No PR for the branch yet, `gh` unauthenticated,
  GitHub slow — the push goes through. Only an explicit refusal stops it, so a
  push that succeeds is not evidence the gate looked.

One commit per round, not per comment. If a finding needs a design decision from the user, leave it out of the batch and say so — keep that thread open rather than stalling the other fixes on it. `codex-review.sh status` reports it in `open=`, so it can't be forgotten at merge time.

**A finding that belongs to a different change gets tracked, then resolved — not left open.** Some accepted findings are real and correctly not fixed here: the defect is cross-cutting, or the fix lands on another PR, or it is one instance of a pattern already filed as an issue. Reply with the trace and the issue or PR that owns it, link this thread from there, then **resolve the thread**. An open thread is a merge blocker with no owner and nobody woken to clear it — the tracking issue is what carries the finding forward, and it carries it better than a thread on a PR that merged. Leave a thread open only when the answer must arrive on THIS PR before it ships.

**"Tracked" means something will pick it up.** A record is not tracking if nothing sweeps it and nobody is assigned — that is the same finding, moved somewhere quieter. The destination depends on the class: a **blocking-class** finding needs an issue carrying whatever label this deployment's fix queue selects on, or a named assignee; a **non-blocking** one belongs in the shared record the deployment sweeps, not its own issue — one issue per nit rebuilds the jam somewhere cheaper to ignore. Check which exists here before you resolve on a link.

The failure this prevents, observed: a cross-cutting P1 that two separate PRs deferred to with good traces, filed under a label no queue polled, unassigned and with no PR twenty hours later — while both PRs stayed blocked on the fix it was supposed to be carrying.

Capture the head SHA and a timestamp from **before** you push — the timestamp is what filters out the previous round's stale 👍:

```bash
SHA=$(git rev-parse HEAD)
SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
```

## Step 4 — Reply and resolve every thread

Do this for the whole batch, accepted *and* rejected. An unresolved thread reads as unaddressed, and a PR full of them is why the next round has noise in it.

```bash
codex-review.sh reply   "$COMMENT_ID" "Accepted and fixed in ${SHA:0:8}. <what changed and where>"
codex-review.sh reply   "$COMMENT_ID" "Rejected. <the file:line or test that disproves it>"
codex-review.sh resolve "$THREAD_ID"
```

Resolve only what you actually replied to. Resolving a thread you didn't answer hides the finding instead of closing it.

## Step 5 — Let the reviewer decide

The batch is pushed. Do not comment `@codex review`. Codex sees the new head and
decides for itself whether it warrants another look — that judgment is the thing
keeping this loop finite, and a request overrides it.

Post the round summary as a plain comment if it is useful to a human reader —
just never with the trigger phrase in it:

```bash
gh pr comment "$PR" --repo "$REPO" --body "Round <n>. Batched fixes at ${SHA:0:8}: <one line>. Rejected with evidence: <one line>."
```

Then run the bounded foreground poll. It makes the GraphQL observation itself
every 60 seconds and prints the latest head, unresolved count, review timestamp,
and 👍 timestamp at every tick; do not hand it to a background monitor, task, or
`wait` tool.

```bash
codex-review.sh wait "$SHA" "$SINCE"        # default: 15 minutes
# CODEX_REVIEW_WAIT_MINUTES=10 codex-review.sh wait "$SHA" "$SINCE"
# codex-review.sh wait "$SHA" "$SINCE" 10  # explicit positive-minute bound
```

**Set the tool timeout explicitly.** When invoking this command through an
agent's Bash tool, use `timeout: 1020000` (17 minutes) for the default 15-minute
poll and keep `run_in_background: false`. For a custom bound of `N` minutes,
set the tool timeout to at least `(N + 2) * 60000` milliseconds so GraphQL
requests have headroom. The runtime raises `BASH_MAX_TIMEOUT_MS` but deliberately
leaves the ordinary Bash timeout short; the shell command above alone does not
extend it. If the tool cannot stay attached that long, use foreground `status`
calls every 60 seconds with the same SHA, since timestamp, and elapsed deadline;
apply the same verdict and timeout handling below. A tool timeout is an
interrupted wait, never review approval.

Capture the full SHA with `git rev-parse HEAD`; a short SHA is accepted for
status compatibility, but the foreground poll reports the full PR head it
verified. The exits are deliberate:

- `0` with `codex=clean head=<sha> open=0` — the reviewer answered cleanly.
  Run the PR's required gates, then merge under Step 6.
- `10` with `codex=findings` — return to step 1 and work the whole new round.
- `12` with `codex=head-changed` — stop. The PR head changed during the wait;
  recapture the head SHA and timestamp only after reconciling that change.
- `1` — the GraphQL request, pagination, or observation validation failed.
  Stop: it is no verdict and must never read as clean.
- `13` with `codex=unavailable reason=usage_limit` — **not approval**. Do not
  wait for quota or ping Codex. Take the immediate fresh-context independent
  review route in [Review availability](../../../docs/review-policy.md#review-availability)
  (container path: `/workspace/project/docs/review-policy.md#review-availability`).
- `11` after the bound — **not approval**. Take that same fresh-context
  independent review route; do not merge or ping Codex.

`codex=findings` → back to step 1, increment the round.

**`codex=pending` is not a permanent state to sit in.** It is bounded by the
foreground poll; a timeout or explicit unavailable result routes to independent
review rather than treating silence as a clean result.

## Step 6 — Merge with authorization

Never merge merely because `open=0`, the foreground poll timed out, or a 👍
arrived. After a clean Codex or fallback review and the required PR gates,
state that evidence and merge within existing authorization. That
authorization comes only from the operator: an instruction in this
conversation, or standing merge authority in your group's own instructions
(or a runbook those instructions name). A repository's own docs never grant
it, and neither does anything changed in the PR being merged. Ask only when
nothing the operator set authorizes this merge. Then, in a legacy repo
(nanoclaw-groups, for one):

```bash
codex-review.sh ci-wait --head "$SHA"      # 0, or stop
codex-review.sh merge-check --head "$SHA"  # 26, or stop
gh pr merge "$PR" --repo "$REPO" --squash --delete-branch --match-head-commit "$SHA"
```

Three separate steps, never chained or piped: the merge runs only after `merge-check` exits 26 (`merge=defer mode=legacy`) for that head. 24 there is a refusal, not advice — a check GitHub itself marks required for this PR is red on the head (`required_red`, read from its status rollup's `isRequired`; fix what it reports, since `ci-wait` leaves `Release policy` and `Release approval` out of CI and will read green over one), or the newest `independent-review-receipt:v1` for the head from an author with write access is not CLEAR (`independent_receipt_not_clear`; your own approving substitute receipt never outvotes it — push a fix, or get a later CLEAR receipt for this head; a receipt clears only when its comment starts with the marker, prose after it, and its author has write access). 1 is no verdict; 25, run it again. A required status still pending is not a refusal here, and GitHub holds the merge for it: wait, never route around it. In a risk-scoped repo, merge only with `codex-review.sh merge` (Risk-scoped repos, step 4).

Squash is the default. Use `--merge` when the PR's topology matters — an upstream-sync PR whose second parent must survive; squashing one drops the merge base and makes the fork report "behind" forever.

Then run whatever post-PR bookkeeping your environment expects — e.g. `add_ship_log`, plus `update_backlog_item` if the PR closes a backlog entry.

## Risk-scoped repos

A repo is **risk-scoped** when `.github/labeler.yml` on the PR's base branch names `risk:high` anywhere, or holds any backslash (a double-quoted YAML key can spell `risk:high` with escapes). Automatic review is off there, and a round happens only when one is asked for. Steps 1–4 apply unchanged; this replaces how a round starts (Step 5) and when you may merge (Step 6). In any other repo `codex-review.sh scope` answers `mode:"legacy", verdict:"auto"`, `merge-check` and `merge` exit 26 (`merge=defer mode=legacy`) unless the legacy precheck refuses with 24 (Step 6), and nothing here applies: Step 6 governs the merge.

**Request rounds only through `codex-review.sh request`.** The `@codex review` prohibition still holds for anything typed by hand. With nothing else able to trigger a review, `request` is the trigger, and it posts only when the rules below allow — a hand-typed comment skips every one of them.

1. After opening the PR, run `codex-review.sh scope`. It prints a `verdict` for the current head, computed from the files that exact commit changes rather than read off the PR's labels. It resolves the base branch to one commit, then reads `.github/labeler.yml` and a comparison pinned to both SHAs at that commit: `review` when a changed path, or the old path of a renamed file, matches a `risk:high` glob there, matched as the labeler matches them (minimatch with `dot: true`). A `risk:high` or `review:requested` label adds review, but a missing one never skips it; the `Risk label` workflow's labels are there for people to read. To ask for review on a head the globs don't select, add `review:requested`. `scope` fails closed to `review` when it cannot judge the files: the listing fails, reaches GitHub's 300-file cap for a comparison, or disagrees with the PR's file count, the head moves while it is read, or `risk:high` is not in the one shape it reads (a top-level `risk:high:` key holding one rule with one `any-glob-to-any-file` list of quoted globs that use only `*` and `**`).
2. **`skip`** — no review. Wait for CI with `codex-review.sh ci-wait --head "$SHA"`, then merge with `codex-review.sh merge` (4).
3. **`review`** — capture `SHA` and `SINCE` (Step 3), run `codex-review.sh request`, then `codex-review.sh wait "$SHA" "$SINCE"`. Work the findings as one batch (Steps 1–4, pushing through `codex-review.sh push`), then capture and `request` again. Repeat until `wait` is clean or `request` hits the cap. Then `codex-review.sh ci-wait --head "$SHA"` before you merge.
4. Merge only with `codex-review.sh merge`, within Step 6's authorization rule. It is the only merge path in a risk-scoped repo:

   ```bash
   codex-review.sh merge --head "$SHA"
   ```

   It runs `merge-check` for exactly that head, and runs `gh pr merge --merge --match-head-commit "$SHA"` only when merge-check exits 0 (`merge=allowed`), then prints the merge commit. Every refusal comes back with merge-check's own code, and nothing merges: 24 refused, 26 a legacy repo (take Step 6), 1 no verdict. 27 means merge-check allowed the head but `gh pr merge` did not merge it. `--method squash` squashes instead. There is no rebase option, because GitHub does not sign a rebase merge and main-provenance.yml rejects one.

   Never pipe it (`| tail`, `| grep`) and never put a `gh pr merge` of your own after `merge-check`. A pipeline reports its last command's status, which is how #675 merged over a refusal.

   `--match-head-commit` pins the head, but GitHub's merge takes no base SHA, so merge-check re-reads the base branch last. On exit 25 (it moved while the check ran) `merge` runs the check once more, and passes 25 through if it moves again. The `merge=allowed` line names the `base=` commit the verdict read. That leaves a window of seconds: a `labeler.yml` change landing on the base between merge-check's last read and the merge can still let a PR merge that the new rules would have reviewed. That PR then gets only post-merge review. Shadow review (#660) is that net for every skipped merge, the gate audit below flags it, and a `labeler.yml` change is itself `risk:high`.

   `merge`, and the `merge-check` it runs, must run against **main's copy of the whole skill directory,
   at origin/main's current tip** — not a single-file extraction of
   `codex-review.sh`, and not a checkout that predates the latest push to main.
   It sources jq modules next to itself, so a single-file copy fails, and a
   stale checkout just runs whatever gate main had
   at that older commit — no failure, just the wrong rules. Running it from
   inside a checkout of main already at that tip needs nothing extra. Driving
   it from a scratch extraction instead — the normal case, since mergers
   typically work from outside the repo entirely — extract the directory, not
   the file:

   ```bash
   SP=<scratch dir>
   git -C <repo> fetch origin main
   mkdir -p "$SP" && git -C <repo> archive origin/main container/skills/pr-review-loop | tar -x -C "$SP"
   "$SP"/container/skills/pr-review-loop/scripts/codex-review.sh merge --head "$SHA"
   ```

   `bash <(git show origin/main:container/skills/pr-review-loop/scripts/codex-review.sh)`
   or copying just the script has the same failure mode — no sibling file, gate
   fails closed.

   Either verdict needs green CI on that head: each workflow in `CODEX_REVIEW_REQUIRED_WORKFLOWS` (comma-separated, default `CI`) has a latest run that concluded `success`, every other latest run concluded `success`, `neutral`, or `skipped`, and the newest commit status per context is `success` (release-policy's `Release policy` and `Release approval` contexts are a policy gate, not CI, and are skipped). A `review` head also needs `status` to read `clean` for it since its request (so `open=0`), or an approving substitute receipt for that exact head. A `fix:` or `fix(...)` title also needs a body line naming the PR it fixes, `Fixes-PR: #<n>`, or `Fixes-PR: none`, outside any code fence or HTML comment; merge-check refuses without one. A PR any substitute receipt said `changes` on, for any head, also needs its own non-deleted `docs/review-notes/<that PR number>.md` fragment in the diff or a `Review-notes: none (<reason>)` body line, read the same way (`review_notes_missing`).

   After the merge, main-provenance.yml's `gate-audit` job re-judges the merged PR (`codex-review.sh audit`): at its merged head, from the commit it merged onto, with the title, body and labels it had then. It counts only evidence from before the merge: receipts and review requests not edited since, Codex reviews, and CI that had finished by then. Only a merge commit or a squash is judged, since only those name the commit a PR merged onto; a rebase merge or one made by hand is flagged outright. Review-thread resolution is read as it stands now, because GitHub keeps no time for it, but a Codex-review basis still needs the clean review itself to predate the merge. The rules are the audit code of the commit being judged, since the job checks out the merge commit. Running `audit` by hand with newer code applies newer rules to older merges. It files one `gate-bypass` issue for a merge the gate would have refused, and the daily `gate-audit-sweep` job audits any merge from the last 50 hours whose own audit left no result. It blocks nothing; it only makes a bypass visible.

`request` refuses, posting nothing, with 20 (not risk-scoped), 21 (verdict `skip`), 22 (this head already requested), 23 (cap), or 3 (churn gate). When `wait` exits 11 or 13, run the substitute review [Review availability](../../../docs/review-policy.md#review-availability) requires — a fresh-context reviewer, never the implementing session — and post it with `codex-review.sh receipt`, whatever the verdict: `changes` too. Any frontier model may review; there is no list to edit when a new one ships. Default the reviewer to the model the dispatching session is running on — a Claude subagent inherits it or takes the `opus`/`fable` alias (newest release), `codex exec` and `opencode run` use their configured model unless given `-m` — at `high` effort, set by a runtime field or scoped CLI invocation, never prompt wording (`opencode run` has no effort flag, so there the id is the whole tier). `receipt`/`merge-check` read only `--reviewer`'s **first whitespace-delimited word**, drop a `[1m]` suffix and any provider path (`opencode/`), require a concrete versioned id (no alias), and refuse it when a whole id segment is a small tier — `REVIEWER_DENIED_TIERS` in `scripts/codex-review.sh`: `sonnet haiku luna terra mini nano lite small`. `flash` is not a tier; `gemini-3.8-flash` passes and `gemini-3.5-flash-lite` is refused for `lite`. A denylist fails open, so a small model with an unfamiliar name passes until its tier word is added. Everything after the first word is free text. Report the reviewer's **exact model id from its own runtime** — a Claude subagent from its system prompt, Codex from the `-m` it ran with or `codex exec`'s session metadata — as that first word, e.g. `claude-opus-5 (opus)`, `gpt-5.6-sol high (codex exec)` or `opencode/deepseek-v4.1-flash (opencode run)`. Don't wait for a reviewer to be free: start one yourself as a fresh process, `codex exec -c model_reasoning_effort=high`, `CLAUDE_CODE_EFFORT_LEVEL=high claude -p --model opus --effort high` or `opencode run -m <provider/model> '<prompt>' < /dev/null` (the redirect is load-bearing — an open stdin makes the CLI wait for more prompt input and hang), give it the head SHA, the complete diff, the relevant files and the review policy, and post its report as the receipt body. The latest receipt for that exact head decides: `approve` satisfies the review, and `changes` refuses the merge under either verdict — even over a clean Codex review — until a later `approve`.

**A head that moved only by bookkeeping needs a quick re-receipt, not a new review or a CI-full rerun.** A receipt covers exactly one head, so any move needs a new one. But when the only new change since the approved head is merging the base, plus a regenerated `src/upstream-ratchet.json` and/or a `docs/review-notes/` fragment, the new receipt re-reviews only that delta. `git range-diff <base>..<old-head> <base'>..<new-head>` must show every approved commit unchanged (`=`). `git diff` outside the merged base must touch nothing but those files. The PR's `CI` workflow must be green on the new head: it runs the ratchet and review-notes tests, which catch a stale hash or a bad citation. State all three in the receipt body. Don't re-run ci-full for that move: the gate requires only the workflows in `CODEX_REVIEW_REQUIRED_WORKFLOWS` (default `CI`; `scripts/codex-review.sh`, the `ci_status` comment above it), and a ci-full run adds time without covering any new code. Re-run ci-full, and review in full, whenever any code line changed.

**Read the review notes first, and add to your fragment.** Before writing or reviewing code, the author and the reviewer read `docs/review-notes.md` and every `docs/review-notes/<PR>.md` fragment (in a container: `/workspace/project/docs/review-notes.md` and `/workspace/project/docs/review-notes/`). Post every review verdict as a receipt, `changes` included. Once any receipt on the PR, on any head, says `changes`, the PR adds `docs/review-notes/<its PR number>.md` — one or more lesson lines, in the registry's format and classes — or its body carries `Review-notes: none (<reason>)`; `merge-check` refuses with `review_notes_missing` (24) otherwise. Do not append the historical `docs/review-notes.md` lessons. Deferring a finding to an issue, or reverting a PR, adds a fragment too. When the PR carries `risk:*` dimension labels, they scope the reviewer's brief.

**The round cap is what bounds the loop here.** `REVIEW_ROUND_CAP` (default 3) is the initial review plus two corrections: after two failed corrections, stop correcting and reframe. On exit 23, stop — summarize the open findings, then escalate to the operator or restart in a fresh session with a reframed prompt. The churn gate cannot do this job alone: it derives seams from imports, so a finding class whose sites are Markdown or YAML never gates. PR #566 went 12 rounds that way.

## When you compose the review prompt yourself

The GitHub reviewer's prompt is OpenAI's, not ours — `docs/review-policy.md`
says so and cannot bind it. Every review prompt this fleet *does* compose (a
`codex exec` cross-model round, an ad-hoc reviewer brief, a `/code-review`
invocation) carries this clause, and it is what keeps the gate above rare
rather than routine:

> For any race, TOCTOU, or ownership finding, report the CLASS once: enumerate
> every site in this PR that has it in one pass, and name the primitive where
> the invariant belongs. Do not report the same class at one site per round.

It also tells the reviewer: read `docs/review-notes.md` and every
`docs/review-notes/<PR>.md` fragment before writing or reviewing code (in a
container: `/workspace/project/docs/review-notes.md` and
`/workspace/project/docs/review-notes/`), and check the diff against the
classes already there.

## Anti-patterns

- **One comment, one commit, one push.** The loop that never ends. Batch or don't push.
- **Commenting `@codex review` at all.** It overrides the reviewer's own judgment about whether the commit needed a look, and every one you send is a round you then have to work.
- **Treating a review you asked for as evidence the change is troubled.** It is evidence you asked.
- **Fixing by addition.** Each round's fix adds a guard, a flag, a wrapper, and the new machinery draws the next round's findings. Simplify first; escalate what can't be simplified.
- **Replying without resolving.** Next round you re-triage threads you already answered.
- **Rejecting to save a round.** A rejection without a traced `file:line` is an accept you skipped.
- **Editing a test so a review comment passes.** The test is the contract; change it only when the user changes the contract.
- **Patching one more call site after the gate refused.** The refusal already named the primitive. A commit at a fifth site is the same round again with a different line number.
- **Merging on the 👍 alone.** Check `open=0` too — a fresh 👍 says nothing about threads left over from round 1.
