# Migration: the `opus` alias means Opus, and an unpinned Claude group runs it

Two things changed together, and only one of them is a default anyone chose.

1. **The defect.** `ANTHROPIC_DEFAULT_OPUS_MODEL` — the SDK short-circuit that decides what the bare word `opus` resolves to — carried **each group's own resolved model**, not an Opus id. So "opus" meant "whatever this group runs". When the unpinned Claude default moved to Sonnet 5 (2026-09-14, `7d0e7df3a`), the `"model": "opus"` pin that `src/group-init.ts` writes into **every** group's `.claude-shared/settings.json` started resolving to `claude-sonnet-5`. Measured in a running container: `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-sonnet-5`. The alias is now the install's Opus constant in every group, and the group's model travels in its own variable, `NANOCLAW_CLAUDE_MODEL`.

2. **The default.** An unpinned Claude group now resolves to `claude-opus-5[1m]`, and Opus's per-family default effort moves `high` → `medium` (that default is now the fleet's baseline burn rather than a deliberate escalation's).

**This changes production behaviour on deploy.** Every Claude group with no model configured moves from Sonnet 5/`xhigh` to Opus 5 [1m]/`medium` on its next spawn, and every `model: opus` subagent or settings pin — in every group, including Sonnet-pinned ones — starts genuinely running Opus.

Pins are data (no deploy); the defaults are code (needs one). **A group you want held on Sonnet must be pinned BEFORE you deploy**, or it runs Opus from the first spawn after the restart.

## 1. Detect

Which Claude groups are unpinned — those are the ones that move.

**Read `groups/<folder>/container.json`, not the DB projection.** The spawn path reads the file (`readContainerConfig`, `src/container-config.ts`), while `ncl groups config get` reports the `container_configs` row (`presentConfig`, `src/cli/resources/groups.ts:68-74`). The two are kept in sync by `ncl groups config update`, but an older DB-only update or a hand edit can leave them disagreeing — and then the projection says "pinned" while the next spawn reads an unpinned file and moves to Opus. Check both `model` and the legacy hand-authored `defaultModel`; either one pins.

```bash
ncl groups list --json | jq -r '.data[] | [.id, .name, .folder] | @tsv' |
while IFS=$'\t' read -r id name folder; do
  f="groups/$folder/container.json"
  [ -f "$f" ] || { printf '%s\t%s\tMISSING %s\n' "$id" "$name" "$f"; continue; }
  jq -r --arg id "$id" --arg name "$name" '
    select((.provider // "claude") == "claude")
    | [$id, $name, (.model // .defaultModel // "(unpinned)")] | @tsv' "$f"
done
```

Run it from the install root (the same directory `groups/` lives in). Where the projection and the file disagree, the file is what runs — and it is also what a drifted install should have corrected, with `ncl groups config update --model <id>`, which writes both.

A per-channel wiring can also pin a model, and it outranks the group config; check any channel you care about:

```bash
ncl wirings list --json | jq -r '.data[] | select(.default_model != null) | [.id, .agent_group_id, .messaging_group_id, .default_model] | @tsv'
```

Anything reading `(unpinned)` with no channel pin runs Opus 5 [1m] at `medium` after deploy.

To see the defect itself in a live container before you deploy:

```bash
docker inspect <container> --format '{{range .Config.Env}}{{println .}}{{end}}' | grep ANTHROPIC_DEFAULT
```

Before this change that prints the group's model in `ANTHROPIC_DEFAULT_OPUS_MODEL`; after it, `claude-opus-5[1m]` in every group, plus a separate `NANOCLAW_CLAUDE_MODEL` holding the group's model.

## 2. Why

A family alias is a promise about a word, not a per-group setting. Sharing one variable between "what `opus` means" and "what this group runs" made the two indistinguishable, so a change to either silently moved the other — which is exactly what happened: nobody decided that `model: opus` should mean Sonnet 5.

Separating them is what makes the default a decision anyone can read: `DEFAULT_OPUS_MODEL` in `src/flag-parser.ts` is what the word means, and `src/claude-spawn-defaults.ts` is what an unpinned group runs.

## 3. Fix — pin first, then deploy

For every group from §1 you want to hold where it is:

```bash
ncl groups config update --id <group-id> --model claude-sonnet-5 --effort xhigh
```

That writes the `container_configs` row **and** mirrors into `groups/<folder>/container.json`, so the pin survives the deploy and takes effect at that group's next spawn. Pin a single channel instead if only one conversation should hold:

```bash
ncl wirings update --id <wiring-id> --default-model claude-sonnet-5 --default-effort xhigh
```

Groups you want on the new default need no action.

Then deploy as usual (the runner source is a boot snapshot, so the host restart ships both halves of this change together):

```bash
sudo systemctl restart nanoclaw-v2
```

## 4. Verify

After the restart, for a container that has respawned:

```bash
docker inspect <container> --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E 'ANTHROPIC_DEFAULT_OPUS_MODEL|NANOCLAW_CLAUDE_MODEL'
```

Expect `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-5[1m]` in **every** Claude group, and `NANOCLAW_CLAUDE_MODEL` equal to that group's pin (or `claude-opus-5[1m]` when unpinned).

What actually ran per turn is recorded, not inferred — the runner logs `query: model=… effort=…` per query (`docker logs <container>`), and `turn_usage` carries the resolved model and effort per turn.

## 5. Rollback

Nothing here is destructive and no data migrates, so rollback is per-group configuration or a revert:

- **One group**: `ncl groups config update --id <group-id> --model claude-sonnet-5 --effort xhigh`, then restart that group (`ncl groups restart --id <group-id>`).
- **The fleet default**: revert `let model = DEFAULT_OPUS_MODEL` to `DEFAULT_SONNET_MODEL` in `src/claude-spawn-defaults.ts`, and `defaultEffortForModel`'s opus branch to `high` in `container/agent-runner/src/providers/claude.ts`, then rebuild and restart.
- **The alias separation is not the part to roll back.** Reverting it restores the defect: the word `opus` goes back to meaning whatever each group runs. If the fleet default is the problem, change the default.
