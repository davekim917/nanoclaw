---
name: stream-fixes
description: >-
  Orchestrate a live stream of small fixes. The user tests a running app and rattles off
  fixes one at a time; you number each as the next ".x" of ONE session ticket, dispatch a
  BACKGROUND agent to implement and live-verify it so the conversation never blocks, land
  every fix on ONE integration branch so the running localhost shows them all unified as the
  user keeps testing, and at PR-time ship ALL the small fixes as a SINGLE PR — peeling only
  genuinely BIG items (a net-new feature, a rewrite, a migration) off into their own PR.
  Use this whenever the user wants to "stream fixes", "start a fix stream", says "I'll stream
  you fixes / small fixes while I test", asks you to "send it to a background agent so we can
  keep talking", or starts rattling off numbered little UI/bug/polish fixes to apply live.
  Trigger on "stream-fixes", "stream fixes",
  "let's stream fixes", "fix stream", or the pattern of a user streaming successive small
  fixes against a localhost. Do NOT use for a single one-off fix, or for building a whole
  feature end-to-end (use e2e-build for that).
---

# stream-fixes

A streaming, non-blocking fix loop. The user keeps a local dev server open, tests, and
reports small fixes as they find them — "#1 the search bar reverts…", "#2 the export button
is misaligned…". You are the **orchestrator**: you never stop to hand-code each fix inline.
You classify it, hand it to a background agent, and immediately return to the conversation so
the user can keep streaming.

## The three guarantees

Everything in this skill exists to hold these three promises at once:

1. **Non-blocking** — each fix goes to a background agent (`run_in_background: true`), so you
   and the user keep talking while it works. You get a notification when it lands.
2. **Unified localhost** — every fix, regardless of which workstream it belongs to, is
   committed to a single **integration branch** that the dev server runs on. So the user sees
   *all* the fixes together on one `localhost`, exactly as they'll look shipped — not
   scattered across branches they'd have to check out one by one.
3. **ALL the small fixes ship in ONE PR; anything BIG gets its own** — this is a standing
   rule and it is decided by **size, not by module**. Every small fix in the session goes into a
   **single PR** under one ticket, each carrying the next `.x` suffix (`269.1`,
   `269.2`, …), no matter which surfaces they touch. The moment something is *big* — a
   net-new capability/screen/integration, or a fix so substantial it needs its own review — it
   is **built on the same integration branch** (so localhost still shows everything together)
   but **peeled off into its own PR** at cut time (see the PR organization rule below).

The trick that makes 2 and 3 coexist: the integration branch is a *local-only preview* that is
never pushed. What gets pushed at the end is the session PR (or, in the split case, one PR per
feature/module).

**And one hard rule underneath all three: a fix isn't done until its *behavior* is verified in
the live app.** "Typecheck + lint passed" is not "the bug is gone" — a plausible-looking change
can compile cleanly and still not fix (or even reproduce) the reported behavior. Every agent
must load the running frontend, reproduce the bug, apply the fix, and loop — re-testing the
actual interaction — until it observes the fix working, and only then commit. This is the
difference between streaming fixes and streaming *hope*.

## Setup (once, when the stream starts)

1. **Find the repo and the dev server.** Identify the app the user is testing. Make sure a dev
   server is running against the working tree so the user has a live localhost — start it with
   `preview_start` (from `.claude/launch.json`), never with a raw shell command. If one is
   already running, reuse it.
2. **Create the integration branch** off the latest base (usually `develop`), and check it out
   in the main working tree — this is what the dev server serves:
   ```bash
   git fetch origin
   git checkout -b stream-fixes/integration origin/develop
   ```
   Reusing an existing feature/followups branch as the integration branch is fine if the user
   is already on one — just keep committing every fix there.
3. **Start a section registry.** Keep a small in-conversation table of
   `section → { ticket, one-line scope }`. It starts empty and grows as fixes arrive. You don't
   need a state file — the git history is the source of truth (each commit carries a `Section:`
   trailer), and you hold the registry in the conversation.

## Per-fix loop

For each fix the user streams:

### 1. Assign the session ticket + next `.x`

**One ticket per session, by default.** At the start of the stream, propose a single session
ticket number from context (highest recent `NNN` in `git log`/branches + 1) and state it
once — don't block on confirmation, and don't re-ask per fix.

Then assign the next suffix `.n` by counting how many fixes have already landed this session:
first fix is `.1`, then `.2`, … **The suffix is per-session, not per-module** — a marketing fix
and a pipeline fix in the same session are `.1` and `.2` of the same ticket.

Still tag each commit with a `Section:` trailer naming the surface it touches (`streets`,
`marketing`, `shipments`, `pipeline`, `auth`, `dashboards`, `mobile`). That trailer is *not*
normally a PR boundary any more — it's there so the PR body can group the fix list readably, and
so you can split cleanly in the exception case where a session really did span two unrelated
modules.

### 2. Dispatch a background agent — ON THE INTEGRATION BRANCH, NEVER A NEW ONE

**HARD RULE: every fix lands on the one integration branch, in the one working tree.**

- Use the **Agent tool** with `run_in_background: true`. The agent works in the main working tree on the already-checked-out integration branch.
- **NEVER use `spawn_task` for a stream fix.** It creates a separate session on its own worktree + branch. That breaks both promises at once: the fix does not appear on the user's localhost, and it does not appear in the stream PR. It also invites conflicts when the branches later meet.
- **NEVER pass `isolation: "worktree"`.** Same reason.
- **NEVER let an agent create, switch, or rebase a branch.** Say so explicitly in every prompt.
- **FORBID subagents from calling `spawn_task`.** Subagents have the tool too, and a "helpful"
  follow-up chip becomes a separate session on its own branch — the exact thing this rule
  exists to prevent, and it silently duplicates work you have already dispatched in-session.
  Put this line in every agent prompt: *"Do NOT call spawn_task. If you find follow-up work,
  report it in your final message and let the orchestrator decide."*

`spawn_task` is only for genuinely **out-of-scope** follow-ups the user should triage later (a separate concern, a different epic) — never for something the user just asked to be fixed now.

**The one legitimate exception is a different repository.** Work in another repo (e.g. XZO-ANALYTICS, which has its own git origin) physically cannot sit on this repo's branch, so it needs its own branch and PR. When that happens, say so plainly and tell the user it will be a second PR — don't let it look like part of the stream.

Spawn a background agent scoped to exactly this one fix (see **Agent prompt template** below).
Give it everything it needs to work unsupervised: the repo path, the integration branch name,
a precise description of the bug, where to look, the minimal-fix + don't-break constraints, the
verify step, and the exact commit message. Tell it **not to push and not to open a PR** — that's
your job at the end.

Return to the conversation immediately. Tell the user the fix is running and invite the next one.

### 3. Integrate to the unified localhost

Because agents commit directly to the integration branch in the main working tree, the running
dev server (HMR) shows each fix the moment it lands — the user sees it appear on their localhost
with no action. When the completion notification arrives, relay a one-line result
(what changed + the commit) so the user can eyeball it live.

## Keeping localhost coherent: parallelism & race-safety

Agents for **different sections touch disjoint files**, so they can run in parallel safely — the
edits don't collide. The one shared resource is git: two agents committing to the integration
branch at the same instant can race the index. Keep it clean with these rules:

- **Serialize the commit, not the work.** It's fine to have several agents *analyzing/editing*
  in parallel, but only one should be committing at a time. The simplest robust default: when a
  new fix would touch the **same section (and thus likely the same files)** as an in-flight
  agent, queue it and dispatch when the first lands. Different sections can overlap freely.
- **Agents commit only their own files** — instruct them to `git add <explicit paths>` and
  commit just those, never `git add -A`. This keeps a stray concurrent edit out of the wrong
  commit and keeps the section split clean.
- If you ever get a partial/dirty tree, stop dispatching, reconcile the working tree, and
  resume — a coherent localhost is worth more than raw throughput.

## Cutting the PRs (on the user's go — "cut PRs" / "ship it")

Never push mid-stream (standing rule: nothing goes to remote until the user says so). When the
user is done streaming and asks to cut PRs, turn the integration branch into ONE PR carrying all
the small fixes, peeling off a separate PR only for anything big:

## Agent prompt template

Fill this in for each dispatched fix. Keep it self-contained — the agent has none of this
conversation's context.

```
You are fixing ONE small bug in <repo path>. The branch `<integration branch>` is already
checked out — make your change and commit to it. DO NOT push and DO NOT open a PR.
DO NOT create, switch, or rebase a branch, and do not create a worktree: every fix in this
stream must land on `<integration branch>` so the user's running localhost shows them all
together and they ship as one PR.

## The bug
<what the user sees, where in the app, and the desired behavior — concrete>

## What to do
1. Locate the relevant component/code (use ripgrep `rg`, not git grep — git grep skips
   untracked files). READ and understand the mechanism before editing; don't guess.
2. **Reproduce the bug in the LIVE app FIRST.** A dev server is already running at
   <frontend url> (backend <backend url>) — do NOT start one (HMR hot-reloads your edits).
   Drive the real browser (Claude_Browser MCP tools: preview_start/navigate/read_page/
   computer/read_console_messages). Log in if needed (<creds>). Confirm you can see the
   reported behavior before you touch code — if you can't reproduce it, say so and stop.
3. Make the MINIMAL change. Explicitly do not break: <the adjacent behaviors most at risk>.
4. **Verify the fix live, and LOOP until the behavior is actually correct.** Re-run the exact
   interaction in the browser; check the console for new errors; confirm the happy path still
   works. If it's not fixed, dig deeper and iterate — never commit a fix you have not watched
   work in the browser. (Only if the browser tools are genuinely unavailable, fall back to a
   test that reproduces the exact interaction and iterate to green — and SAY you used a test,
   not the live app, so it can be double-checked.)
5. Confirm `tsc --noEmit` + `eslint <changed files>` pass. Frontend: do NOT run prettier.
6. Commit ONLY the files you changed (`git add <paths>` — never `git add -A`) with message:
   `<ticket>.<n>: <short imperative desc> (live-verified)`
   and a body containing:
   `Section: <section>`

## Report back
The REAL root cause (2-4 sentences), the diff, HOW you verified in the browser (what you
typed/clicked and what you observed; note any screenshot path), confirmation the interaction +
console are clean, tsc/eslint status, and the commit SHA. If you could not fully verify, STOP
before committing and report exactly where you got stuck.
```

## How to talk to the user during a stream

User is the product/business decision-maker here, not the reviewer of your code. **Report like a product manager briefing an executive, not like an engineer writing a commit message.**

- Lead with **what changed for the user and why it matters** — cost, benefit, risk. Not the mechanism.
- **Be concise.** A landed fix is 1–3 sentences. Save the long form for when something is genuinely surprising or needs a decision.
- **No walls of detail by default**: no per-file diffs, no test counts, no tsc/eslint status, no file:line citations, no tables of columns — unless the user asks, or it's the actual subject (e.g. "the numbers are wrong, prove they're right now").
- **Surface decisions and trade-offs, not internals.** "This blocks a real publish if we get it wrong, so it fails open" — yes. Which guard function it calls — no.
- **Say the cost/benefit explicitly** when recommending: what it buys, what it risks, roughly what it takes.
- Flag anything that **moves customer-visible numbers, needs a prod migration, or requires telling a customer about deploy timing** — those are business events, and they're always worth the words.
- Still be direct about **bad news, wrong turns and your own errors** — briefly, and in terms of impact rather than mechanism.