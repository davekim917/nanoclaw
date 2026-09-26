# Scheduled Tasks

Scheduled tasks run an agent prompt at a future time or on a recurring cron
schedule. Each task belongs to an agent group and runs in its own system
session, separate from normal chat sessions.

Run `ncl tasks create --help` for the complete and current CLI reference.

## Create a recurring task

From the host, pass the agent group that should own the task:

```bash
ncl tasks create \
  --group <agent-group-id> \
  --name "weekday briefing" \
  --recurrence "0 9 * * 1-5" \
  --prompt "Prepare the weekday briefing and send it to telegram"
```

The first run is calculated from the cron schedule. Cron expressions use the
NanoClaw installation timezone.

Inside an agent container, `--group` is filled in automatically with that
agent's group.

## Create a one-time task

One-time tasks use `--process-after` instead of `--recurrence`:

```bash
ncl tasks create \
  --group <agent-group-id> \
  --name "call reminder" \
  --process-after "2026-07-14T18:00:00+03:00" \
  --prompt "Remind me to call Dana"
```

`--process-after` accepts an ISO 8601 timestamp or a local time interpreted in
the installation timezone.

## Delivery and run logs

A scheduled task has no chat attached to it. If its result should reach a
user, the prompt must tell the agent where to send it. Use a destination name
available to that agent, such as `telegram` or `team-slack`.

NanoClaw also asks the agent to append a short work-log entry after each agent
run. View run counts, failures, and recent log entries with:

```bash
ncl tasks get <task-id> --group <agent-group-id>
```

## Manage and test tasks

```bash
ncl tasks list --group <agent-group-id>
ncl tasks update <task-id> --group <agent-group-id> --prompt "New prompt"
ncl tasks pause <task-id> --group <agent-group-id>
ncl tasks resume <task-id> --group <agent-group-id>
ncl tasks cancel <task-id> --group <agent-group-id>
ncl tasks delete <task-id> --group <agent-group-id>
```

`cancel` stops the live task but keeps its history. `delete` permanently removes
the whole task series and its history.

To test a task immediately without changing its schedule:

```bash
ncl tasks run <task-id> --group <agent-group-id>
```

`run` also works while a task is paused. It queues one extra run and does not
resume the recurring schedule.

## Script gates

A task can run a Bash script before waking the agent. This is useful for
frequent checks where most runs have nothing for the agent to do.

The script's last line of standard output must be JSON:

```json
{ "wakeAgent": false, "observation": { "kind": "empty", "evidence": "no new alerts", "bound": "4h" } }
```

or:

```json
{ "wakeAgent": true, "data": { "alerts": 2 } }
```

- `wakeAgent: false` completes the run without calling the model. Its
  `observation` says what the script saw; see [Observations](#observations).
- `wakeAgent: true` wakes the agent and adds `data` to its prompt.

Scripts run with Bash, a 120-second default timeout (overridden by
`NANOCLAW_TASK_SCRIPT_TIMEOUT_MS`), and a 1 MB output limit. The JSON
decision must be the final line written to standard output. Keep `data` small
and include only what the agent needs.

For example, have the producer atomically replace the marker with a new opaque
event or generation ID for each observation, then save this as
`check-marker.sh`. This gate keeps the marker as the observed source until the
agent records a durable completion receipt. The marker ID is its observation
identity, so later work remains pending even when an older marker was completed:

```bash
marker=/workspace/agent/wake-next-task
receipt=/workspace/agent/wake-next-task.completed
observe=/app/skills/task-observation/task_observation.py

if [ ! -f "$marker" ]; then
  python3 "$observe" --kind empty --evidence "no marker" --bound 1h
  exit 0
fi

if ! marker_id="$(tr -d '\r\n' < "$marker")"; then
  echo "could not read marker" >&2
  exit 1
fi
case "$marker_id" in
  ""|*[![:alnum:].:_-]*)
    echo "marker must contain a nonempty safe ID" >&2
    exit 1
    ;;
esac

if [ -e "$receipt" ] && [ ! -r "$receipt" ]; then
  echo "could not read completion receipt" >&2
  exit 1
fi
receipt_id=""
if [ -r "$receipt" ]; then
  if ! receipt_id="$(tr -d '\r\n' < "$receipt")"; then
    echo "could not read completion receipt" >&2
    exit 1
  fi
fi

if [ "$receipt_id" = "$marker_id" ]; then
  python3 "$observe" --kind empty --evidence "marker $marker_id already completed" --bound 1h
else
  printf '{"wakeAgent": true, "data": {"reason": "marker pending", "markerId": "%s"}}\n' "$marker_id"
fi
```

The task prompt should tell the agent to record `markerId` in `receipt` only
after it has verified the required outcome, using a same-directory temporary
file and atomic rename. Do not delete the marker when a wake is queued. On a
failed or killed turn, the missing receipt keeps the same marker pending; if the
producer atomically writes a new marker ID, it remains pending rather than being
consumed by the older receipt.

Test it before scheduling, then pass its contents to `ncl`:

```bash
bash check-marker.sh

ncl tasks create \
  --group <agent-group-id> \
  --name "marker check" \
  --recurrence "*/15 * * * *" \
  --prompt "Handle the reported marker. After verifying the required outcome, write the supplied markerId as the sole line of a same-directory temporary file, then atomically rename it to /workspace/agent/wake-next-task.completed. Do not remove the marker." \
  --script "$(cat check-marker.sh)"
```

Store state that must survive between runs under `/workspace/agent`, the agent
group workspace.

## Observations

A run that does not wake the agent declares what it observed:

| `kind`       | Meaning                                                                  |
| ------------ | ------------------------------------------------------------------------ |
| `empty`      | Checked; nothing to do.                                                  |
| `unreadable` | The source could not be read.                                            |
| `blocked`    | The work could not be dispatched.                                        |
| `unfinished` | Work is still open. `since` (ISO-8601 with a zone) says when it started. |

Every observation carries `evidence` (a non-empty string, object or array) and
a `bound` (`90m`, `4h`, `2d`, clamped to 15 minutes – 7 days). Print the line
with the `task-observation` container skill's helper, which escapes the JSON
and refuses an invalid observation:

```bash
python3 /app/skills/task-observation/task_observation.py --kind empty --evidence "no new alerts" --bound 4h
```

Each run's result is recorded against its occurrence before the occurrence is
completed or the agent is woken. `empty` and a wake are successes. Every other
result is not: `unreadable`, `blocked` and `unfinished`, a script error (with
its reason), and an invalid observation. A run of consecutive unsuccessful
results is one episode. Its deadline is its earliest start (its first result,
or an earlier `since`) plus its smallest bound, so a later run can bring the
deadline forward but never push it back. Once the deadline passes, the
operators get one message for the episode, even if the task never runs again;
the next `empty` or wake ends it. Errors and invalid observations use a 2-hour
bound. A result that cannot be recorded holds its occurrence until it is, and
the operators are told once it has waited an hour.

A `wakeAgent: false` line with no observation is recorded as `undeclared`. It
currently counts as a success; once every producer declares observations it
will count as a failure.

Avoid putting secrets directly in task scripts. Prefer runtime credential
injection through OneCLI so credentials are not stored in the task definition.

## Frequency limit

An ungated recurring task that would fire more than four times in the next 24
hours is rejected. A task with a script gate is allowed to run more often
because `wakeAgent: false` uses no model tokens.

For an intentionally frequent task that has no script, see the explicit
override in `ncl tasks create --help` and confirm the token and quota cost
before using it.

## Script failures

A timeout, nonzero exit, missing decision, or invalid JSON counts as a failed
run. Consecutive failures delay the next recurring run by 2, 4, 8, 16, 32,
then 60 minutes. Further failures stay at the 60-minute delay.

After eight consecutive failures, NanoClaw pauses the series and writes the
reason to its run log. Fix the script, test it, then resume the task:

```bash
ncl tasks resume <task-id> --group <agent-group-id>
```

Only script errors count toward this backoff. An observation that is not
`empty` does not delay the series; it is held against its bound instead (see
[Observations](#observations)).

## Template tasks

Agent templates can include recurring tasks and optional script gates. Template
tasks are created paused so installing a template never starts background work
without approval. See [Agent Templates](templates.md#recurring-tasks).

For implementation details, see
[Pre-Agent Scripts](agent-runner-details.md#pre-agent-scripts-tasks).
