# Migration: scheduled tasks lose their Claude-only model/effort default

> **Sequence:** pins first, then deploy. See §3 — this is the opposite of a fix-it-afterwards migration, because pins are data and the removal is code.

Until this release, a scheduled-task fire on a **Claude** group with no `--model`/`--effort` pin of its own was forced onto `sonnet` at `xhigh` effort, regardless of what that group was configured to run. That branch is deleted. An unpinned scheduled task now resolves to the group's configured model and effort, else the provider's per-family default — the same place interactive chat starts from.

One deliberate difference from chat: a **pure** task wake does not inherit a per-session sticky model or effort. If a human typed `-m opus` in that thread, chat keeps using Opus and the unpinned task still fires on the group default. A batch that mixes real chat with a task is a human conversation the task rode along with, and keeps the sticky — only a task-only wake is suppressed.

Codex and OpenCode groups were never in that branch and are unaffected. A task's own pin still wins over everything, unchanged.

This doc is the migration path for that change, written to be handed to a coding agent verbatim: detect → why → fix → verify → rollback.

**Most installs need no action.** The change is a behavior and per-fire cost change, not a breakage — every affected task keeps running. Read "Detect" to see what moves, then decide.

## 1. Detect

Unpinned series are the ones that move. `ncl tasks list` now renders a `PIN` column, and an unpinned series shows `-`:

```bash
ncl tasks list                      # all groups
ncl tasks list --group <group-id>   # one group
```

For a scriptable inventory, `--json` carries `model_pin` and `effort_pin` (both `null` when unpinned):

```bash
ncl tasks list --json | jq -r '
  .data[] | select(.model_pin == null and .effort_pin == null)
      | [.agent_group_id, .series_id, .prompt] | @tsv'
```

Only rows whose group runs **Claude** are affected. Check a group's provider with `ncl groups config get --id <group-id>` — and note that `container.json` is the authority for what actually boots, not the `container_configs` projection.

**Do not rely on a count from someone else's install.** On the reference install this was 31 of 46 armed series at the time of writing, but the number drifts as tasks are created and cancelled. The stable shape is: _every unpinned series on a Claude group moves to that group's default._

## 2. Why

The old default was wrong in three separate ways, and they compound:

- **It was invisible.** Nothing in `ncl tasks get` or the task's own definition said `sonnet`/`xhigh`. The value was applied deep in the runner's poll loop, so the only way to discover it was to read the source.
- **It contradicted the group's own configuration.** An operator who set a group to Opus got Opus in chat and Sonnet on a schedule, with no indication the two differed.
- **It was Claude-only.** The same unpinned task on a Codex group already resolved to the group default. One provider silently behaved differently from the others.

It was also, in one respect, right: it existed to stop scheduled fires from riding an interactive sticky model. That protection is kept — a pure task wake ignores the session sticky — but it is now implemented by _suppressing_ the sticky rather than by substituting a hardcoded `sonnet`/`xhigh` the group's own config could neither see nor override.

A scheduled task is a way to _run_ an agent, not a different agent. It should not have its own model policy. The pin exists for the case where a specific task genuinely needs a specific model — and a pin, unlike the deleted default, is visible in `ncl tasks list`.

## 3. Fix — pin BEFORE you deploy, not after

**The order matters and it is the opposite of what you might expect.** Pins are data in the session DBs and take effect immediately with no deploy. The removal is code and needs one. So any series you want held on its current model must be pinned _before_ the deploy, not in response to it — otherwise it runs at the group default for every fire in between.

```bash
# For each series that should NOT move to the group default:
ncl tasks update --id <series-id> --group <group-id> --model claude-sonnet-5 --effort xhigh
```

That reproduces the previous behavior exactly, and now it is _visible_ in `ncl tasks list` as a pin rather than an invisible default.

**Verify the pins landed before deploying** — this is the step that makes the deploy safe:

```bash
# Every series you intended to pin should show a PIN, not `-`.
ncl tasks list --json | jq -r '
  .data[] | select(.model_pin != null)
      | [.agent_group_id, .series_id, .model_pin, .effort_pin] | @tsv'
```

Series you deliberately leave unpinned will move to their group's default. That is the intent — pin the exceptions, not everything.

`ncl tasks repin` is **not** the tool for this: it retargets pins that already _exist_ (match a current pin, set a new one), and these series have no pin to match. Use `ncl tasks update` to create the first pin; `repin` is for a later model bump or a provider switch.

**Nothing is auto-pinned by the upgrade, deliberately.** Freezing every unpinned series onto a model nobody chose would be the same defect this change closes — and see the rollback caveat below, because pinning cannot currently be undone.

> **On this install**, the pinning step is already done: ten recap/digest series are pinned to `claude-sonnet-5`/`xhigh` and the remaining unpinned series are intended to move to the group default. This section is the general procedure, for a fork doing the same migration.

## 4. Verify

Verify at the **consumer**, not at the store. `ncl tasks get` shows what is configured; it cannot tell you what the model actually ran. The per-turn ledger can:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "
  SELECT agent_group_id, model, COUNT(*) AS turns
    FROM turn_usage
   WHERE trigger = 'scheduled'
     AND ts > '<ISO timestamp of your upgrade>'
   GROUP BY agent_group_id, model
   ORDER BY turns DESC;"
```

Each row is what a scheduled fire was actually billed as. After the upgrade, an affected group's unpinned series should appear under its configured model rather than under `claude-sonnet-*`.

**Prove the query fires before believing a quiet result.** Run it without the `ts` filter first: if that returns nothing either, you are looking at an empty ledger, not a clean migration. A scheduled series has to have fired at least once since the upgrade before this can show anything — check `ncl tasks get --id <series-id>` for its next run time if the ledger is empty.

## 5. Rollback

Rolling back is re-pinning: `ncl tasks update --id <series-id> --group <group-id> --model sonnet --effort xhigh` restores the previous behavior for that series exactly. There is no global switch to restore, because the thing removed was a hard-coded branch rather than a setting.

**Read this before pinning series defensively.** A pin cannot currently be cleared from the CLI. `--model`/`--effort` values are _merged_ into the stored pin rather than replacing it, and an empty string reads as an absent flag rather than as a clear, so there is no `--model ""` that returns a series to unpinned. Pinning is a one-way door until a clear verb exists. Pin the series you have a reason to pin; leave the rest.

If you need to undo a pin before then, cancel the series and recreate it without `--model`/`--effort` — recreating changes the series id, so anything referencing that id must be updated too.
