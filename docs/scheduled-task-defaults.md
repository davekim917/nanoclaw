# Migration: scheduled tasks use the group default, and stop inheriting chat stickies

> **Sequence:** pins first, then deploy. See §3 — this is the opposite of a fix-it-afterwards migration, because pins are data and the removal is code.

Until this release, a scheduled-task fire on a **Claude** group with no `--model`/`--effort` pin of its own was forced onto `sonnet` at `xhigh` effort, regardless of what that group was configured to run. That branch is deleted. An unpinned scheduled task now resolves to the group's configured model and effort, else the provider's per-family default — the same place interactive chat starts from.

One deliberate difference from chat: a **pure** task wake does not inherit a per-session sticky model or effort. If a human typed `-m opus` in that thread, chat keeps using Opus and the unpinned task still fires on the group default. A batch that mixes real chat with a task is a human conversation the task rode along with, and keeps the sticky — only a task-only wake is suppressed.

**Two changes with two different scopes — this matters for what you need to inventory:**

| change                                                        | applies to                                                      |
| ------------------------------------------------------------- | --------------------------------------------------------------- |
| removing the hardcoded `sonnet`/`xhigh` default               | **Claude groups only** — no other provider ever had that branch |
| no longer inheriting a per-session sticky on a pure task wake | **all three providers** — Claude, Codex, and OpenCode           |

The sticky suppression is deliberately provider-neutral: `getStickyModel` is not Claude-specific, so an unpinned Codex or OpenCode task inherited an interactive `-m` exactly the same way and now does not. **Inventory every group, not just your Claude ones.**

A task's own pin still wins over everything, unchanged — which is what makes the practical impact small for most installs (see the measured state below).

### Measured state on this install, 2026-09-08

Verified by reading `container.json` for every group and cross-referencing live series (not inferred):

- 15 non-Claude groups exist (8 Codex, 7 OpenCode).
- Exactly **one** of them has a live recurring series: `illysium-codex` → `lab-weekly-build-ollie-o-839c`.
- That series is **pinned** to `gpt-6-astra`/`high`, and a pin wins under the new code exactly as it did under the old.

**So zero non-Claude series change behaviour here today.** That is a fact about the current fleet, not a property of the change. Re-check it if you add an unpinned Codex or OpenCode scheduled task — such a task _would_ be affected, and nothing warns you.

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

That inventory covers **every** provider, which is what you want: the sticky-inheritance half of this change applies to all three. To see which provider each affected group runs — the Claude ones additionally lose the `sonnet`/`xhigh` default — join against the group config:

```bash
ncl tasks list --json | jq -r '
  .data[] | select(.model_pin == null and .effort_pin == null)
      | [.agent_group_id, .series_id] | @tsv' \
| while IFS=$'\t' read -r g s; do
    p=$(ncl groups config get --id "$g" --json | jq -r '.data.provider // "claude"')
    printf '%s\t%s\t%s\n' "$p" "$g" "$s"
  done | sort
```

`ncl groups list --json` does **not** carry the provider, which is why this joins through `groups config get` per group. Note `container.json` is the authority for what actually boots, not the `container_configs` projection.

**Do not rely on a count from someone else's install.** The numbers drift as tasks are created and cancelled. The stable shapes are:

- _Every unpinned series on a **Claude** group moves to that group's configured default._
- _Every unpinned series on **any** provider stops inheriting a per-session sticky model/effort._

## 2. Why

The old default was wrong in three separate ways, and they compound:

- **It was invisible.** Nothing in `ncl tasks get` or the task's own definition said `sonnet`/`xhigh`. The value was applied deep in the runner's poll loop, so the only way to discover it was to read the source.
- **It contradicted the group's own configuration.** An operator who set a group to Opus got Opus in chat and Sonnet on a schedule, with no indication the two differed.
- **It was Claude-only.** The same unpinned task on a Codex group already resolved to the group default. One provider silently behaved differently from the others.

  (This bullet is about the removed _default_ only. The sticky-inheritance half was never Claude-specific — Codex and OpenCode task wakes inherited an interactive `-m` too, and stop doing so with this change. See the scope table at the top.)

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
