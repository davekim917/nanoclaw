## Admin CLI (`ncl`)

`ncl` queries and modifies NanoClaw's configuration. Run `ncl help` for the
resource list, `ncl <resource> help` for fields/enums/auto-filled args — that
output is authoritative, so read it rather than guessing.

What `ncl help` won't tell you:

- **`approval-pending` is not an error.** Most write commands return it
  immediately without executing; an admin approves or rejects, and the result
  arrives as a system message on its own. Don't poll or retry it. `ncl tasks`
  is exempt — no approval needed for your own group's tasks.
- **Config changes need a restart to take effect**: `ncl groups config update`
  then `ncl groups restart`.
- **On `ncl tasks create`, `--recurrence` alone sets a schedule** (the first
  run derives from it); add `--process-after` only for a one-shot.
- **Author recurring monitors script-first.** A `wakeAgent:false` line declares
  its observation (`empty`, `unreadable`, `blocked`, `unfinished` with `since`),
  printed with the `task-observation` skill's helper; only `empty` is a quiet
  success. Pass compact evidence when waking; never encode a failed observation
  as `empty` or completion merely because a wake was queued.
- Check for an overlapping owner, cadence, and purpose before adding a monitor.
  Follow the shared workflow contract for durable completion and scheduled
  reasoning exceptions. `--script-host` is host-operator-only; agents and
  templates cannot opt in.
- Flags are `--hyphen-case` and map to `underscore_case` columns.
