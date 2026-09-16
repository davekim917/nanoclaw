# Migration: the `opus` alias means Opus, and the fleet defaults move

Two things changed together, and only one of them is a default anyone chose.

1. **The defect.** `ANTHROPIC_DEFAULT_OPUS_MODEL` — the SDK short-circuit that decides what the bare word `opus` resolves to — carried **each group's own resolved model**, not an Opus id. So "opus" meant "whatever this group runs". When the unpinned Claude default moved to Sonnet 5 (2026-09-14, `7d0e7df3a`), the `"model": "opus"` pin that `src/group-init.ts` writes into **every** group's `.claude-shared/settings.json` started resolving to `claude-sonnet-5`. Measured in a running container: `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-sonnet-5`. The alias is now the install's Opus constant in every group, and the group's model travels in its own variable, `NANOCLAW_CLAUDE_MODEL`.

2. **The defaults.** An unpinned **Claude** group now resolves to `claude-opus-5[1m]`, at Opus's unchanged `high` family effort. An unpinned **Codex** group now resolves to `gpt-5.6-sol` at `high` reasoning (was `gpt-5.6-terra` at `xhigh`) — the same tier on both providers, so a group's provider decides what runs it, not what tier it runs at.

**This changes production behaviour on deploy.** Every Claude group with no model configured moves from Sonnet 5/`xhigh` to Opus 5 [1m]/`high` on its next spawn; every Codex group with no model configured moves from Terra/`xhigh` to Sol/`high`; and every `model: opus` subagent or settings pin — in every group, including Sonnet-pinned ones — starts genuinely running Opus. **No pin is ever rewritten**, on either provider.

Pins are data (no deploy); the defaults are code (needs one). **A group you want held where it is must be pinned BEFORE you deploy**, or it runs the new default from the first spawn after the restart.

## 1. Detect

Which Claude groups are unpinned — those are the ones that move.

**Ask the host's own resolver, not a hand-written check.** Two things make a hand-written check wrong, and both bit this doc in review:

- `groups/<folder>/container.json` is authoritative, not the `container_configs` row `ncl groups config get` prints (`presentConfig`, `src/cli/resources/groups.ts:68-74`) — the spawn path reads the file (`readContainerConfig`), and a DB-only update or hand edit can leave the two disagreeing.
- **A present `model` is not necessarily a pin.** `resolveClaudeSpawnDefaults` DROPS a value that is not Claude vocabulary and falls through to the default — so a `gpt-*` id left behind by `--provider claude` (which does not clear the previous provider's model), or any typo, reads as pinned and runs as unpinned.

So run the resolver itself. From the install root:

```bash
cat > ./claude-default-audit.ts <<'TS'
import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from './src/config.js';
import { readContainerConfig } from './src/container-config.js';
import { resolveClaudeSpawnDefaults } from './src/claude-spawn-defaults.js';

for (const folder of fs.readdirSync(GROUPS_DIR)) {
  if (!fs.existsSync(path.join(GROUPS_DIR, folder, 'container.json'))) continue;
  const cfg = readContainerConfig(folder);
  if ((cfg?.provider ?? 'claude') !== 'claude') continue;
  const r = resolveClaudeSpawnDefaults(cfg ?? {});
  console.log([folder, cfg?.model ?? cfg?.defaultModel ?? '(none)', r.model, r.drops.join('; ') || '-'].join('\t'));
}
TS
pnpm exec tsx ./claude-default-audit.ts   # delete the file when you're done
```

Columns: folder, the configured value, **what will actually run**, and any value the resolver refused. Run it on the code you have now to see today's answer, and again after deploy to see the new one — it imports the same function the spawn path calls, so it cannot drift from the vocabulary or the precedence chain.

A row whose third column is not its second is unpinned in effect: either nothing was configured, or the fourth column says what was thrown away.

A per-channel wiring can also pin a model, and it outranks the group config; check any channel you care about:

```bash
ncl wirings list --json | jq -r '.data[] | select(.default_model != null) | [.id, .agent_group_id, .messaging_group_id, .default_model] | @tsv'
```

A Claude group whose third column already reads `claude-opus-5[1m]`, with no channel pin above it, is staying put. Everything else moves to Opus 5 [1m] at `high` after deploy.

**Codex groups** are simpler: their fleet default is applied inside the container, so a group is unpinned exactly when its `container.json` carries neither `providerConfig.model`/`reasoning_effort` nor a top-level `model`/`effort`. List them with:

```bash
for f in groups/*/container.json; do
  jq -r --arg f "$f" 'select(.provider == "codex")
    | [$f, (.providerConfig.model // .model // "(unpinned)"),
           (.providerConfig.reasoning_effort // .effort // "(unpinned)")] | @tsv' "$f"
done
```

Each column moves independently: a row reading `(unpinned)` in column 2 runs `gpt-5.6-sol` after deploy, and `(unpinned)` in column 3 runs `high`. A configured value in either column is a pin and is untouched. (Measured on this install: every Codex group sets `effort` explicitly, so only the model moves.)

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

- **One group**: `ncl groups config update --id <group-id> --model <the model it had> --effort <the effort it had>`, then restart that group (`ncl groups restart --id <group-id>`). Works the same for a Codex group (`--model gpt-5.6-terra --effort xhigh`).
- **The fleet defaults**: revert `let model = DEFAULT_OPUS_MODEL` to `DEFAULT_SONNET_MODEL` in `src/claude-spawn-defaults.ts` for Claude, and `DEFAULT_CODEX_MODEL`/`DEFAULT_CODEX_EFFORT` in `container/agent-runner/src/providers/codex.ts` for Codex, then rebuild and restart. Each provider's default is one constant; neither touches the other.
- **The alias separation is not the part to roll back.** Reverting it restores the defect: the word `opus` goes back to meaning whatever each group runs. If the fleet default is the problem, change the default.
