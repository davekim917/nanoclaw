# Migration: the Codex default model

## Current: GPT-6 Sol at `high` (2026-09-22)

**What moves.** `DEFAULT_CODEX_MODEL` (`container/agent-runner/src/providers/codex.ts`) is now `gpt-6-sol`, replacing `gpt-5.6-sol`. `DEFAULT_CODEX_EFFORT` stays `high`. The `sol` and `luna` aliases (`CODEX_MODEL_ALIAS_MAP`, `src/flag-parser.ts`) now name `gpt-6-sol` and `gpt-6-luna`. `terra` still names `gpt-5.6-terra`, because Terra has no GPT-6 release. `astra` is unchanged.

On deploy, two kinds of Codex path move to GPT-6 Sol:
- any Codex group whose `container.json` sets no model;
- any Claude group whose `providerFallback` is `{"provider": "codex"}` with no `model`.

**Aliases resolve when the value is written.** A pin set with `-m sol`, `ncl … --model sol` or the channel-config tool stores the concrete id. An existing `gpt-5.6-sol` or `gpt-5.6-luna` pin stays on 5.6 until it is rewritten, and the same will hold after the next bump for a pin written today.

**Detect.** From the install root:

```bash
# Codex primaries and Codex fallbacks with no model (these move):
node -e 'const fs=require("fs");for(const g of fs.readdirSync("groups")){let c;try{c=JSON.parse(fs.readFileSync(`groups/${g}/container.json`,"utf8"))}catch{continue}const fb=c.providerFallback||{};if(c.provider==="codex"&&!c.model&&!(c.providerConfig||{}).model)console.log("primary",g);if(fb.provider==="codex"&&!fb.model)console.log("fallback",g)}'
# Frozen 5.6 pins (these do NOT move): wirings, tasks, container.json
pnpm exec tsx scripts/q.ts data/v2.db "select id, agent_group_id, default_model, default_effort from messaging_group_agents where default_model like 'gpt-5.6-%'"
ncl tasks list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);for(const t of (Array.isArray(d)?d:d.data)) if(/^gpt-5\.6-/.test(t.model_pin||"")) console.log(t.agent_group_id,t.series_id,t.model_pin,t.effort_pin||"-")})'
grep -l '"model": *"gpt-5\.6-' groups/*/container.json
```

**Why.** GPT-6 Sol and Luna are the GPT-6 successors to the 5.6 tiers, announced by OpenAI on 2026-09-22 at lower API prices. Both are served through codex-cli 0.155.1, the CLI this image pins. This was verified on the host by `codex exec -m gpt-6-sol` and `-m gpt-6-luna`: the session metadata reported that model, and `max` effort was accepted.

**Fix: keep 5.6 on a path, before deploying.** Pins are data and need no deploy:

```bash
ncl groups config update --id <group-id> --model gpt-5.6-sol --effort high
ncl wirings update <wiring-id> --default-model gpt-5.6-sol
ncl tasks update --id <series> --group <group-id> --model gpt-5.6-sol
```

For a fallback, set `providerFallback.model` in that group's `container.json`.

**Deploy.** Run `scripts/deploy.sh`. The runner source is a boot snapshot, so this needs a host restart. It needs no image rebuild unless something else in the batch changes the image inputs.

**Verify.** A fresh turn on an unpinned Codex group writes `turn_usage` rows with `model = 'gpt-6-sol'`:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "select agent_group_id, model, effort, count(*) from turn_usage where provider = 'codex' and ts > '<deploy time>' group by 1,2,3"
```

**Rollback.** Set `DEFAULT_CODEX_MODEL` back to `gpt-5.6-sol`, and set the `sol`/`luna` aliases back to their `gpt-5.6-*` ids. Then redeploy. Any pin written to `gpt-6-*` in the meantime stays until it is rewritten.
