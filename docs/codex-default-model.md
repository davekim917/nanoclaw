# Migration: the Codex default model

## Current: GPT-6.1 Sol at `high` (2026-09-29)

This section is the current migration. Effort does not move, and Luna, Astra and Terra do not move.

**What moves.** `DEFAULT_CODEX_MODEL` (`container/agent-runner/src/providers/codex.ts`) is `gpt-6.1-sol`, replacing `gpt-6-sol`, and the `sol` family alias (`CODEX_FAMILY_DEFAULTS`, `src/flag-parser.ts`) names it too, so the unpinned default and a `sol` pin run the same model (`setup/lib/codex-model-min-cli.test.ts` fails when they differ). New pinned alias: `gpt6.1-sol`; `gpt6-sol` still pins `gpt-6-sol`. `DEFAULT_CODEX_EFFORT` stays `high`: OpenAI's own API default for this model is `medium`, and the fleet's `high` is operator policy.

On deploy, three kinds of Codex path move to GPT-6.1 Sol:
- any Codex group whose `container.json` sets no model (`model`, `providerConfig.model`, or the legacy `defaultModel`);
- any Claude group whose `providerFallback` is `{"provider": "codex"}` with no `model`;
- any wiring, task, group or sticky whose model is stored as the word `sol`, because family words resolve in the container at use.

A pin stored as a full id (`gpt-6-sol`, or a 5.6 id) does not move.

**Requires codex-cli ≥ 0.159.0 in the agent image.** Measured on 2026-09-29 with ChatGPT-account auth, which is how the fleet's Codex runs, at `high` effort: `gpt-6.1-sol` returns HTTP 400 ("The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account") on codex-cli 0.156.0, 0.157.1 and 0.158.0, and runs on 0.159.0. The control `gpt-6-sol` runs on both 0.156.0 and 0.159.0. Neither OpenAI's model page nor the 0.157 to 0.159 release notes state a minimum version, so the floor is measured, not documented. The image pin moves 0.156.0 → 0.159.0 in this change (`container/Dockerfile` `CODEX_VERSION`, recorded in `versions.json` as `codex-cli`), and the host CLI moves to the same version.

**A Codex-only image bump does not make spawns refuse.** `src/agent-runner-image-check.ts` compares a hash of the runner's `package.json` and `bun.lock`, and a Codex CLI bump changes neither. A group still on an image below 0.159.0 therefore spawns normally, sends `gpt-6.1-sol` to the old CLI, and every turn fails with the 400. Check the running CLI, not the spawn.

**Detect.** From the install root:

```bash
# Codex primaries and Codex fallbacks with no model (these move):
node -e 'const fs=require("fs");for(const g of fs.readdirSync("groups")){let c;try{c=JSON.parse(fs.readFileSync(`groups/${g}/container.json`,"utf8"))}catch{continue}const fb=c.providerFallback||{};if(String(c.provider||"").toLowerCase()==="codex"&&!c.model&&!c.defaultModel&&!(c.providerConfig||{}).model)console.log("primary",g);if(String(fb.provider||"").toLowerCase()==="codex"&&!fb.model)console.log("fallback",g)}'
# Pins stored as the word `sol` (these move) and full-id `gpt-6-sol` pins (these do NOT): wirings, tasks, container.json. The task list shows pending and paused series only, so repeat that check once in-flight fires have finished and before you deploy
pnpm exec tsx scripts/q.ts data/v2.db "select id, agent_group_id, default_model, default_effort from messaging_group_agents where lower(default_model) in ('sol','gpt-6-sol')"
ncl tasks list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);for(const t of (Array.isArray(d)?d:d.data)) if(/^(sol|gpt-6-sol)$/i.test(t.model_pin||"")) console.log(t.agent_group_id,t.series_id,t.model_pin,t.effort_pin||"-")})'
grep -HiE '"(model|defaultModel)": *"(sol|gpt-6-sol)"' groups/*/container.json
# Session stickies: run the sticky sweep in History: 2026-09-22 (Detect) with `value in ('sol','gpt-6-sol')`.
```

A session sticky moves only when it is stored as `sol`; clearing one is the History section's note (no `ncl` verb; write `outbound.db` only while that session's container is stopped). A pure task fire ignores session stickies (`effectiveTurnSettings`, `container/agent-runner/src/poll-loop.ts`). For a Codex group the order is sticky, wiring, `container.json` `model`, legacy `defaultModel`, `providerConfig.model`, host `CODEX_MODEL` env, then the install default, so a `providerConfig.model` counts only when no wiring, `model` or `defaultModel` is set. A host `CODEX_MODEL` env would override the default for every Codex group with nothing more specific set; check it before deploying:

```bash
tr '\0' '\n' < /proc/$(systemctl show -p MainPID --value nanoclaw-v2)/environ | grep -E '^CODEX_MODEL='
grep -E '^\s*CODEX_MODEL=' .env
```

**Why.** OpenAI lists `gpt-6.1-sol` with reasoning efforts `low`, `medium` (default), `high`, `xhigh` and `max`, a 1,050,000-token context, 128,000 max output tokens, $2 / $10 per MTok input / output, and an April 30, 2026 knowledge cutoff (developers.openai.com/api/docs/models/gpt-6.1-sol). `setup/lib/codex-model-min-cli.test.ts` fails if the default or the `sol` alias names a model while `versions.json` pins an older CLI than that model's measured minimum.

**Fix: keep GPT-6 Sol on a path, before deploying.** Pins are data and need no deploy:

```bash
ncl groups config update --id <group-id> --model gpt-6-sol --effort high
ncl wirings update <wiring-id> --default-model gpt-6-sol
ncl tasks update --id <series> --group <group-id> --model gpt-6-sol
```

For a fallback, set `providerFallback.model` in that group's `container.json`. `gpt-6-sol` stays served on codex-cli 0.159.0.

**Deploy.** Run `scripts/deploy.sh` on a build whose image pins codex-cli ≥ 0.159.0; it rebuilds the image because `container/` changed. Before the host restart, rebuild any group that spawns from its own image (`grep -lE '"imageTag"' groups/*/container.json`): a base rebuild does not touch it, and it would send the new default to its old baked CLI. A package image built by `install_packages` is rebuilt with `ncl groups restart --id <group-id> --rebuild`, which also recycles that group's containers, so run it at a quiet moment; any other tag is an operator-supplied image and is rebuilt with its own process. Running containers survive a host restart: the new host adopts them, and they keep the runner source and CLI they were spawned with. So after the restart, recycle each Codex group, and each Claude group with a Codex fallback, that has a live container: `ncl groups restart --id <group-id>`. Until then, those sessions keep running the old default on the old CLI, which is consistent. Move the host CLI with `codex update` (the standalone install keeps earlier releases under `~/.codex/packages/standalone/releases/`) so it equals the image pin.

**Verify.** A turn on a container spawned after the deploy (recycled as above) for an unpinned Codex group writes `turn_usage` rows with `model = 'gpt-6.1-sol'`. Also confirm both CLIs:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "select agent_group_id, model, effort, count(*) from turn_usage where provider = 'codex' and ts > '<deploy time>' group by 1,2,3"
docker exec <codex container> codex --version   # expect 0.159.0
codex --version                                  # host, expect 0.159.0
```

**Rollback.**
- **One path**: apply the Fix commands above, then `ncl groups restart --id <group-id>`.
- **The fleet default**: set `DEFAULT_CODEX_MODEL` back to `gpt-6-sol` and the `sol` entry of `CODEX_FAMILY_DEFAULTS` back to `gpt-6-sol`, then redeploy and recycle the Codex groups as in Deploy. The CLI pin can stay: 0.159.0 serves both models. Any pin written as `gpt-6.1-sol` in the meantime stays until it is rewritten, and fails with the 400 if the image is ever rolled back below 0.159.0, so rewrite those to `gpt-6-sol` first.
- **The host CLI**: point `~/.codex/packages/standalone/current` back at the earlier release directory.

---

## History: 2026-09-22 — GPT-6 Sol at `high`

_Historical. Its model half (`gpt-6-sol`) is superseded by the section above; its `luna` and `astra` facts are current. Its Detect block is reused above as a tool._

**What moves.** `DEFAULT_CODEX_MODEL` (`container/agent-runner/src/providers/codex.ts`) is now `gpt-6-sol`, replacing `gpt-5.6-sol`. `DEFAULT_CODEX_EFFORT` stays `high`. The `sol` and `luna` aliases (`CODEX_MODEL_ALIAS_MAP`, `src/flag-parser.ts`) now name `gpt-6-sol` and `gpt-6-luna`. `terra` still names `gpt-5.6-terra`, because Terra has no GPT-6 release. `astra` is unchanged.

**Requires codex-cli ≥ 0.155.1 in the agent image.** Measured on 2026-09-22 with ChatGPT-account auth, which is how the fleet's Codex runs. On 0.154.0, `gpt-6-sol` returns HTTP 400: "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account". On 0.155.1, `gpt-6-sol` and `gpt-6-luna` are both served, and `max` effort is accepted. The image pin moves to 0.156.0 in the Opus 5.5 change (`container/Dockerfile` `CODEX_VERSION`, recorded in `versions.json` as `codex-cli`). Deploy this change with that one or after it, never on an image still at 0.154.0: every unpinned Codex path would fail.

On deploy, two kinds of Codex path move to GPT-6 Sol:
- any Codex group whose `container.json` sets no model (`model`, `providerConfig.model`, or the legacy `defaultModel`);
- any Claude group whose `providerFallback` is `{"provider": "codex"}` with no `model`.

**Pins written before 2026-09-24 hold full ids.** Until then a chat `-m sol`, a task pin and the channel-config tool stored the concrete id, so an existing `gpt-5.6-sol` or `gpt-5.6-luna` pin written that way stays on 5.6 until it is rewritten. Since 2026-09-24 the family names `sol` / `luna` / `astra` / `terra` are stored as typed on every path and resolved in the container (`CODEX_FAMILY_DEFAULTS`, `src/flag-parser.ts:128`), so a pin written as `sol` follows the next bump by itself.

**Detect.** From the install root:

```bash
# Codex primaries and Codex fallbacks with no model (these move):
node -e 'const fs=require("fs");for(const g of fs.readdirSync("groups")){let c;try{c=JSON.parse(fs.readFileSync(`groups/${g}/container.json`,"utf8"))}catch{continue}const fb=c.providerFallback||{};if(String(c.provider||"").toLowerCase()==="codex"&&!c.model&&!c.defaultModel&&!(c.providerConfig||{}).model)console.log("primary",g);if(String(fb.provider||"").toLowerCase()==="codex"&&!fb.model)console.log("fallback",g)}'
# Frozen 5.6 pins (these do NOT move): wirings, tasks, container.json
pnpm exec tsx scripts/q.ts data/v2.db "select id, agent_group_id, default_model, default_effort from messaging_group_agents where default_model like 'gpt-5.6-%'"
ncl tasks list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);for(const t of (Array.isArray(d)?d:d.data)) if(/^gpt-5\.6-/.test(t.model_pin||"")) console.log(t.agent_group_id,t.series_id,t.model_pin,t.effort_pin||"-")})'
grep -lE '"(model|defaultModel)": *"gpt-5\.6-' groups/*/container.json
# Session stickies from an earlier `-m sol`/`-m luna` (they override the group for that session):
pnpm exec tsx -e "import Database from 'better-sqlite3'; import fs from 'fs'; for (const g of fs.readdirSync('data/v2-sessions')) { let ss = []; try { ss = fs.readdirSync('data/v2-sessions/' + g) } catch { continue } for (const s of ss) { const p = 'data/v2-sessions/' + g + '/' + s + '/outbound.db'; if (!fs.existsSync(p)) continue; try { const d = new Database(p, { readonly: true }); for (const r of d.prepare(\"select value from session_state where key = 'sticky_model' and value like 'gpt-5.6-%'\").all()) console.log(g, s, r.value); d.close() } catch (e) { if (!/no such table/.test(e.message)) console.error('UNREADABLE', p, e.message) } } }"
```

A session sticky moves only when someone in that thread sends `-m sol` (or `-m ''` to clear it back to the group's model). There is no `ncl` verb for it. The container owns `outbound.db`, so an operator writes to it only while that session's container is stopped: delete the `sticky_model` row from `session_state`.

**Why.** GPT-6 Sol and Luna are the GPT-6 successors to the 5.6 tiers, announced by OpenAI on 2026-09-22 at lower API prices. Neither id is in Codex's bundled model catalog. Under ChatGPT-account auth, codex-cli 0.155.1 and later get them from the server catalog (`~/.codex/models_cache.json`): `gpt-6-sol` supports `low` through `ultra`, and `gpt-6-luna` supports `low` through `max`. 0.154.0 has no metadata for them and falls back, and the server then refuses the request. `setup/lib/codex-model-min-cli.test.ts` fails if the default or the `sol`/`luna` aliases name a GPT-6 model while `versions.json` pins an older CLI.

**Fix: keep 5.6 on a path, before deploying.** Pins are data and need no deploy:

```bash
ncl groups config update --id <group-id> --model gpt-5.6-sol --effort high
ncl wirings update <wiring-id> --default-model gpt-5.6-sol
ncl tasks update --id <series> --group <group-id> --model gpt-5.6-sol
```

For a fallback, set `providerFallback.model` in that group's `container.json`.

**Deploy.** Run `scripts/deploy.sh` on a build whose image pins codex-cli ≥ 0.155.1. `deploy.sh` rebuilds the image when `container/` changed. Running containers survive a host restart: the new host adopts them, and they keep the runner source and CLI they were spawned with. So after the restart, recycle each Codex group, and each Claude group with a Codex fallback, that has a live container: `ncl groups restart --id <group-id>`. Until then, those sessions keep running the old default.

**Verify.** A turn on a container spawned after the deploy (recycled as above) for an unpinned Codex group writes `turn_usage` rows with `model = 'gpt-6-sol'`. Also confirm the container's CLI with `docker exec <container> codex --version` (expect ≥ 0.155.1):

```bash
pnpm exec tsx scripts/q.ts data/v2.db "select agent_group_id, model, effort, count(*) from turn_usage where provider = 'codex' and ts > '<deploy time>' group by 1,2,3"
```

**Rollback.** Set `DEFAULT_CODEX_MODEL` back to `gpt-5.6-sol`, and set the `sol`/`luna` aliases back to their `gpt-5.6-*` ids. Then redeploy and recycle the Codex groups as in Deploy. Any pin written to `gpt-6-*` in the meantime stays until it is rewritten. If the image is ever rolled back below codex-cli 0.155.1, those pins fail with the 400 above, so rewrite them to `gpt-5.6-*` first.
