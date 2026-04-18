# Daily Digest Pattern (Phase 5.4)

## Why there's no "daily digest feature" in v2

v1 shipped a dedicated host-side `daily-notifications.ts` module that
read from two bespoke tables (`backlog`, `ship_log`) and emitted a
hardcoded summary at 8am Eastern. That tied the digest's content shape
to a specific persistence schema and required a host code change for
any content change.

v2 replaces the hardcoded feature with a composition of existing
primitives:

- **Scheduling** — `schedule_task` MCP tool (cron-style recurrence via
  the host's task scheduler).
- **Data sources** — the agent has access to: `search_threads` (cross-
  thread FTS), auto-memories (Claude Code native), `git log` + `gh pr
  list` inside cloned repos (Phase 2.11), MCP tools per group.
- **Delivery** — the agent's chat output naturally goes to whatever
  chat it was scheduled in.

The agent composes the digest at runtime from whatever sources are
relevant. When v2 ships a new data source, it's automatically
available to the digest without a code change.

## How to set up a daily digest

Pick whichever agent group should produce it (usually main/Axie for a
personal digest, or a group agent for team digests). In the chat where
you want the digest delivered, say something like:

> Schedule a recurring task to run at 8am America/New_York every day.
> When it runs, search my recent threads and memories for what I
> shipped yesterday, any PRs I opened or merged, scheduled tasks that
> completed, and anything notable in the archive. Reply with a 5–8
> line summary. Skip the message entirely on days with nothing
> noteworthy — don't send "nothing happened" filler.

The agent will call `schedule_task` with:
- `processAfter` — next 8am in the given timezone
- `recurrence` — `0 8 * * *`
- `prompt` — something like the above

When the task fires, the agent re-runs with that prompt. It pulls from
whatever tools it has access to, composes the summary, and replies in
the same chat.

## Variations

**Per-project digests:** schedule inside the project's thread. The
agent has context for which repo / workspace / channel this is about,
so the summary scopes itself.

**Weekly instead of daily:** change the cron to `0 8 * * 1` (Monday
8am) and tweak the prompt.

**Different content:** re-run the `schedule_task` with a new prompt.
No code change. The scheduler `update_task` tool also works for
editing an existing series.

**Team digests:** have the agent run the summary prompt and cross-post
it to other groups via the agent-to-agent messaging primitive (if
destinations are wired).

## Why not a `/daily-digest` slash command or first-class host feature?

Every slash command / host module is maintenance. The same capability
is already covered by `schedule_task` + the agent's tool surface.
Adding a parallel hardcoded path would be v1-style; v2's direction is
"compose from primitives, not special-case features."

If a digest pattern becomes ubiquitous and Dave ends up setting it up
the same way in every group, the right evolution is to add a small
helper (e.g. a `setup-daily-digest` skill) that prompts the agent with
the canonical schedule+prompt — still zero new host modules.
