# Task observations become required

From this release, a scheduled task script whose last stdout line does not wake
the agent must declare an observation. A bare `{"wakeAgent": false}` (with or
without `data`) is recorded as `undeclared`, which is now a failure held to a
2-hour bound. A series that keeps printing one sends the operators one message,
2 hours after its first fire on the new release, and keeps its episode open
until it declares `empty` or wakes.

## Why

A no-wake fire used to be a silent success. A watcher whose work was stuck
could report "nothing to do" for days, and every one of those fires looked
healthy. A declared observation (`empty`, `unreadable`, `blocked`, or
`unfinished` with `since`) says what the fire saw and how long a bad result may
stand. The previous release recorded undeclared lines as successes so that
producers could migrate; this release enforces the contract. See
[scheduled-tasks.md](scheduled-tasks.md#observations).

## Detect

Run both steps before you deploy, and again immediately before the restart.
Both are read-only.

1. Series that printed an undeclared line since the previous release deployed:

   ```bash
   pnpm exec tsx scripts/q.ts data/v2.db "SELECT u.agent_group_id, u.series_id, MAX(u.recorded_at) AS last_undeclared, (SELECT MAX(d.recorded_at) FROM task_run_outcomes d WHERE d.source = 'gate' AND d.series_id = u.series_id AND d.observation IN ('empty', 'unreadable', 'blocked', 'unfinished')) AS last_declared FROM task_run_outcomes u WHERE u.source = 'gate' AND u.observation = 'undeclared' GROUP BY 1, 2 ORDER BY 3 DESC"
   ```

   Every series listed printed a bare line on at least one path. Fix it unless
   you have already changed its script since `last_undeclared`. A
   `last_declared` value only shows that some other path already declares.

2. Scripted series whose no-wake path the ledger has never seen declared.
   This includes series that have not fired since the previous release
   (weekly and monthly ones, usually), and series that have only woken or
   errored:

   ```bash
   declared=$(pnpm exec tsx scripts/q.ts data/v2.db "SELECT DISTINCT series_id FROM task_run_outcomes WHERE source = 'gate' AND observation IN ('empty', 'unreadable', 'blocked', 'unfinished')")
   ncl tasks list --all --json | jq -r --arg declared "$declared" '
     ($declared | split("\n")) as $seen
     | [.data[] | select(.has_script == 1)]
     | "scripted series listed: \(length)",
       (.[] | select(.series_id | IN($seen[]) | not) | "\(.agent_group_id) \(.series_id) \(.recurrence // "one-shot")")'
   ```

   Read the script of each series this prints with
   `ncl tasks get --id <series> --group <group>`, and check every path that
   prints `wakeAgent: false`. `has_script` is `0` or `1`, and jq treats `0` as
   true, so the filter compares it explicitly. `ncl tasks list` shows only
   pending and paused occurrences, so a series whose fire is running is
   missing until it re-arms. If the `scripted series listed` count differs
   between runs, run the step again after in-flight fires finish.

## Fix

Print the final line with the `task-observation` helper instead of by hand:

```bash
H=/app/skills/task-observation/task_observation.py   # in a container
python3 "$H" --kind empty --evidence "0 open PRs changed" --bound 4h
python3 "$H" --kind unreadable --evidence "GitHub API returned 502" --bound 90m
```

A host-gated script (`--script-host`) runs on the host, where `/app` does not
exist: use `<install root>/container/skills/task-observation/task_observation.py`.
A script that already prints a rich line can keep it and merge the helper's
observation into it, for example
`jq -c --argjson o "$(python3 "$H" --kind empty --evidence-json "$data" --bound 2h)" '. + {observation: $o.observation}' <<<"$line"`.

Choose the kind honestly: a failed fetch is `unreadable`, a refused dispatch or
lock is `blocked`, open work is `unfinished` with the `since` it started, and
only "checked, nothing to do" is `empty`. Change an inline script with
`ncl tasks update --id <series> --group <group> --script …`. Only the operator
may change a host-gated series' script.

## Verify

After the next fire of each series you changed:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT observation, outcome, bound_ms, recorded_at FROM task_run_outcomes WHERE source = 'gate' AND series_id = '<series>' ORDER BY id DESC LIMIT 3"
```

The newest row shows a declared kind (not `undeclared`) and a `bound_ms`.

## Rollback

Revert this release and restart the host. Undeclared lines are then recorded
as successes again, and the next such fire ends the series' open episode. A
message already sent stays sent.
