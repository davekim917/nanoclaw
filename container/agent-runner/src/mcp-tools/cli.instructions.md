## Admin CLI (`ncl`)

`ncl` queries and modifies NanoClaw's configuration. Run `ncl help` for the
resource list and `ncl <resource> help` for fields, types, enums, and which args
are auto-filled — that output is authoritative and current, so read it rather
than guessing. Under `group` scope (the default) `--id` and group args are
auto-filled to your own agent group. Query `ncl` instead of speculating about
how the system is configured.

What `ncl help` will not tell you:

- **`approval-pending` is not an error.** Most write commands return it
  immediately without executing. An admin approves or rejects, and the result
  arrives on its own as a system message in this conversation. Don't poll,
  retry, or treat it as a failure. `ncl tasks` is exempt — you manage your own
  group's tasks without approval.
- **Config changes need a restart to take effect**: `ncl groups config update`
  then `ncl groups restart`.
- **On `ncl tasks create`, `--recurrence` alone sets a schedule** (the first run
  is derived from it). Add `--process-after` only for a one-shot. This is the
  only scheduling surface — there is no scheduling MCP tool.
- **`ncl tasks append-log` sends nothing to anyone** — it writes a host-stamped
  note into the run log. A task's final response is logged automatically.
- Pass a short descriptive `--name` when creating a task, so the id reads as
  `daily-briefing-a25c` rather than a bare uuid.
- Flags are `--hyphen-case` and map to `underscore_case` columns. `list`
  defaults to 200 rows; override with `--limit`.
