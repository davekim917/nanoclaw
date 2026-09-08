# Migration: switching a group's provider with pinned scheduled tasks

A scheduled task can pin a model and effort for its own fires (`ncl tasks create/update --model/--effort`). That pin is validated against the agent group's provider **at create time and never again**. Provider vocabularies do not overlap — `gpt-6-astra` is meaningful to Codex and meaningless to Claude — so migrating a group from one provider to another used to leave every pinned series holding a model the new provider cannot run. The series kept firing, kept failing, and the pin kept reading as valid.

That is how one recurring task failed 21 times over 14 hours after its group moved from Codex to Claude.

`ncl groups config update --provider <x>` now audits every pending and paused series first and **refuses** the switch if any pin would be stranded, naming each series, its pin, and why the pin is invalid under the new provider.

This doc is the migration path, written to be handed to a coding agent verbatim: detect → why → fix → verify → rollback.

## 1. Detect

You do not need to go looking — the switch tells you. Run it and read the refusal:

```bash
ncl groups config update --id <group-id> --provider <new-provider>
```

If nothing is stranded the switch proceeds normally. If something is, the command refuses and lists each offending series.

To inspect pins before attempting a switch, `ncl tasks list` shows a `PIN` column (`model@effort`, `-` when unpinned):

```bash
ncl tasks list --group <group-id>
ncl tasks list --group <group-id> --json | jq -r '
  .[] | select(.model_pin != null or .effort_pin != null)
      | [.series_id, .model_pin, .effort_pin] | @tsv'
```

Note `container.json` is the authority for which provider a group actually runs; the `container_configs` DB row is a projection that can lag. The audit reads the file, as does the spawn path.

## 2. Why the switch refuses instead of warning

A warning would be printed once, into a terminal, at the moment the operator is busy doing something else — and the consequence arrives hours later as a task that silently fails forever. The failure mode this exists to prevent is _invisible_, so the remedy has to be _blocking_.

Refusing is only defensible because there is a remedy that does not require hand-editing every series, which is why `ncl tasks repin --target-provider` exists. Without it, refusing would simply wedge the operator: `ncl tasks update --model` validates against the group's **current** provider, so you could not pre-write the new provider's models before switching.

**Pins are never rewritten automatically.** A pin exists to hold a model steady; a pin that changes by itself is not a pin. The operator chooses the new value.

## 3. Fix

Re-target the stranded pins to models the destination provider can run, then switch:

```bash
# Preview first — nothing is written.
ncl tasks repin --group <group-id> --target-provider <new-provider> \
  --from-model gpt-6-astra --to-model claude-sonnet-5 --dry-run

# Apply.
ncl tasks repin --group <group-id> --target-provider <new-provider> \
  --from-model gpt-6-astra --to-model claude-sonnet-5

# Now the switch is accepted.
ncl groups config update --id <group-id> --provider <new-provider>
```

`--target-provider` tells `repin` to validate replacements against the provider you are migrating **to**, not the one the group still has. Matching still happens in the group's current vocabulary, so `--from-model` is the value as stored today.

Repeat for each distinct stranded pin — the refusal lists them. Effort pins are re-targeted the same way with `--from-effort`/`--to-effort`; note the vocabularies differ (Claude takes `xhigh` and rejects `ultra`, Codex takes `ultra` and rejects `xhigh`, OpenCode accepts only `low`/`medium`/`high`/`max`).

**Validation is all-or-nothing; the writes are not.** Every candidate is validated before the first write, so an invalid replacement refuses the whole command without touching anything. The writes themselves land per series in separate session DBs, with no transaction spanning them — if one fails after earlier ones succeeded, the result names which series were re-pinned and which were not. Re-run with the remaining `--from-model` to finish.

## 4. Verify

Verify at the **consumer**, not the store. `ncl tasks get` shows what is configured; it cannot tell you what the model actually ran. The per-turn ledger can:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "
  SELECT agent_group_id, provider, model, COUNT(*) AS turns
    FROM turn_usage
   WHERE trigger = 'scheduled'
     AND agent_group_id = '<group-id>'
     AND ts > '<ISO timestamp of the switch>'
   GROUP BY agent_group_id, provider, model
   ORDER BY turns DESC;"
```

After the switch, scheduled fires for that group should appear under the new provider and the models you re-pinned to.

**Prove the query fires before believing a quiet result.** Run it without the `ts` filter first: if that also returns nothing, you are looking at an empty ledger rather than a clean migration. A series has to have fired at least once since the switch — check `ncl tasks get --id <series-id>` for its next run time.

## 5. Rollback

Rollback is the same two steps as the migration, in the same order: **re-pin first, then switch.** The refusal protects the switch in both directions, so going back with the provider update first would simply be refused — the tasks are now carrying destination-provider pins that are invalid under the old provider.

```bash
# 1. Re-pin back, validating against the provider you are returning TO.
ncl tasks repin --group <group-id> --target-provider <old-provider> \
  --from-model claude-sonnet-5 --to-model gpt-6-astra --dry-run

ncl tasks repin --group <group-id> --target-provider <old-provider> \
  --from-model claude-sonnet-5 --to-model gpt-6-astra

# 2. Then switch back.
ncl groups config update --id <group-id> --provider <old-provider>
```

There is no "reverse order" version of this. `repin --target-provider` exists precisely so the pins can be made valid for a provider the group does not have yet, which is what makes both the migration and its rollback executable at all.

**Known limitation — a pin cannot be cleared.** `--model`/`--effort` are _merged_ into the stored pin rather than replacing it, and an empty flag reads as absent, so there is no `--model ""` that returns a series to unpinned. Rollback can change a pin to a different value but cannot remove it. If you need a series genuinely unpinned, cancel and recreate it without `--model`/`--effort` — which changes the series id, so update anything referencing it.
