---
name: pr-review-loop
description: Drive a PR to merge through Codex's automated review in batched rounds — collect every open comment, accept or reject each with evidence, fix them in one commit, reply and resolve every thread, then let the reviewer decide whether another round is warranted. Use this whenever a PR has Codex review comments to work through, right after opening a PR that Codex will auto-review, and any time the user says "address the codex comments", "work the review", "resolve the PR comments", or "get this PR merged". Use it especially when a PR is on its third round of review and isn't converging.
---

# PR review loop

Codex (`chatgpt-codex-connector[bot]`) reviews a PR when it opens, and afterwards decides for itself whether a new head commit warrants another look. Worked one comment at a time, that is an unbounded loop: patch → new review → patch → new review. Worked in rounds, it converges in two or three.

**The whole skill is one rule: a round is a batch.** Collect every unresolved comment, decide on all of them, fix all the accepted ones in one commit, push once. Never push a commit for a single comment.

**Then stop, and do not ask for a re-review.** The reviewer decides whether your commit warrants another look, and silence is an answer — it means the change did not need one. A `@codex review` comment overrides that judgment and manufactures a round nobody wanted. On 2026-08-09 one deployment drove a 213-line PR to four requested rounds in two and a half hours, then blocked its own merge on the count; four PRs sat frozen with CI green, one with every thread already resolved. If a repo genuinely has no automatic reviewer, that is a deployment fact its instructions should state — it is not a reason to start pinging.

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
- **Third arriving review and still not converging** — stop and diagnose out
  loud before touching code. Post your read to the PR thread and mention the PR
  owner and whoever owns release calls in this deployment: the trend (same subsystem? same invariant? severity flat or
  rising?) and which of the three cases below you think you are in. Then act on
  that diagnosis. What you must not do is push another patch because a patch is
  what you pushed last time — "address the Nth review" as a commit message is
  the anti-pattern this skill exists to stop, and it is how #299 reached round
  18.

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

It groups every finding on the PR by file and counts how many **distinct reviews** touched each one. Any file flagged `CHURN` (3+ separate rounds) is where your patches are chasing each other. A real example of the pattern: two files drew findings in five separate rounds each and accounted for ten of twelve total rounds, three of them consecutive on the same file. Round 1 on that PR was a normal haul — 8 findings, 3×P1, across 4 files. Everything after it was the same two seams coming back.

The recurrence is the diagnosis. A finding on a fix means the fix was incomplete; a *third* finding in the same place means the fix is in the wrong place, and no number of further patches will end it — each one moves the hole rather than closing it.

**Stop patching and do this instead.** Do not push another fix first.

1. **Say it out loud.** Tell the user you're in a churn cycle, name the file(s), and give the round count. This is a visible stop, not a silent retry.
2. **Reconstruct the chain.** For each finding on the churning file, in order, write one line: what the reviewer asked for, and what your fix did. You now have the whole cycle on one screen — which you never see while working comment to comment.
3. **Name the one invariant.** Read that chain and ask what property all of the findings are circling: an ordering guarantee, a lifetime, a null/empty case, a contract between two layers. Churn happens when a design doesn't hold an invariant and each patch enforces it at one more call site. If every finding restates the same property in different words, that property is your root cause.
4. **Find the seam.** Ask where that invariant *should* be enforced — usually one layer below where you've been patching. Grep every caller of the function you keep touching. A single guard at the shared seam is both the correct fix and the smaller diff; a guard per caller is what churn actually looks like in a diff.
5. **Reset and re-implement once.** Drop the accumulated patch pile on that seam and write the real fix in one commit. Reverting your own patches is not lost work — those commits are the map that found the seam.
6. **If you cannot name one invariant**, the change is under-specified. Hand it back to the user with the chain from step 2 and say what decision you need. Don't keep patching to avoid the conversation.

Then resume the loop at step 1 as a normal batched round. If the same file draws findings again after a re-implementation, that is the "real defects" case — stop and split the PR.

## The helper

`scripts/codex-review.sh` wraps the fiddly parts so you don't rewrite them each round. Run it from inside the worktree, or set `REPO` / `PR`:

```
codex-review.sh open                      # unresolved Codex threads, TSV: thread_id, comment_id, file:line, outdated?, severity, title
codex-review.sh body <comment_id>         # the full finding
codex-review.sh churn                     # files drawing findings across 3+ rounds — the churn detector
codex-review.sh reply <comment_id> <text> # reply on that thread
codex-review.sh resolve <thread_id>       # mark it resolved
codex-review.sh status <sha> <since_iso>  # codex=<pending|clean|findings> open=<n> review=<n> reaction=<n>
```

Three details it encodes, each of which has cost real debugging time — keep them if you ever hand-roll the API calls:

- The reviewer is `chatgpt-codex-connector` in GraphQL and `chatgpt-codex-connector[bot]` in REST. Match case-insensitively on a prefix, never `==` against one spelling.
- `commit_id` comes back as the full 40-char SHA. `startswith` your short SHA; `==` never matches.
- Codex signals a clean review two ways: a review with no findings, **or** just a 👍 reaction on the PR. Poll only `/reviews` and you wait forever on a clean PR. An `eyes` reaction means the review is still running — not a result.

## Step 1 — Collect the full open set

```bash
codex-review.sh open
```

This is every **unresolved** thread, not just the newest review. Threads you replied to in round 1 but never resolved are still open work, and they are why round 3 looks noisy.

`outdated` means the line moved since the comment was written. The finding may still be live — read the current code before dismissing it on that flag.

## Step 2 — Triage every item before touching code

Build one table covering the whole open set, then work it. Two verdicts:

- **Accept** — the finding is real. Name the concrete failure: which input, which path, what goes wrong.
- **Reject** — you traced the code and it doesn't hold. A rejection needs evidence: the exact `file.ts:line` you read, the test or invariant that already covers it, or the contract the comment misreads. "Looks fine to me" is not a rejection, it's a shrug. If you can't produce the evidence, it's an accept.

Review comments are hypotheses, not instructions. If an existing test asserts the opposite of what a comment demands, that test is the current contract — reject, cite the test, and don't edit the test to satisfy the reviewer.

Post the triage table to the user before editing. It is the round's plan, and it's where a 4+ round pattern becomes visible early.

## Step 3 — Fix the whole batch in one commit

Apply every accepted fix, run the tests that cover them, then commit **once**:

Run whatever suite and typecheck the touched tree owns — the repo's own commands, not a remembered one.
Commit and push once — `git_commit` / `git_push` if you have those MCP tools, plain `git commit` / `git push` otherwise.

One commit per round, not per comment. If a finding needs a design decision from the user, leave it out of the batch and say so — keep that thread open rather than stalling the other fixes on it. `codex-review.sh status` reports it in `open=`, so it can't be forgotten at merge time.

**A finding that belongs to a different change gets tracked, then resolved — not left open.** Some accepted findings are real and correctly not fixed here: the defect is cross-cutting, or the fix lands on another PR, or it is one instance of a pattern already filed as an issue. Reply with the trace and the issue or PR that owns it, link this thread from there, then **resolve the thread**. An open thread is a merge blocker with no owner and nobody woken to clear it — the tracking issue is what carries the finding forward, and it carries it better than a thread on a PR that merged. Leave a thread open only when the answer must arrive on THIS PR before it ships.

**"Tracked" means something will pick it up.** Filing an issue is not tracking if no queue polls its labels and no human is assigned — that is the same finding, moved somewhere quieter. Before you resolve on a tracking link, check that the issue carries whatever label the fix queue in this deployment actually selects on, or name an assignee. The failure this prevents, observed: a cross-cutting P1 that two separate PRs deferred to with good traces, filed under a label no queue polled, unassigned and with no PR twenty hours later — while both PRs stayed blocked on the fix it was supposed to be carrying.

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

Then wait on `codex=`:

```bash
codex-review.sh status "$SHA" "$SINCE"     # → codex=pending open=0 review=0 reaction=0
```

Reviews take minutes, so how you wait depends on where you're running:

- **In an agent container:** don't park the poll as a background shell and end your turn — the container dies after ~30 minutes idle and takes the loop with it. Use the `wait` tool, which brings the wake back into this thread with full context:
  ```
  wait({ minutes: 5, prompt: "Run codex-review.sh status <sha> <since> for PR #<n>; if codex=findings go back to step 1 as round <n+1>, if codex=clean and open=0 merge, else wait again" })
  ```
- **On a host session:** just re-run `status` between other work, or poll it on an interval. There's no idle ceiling to lose the loop to.

`codex=findings` → back to step 1, increment the round.

**`codex=pending` is not a permanent state to sit in.** Now that nobody asks
for the review, a head the reviewer declined to look at never produces a
verdict — it stays `pending` forever, and a loop that waits for one waits until
the container dies. So bound it: after **20 minutes** of `pending` with CI green
and `open=0`, the reviewer has declined, and a declined re-review is a merge
signal, not a missing one. Say that is what you concluded, and merge.

## Step 6 — Merge

Merge on `open=0` plus either `codex=clean` or a bounded decline (above). Never
on `open=0` alone: that says nothing is outstanding, not that the last commit was
looked at.

```bash
gh pr merge "$PR" --repo "$REPO" --squash --delete-branch
```

Squash is the default. Use `--merge` when the PR's topology matters — an upstream-sync PR whose second parent must survive; squashing one drops the merge base and makes the fork report "behind" forever.

Then run whatever post-PR bookkeeping your environment expects — e.g. `add_ship_log`, plus `update_backlog_item` if the PR closes a backlog entry.

## Anti-patterns

- **One comment, one commit, one push.** The loop that never ends. Batch or don't push.
- **Commenting `@codex review` at all.** It overrides the reviewer's own judgment about whether the commit needed a look, and every one you send is a round you then have to work.
- **Treating a review you asked for as evidence the change is troubled.** It is evidence you asked.
- **Replying without resolving.** Next round you re-triage threads you already answered.
- **Rejecting to save a round.** A rejection without a traced `file:line` is an accept you skipped.
- **Editing a test so a review comment passes.** The test is the contract; change it only when the user changes the contract.
- **Merging on the 👍 alone.** Check `open=0` too — a fresh 👍 says nothing about threads left over from round 1.
