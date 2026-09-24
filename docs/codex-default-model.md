# Migration: the Codex default model

## Current: GPT-6 Sol at `high` (2026-09-22)

**What moves.** `DEFAULT_CODEX_MODEL` (`container/agent-runner/src/providers/codex.ts`) is now `gpt-6-sol`, replacing `gpt-5.6-sol`. `DEFAULT_CODEX_EFFORT` stays `high`. The `sol` and `luna` aliases (`CODEX_MODEL_ALIAS_MAP`, `src/flag-parser.ts`) now name `gpt-6-sol` and `gpt-6-luna`. `terra` still names `gpt-5.6-terra`, because Terra has no GPT-6 release. `astra` is unchanged.

**Requires codex-cli ≥ 0.155.1 in the agent image.** Measured on 2026-09-22 with ChatGPT-account auth, which is how the fleet's Codex runs. On 0.154.0, `gpt-6-sol` returns HTTP 400: "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account". On 0.155.1, `gpt-6-sol` and `gpt-6-luna` are both served, and `max` effort is accepted. The image pin moves to 0.156.0 in the Opus 5.5 change (`container/Dockerfile` `CODEX_VERSION`, recorded in `versions.json` as `codex-cli`). Deploy this change with that one or after it, never on an image still at 0.154.0: every unpinned Codex path would fail.

On deploy, two kinds of Codex path move to GPT-6 Sol:
- any Codex group whose `container.json` sets no model (`model`, `providerConfig.model`, or the legacy `defaultModel`);
- any Claude group whose `providerFallback` is `{"provider": "codex"}` with no `model`.

**Pins written before 2026-09-24 hold full ids.** Until then a chat `-m sol`, a task pin and the channel-config tool stored the concrete id, so an existing `gpt-5.6-sol` or `gpt-5.6-luna` pin written that way stays on 5.6 until it is rewritten. Since 2026-09-24 the family names `sol` / `luna` / `astra` / `terra` are stored as typed on every path and resolved in the container (`CODEX_FAMILY_DEFAULTS`, `src/flag-parser.ts`), so a pin written as `sol` follows the next bump by itself.

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
