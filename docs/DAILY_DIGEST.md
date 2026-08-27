# Daily Digest

v2 supports daily digests two ways: a built-in host-side summary for
workgroups whose Codex poster explicitly opts in, and an agent-driven pattern
(richer per-group content via `ncl tasks create`). They coexist — pick the one
that fits the use case, or run both.

## Path A — Host-side daily summary (opt-in)

Shipped at `src/daily-summary.ts`. Runs a 5-min tick on the host; fires
once a day per opted-in workgroup at the configured hour-in-TZ, posts a
digest to the Codex poster's configured channel, and skips groups with no
recent activity. Opt in with `dailySummary.messagingGroupId`; there is no
primary-channel fallback.

**What it includes:**

- **🤖 Agent Shipped** — `ship_log` entries (last 24h), grouped by repo.
  Populated by `commit-scan` (host-side, default-branch commits in cloned
  repos) and the `add_ship_log` MCP tool agents call inline.
- **✅ Resolved** — backlog items with `status IN ('resolved','wont_fix')`
  and `resolved_at >= since`.
- **📌 Open Backlog** — all `open` + `in_progress` backlog items, with
  priority emoji + an `[in progress]` suffix.

### GitHub Issues as the backlog source

Set `dailySummary.githubIssuesRepo` on the workgroup's Codex poster to use a
single GitHub repository (`owner/repo`) for both backlog sections. The host
fetches every open issue page and recently closed issues, excludes pull
requests, and renders open rows as linked `#number title` entries in the
existing digest thread. Severity labels map as `severity:p0`/`p1` → high,
`p2` → medium, and `p3` → low; only `in progress` or `status:in_progress`
marks an issue in progress.

When configured, GitHub is authoritative: the host never falls back to
`backlog_items`. A missing credential, authentication failure, or open-issues
fetch failure logs a warning and uses empty backlog and resolved lists, while
independent ship-log sections may still post. If only the closed-history fetch
fails after open issues were fetched, the host preserves that open backlog and
uses an empty resolved list. The poster resolves GitHub auth through its
configured `githubTokenEnv`, credential-folder scoped token, global token, or
GitHub App sentinel—the same chain used for its container.

```json
"dailySummary": {
  "messagingGroupId": "mg-1700000000000-example11",
  "githubIssuesRepo": "davekim917/nanoclaw"
}
```

Do not also schedule an agent-driven GitHub backlog digest for that same
channel: scheduled-task replies are separate messages, while this source keeps
the list under the host summary's parent message.

**Sections are omitted when empty.** A group whose all-three are empty
gets no message that day.

**What it does NOT include** (vs v1):

- GitHub team-PR section (`fetchGithubMergedPRs`) — skipped at port
  time. `commit-scan` already covers default-branch shipping in locally
  cloned repos; the gap is non-cloned team repos + author attribution.
  Add by porting v1's `fetchGithubMergedPRs` if/when it matters.

**Config — env vars (set on the host service):**

| Var | Default | Purpose |
|---|---|---|
| `DAILY_SUMMARY_ENABLED` | `1` | Set to `0` to disable host-side digest entirely. |
| `DAILY_SUMMARY_HOUR` | `8` | Local hour (0–23) in `DAILY_SUMMARY_TZ`. |
| `DAILY_SUMMARY_TZ` | `America/New_York` | IANA TZ string. |

**Config — explicit per-group opt-in:** set `dailySummary.messagingGroupId`
in the workgroup's Codex poster `container.json`. This is both the opt-in
and destination channel; the host does not fall back to the group's primary
wired channel:

```json
"dailySummary": {
  "messagingGroupId": "mg-1700000000000-example11"
}
```

Look up the id via:

```sql
SELECT id, channel_type, platform_id, name FROM messaging_groups
WHERE name LIKE '%channel-name%';
```

Example: example-labs's `container.json` opts its digest into Slack
`#agents-example`.

**State:** `data/daily-summary-state.json` tracks the
`lastFiredDateKey` (YYYY-MM-DD in TZ) so a host restart on the same day
doesn't re-fire.

**Lifecycle:** `startDailySummary()` boots from `src/index.ts` after
commit-scan; `stopDailySummary()` runs in `shutdown()` alongside other
host-side timers.

## Path B — Agent-driven digest (richer content)

The host-side summary covers `ship_log` + `backlog` when a Codex poster opts
in. If you want the digest to pull from other sources — auto-memories, recent
threads, `git log`, `gh pr list`, MCP tools — schedule it through the agent
instead.

In the chat where you want the digest delivered, say something like:

> Schedule a recurring task to run at 8am America/New_York every day.
> When it runs, search my recent threads and memories for what I
> shipped yesterday, any PRs I opened or merged, scheduled tasks that
> completed, and anything notable in the archive. Reply with a 5–8
> line summary. Skip the message entirely on days with nothing
> noteworthy — don't send "nothing happened" filler.

The agent runs `ncl tasks create --recurrence "0 8 * * *"` with the
prompt. The task fires in its own isolated session; replies default to
the channel the agent scheduled from (routing is stamped at create).

**Variations:**

- **Per-project:** schedule from the project's thread with `--thread`;
  replies land in-thread.
- **Weekly:** swap cron to `0 8 * * 1`.
- **Different content:** `ncl tasks update --prompt` — no code change.
- **Team digests:** the agent runs the summary prompt and cross-posts
  via the agent-to-agent messaging primitive (when wired).

**Cost:** each agent run costs tokens; host-side path costs nothing per
fire. If the content stays simple (ship_log + backlog), prefer Path A.
Use Path B when you need narrative summarization or sources the host
doesn't read.

## When to pick which

| Need | Path |
|---|---|
| Basic ship_log + backlog summary for an opted-in Codex poster | A |
| Custom prompt per group | B |
| Sources beyond ship_log + backlog (memories, threads, git, gh) | B |
| Strict cost ceiling (no agent tokens per fire) | A |
| Skip-empty without agent judgment | A |
| Narrative phrasing, "what mattered" framing | B |

Running both for the same group is fine — they're independent posts.
