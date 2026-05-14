# Backlog item → Spawn worker template

This file is the canonical contract every spawned worker must follow when
shipping work for a Linear ticket in the Illysium-ai org. The orchestrator
(@illie) references it from every spawn brief instead of restating the
checklist; the spawned worker reads it on entry and executes the phases.

Path inside the container: `/workspace/agent/spawn-template.md`

---

## When to use this template

Apply for any backlog item that ships code, dbt models, SQL DDL, or
config to a real branch + PR. Skip for one-off exploration, data-only
investigation, or admin tasks that don't change a repo.

If a ticket only needs to update Linear (close as duplicate, file a
follow-up, etc.) skip Phases 2–4 and use `spawn_complete` directly.

---

## Brief contract — what the orchestrator must fill in

When @illie writes a spawn brief, she fills these fields and references
this template. Anything not filled is a brief defect — pause and ask
before spawning.

```
## Goal
Resolve <Linear ID> — <one-sentence outcome>.
Linear: <URL>

## Inputs
- Repo: <Illysium-ai/REPO-NAME>            ← MUST be in Illysium-ai org
- Scope: <files / dirs / DB objects to touch>
- Dependencies: <other PRs / tickets that must land first, or "none">
- Non-goals: <anything the worker should NOT do>

## Acceptance
- <verifiable outcome 1, e.g. "PR opened against main with passing CI">
- <verifiable outcome 2, e.g. "Linear status moved to In Review">
- <verifiable outcome 3, e.g. "0 rows match SELECT … WHERE …">

## Workflow
Follow /workspace/agent/spawn-template.md. Report progress per the
reporting contract in that file.
```

The worker reads the brief, reads this template, and proceeds.

---

## Worker process — the five phases

### Phase 1: Setup

1. `create_worktree({ repo: "<REPO-NAME>" })` — get a fresh worktree
   rebased onto `origin/HEAD`. **Do NOT pass `branch:` unless the brief
   explicitly says "resume on existing branch X"**. The default
   `thread-<sessionId>-<repo>` branch is unique per spawn and is what
   guarantees you're not stepping on a sibling spawn's branch. If the
   response says "next git_push must use force: true", remember to
   pass `force: true` on Phase 4 push.
2. If create_worktree reports a rebase conflict, STOP and call
   `spawn_failed({ summary: "rebase conflict on …", fail_reason:
   "needs_manual_rebase" })`. Do not attempt to resolve blindly.
3. **Branch-hygiene check (mandatory).** Run `git -C
   /workspace/worktrees/<repo> branch --show-current` and verify the
   output starts with `thread-` (the create_worktree default prefix)
   OR matches the exact branch the brief told you to resume. If it
   matches some OTHER repo's PR branch (e.g., `xzo-42-...` when your
   brief is XZO-40), the worktree state is contaminated — STOP and
   call `spawn_failed({ fail_reason: "other", summary: "worktree
   already on unrelated branch <name>; refuse to push" })`. Editing +
   pushing would force-overwrite an unrelated PR's HEAD.
4. Read every file named in the brief's Scope and Dependencies before
   making changes. Truth-Grounded Responses — no guessing what's in
   them.
5. Call `spawn_progress({ message: "Phase 1 setup complete: worktree
   at <repo>, branch <name>, read <N> files." })`.

### Phase 2: Implement

5. Make the changes described in the brief. Stay within Scope; don't
   mass-touch shared files (parallel siblings may be in the same area).
6. For dbt model changes: edit the model, then `dbt parse` (or repo's
   equivalent — check `Makefile` / `package.json` scripts) to catch
   syntax errors before testing.
7. For SQL DDL deploys: run against XZO_DEV (or APOLLO_DEVELOPMENT)
   first, never directly against XZO_PROD without explicit Acceptance.
8. For schema-changing work: grep the entire repo for the changed
   column/table name across `*.sql`, `*.yml`, `*.yaml` before
   finalizing — see CLAUDE.local.md § Dimension-Removal Refactors.
9. Call `spawn_progress({ message: "Phase 2 implement complete: <files
   changed> with <key change summary>" })`.

### Phase 3: Verify

10. Run repo tests (`dbt test`, `npm test`, `pytest`, etc — check the
    Makefile or package.json for the canonical command).
11. For dbt: verify the assertion the brief calls out — typically a
    row-count, NULL-count, or grain check via `snow sql` against the
    appropriate connection (`xzo_dev`, `xzo_prod`, `apollo`,
    `apollo_wgs`).
12. If `codex` CLI is installed and the repo has `.codex/` config, run
    `codex review` and address any high-severity findings before
    proceeding. (Optional — only when the repo opts in.)
13. Call `spawn_progress({ message: "Phase 3 verify: <test name>
    passing, <assertion result>" })`.

### Phase 4: Ship

14. `git_commit({ repo: "<REPO>", message: "<type>(<scope>): <one-line
    summary>\n\n<body explaining WHY, not WHAT>" })`.
    - NEVER add `Co-Authored-By:` trailers.
    - NEVER add "Generated with Claude Code" footers.
    - Spec/context files (briefs, designs) go on the feature branch,
      never on main.
15. `git_push({ repo: "<REPO>"[, force: true if Phase 1 said so] })`.
16. `open_pr({ repo: "<REPO>", title: "<one-line>", body: "<summary,
    test plan, linear link>" })`.
17. `mcp__nanoclaw__add_ship_log({ title, description, pr_url, branch,
    tags })`.
18. If the ticket resolves a backlog item:
    `mcp__nanoclaw__update_backlog_item({ item_id, status:
    "resolved", notes: "Fixed in PR #<N>" })`.
19. If the worker can touch Linear (linear MCP wired): move the ticket
    from "In Progress" to "In Review".

### Phase 5: Report

20. `spawn_complete({ summary: "<Linear ID> implementation complete
    and verified, PR #<N> ready for merge.\n\n<key changes>\n\n<test
    results>\n\nLinear: <URL>" })`.

If at any point a phase cannot proceed: call `spawn_failed({ summary:
"<phase> blocked because <evidence>", fail_reason: "<one of:
needs_manual_rebase | external_blocker | hard_constraint | unclear_brief
| anthropic_aup | other>" })` and stop. Do not improvise around blocks.

### When you need operator input mid-task

You have **two tools** for asking the operator — pick by intent:

- **Hard block** (cannot proceed safely without an answer): call
  `spawn_request_steer({ question: "<one-line summary>" })` and **stop**.
  Use this for any **architectural / schema / DDL / output-materialization
  / blocking-strategy** decision where guessing could land the wrong
  contract in production. Lights up the dashboard "Needs you" lane.
- **Soft preference** (you can pick a reasonable default and continue):
  call `ask_question({ ... })`. Use for ergonomic choices (threshold
  values, naming conventions, formatting) where any of the options is
  acceptable and the worst case is "re-tune later". Posts an interactive
  question to chat **without** blocking the task. The dashboard now
  also flags `ask_question` on the Needs You lane so the operator
  doesn't miss it — but the worker keeps running.

Default to `spawn_request_steer` (hard block) when in doubt. Continuing
autonomously past a real design fork is a much worse failure mode than
waiting a few hours for the operator. Examples that **MUST** hard-block:

- "Where should `CANONICAL_GROUP_ID` live? `marts/finance/` or
  `analytics/finance/`?" → DDL location is a contract. **Block.**
- "Output materialization: table or incremental view?" → choice of
  semantics. **Block.**
- "Default fuzzy-match threshold: 0.85 or 0.90?" → ergonomic, low
  blast radius. Soft `ask_question` is fine.

After a hard block, **stop and idle**: do not print the question into
chat and keep working, and do not guess. The next inbound steer
message clears the flag automatically and unblocks you.

Use these instead of:
- Printing "?" into a normal status/chat line and continuing (operator
  can't tell from the board, and the question gets lost in scrollback).
- Calling `spawn_failed({ fail_reason: "unclear_brief" })` for a
  recoverable question (that terminates the task — only use when the
  brief is unsalvageable).

Examples of good `question` text:
- "Repo XZO-ANALYTICS has two model directories — `marts/finance/` and
  `analytics/finance/`. Brief says 'finance'. Which one?"
- "Acceptance asks for 0 NULL rows but the source has 14 legit NULLs.
  Drop them, fail closed, or update the assertion?"

---

## Reporting contract

The orchestrator and the dashboard both consume your progress signals.
Call `spawn_progress` at the end of each phase (steps 4, 9, 13). Each
message should be one to two sentences with concrete evidence (file
counts, query results, branch name) — not "working on it".

`spawn_complete` and `spawn_failed` are terminal. Once called, the
session ends. Don't call them mid-work.

---

## Anti-patterns — do not do these

- **Don't commit to main.** Always work on the worktree's branch. The
  branch is created by `create_worktree` automatically.
- **Don't skip `spawn_progress` between phases.** Without it the
  no-progress watchdog cannot tell whether you're working or stuck. The
  host now bumps progress on outbound activity, but the explicit
  progress message is what the orchestrator + dashboard render.
- **Don't run dbt/snow against XZO_PROD without explicit Acceptance.**
  If the brief doesn't say "deploy to prod", deploy to dev and stop.
- **Don't open a PR with empty test plan.** Reviewers need to know what
  was verified. If you couldn't verify something, say so explicitly.
- **Don't fabricate test results.** If a test is broken or skipped,
  report that — not "tests passing".
- **Don't expand scope.** If you find a related bug, file a follow-up
  ticket via `mcp__nanoclaw__add_backlog_item` — do not fix it in the
  same PR unless the brief says so. Parallel siblings cannot coordinate
  in-flight; off-scope edits cause merge conflicts.

---

## Worked example — XZO-54 (the kind of brief that worked)

```
## Goal
Resolve **Linear XZO-54** — redeploy UDTF_GET_DEPLETIONS_FORECAST to
XZO-PROD so the cache populate stops failing with `invalid identifier
'EDIT_TYPE'`.
Linear: https://linear.app/illysium/issue/XZO-54

## Inputs
- Repo: Illysium-ai/XZO-ANALYTICS
- Scope: sf_ddl/udfs/udtf_get_depletions_forecast.sql
- Dependencies: none
- Non-goals: do NOT touch the cache populate logic — XZO-54 is signature
  drift only.

## Acceptance
- DDL deployed against XZO_PROD via `snow sql -c xzo_prod -f …`
- `SHOW FUNCTIONS LIKE 'UDTF_GET_DEPLETIONS_FORECAST'` returns exactly
  one row with the new signature
- PR opened with `dbt parse` clean
- Linear XZO-54 moved to "In Review"

## Workflow
Follow /workspace/agent/spawn-template.md.
```

The worker handles the rest mechanically. The orchestrator's job is to
write a precise brief; the template encodes the discipline.
