# Task-script output occurrence isolation

## Problem

A safe host-side task script may place `content.scriptOutput` on a pending task
row. The container treats that field, including `null`, as proof the script has
already run and skips a second execution. Recurrence used to copy this
per-occurrence result into the next row, which could suppress that new row's
script.

## Decision

- Re-arming strips only an own `scriptOutput` property from JSON object content.
  Content with no result is retained byte-for-byte, and terminal predecessor
  rows remain historical records.
- Updating `script` or `scriptHost` removes the current result because it no
  longer proves execution of the selected script or mode.
- Prompt, delivery, model-pin, and other current-occurrence settings retain the
  result. Pause/resume also retains it because it resumes the same occurrence.

## Executable acceptance

1. **Clone isolation** — pending and paused successors omit both object and
   `null` output while retaining routing and all other task content.
2. **Live edit invalidation** — `script` and `scriptHost` updates remove output;
   prompt, delivery, and model-pin changes do not.
3. **Runner sentinel** — any present output, including `null`, prevents a
   second container script execution.
4. **Verification** — scheduling DB and host-script integration suites, runner
   script suite, host and runner TypeScript checks, and the upstream ratchet
   report pass with no unexpected generated changes.

## Boundaries

This changes the fork-owned recurrence writer in
`src/modules/mailbox/ops/tasks.ts`. It does not change the upstream SQLite task
writer, script execution, routing, or schedule calculation.
