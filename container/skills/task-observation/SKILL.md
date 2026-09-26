---
name: task-observation
description: >-
  Print the final stdout line of a scheduled task's pre-task script (--script)
  as a declared observation: empty, unreadable, blocked or unfinished, with
  evidence and a bound. Use whenever you write or edit a task script, or a
  script a scheduled task runs, so a fire that does not wake the agent still
  proves what it saw and a stuck or failing check reaches the operator.
---

# Task observation

A pre-task script's last stdout line decides the fire. When it does not wake
the agent, it must say what it observed, or the fire is recorded as
`undeclared` (and, once enforcement lands, as a failure):

```json
{ "wakeAgent": false, "observation": { "kind": "empty", "evidence": "no new PRs", "bound": "4h" }, "data": {} }
```

Print it with the helper rather than by hand; it escapes the JSON and refuses
an invalid observation (nothing on stdout, exit 2, the reason on stderr), so a
mistake shows up as a script error that names the problem.

- In a container: `/app/skills/task-observation/task_observation.py`
- In a host-gated script (`--script-host`): the same file under the install's
  checkout, `<install root>/container/skills/task-observation/task_observation.py`

```bash
H=/app/skills/task-observation/task_observation.py
python3 "$H" --kind empty --evidence "0 open PRs changed" --bound 4h
python3 "$H" --kind unreadable --evidence "GitHub API returned 502" --bound 90m
python3 "$H" --kind unfinished --evidence-json '{"pr": 12}' --bound 4h --since "$STARTED_AT"
python3 "$H" --wake --data '{"pr": 12}'
```

From Python: `sys.path.insert(0, "<that directory>")`, then
`from task_observation import observation_line, wake_line`.

## Kinds

| kind         | meaning                                               | recorded                  |
| ------------ | ----------------------------------------------------- | ------------------------- |
| `empty`      | checked, nothing to do                                | ok; ends any open episode |
| `unreadable` | the source could not be read                          | not ok                    |
| `blocked`    | the work could not be dispatched                      | not ok                    |
| `unfinished` | work is open; `--since` is when it started (required) | not ok                    |

A wake (`--wake`) also ends an open episode. A script error (non-zero exit,
timeout, bad output) is recorded as not ok with the reason.

## Bound and since

`--bound` is how long a not-ok result may stand before the operator is told:
`90m`, `4h`, `2d`, clamped to 15 minutes – 7 days. Consecutive not-ok fires
form one episode whose deadline is its earliest start plus its smallest
bound: a later fire can shorten it, never extend it.

`--since` is ISO-8601 with a zone (`2026-09-26T08:00:00Z` or `-04:00`), no more
than 5 minutes in the future. Report the same `since` for the same open work
on every fire: when it is earlier than the episode's first not-ok fire, it
moves the episode's start back to when the work really began.

`--evidence` is what you checked, in a sentence; `--evidence-json` takes a
non-empty object or array instead. Keep both small. The evidence is all that is
recorded of a fire that does not wake the agent: `--data` reaches the agent's
prompt with `--wake` and is not stored otherwise.
