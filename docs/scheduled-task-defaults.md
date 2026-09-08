# Migration: scheduled tasks lose their Claude-only model/effort default

Until this release, a scheduled-task fire on a **Claude** group with no `--model`/`--effort` pin of its own was forced onto `sonnet` at `xhigh` effort, regardless of what that group was configured to run. That branch is deleted. An unpinned scheduled task now resolves exactly like interactive chat: the group's configured model and effort, else the provider's per-family default.

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
  .[] | select(.model_pin == null and .effort_pin == null)
      | [.agent_group_id, .series_id, .prompt] | @tsv'
```

Only rows whose group runs **Claude** are affected. Check a group's provider with `ncl groups config get --id <group-id>` — and note that `container.json` is the authority for what actually boots, not the `container_configs` projection.

**Do not rely on a count from someone else's install.** On the reference install this was 31 of 46 armed series at the time of writing, but the number drifts as tasks are created and cancelled. The stable shape is: _every unpinned series on a Claude group moves to that group's default._

## 2. Why

The old default was wrong in three separate ways, and they compound:

- **It was invisible.** Nothing in `ncl tasks get` or the task's own definition said `sonnet`/`xhigh`. The value was applied deep in the runner's poll loop, so the only way to discover it was to read the source.
- **It contradicted the group's own configuration.** An operator who set a group to Opus got Opus in chat and Sonnet on a schedule, with no indication the two differed.
- **It was Claude-only.** The same unpinned task on a Codex group already resolved to the group default. One provider silently behaved differently from the others.

A scheduled task is a way to _run_ an agent, not a different agent. It should not have its own model policy. The pin exists for the case where a specific task genuinely needs a specific model — and a pin, unlike the deleted default, is visible in `ncl tasks list`.

## 3. Fix

**The default action is no action.** Unpinned series pick up their group's configuration on their next fire.

If a specific series genuinely needs the old model — a long-running monitor tuned to Sonnet's latency, a high-volume series where Opus per-fire cost is unwelcome — pin it deliberately:

```bash
ncl tasks update --id <series-id> --group <group-id> --model sonnet --effort xhigh
```

That reproduces the previous behavior exactly, and now it is _visible_ in `ncl tasks list` as a pin rather than being an invisible default.

`ncl tasks repin`, also new in this release, is **not** the tool for this migration: it retargets pins that already exist (match on a current pin, set a new one), and these series have no pin to match. It is the tool for a later model bump or a provider switch.

**Nothing is auto-pinned on upgrade, deliberately.** Freezing every unpinned series onto a model nobody chose would be the same defect this release closes — and see the rollback caveat below before pinning defensively.

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
