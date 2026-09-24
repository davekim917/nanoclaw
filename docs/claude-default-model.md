# Migration: the Claude default model

## Current: Opus and Fable default effort `high` (2026-09-24)

This section is the current migration. The model does not move: `DEFAULT_OPUS_MODEL` stays `claude-opus-5-5[1m]` (see **History: 2026-09-22** below). Only the family default effort moves.

**What moves.** `defaultEffortForModel` (`container/agent-runner/src/providers/claude.ts`) returns `high`, not `medium`, for every `claude-opus-*` id, the bare `opus` alias, a turn with no model, and every `claude-fable-*` id. Sonnet stays `xhigh`, and Haiku stays at no effort. A path moves only when **no layer sets an effort**, because the family default is the last step of the runner's chain: `input.effort ?? stickyConfig.effort ?? NANOCLAW_EFFORT_OVERRIDE ?? defaultEffortForModel(model)` (the "Effort precedence" block in the same file). Every explicit pin keeps its value.

**Detect.** These layers pin an effort. A Claude path with none of them set moves to `high`:
- a session sticky `sticky_effort` (chat `-e`). A pure task fire ignores it (`effectiveTurnSettings`, `container/agent-runner/src/poll-loop.ts`);
- `container.json` `providerConfig.effort`;
- channel wiring `default_effort`, then `container.json` `effort`, then legacy `defaultEffort`. The host folds these three into `NANOCLAW_EFFORT_OVERRIDE`, in that order (`effortLayers`, `src/claude-spawn-defaults.ts`);
- a task `effort_pin`;
- a subagent's frontmatter `effort:`.

```bash
grep -HE '"(effort|defaultEffort)":' groups/*/container.json
pnpm exec tsx scripts/q.ts data/v2.db "select mga.id, mga.agent_group_id, mga.default_effort from messaging_group_agents mga where coalesce(mga.default_effort,'') <> ''"
ncl tasks list --json   # rows with effort_pin
grep -rHE '^effort:' groups/*/.claude/agents                                    # project scope
grep -rHE '^effort:' data/v2-sessions/*/.claude-shared/agents 2>/dev/null        # user scope (per group)
find ~/plugins -type d -name agents -not -path '*/node_modules/*' -exec grep -rHE '^effort:' {} +   # plugin-mounted roles
# Session stickies (every session's outbound.db; unreadable DBs are reported):
pnpm exec tsx -e "import Database from 'better-sqlite3'; import fs from 'fs'; for (const g of fs.readdirSync('data/v2-sessions')) { let ss = []; try { ss = fs.readdirSync('data/v2-sessions/' + g) } catch { continue } for (const s of ss) { const p = 'data/v2-sessions/' + g + '/' + s + '/outbound.db'; if (!fs.existsSync(p)) continue; try { const d = new Database(p, { readonly: true }); for (const r of d.prepare(\"select value from session_state where key = 'sticky_effort'\").all()) console.log(g, s, r.value); d.close() } catch (e) { if (!/no such table/.test(e.message)) console.error('UNREADABLE', p, e.message) } } }"
```

**Why.** Operator observation, 2026-09-24: after the 2026-09-22 move to `medium`, work reviewed by a second agent needed rework noticeably more often. That is not measured, and it is confounded: the same deploy moved Opus 5 to Opus 5.5. The cost headroom is measured. Over `turn_usage` since 2026-09-15 (human, on_wake and scheduled turns), Opus 5.5 at `medium` averaged $1.88 per turn, against $5.74 for Opus 5 at `high`, so `high` on Opus 5.5 is expected to stay below the pre-09-22 cost.

**Fix: keep `medium` on a path.** Set it explicitly before deploying:

```bash
ncl groups config update --id <group-id> --effort medium        # group
ncl wirings update <wiring-id> --default-effort medium          # one channel
ncl tasks update --id <series> --group <group-id> --effort medium
```

**Deploy.** The change is agent-runner source only. It adds no dependencies, so the image needs no rebuild. The runner source is a boot snapshot taken at host start (`src/agent-runner-source.ts`), so a **host restart** is what makes it live. Running containers are adopted across the restart and keep the snapshot they spawned with. They move as they respawn; recycle one sooner with `ncl groups restart --id <group-id>`.

**Verify.** A turn from a container spawned after the restart, for a path with no effort pin, writes `turn_usage` with `effort = 'high'` (and `effort_requested = 'high'`) on `claude-opus-5-5[1m]`:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "select model, effort, count(*), round(avg(cost_usd),3) from turn_usage where provider='claude' and ts > '<restart time>' group by 1,2"
```

**Success check (one week after the restart).** The rework signal was never measured directly, so judge this change on two numbers from `turn_usage`, for the coordinator group whose rework prompted the change (main-model rows only; baselines below are from the install that made this decision). Compare a 7-day window after the restart against the baselines below:

| Metric | Opus 5 / `high` (2026-09-15 → 09-22) | Opus 5.5 / `medium` (09-22 → 09-24) |
|---|---|---|
| Turns per thread that has a human turn (the rework proxy: extra agent-initiated turns per human ask) | 4.97 (79 threads; 4.72 human) | 5.66 (44 threads; 4.68 human) |
| Average cost per turn | $5.04 (623 turns) | $2.13 (255 turns) |

```bash
# rework proxy: turns per human-touched thread, and how many of them were human
pnpm exec tsx scripts/q.ts data/v2.db "with s as (select session_id, sum(trigger='human') h, count(*) n from turn_usage where agent_group_id='<group-id>' and model='claude-opus-5-5[1m]' and ts > '<restart>' group by 1 having h>0) select count(*), round(avg(n),2), round(avg(h),2) from s"
# cost per turn
pnpm exec tsx scripts/q.ts data/v2.db "select effort, count(*), round(avg(cost_usd),3) from turn_usage where agent_group_id='<group-id>' and model='claude-opus-5-5[1m]' and ts > '<restart>' group by 1"
```

It worked if turns per human-touched thread fall back toward 5.0, with human turns per thread flat, and cost per turn stays well under the Opus 5 / `high` baseline. If turns per thread don't fall, `high` isn't buying less rework: roll back, or look at the model switch instead. The medium-era baseline covers only about two days, so treat it as a direction, not a precise number.

**Rollback.** Change `defaultEffortForModel` back to `medium` for opus, no-model and fable, then redeploy (host restart). No pin was written, so there is nothing to unpin.

## History: 2026-09-22 — Opus 5.5 at `medium`

_Historical. The effort half of this section (`medium`) is superseded by the section above; the model half (`claude-opus-5-5[1m]`) is current._

Everything under the older **History** further below describes the 2026-09-16 change and its values. Only that section's §1 audit script is reused here, as a tool.

**What moves.** `DEFAULT_OPUS_MODEL` (`src/flag-parser.ts`) is now `claude-opus-5-5[1m]`, and the Opus family default effort (`defaultEffortForModel`, `container/agent-runner/src/providers/claude.ts`) is now `medium`, down from `high`. On deploy, every Claude path whose model is the Opus default or an `opus` alias runs Opus 5.5. That covers primary groups, declared `providerFallback`s, `-m opus`, and `opus` task, wiring and subagent pins. Every Opus path with no effort configured runs `medium`, and that includes an explicit `claude-opus-5[1m]` pin, because the family default keys on every `claude-opus-*` id. Codex and OpenCode defaults do not move.

**Detect.** A Claude chat turn resolves its model in this order: `-m` (the turn's flag or the session sticky), then `container.json` `providerConfig.model`, then channel wiring `default_model`, then `container.json` `model`, then the install default. That is `input.model ?? stickyConfig.model ?? NANOCLAW_CLAUDE_MODEL` at `container/agent-runner/src/providers/claude.ts:2770`; the host folds wiring and group `model` into that env var. A pure scheduled-task fire resolves: task pin, `providerConfig.model`, group `model`, then the install default. It ignores session stickies (`container/agent-runner/src/poll-loop.ts:4027-4032`), and a task session has no channel wiring. Effort resolves the same way through the matching `effort` fields, then the family default. A path **moves to Opus 5.5** when that chain ends at the install default or at the word `opus`. A frozen id such as `claude-opus-5[1m]` keeps its model. A path **moves to `medium`** when it resolves to any `claude-opus-*` id and no layer sets an effort, and that includes frozen `claude-opus-5[1m]` pins. Check every layer:

```bash
# 1. Groups and every declared providerFallback, answered by the spawn resolver itself:
#    run the audit script in History §1 unchanged; "(none)" or a refusal = unpinned.
# 1b. providerConfig pins (they outrank every wiring; change them here, not on a wiring):
node -e 'const fs=require("fs");for(const g of fs.readdirSync("groups")){let c;try{c=JSON.parse(fs.readFileSync(`groups/${g}/container.json`,"utf8"))}catch{continue}const p=c.providerConfig||{};if(p.model||p.effort)console.log(g,p.model||"-",p.effort||"-")}'
# 2. Channel wirings, including effort-only ones:
pnpm exec tsx scripts/q.ts data/v2.db "select mga.id, mg.name, ag.folder, mga.default_model, mga.default_effort from messaging_group_agents mga join messaging_groups mg on mg.id = mga.messaging_group_id join agent_groups ag on ag.id = mga.agent_group_id where coalesce(mga.default_model,'') <> '' or coalesce(mga.default_effort,'') <> ''"
# 3. Every live task series; "(group)" = no pin, so it follows its group's model/effort:
ncl tasks list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);for(const t of (Array.isArray(d)?d:d.data)) console.log(t.agent_group_id, t.series_id, t.model_pin||"(group)", t.effort_pin||"(group)")})'
# 4. Session stickies (every session's outbound.db, one process; unreadable DBs are reported):
pnpm exec tsx -e "import Database from 'better-sqlite3'; import fs from 'fs'; for (const g of fs.readdirSync('data/v2-sessions')) { let ss = []; try { ss = fs.readdirSync('data/v2-sessions/' + g) } catch { continue } for (const s of ss) { const p = 'data/v2-sessions/' + g + '/' + s + '/outbound.db'; if (!fs.existsSync(p)) continue; try { const d = new Database(p, { readonly: true }); for (const r of d.prepare(\"select key, value from session_state where key in ('sticky_model','sticky_effort')\").all()) console.log(g, s, r.key, r.value); d.close() } catch (e) { if (!/no such table/.test(e.message)) console.error('UNREADABLE', p, e.message) } } }"
```

A wiring with only `default_effort` keeps that effort and takes its model from the group. A sticky or pin reading `opus` moves to 5.5, and a frozen id does not.

**Why.** Opus 5.5 costs $4/$20 per MTok, against Opus 5's $5/$25, and `medium` is its API default. The container's claude-code CLI must be at least 2.1.280 to know the id, and this change pins exactly that version (with agent SDK 0.3.280 and codex-cli 0.156.0, recorded in `versions.json`).

**Fix: keep Opus 5/`high` on a path, before deploying.** Pins are data, so they take effect without a deploy:

```bash
ncl groups config update --id <group-id> --model claude-opus-5[1m] --effort high      # a whole group
ncl wirings update <wiring-id> --default-model claude-opus-5[1m] --default-effort high # one channel (no effect where providerConfig sets a value)
ncl tasks update --id <series> --group <group-id> --model claude-opus-5[1m] --effort high
```

A group whose `container.json` has `providerConfig.model`/`.effort` is governed by those values ahead of any wiring. Edit them in the file to hold or move that group. A declared `providerFallback` keeps Opus 5 only if its own `model`/`effort` in `container.json` say so.

**Deploy.** Run `scripts/deploy.sh`. It pulls, builds the host, and rebuilds the agent image, because `container/` changed. Then it restarts. The image rebuild is required: the SDK bump changes the runner's deps hash, and `src/agent-runner-image-check.ts` refuses every spawn until the image matches.

**Verify.**

```bash
docker inspect <fresh claude container> --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E 'ANTHROPIC_DEFAULT_OPUS_MODEL|NANOCLAW_CLAUDE_MODEL'
pnpm exec tsx scripts/q.ts data/v2.db "select model, effort, count(*) from turn_usage where ts > '<deploy time>' group by 1,2"
```

Expect `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-5-5[1m]` in every Claude container, with `NANOCLAW_CLAUDE_MODEL` equal to the group's pin or to `claude-opus-5-5[1m]` when unpinned. New `turn_usage` rows for unpinned work should read `claude-opus-5-5[1m]` / `medium`. Only `ANTHROPIC_DEFAULT_OPUS_MODEL` proves the build: if it still reads `claude-opus-5[1m]`, the container was spawned from the old build or image. `NANOCLAW_CLAUDE_MODEL=claude-opus-5[1m]` on a fresh container is simply a path pinned by the Fix commands above.

**Rollback.**
- **One path**: apply the Fix commands above, then `ncl groups restart --id <group-id>`.
- **The fleet default**: set `DEFAULT_OPUS_MODEL` back to `claude-opus-5[1m]`, and set the `claude-opus-*` branch of `defaultEffortForModel` back to `'high'`. Then redeploy with `scripts/deploy.sh`, which rebuilds the image because `container/` changed. The CLI/SDK pins can stay: 2.1.280 still serves Opus 5.

---

## History: 2026-09-16 — the `opus` alias means Opus, and the fleet defaults move

_Historical. The values below (Opus 5/`high`, Codex Sol/`high`) were current on 2026-09-16. They are superseded for Claude by the section above._

Two things changed together, and only one of them is a default anyone chose.

1. **The defect.** `ANTHROPIC_DEFAULT_OPUS_MODEL` — the SDK short-circuit that decides what the bare word `opus` resolves to — carried **each group's own resolved model**, not an Opus id. So "opus" meant "whatever this group runs". When the unpinned Claude default moved to Sonnet 5 (2026-09-14, `7d0e7df3a`), the `"model": "opus"` pin that `src/group-init.ts` writes into **every** group's `.claude-shared/settings.json` started resolving to `claude-sonnet-5`. Measured in a running container: `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-sonnet-5`. The alias is now the install's Opus constant in every group, and the group's model travels in its own variable, `NANOCLAW_CLAUDE_MODEL`.

2. **The defaults.** An unpinned **Claude** group now resolves to `claude-opus-5[1m]`, at Opus's unchanged `high` family effort. An unpinned **Codex** group now resolves to `gpt-5.6-sol` at `high` reasoning (was `gpt-5.6-terra` at `xhigh`) — the same tier on both providers, so a group's provider decides what runs it, not what tier it runs at.

**This changes production behaviour on deploy.** Every Claude group with no model configured moves from Sonnet 5/`xhigh` to Opus 5 [1m]/`high` on its next spawn; every Codex group with no model configured moves from Terra/`xhigh` to Sol/`high`; and every `model: opus` subagent or settings pin — in every group, including Sonnet-pinned ones — starts genuinely running Opus. **No pin is ever rewritten**, on either provider.

Pins are data (no deploy); the defaults are code (needs one). **A group you want held where it is must be pinned BEFORE you deploy**, or it runs the new default from the first spawn after the restart.

## 1. Detect

Which groups move — and it is **not** just the Claude ones. A declared `providerFallback` resolves through these same defaults, so a Codex group that falls back to Claude moves on the Claude default, and a Claude group that falls back to Codex moves on the Codex one. Measured on this install: 14 fallback paths resolve through a default that moves, and a primary-provider-only check lists none of them.

Three things make a hand-written check wrong, and all three were found in review of this PR:

- `groups/<folder>/container.json` is authoritative, not the `container_configs` row `ncl groups config get` prints (`presentConfig`, `src/cli/resources/groups.ts:68-74`) — the spawn path reads the file (`readContainerConfig`), and a DB-only update or hand edit can leave the two disagreeing.
- **A present `model` is not necessarily a pin.** `resolveClaudeSpawnDefaults` DROPS a value that is not Claude vocabulary and falls through to the default — so a `gpt-*` id left behind by `--provider claude` (which does not clear the previous provider's model), or any typo, reads as pinned and runs as unpinned.
- **The primary provider is not the only thing that runs.** See above.

So run the resolver itself, over every group and its fallback. From the install root:

```bash
cat > ./claude-default-audit.ts <<'TS'
import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from './src/config.js';
import { readContainerConfig } from './src/container-config.js';
import { resolveClaudeSpawnDefaults } from './src/claude-spawn-defaults.js';

// Codex's fleet defaults live in the container package (a separate Bun tree
// this host script cannot import), so read them out of their single source
// rather than restating them. Loud on a rename; never silently stale.
const codexSrc = fs.readFileSync('container/agent-runner/src/providers/codex.ts', 'utf8');
const pick = (name: string) => {
  const m = new RegExp(`export const ${name} = '([^']+)'`).exec(codexSrc);
  if (!m) throw new Error(`${name} not found — read container/agent-runner/src/providers/codex.ts`);
  return m[1];
};
const CODEX_MODEL = pick('DEFAULT_CODEX_MODEL');
const CODEX_EFFORT = pick('DEFAULT_CODEX_EFFORT');

// What a spawn on `provider` resolves to, given the model/effort that reaches
// it. The claude half calls the host's own resolver; the codex half applies
// its constants the way the provider does (a pin always wins). OpenCode has
// its own default (DEFAULT_OPENCODE_MODEL, src/providers/opencode.ts) that
// this change does not touch — say so rather than running it through the
// wrong resolver.
const resolve = (provider: string, model?: string | null, effort?: string | null) => {
  if (provider === 'codex') return { model: model ?? CODEX_MODEL, effort: effort ?? CODEX_EFFORT, drops: [] as string[] };
  if (provider !== 'claude') return { model: model ?? "(this provider's own default)", effort: effort ?? undefined, drops: [] as string[] };
  return resolveClaudeSpawnDefaults({ model, effort } as never);
};

const print = (folder: string, kind: string, provider: string, configured: string | null, effort: string | null) => {
  const r = resolve(provider, configured, effort);
  console.log(
    [folder, kind, provider, configured ?? '(none)', r.model, r.effort ?? '(family default)', r.drops.join('; ') || '-'].join('\t'),
  );
};

for (const folder of fs.readdirSync(GROUPS_DIR).sort()) {
  if (!fs.existsSync(path.join(GROUPS_DIR, folder, 'container.json'))) continue;
  const cfg = readContainerConfig(folder) as Record<string, any> | undefined;
  if (!cfg) continue;
  // providerConfig is the provider's OWN sticky config, and the two providers
  // rank it oppositely: claude's `stickyConfig` beats the env the host sends
  // (claude.ts `input.model ?? this.stickyConfig.model ?? env`), while codex's
  // top-level model reaches providerConfig through config.ts and wins. Its
  // effort key differs too — `effort` on claude, `reasoning_effort` on codex.
  const provider = cfg.provider ?? 'claude';
  const pc = cfg.providerConfig ?? {};
  const [model, effort] =
    provider === 'claude'
      ? [pc.model ?? cfg.model ?? cfg.defaultModel ?? null, pc.effort ?? cfg.effort ?? cfg.defaultEffort ?? null]
      : [cfg.model ?? cfg.defaultModel ?? pc.model ?? null, cfg.effort ?? cfg.defaultEffort ?? pc.reasoning_effort ?? null];
  print(folder, 'primary', provider, model, effort);
  // A declared fallback carries its OWN model/effort and nothing else: the
  // primary's are discarded when it applies (src/provider-fallback.ts), so it
  // must be resolved from the fallback's own fields, never the group's.
  const fb = cfg.providerFallback;
  if (fb?.provider) print(folder, 'fallback', fb.provider, fb.model ?? null, fb.effort ?? null);
}
TS
pnpm exec tsx ./claude-default-audit.ts   # delete the file when you're done
```

Columns: folder, primary-or-fallback, provider, that path's own configured value, **what will actually run**, the effort, and anything the resolver refused. A path is unpinned — and moves — when its fourth column reads `(none)`, **or** when the last column names a refusal: a value the resolver threw away (a `gpt-*` id left behind by `--provider claude`, a typo) leaves the path running the default just as surely as configuring nothing. Short of that, a fifth column that merely *differs* from the fourth is usually benign: an alias expanding (`opus` → `claude-opus-5[1m]`), or an OpenCode row, which differs by construction because that provider's default is out of scope here and does not move. `(family default)` in the effort column means no effort is exported and the provider picks its own (Opus → `high`, Sonnet → `xhigh`, Haiku → none).

Run it on the code you have now to see today's answers, and again after deploy to see the new ones. It calls the same resolver the spawn path calls and reads the Codex constants out of their own source, so the vocabulary and the install defaults cannot drift from it. The one thing it restates is the per-provider ranking of `providerConfig` against the top-level fields (see the comment in the loop) — if a group ever grows a `providerConfig` block, re-read that comment before trusting the row — against `container/agent-runner/src/providers/claude.ts` for the Claude side, and against `src/container-runner.ts` (the host ships the top-level model as the channel-shaped `NANOCLAW_CODEX_MODEL_OVERRIDE`, which is why it outranks `providerConfig`) for the Codex side. `container/agent-runner/src/config.ts` alone reads the opposite way.

A per-channel wiring can also pin a model, and it outranks the group config; check any channel you care about:

```bash
ncl wirings list --json | jq -r '.data[] | select(.default_model != null) | [.id, .agent_group_id, .messaging_group_id, .default_model] | @tsv'
```

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
