# Quota burn — plan

Install-specific agent, workgroup and operator names are generalized for the public boundary.

Status: draft 2026-09-14 rev 2. Owner: the operator. Execution: one retained frontier worker per task.

## Scope

The **entire fleet** plus **host Claude Code** and **host Codex**. Every task below names where
it lands:

| Surface | Claude | Codex |
|---|---|---|
| Host CLI | `~/.claude/settings.json` env block / shell env | `~/.codex/config.toml` `[agents]` |
| Container env | `src/container-runner.ts` `-e` pushes (~6240–6525) | `src/providers/codex.ts:78–80` → container `config.toml` |
| Per-group | `groups/<g>/container.json` `effort`, `model` | same, plus `providerFallback` block |
| Behaviour | `~/plugins/bootstrap` hooks (installed on host + containers, all three providers) | same |

## Constraint: upstream mergeability

We are a customized fork; touching upstream-tracked files is expected. The constraint is
**merge tractability** — staying able to pull upstream features — not a no-touch rule. The
existing ratchet is the gate (`src/upstream-ratchet.json`; `pnpm run ratchet:report -- --write`;
growth needs `--accept` + a reason in the PR body). This plan adds nothing stricter.

Shape changes to upstream-tracked files so they merge cleanly: additive over restructuring;
one seam per change; no reflow of code upstream owns. `host-sweep.ts` (+1,611) and
`container-runner.ts` (+7,202) are already customized — a two-line env push or one
precondition check is not what makes a merge hard; a refactor of the sweep loop is.

Fork-owned files carry no merge cost — `src/providers/codex.ts`, `src/providers/opencode.ts`,
`src/modules/provider-fallback/`, `src/db/provider-health.ts`, the agent-runner, the
bootstrap plugin. Prefer landing a mechanism there when the seam exists; otherwise land it
additively upstream-side and accept the ratchet growth with a reason.

## Outcome

Fable weekly meter under ~60% at week-end; Codex weekly not exhausted; **no downgrade of
builder model or effort**. Baseline 2026-09-14 hour 12: Fable 44%, All models 24%, 5-hour
meter maxed twice with six OAuth slots rotating.

## What the data says

Claude last 12h (ISO-correct); Codex last 7d. Per-turn figures are comparable across windows.

| Provider / role | Model | Turns | Input+cache per turn | Notes |
|---|---|---|---|---|
| Claude **coordinator** | Sonnet 5 xhigh | 74 | **2.1M** | heavier than its own builders |
| Claude **builder** | Fable 5.1 medium | 63 | 1.75M | 7.4 API turns/turn on agent-A — lean |
| Codex **coordinator** | Terra xhigh | 76 | **0.8M** | 4× leaner than its builders — correct shape |
| Codex builder | Astra (all efforts) | 276 | 3.2M | xhigh 8.3M/turn, low 2.0M, medium 1.7M |
| Codex builder | Sol (all efforts) | 201 | 3.5M | high/human is the biggest single Codex line |

- **99.4% of Claude volume is cache reads.** Bill = `context_per_step × steps × turns`.
- **The Claude coordinator/builder split is inverted; the Codex one is not.** Same xhigh
  effort on a comparable-tier coordinator (Terra) runs 0.8M/turn. So Sonnet's churn is not
  "cheap model needs more steps" — Terra disproves that. It's what the Sonnet sessions *do*.
- **What they do:** agent-B retained Sonnet coordinator, all-time 477 Bash / 78 Agent (6:1).
  In the 66-step turn ending 01:12Z: 59 steps over 13 min *before* dispatching Fable —
  `git show` on frontend source, `curl` on deployment healthz, a full `agent-browser` login.
  Each is a named violation of the dispatch-first gate. Its own brief said *"I am not
  pre-solving any of this for you."* Narrated, not enforced.
- **Context floor:** `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000` (`container-runner.ts:6253`,
  fork commit `28dca8140`) with `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80` → sessions grow to ~800k
  before compacting. Observed 120–300k/step and rising. agent-B standing instructions 57KB
  (~14k tokens) is the fixed part; the rest is un-compacted history. Retained coordinator
  transcript 12.7MB / 257 turns since 09-12.
- **Scheduled = 57% of Claude spend.** `xzo-pr-watch` 132 fires/7d on Fable; sample outcome
  *"eight open PRs, none ready."* agent-A scheduled $130/day. Overnight 28 autonomous Fable
  turns, $117.
- **Codex effort does track volume** (Astra xhigh 8.3M vs medium 1.7M per turn). Container
  Codex top-level effort defaults `xhigh` when `container.json` omits it
  (`container/agent-runner/src/providers/codex.ts:400`). Subagent default is `medium`
  (`src/providers/codex.ts:79`). Threads default 15 (`:80`).
- **Bucket note:** Sonnet and Opus both draw from *All models* (24%). Neither touches the
  Fable meter (44%). A coordinator model swap cannot help the binding constraint.
- **OAuth ring is lockstep and half-blind.** Ring is primary → `_2` … `_6`
  (`container/agent-runner/src/providers/claude.ts:2223–2230`); a fresh session starts at
  position 0 and advances only on failure, so every group in a shared credential set
  (`group:workgroup-1` = agent-A, agent-B, workgroup-1, agent-C) exhausts slots together. `/usage` is
  pulled only for the *active* slot, so idle slots go dark — `TOKEN` last sampled 09-09.
  Weekly map 2026-09-14T14:00Z: `_1` 0.76 (stale) · `_2` 0.87 · `_3` 0.88 · `_4` 0.83
  (dead to 09-17; agent-B assigned) · `_5` 0.21 · `_6` 0.18 (week began 09-13; five sessions
  on it). Four slots at 76–88%, two fresh, and the ring cannot see it. This is why six keys
  don't finish a week.
- **Codex quota is observable; nanoclaw doesn't read it.** 561 Codex turns, zero rate-limit
  fields in `turn_usage`. But the app-server protocol (codex-cli 0.154.0,
  `codex app-server generate-json-schema`) exposes a pull, **`account/rateLimits/read`** →
  `GetAccountRateLimitsResponse { rateLimits: RateLimitSnapshot, rateLimitsByLimitId }`, and a
  push, **`account/rateLimits/updated`** → `AccountRateLimitsUpdatedNotification` (sparse; merge
  into the last read). Neither is called or subscribed in
  `container/agent-runner/src/providers/codex-app-server.ts`; `makeRequest(method, params)` at
  `:126` is the seam. Today the only signal is `systemError` after the fact — and agent-A,
  workgroup-1, agent-B are all on Codex fallback right now (14:14Z). `provider_health` is fork-owned
  (`src/modules/provider-fallback/`, `src/db/provider-health.ts`).

Ruled out: self-heal nudges (7% of scheduled fires); coordinator effort as the cause
(Terra/xhigh is lean); builder step count; cross-provider `steps` comparison (Codex counts
ThreadItems, Claude counts API turns — `codex.ts:1860` vs `claude.ts:2859`).

## What Boris would do

**One approach:** hook the dispatch-first gate, cap the compact window, split polls from
actions with a prompt edit first, set the env caps. Measure at +24h. Nothing else until then.

**Why.** *Same mistake twice → make it structural.* The coordinator states the rule and
breaks it 6:1; Terra at the same effort doesn't — so the fix is a guard, not a model swap.
*Simplest mechanism:* the compact window is one existing line; the poll fix is a prompt edit
before it's anything else; the guard pattern already exists in `hooks/guards/`. *Don't touch
upstream:* every Tier 0–2 change lands in fork-owned lines or the plugin.

**Vetoed.**
- **Sonnet → Opus for coordinators.** Terra/xhigh coordinating at 0.8M/turn shows a
  same-tier model at the same effort is lean when it stays in lane. Opus would investigate
  *more* thoroughly, not less, and it draws from the same bucket Sonnet does. The hook fixes
  the behaviour for any model. A/B it later (Tier 4) if the hook doesn't land the number.
- **Mixed-model proxy routing DeepSeek into builder sessions.** Mechanism verified (§3);
  no work for it after Tiers 0–2.
- **New responsibility in `host-sweep`.** Drift. Only if the zero-drift ladder fails.
- **Concurrency caps as the fix.** They protect the 5-hour meter, not the weekly one.

**Product-terms tradeoff.** Builders keep model and effort — nothing client-facing changes.
Coordinators stop doing 13 minutes of work the builder redoes; turns get faster. Pollers
stop waking Fable to learn nothing changed. Compacting earlier means a builder mid-task can
lose detail in a summary — the one real quality risk, which is why it's per-group and
measured before fleet-wide.

**What changes the verdict.** If +24h shows Sonnet p95 API-turns < 12 and Fable is still on
pace to exhaust, the remaining lever is builder-side — and then Fable/Opus A/B (Tier 4) moves
up, because Opus draws from the roomier bucket.

## Tasks

### Tier 0 — first PR

`src/` and agent-runner items ship as one PR → merge gate → host restart (the operator's gates).
Host-CLI settings and `groups/` config are direct edits. 0.1–0.5 approved 2026-09-14;
0.6–0.7 await approval — they change credential selection and provider parking on a live fleet.

| # | Task | Lands in | Done when |
|---|---|---|---|
| 0.1 | `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` | host settings env; `container-runner.ts` `-e` push beside `:6524` | default is 3; container `env \| grep SUBAGENT` shows 1 |
| 0.2 | `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=3` | same | default is 20 |
| 0.3 | Explicit `effort` on every Codex group and every Codex `providerFallback` block | `groups/*/container.json` | `turn_usage.effort` never null/xhigh-by-default for Codex |
| 0.4 | `max_concurrent_threads_per_session` 15 → 4; host `~/.codex/config.toml` `[agents]` to match | `src/providers/codex.ts:80`, `container/agent-runner/src/codex-companion-setup.ts:106`, host toml | fork-owned files |
| 0.5 | **`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 1,000,000 → 400,000 on one group** (agent-B). Compaction fires ~320k instead of ~800k. Watch `cache_read_tokens/steps` and builder review verdicts for 24h. If quality holds, fleet-wide; if not, try 600k. | `container-runner.ts:6253` — existing fork line; add optional `autoCompactWindow` to `container.json`, default 1,000,000 | cache-read/step on agent-B drops; no builder `must_fix` attributable to lost context |
| 0.6 | **Usage-maximizing slot pick** *(the operator-directed 2026-09-14)*. At session start, `/usage`-pull every ring slot, not just the active one; choose **highest `seven_day` utilization that is still below 100%** (drain the most-used account first), tiebreak highest `five_hour`; skip any slot whose `seven_day` is exhausted. Persist as today. *Objective:* leave no headroom unspent at a slot's reset — a slot at 88% resetting in 14h is 12% of free quota; lowest-first would have left it on the table. Hitting 100% mid-session is handled by the existing in-turn rotate-and-retry (`poll-loop.ts:1052`, `claude.ts:2389`); the prompt-cache miss on the new account is accepted cost. Idle slots stop going dark because every slot is pulled at each session start. **Worker must verify:** in-flight subagents survive a parent ring rotation (they share the container process env — confirm the SDK re-reads `CLAUDE_CODE_OAUTH_TOKEN` on the next call rather than caching it at spawn). | `container/agent-runner/src/providers/claude.ts` ring build ~2223 / resume ~2268; `usage_pull` helper exists | fork-owned; slots reach their reset at ≥ 95% used; no slot sits idle below 50% while another is being drained |
| 0.7 | **Codex rate-limit read + park** *(needs approval)*. Mirror Claude's `usage_pull`: on Codex session start call `account/rateLimits/read` (params `{ excludeResetCreditDetails: true }`), subscribe to `account/rateLimits/updated` and merge sparse updates into the last snapshot. From `RateLimitSnapshot`: `primary`/`secondary` are `RateLimitWindow { usedPercent 0–100, resetsAt, windowDurationMins }` — classify by `windowDurationMins` (300 → `five_hour`, 10080 → `seven_day`). Write rows to the existing `rate_limit_samples` (`utilization = usedPercent/100`, `account` = Codex auth identity, `source='usage_pull'`) — no new schema. Park the group's Codex in `provider_health` when `secondary.usedPercent ≥ 90` or `rateLimitReachedType` is non-null (enum distinguishes `rate_limit_reached` from `workspace_*_credits_depleted` / `workspace_*_usage_limit_reached` — record which). Keep a 60-min park on `systemError` as the fallback for when the read itself fails. `rateLimitsByLimitId` (multi-bucket by `limit_id`, e.g. `codex`) — log it, don't design around it yet. Surface in `ncl`. Schema source: `codex app-server generate-json-schema --out <dir>`, codex-cli 0.154.0. | `container/agent-runner/src/providers/codex-app-server.ts` — `makeRequest(method, params)` at `:126`, notification handler alongside the existing `ServerNotification` dispatch; `src/modules/provider-fallback/`, `src/db/provider-health.ts` for the park | all fork-owned; Codex `seven_day` appears in `rate_limit_samples` per account; fallback groups park before exhausting rather than after `systemError` |

### Tier 1 — split poll from act, zero-drift ladder

Try in order. Measure each on `turn_usage` (agent-A, `trigger='scheduled'`, $/day) before
moving down.

| # | Task | Drift |
|---|---|---|
| 1.1a | **Prompt edit.** `xzo-pr-watch` prompt: first action is one `gh api` head-sha comparison against a state file; on no delta reply "no change" and stop. Same wake, ~2 API turns instead of 7.4. | none — `ncl tasks` edit |
| 1.1b | **Poll agent group.** If 1.1a isn't enough: a `provider: opencode` (GLM-flash or, after §3.1, DeepSeek) or Haiku group owns the poll series. On delta it `@`-mentions agent-A with the delta. Everything is a message — no host change. | none — new group + wiring |
| 1.1c | **Host precondition.** If a+b don't land the number: recurrence row precondition evaluated in `host-sweep` S18, additive, one seam. | upstream-tracked — ratchet `--accept` with reason in PR body |
| 1.2 | Inventory poll-shaped series in `task_run_outcomes` (7d): inbox pollers, CI watches, `xzo-develop-qa-harness` if it's a "did develop move" check. Apply 1.1a. | none |

### Tier 2 — coordinator step discipline (hook, not prose)

| # | Task | Lands in |
|---|---|---|
| 2.1 | `hooks/guards/dispatch-first-core.ts` + `dispatch-first.ts` + tests. PreToolUse on `Bash\|Read\|Grep\|Glob\|WebFetch`: on the ordinary-coordinator roster, if no `Agent` tool_use since the last user message in `transcript_path`, block past N=3 pre-dispatch calls (allowlist `gh pr view … headRefOid`, `mkdir`, `git fetch`). Runtime-neutral core + Claude adapter, same shape as `block-destructive`. | `~/plugins/bootstrap/plugins/workflow/hooks/guards/` — plugin, no nanoclaw drift; applies to host and containers |
| 2.2 | Codex/OpenCode parity via the `opencode-guard.ts` pattern and Codex `hooks.json`. | same |
| 2.3 | Hard round cap in `workflow-contract.md` (both copies): coordinator ≤3 dispatch rounds per task. Ships with 2.1 so it's enforced. | plugin |

Measure: Sonnet `steps` p50/p95 and cache-read per turn. Target p95 < 12 API turns.
Cross-check Terra stays ≤ 0.8M/turn.

### Tier 3 — DeepSeek via OpenCode Go (gated)

**Verdict 2026-09-14:** not frontier for the builder workload. Terminal-Bench 4.0 31.2 vs
Fable 55.8 / Astra 57.9; no independent SWE-bench for the Flash variant; V4-anchor MRCR-1M
77–79 vs Opus 93; harness bug chain (opencode #24130→#35689, #36354 on the Go backend) where
the model returns `finish_reason: stop` mid-loop and the agent exits silently. Practitioner
rule: *one file + one round → Flash; crosses files or >2 tool calls → stronger.*

| # | Task |
|---|---|
| 3.1 | **Gate.** Pin `model: "opencode-go/deepseek-v4.1-flash"` on one idle opencode group. 20-step multi-turn tool-calling task at our real tool count (15–29). Pass = no silent `stop` exit, no empty-name tool call, correct params on calls 4+. |
| 3.2 | If 3.1 passes: 1.1b's poll group and `wiki-lint-*` (report-only) move onto it. Nothing that crosses files. |
| 3.3 | Wire gotchas to encode in `src/providers/opencode.ts` (curl-verified): auth `x-api-key` (Bearer → 401); `x-opencode-session` required; `tool_choice` `auto` only (forced → 400); `cache_control` **honored** on this path; streaming + `system` arrays work; unrecognised model IDs auto-map to Flash — send the literal `deepseek-v4.1-flash`; empty completions before 1M — compact ≤400k. Add an `opencode.ai` host-pattern secret to OneCLI (none exists today). |

**Mixed-model routing (Claude/Codex session → DeepSeek for a sub-call)** — mechanism verified,
**vetoed until 3.1 passes and a sub-task exists for it.**

- *Claude Code:* model string sent verbatim; subagent can name a non-Claude model via
  frontmatter or `CLAUDE_CODE_SUBAGENT_MODEL`. Raw `ANTHROPIC_BASE_URL` → OpenCode Go returns
  `unrecognized_model` (rejects Claude Code's beta headers, not the model); `ANTHROPIC_BASE_URL`
  is process-global. **Proxy required:** claude-code-router (37k★) — per-spawn model via
  `<CCR-SUBAGENT-MODEL>` tag, `anthropic_messages` upstream, headless Docker. Config is SQLite
  edited via UI → deploy artifact to back up/restore.
- *Codex, whole-session:* no router — `[model_providers.opencode-go]` with
  `base_url="https://opencode.ai/zen/go/v1"`, `wire_api="responses"`,
  `http_headers={x-opencode-session=…}`; `/responses` tool loop verified 200.
  `model_provider` is process-global. *Per-subagent mixing:* **codex-router** (3.4k★) — the
  Codex-side tool; handles the `tool_choice` 400 and the 400k compaction. Same gate.
- *Reachability:* host `ANTHROPIC_BASE_URL` already forwards to containers with a `NO_PROXY`
  bypass (`container-runner.ts:6768`). A host router is reachable by the existing path; its
  key can come from a OneCLI `opencode.ai` host-pattern secret. Zero new secret code.

Why vetoed: after Tiers 0–2 no work remains in a builder session for DeepSeek — polls need no
model, grep is one Fable tool call, triage is open-ended judgment (its weakest bench). CCR
plus a config-backup ritual to route work that no longer exists is complexity with no job.
**Flips when:** 3.1 passes *and* Tier 2 measurement shows a recurring builder sub-task under
5 API turns. Then Codex groups → the 5-line block; Claude groups → CCR.

### Tier 4 — bucket balancing (measured)

| # | Task |
|---|---|
| 4.1 | **Done live by the operator ~17:00Z 2026-09-14** on observed Fable burn: agent-A `claude-fable-5-1[1m]`/`medium` → **`claude-opus-5[1m]`/`high`**, fallback Astra/medium → **`gpt-5.6-sol`/`high`** (`groups/` `00e423e9`). Not a one-build A/B — the heaviest group, all triggers. Measurement window starts 17:00Z. First Opus turn (human, 23 min): 90 steps, 117k ctx/step, 48.8k out, **$8.55** vs Fable/medium 24h avg 10.5 steps, 213k ctx/step, 7.5k out, **$6.76/turn**. One turn; not a read. Watch at +24h: cost/turn by trigger, steps/turn on `scheduled` (the poll shape), and which weekly meter moves (Opus draws *All models*, was 24%). |
| 4.2 | **Decided by the operator 2026-09-14 ~22:50Z, fleet-wide, not waiting on 4.1:** default worker is **Opus 5 / Sol at `high`**; **Fable 5.1 / Astra are the escalation** (explicit human request, or the judgment-heavy shapes the contract already names) and when used skew **low/medium, some high, few xhigh, max rare**. Model tier buys judgment, effort buys depth, don't stack both unless the shape demands it. Two default columns in the rubric: Opus/Sol "stay at" = `high`; Fable/Astra "stay at" = `medium`. Step-down/step-up triggers unchanged. Dispatched to `policy-default-worker` (Opus): `workflow-contract.md` ×2, always-on ×2, `container/agents/worker-frontier.md` (model + effort pin), Codex worker default Astra→Sol, agent-runner terminal fallback (`config.ts:136–144`) if it's Fable/Astra, reviewer-models regen, bootstrap 5.2.0/2.2.0. No `groups/` pins touched. Limitation surfaced: the Agent tool has no per-call effort override, so a dispatch inherits the agent def's pin — the def must carry `high`. |
| 4.3 | Coordinator Sonnet vs Opus/medium — only if 2.1 lands and Sonnet p95 is still > 12. Note it can't move the Fable meter. |

### Tier 5 — context floor, second pass (if 0.5 isn't enough)

| # | Task |
|---|---|
| 5.1 | `instruction-audit` on agent-B/agent-A standing instructions (57KB). |
| 5.2 | Retained-coordinator session length — reset coordinator session per task; keep the *builder* thread continuous (anshuc's winning shape). |

## Codex-side assessment (asked 2026-09-14)

Structurally correct: Terra/xhigh coordinator at 0.8M/turn is 4× leaner than Astra/Sol
builders — the opposite of the Claude side. Builders are heavy (3.2–3.5M/turn) and effort
tracks volume there, so 0.3 (explicit effort) has teeth on Codex. Codex total input over 7d is
3,272M vs Claude 8,773M — 27% of fleet volume on 17% of turns. Quality axis (failed-run rate,
`systemError` frequency) pending — background query.

## Status 2026-09-14 ~16:20Z

| PR | Item | Head | State |
|---|---|---|---|
| #810 | 0.1–0.5 | **merged `06720dd54`** | r1 `needs-attention` → fix `8417a3734` → r2 `approve` → notes `553ead55f` (CI red: unregistered class) → `0cc31f8e1` r4 `approve` → merged 17:46Z → deploy #1 failed on untracked `reports/` (rolled back) → **deploy #2 ok 17:54:50Z; service restarted 17:54:51Z; preflight ok**. **Verified** on first post-restart spawn (workgroup-1 17:55:49Z): depth=1, concurrency=3, window=1000000. agent-B 400000 pending its next spawn. `BUILD_INFO.json` sha==HEAD, `dirty:false`. |
| #811 | 0.6 | **merged `da3d2d06e`** | headroom 0.05 → scope `skip` (labeler miss) → Astra run anyway → r1 **[high] token value in fetch-error log** → Fable worker 429'd at commit → Codex finisher completed it (sanitize at source, deadline test retargeted to sanitized contract, new class `secret in error message`) `bc768297a` → Astra r2 `approve` → CI green → merged 21:58Z → **deployed 22:02:47Z**, BUILD_INFO `da3d2d06e` dirty=false. **Live-verified 02:55Z: 0.6 works as designed.** Survey (latest `usage_pull` seven_day today):
`_5` 0.57, `_1` 0.35 — the other four slots' pulls failed unsampled, and their `rate_limit_event`
rows carry `status=rejected` on seven_day, i.e. they are at/over the wall. The pick drains `_5`
(highest utilization still under the 0.95 headroom): 101 turn events on `_5` vs 9–15 each on the
rest, which are ring-fallback probes. Note the ring is back to **6 slots** — all of
`CLAUDE_CODE_OAUTH_TOKEN`, `_2`…`_6` are present in `.env` (names only checked), so the earlier
"`_5` removed 17:11Z → 5 accounts" note is superseded. |
| #812 | 0.7 | **merged `e4dbcb006`**; **deploy #3 ok 01:30:17Z** (BUILD_INFO `e4dbcb006` dirty=false, preflight ok, runner snapshot `20260915T013019` carries `readCodexAccountRateLimits`; carries #814). **Live check done 02:50Z — HALF of 0.7 is dead in production.** Push path works: 382 rows since
01:30Z, `source='rate_limit_event'`, `credential_set='codex:.codex'`, `limit_type='seven_day'`,
util 0.01→0.04. Read path fails on EVERY bind: live container logs show
`account/rateLimits/read failed: Invalid request: invalid type: map, expected unit`, so the
`usage_pull` write at `codex-rate-limit-tracker.ts:232` never runs (zero such rows fleet-wide).
**Root cause — version skew:** 0.7 was written against the HOST schema (codex-cli 0.154.0, which
defines `GetAccountRateLimitsParams` and marks `params` optional), but containers run codex-cli
**0.153.4** (`container/Dockerfile:41`), where the method takes unit. Fixtured RPC tests could not
catch it — the fixture mirrored the code's own request shape. Fix dispatched: omit params entirely
(valid on both), plus a wire-shape regression test. See memory `codex-version-skew-host-vs-container`.
Park decisions therefore currently rest only on whatever a push happens to carry — the bind-time
snapshot that 0.7's park logic was designed around is absent. | … → r3 approve `a4e06320f` → PR was CONFLICTING with main so CI never ran (see memory `ci-silent-on-conflicting-pr`) → rebased twice (main moved with #813/#814) → `9df6bc432` → r4 rebase confirmation by a fresh Claude Opus reviewer (host Codex out of quota) → CI green → merged. |
| #815 | 5.1 | `a0a5f7542` receipted (r1 Astra approve at `0f99201c9`; r2 Claude rebase-confirm) — **will re-conflict on ratchet after #812**; owner rebasing again | OpenCode fleet default → `opencode-go/deepseek-v4.1-flash`. the operator opted in on OpenCode Go 01:10Z; live probe answers OK incl. `reasoningEffort: high`. No DB default (provider_models dropped in 039). OpenCode `worker-frontier` twin has no model pin → rides the fleet default (parked decision). Needs its own deploy after merge. |
| #812-old | 0.7 | `a4e06320f` | park 95 → scope `review` → Astra r1 `needs-attention`: **[high] in-flight read overwrites a newer push** (`tracker.ts:169` vs `:193`), [medium] pushes bump `lastReadAt` and starve the full read (`:194`) → receipt `changes` → Fable worker 429'd with ~79 lines uncommitted → Codex (`codex-finish-812`) `4161e3a23` (F1/F2 were complete; CI red was a source-anchor regex in `codex.factory.test.ts` that 0.7's `turnEvents` binding had orphaned — retargeted, no assertion weakened; runner 1856/0, host 9052/0) → Astra r2 **[high] whole-read discard opens a sparse-update hole** (primary-only push mid-read blanks a fresh `secondary=96`) → `a4e06320f` per-field `fieldPushSeq` + shared `codexRateLimitSnapshotUpdatedKeys`, 2 repro tests, note class `over-broad guard` → Astra r3 `approve` (executed the repro; bind resets seq; no overflow path) → receipt 23:11Z |
| #813 | 4.2 | **merged `09dec73e1`, deployed 00:47:44Z** (BUILD_INFO sha match, dirty=false, preflight ok). r3 approve `c2c6e9fad` → CI red: `provider-surfaces.test.ts` asserted the old Fable literal (verification had been touched-files-only) → `5d120ce5b` derives model/effort from the def, full host suite 9056/0, ratchet +8 accepted → r4 approve → merged. Post-deploy hand actions done 00:48Z: `~/.claude/agents/worker-frontier.md` re-copied (Opus/high); `pnpm exec tsx scripts/sync-codex-subagents.ts` (watcher missed the cp) → host + 18 group `.codex/agents/worker-frontier.toml` now `gpt-5.6-sol` / high — **21 modified files in `groups/` for the operator to commit**. |
| #813-old | — | `c2c6e9fad` | policy worker (Opus): `worker-frontier.md` → `claude-opus-5[1m]`/`high`; `CODEX_WORKER_MODELS` → `gpt-5.6-sol`; Codex `default_subagent_reasoning_effort` medium→high (both sites — **global** Codex subagent default, no per-role knob in codex-cli 0.154.0); reviewer-models regen keeps all four ids (compat set swapped to Fable/Astra); terminal fallbacks unchanged (unpinned Claude → opus/high already; unpinned Codex → terra/xhigh is the coordinator tier, deliberate). Astra r1 [medium] stale prose in `frontier-worker-trial.md:35` / `review-policy.md:40` → swept → r2 [medium] new prose test was a paragraph-wide keyword gate (false-positives valid sentences, misses "Medium is the default effort") → replaced with one config-derived positive assertion per doc. Bootstrap `16b4bd9` (5.2.0/2.2.0, **unpushed**): contract ×2, always-on ×2, README, orchestrate SKILL ×2, `frontier-worker.mjs` tier-aware effort default (Fable/Astra→`medium`, Opus/Sol→`high`; explicit `--effort` wins). |
| bootstrap `ffa3fd9` | 2.1 | — | pushed, host 5.1.0 / Codex 2.1.0, containers live on next spawn; warn mode; no live trip observed yet |
| opencode default | 5.1 | dispatched 2026-09-15 00:25Z | **the operator 2026-09-15:** OpenCode fleet default model → `opencode-go/deepseek-v4.1-flash` (was `opencode-go/glm-5.3-flash`, `src/providers/opencode.ts:40`). All 7 `*-opencode` groups have `model: null` → inherit the code default; no per-group pin changes. Worker checks whether the `provider_models` seed (migrations 037/038) carries a default that needs a new migration, and the runner's per-model context-limit/effort-options map for the new slug. |
| #814 | 4.3 | **merged `f9e5f4bcb`** 00:55Z (not yet deployed — no runtime change: vendor script + manifest + drift test + CLAUDE.md line; rides the #812 deploy) | r1: [high] plugin scripts imported repo-level `retire-bootstrap-agents.mjs` (bare install → ERR_MODULE_NOT_FOUND) + 3 medium (bare-name preference pins a stale hand copy; EACCES treated as absence; drift suite skipped without the plugin) → fixed (ownership helpers moved INTO the plugin, packaging tests from a `cp -r` of the plugin alone, qualified name `bootstrap-workflow:worker-frontier` preferred, ENOENT-only absence, committed `src/workflow-agent-vendor.manifest.json` asserted unconditionally) → r2: [medium] create-path TOCTOU vs nanoclaw codex-sync → `wx` exclusive create + EEXIST re-check, same-dir temp + rename, bounded retry (installer tests 13/13) → r3 approve → rebased onto main after #813 squash → r4 approve → merged. Findings: Claude Code namespaces plugin agents (qualified name on host, bare in containers); Codex plugins cannot ship agents (TOML installed by `install-agent-roles.mjs`, refuses foreign-marker files — verified refusing nanoclaw's on this host). Bootstrap `7810177` (5.3.0/2.3.0) **unpushed**. |
| relocation | 4.3 | dispatched 23:05Z | **the operator 2026-09-14 ~23:05Z: bootstrap must be self-sufficient** — `/orchestrate` on a bare install has no `worker-frontier` today (def lives only in nanoclaw `container/agents/` + a hand copy in `~/.claude/agents/`, mtime 09-13; bootstrap never shipped a `worker-*` file). Plan: plugin ships `plugins/workflow/agents/worker-frontier.md` + generated `plugins/workflow-agents/agents/worker-frontier.toml` (Sol); nanoclaw vendors the `.md` with a drift test (design-artifact-loop pattern) that also pins `CODEX_WORKER_MODELS`. Open questions the worker must answer first: plugin-agent naming on the host (`<plugin>:worker-frontier` vs bare) and whether Codex loads plugin `agents/` natively. Bootstrap 5.3.0/2.3.0, separate nanoclaw PR. |

Post-deploy hand-action (after #813): re-copy `container/agents/worker-frontier.md` →
`~/.claude/agents/worker-frontier.md` (nothing in `src/` writes it) so the host Agent tool and
the host codex-sync watcher pick up Opus/high + Sol — until 4.3 lands and removes the hand copy.

Hand-actions done: bootstrap push, `groups/` commit `4d7626ee` (18 files — swept in the two
untracked `mr-wiki-*` groups), host `settings.json` caps.

**Decided 2026-09-14 (the operator deferred to WWBD recommendation): 5% headroom, one number both
sides.** SDK snapshots `process.env` into the spawned CLI (`sdk.mjs:221`); a mid-turn wall is
abort + full query replay (`claude.ts:2571–2591`), not a hot swap — so walling costs a turn
replay, not a cache miss. 0.6: `SLOT_PICK_HEADROOM = 0.05` — pick highest `seven_day < 0.95`.
0.7: `CODEX_PARK_USED_PERCENT = 95` (was 90 in the pre-objective plan text). Vetoed: ship
as-is (spends the last 5% *and* re-spends the interrupted turn); hot-swap now (no one-line
fix at the `sdk.mjs:221` seam — build only if measurement says walls persist). Retune at +7d:
slots resetting < 90% used → tighten to 0.97; mid-turn walls > 2/day → widen or build hot-swap.

**2026-09-15 01:03Z — host Codex account out of quota until 2026-09-21 03:28Z** ("You've hit your
usage limit"). Kills the substitute Astra review transport AND host `codex exec` workers
(`codex:codex-rescue` / `codex-finish-*`) for the week. Container groups use their own
`~/.codex-<folder>` homes — unaffected. Substitute-of-the-substitute: fresh-context Claude
reviewer (Opus/high `worker-frontier`) is the cross-family reviewer for Codex-authored heads
(reviewer-models.txt permits `claude-opus-5` / `claude-fable-5-1`); first used for #812 r4.
Note the tokens this session's reviews consumed: 8 Astra rounds tonight ≈ 45–75K each.
**01:37Z — Codex limits back** (the operator); probe `codex exec … "Reply OK"` = 19,350 tokens — that is the
fixed per-round floor (`--ignore-user-config` prompt + schema) before any diff is read. Astra
substitute review is the default again; fresh-context Claude Opus `worker-frontier` stays the
documented fallback for Codex-authored heads.

**Follow-ups surfaced by this round (not blocking):**
- Codex cloud code-review is out of credits; substitute CLI path works (`gpt-6-astra`) but
  `cross-model-review.md`'s transport string needs `--skip-git-repo-check` when run on the host
  (containers pre-trust `/workspace`; `--ignore-user-config` drops the host trust list).
- `block-destructive` guard treats the session scratchpad `/tmp/claude-*/` as non-ephemeral.
- `container/agent-runner/tsconfig.json` excludes `*.test.ts` and bun:test doesn't typecheck —
  test files drift from types silently (`poll-loop.test.ts` has live errors today).
- 0.7 "surface in `ncl`" not done; `provider_health` rows readable via `scripts/q.ts`.
- 0.7 ratchet +107 (`poll-loop.ts` +34, test +61, `types.ts` +12) — additive, reason in PR body.
- `codex-review.sh wait` is positional (`<sha> <since_iso> [minutes]`), not `--head`.
- **Two cleanliness bars on deploy.** `scripts/deploy.sh` `tracked_changes()` checks
  `--untracked-files=no`; the `prebuild` hook `scripts/check-build-clean.ts` checks full
  `--porcelain` and only waives docs-only dirt. An untracked non-docs dir (`reports/`, one
  HTML from an earlier session) passed deploy's guard, failed the build's, and cost a full
  rollback cycle (17:49Z). Either align the two, or have deploy.sh run the build's check
  up front before snapshotting. `reports/` moved to
  `/home/ubuntu/scratch/nanoclaw-v2-reports-moved-2026-09-14T1750Z` — recoverable.
- Review-note `class` must be registered under `## Classes` in `docs/review-notes.md`;
  `scripts/review-notes.test.ts` fails CI otherwise. `enforcement scope` was the fit here.
- **#811 live state at 22:35Z — deployed, ran, nothing to pick.** (Earlier "stale image"
  diagnosis was wrong: agent-runner source is NOT baked into the image — Dockerfile:6 — it's
  bind-mounted at `/app/src` from the boot snapshot `data/agent-runner-src/<ts>/`, which the
  22:02:49 restart took post-pull and which contains `claude-slot-pick.ts`. A bare
  `docker run` has no mount, so testing the image for source is meaningless.) The 22:16
  workgroup-1 Claude spawn ran the pick; every `/api/oauth/usage` pull returned **HTTP 429
  `rate_limit_error`** (verified from the host for `_5` and `_6`, 29–127 ms, with and without
  the beta header), so all six came back `unsampled` and it fell back to the ring walk —
  which found **5 of 6 slots `seven_day`-rejected** and landed on `_6`, where agent-B and both
  agent-A containers already sit. The session then failed over to Codex. Fleet at 22:35Z:
  3 Claude (all `_6`), 2 Codex, 1 OpenCode. Resets: `_3`/`_5` 04:00Z, `_1` 06:00Z, `_6`
  15:00Z (09-15). **Real #811 test is the first Claude spawn after 04:00Z.**
  **Live-confirmed 22:30:23Z** (agent-B Claude spawn, docker stderr): ring loaded, resumed `_4`,
  pick fired 5 pulls → each `Slot usage pull failed for <slot> (unsampled): usage pull HTTP
  429` — sanitized, no token value (F1 fix live) → summary line `7d=? 5h=? skipped:unsampled`
  ×5 → fallback kept `_4`. Ring is **5 slots, not 6: `CLAUDE_CODE_OAUTH_TOKEN_5` is empty**
  in `.env` (len 0) — it was live at 12:31Z (real readings) and 14:00Z (3 sessions); blanked
  sometime after. The ring's placeholder guard skips it. Fleet has 5 accounts tonight.
- **#811 follow-up — no throttle on the six-way pull. RESOLVED, and the recorded fix was
  wrong.** Old single-slot pull: `USAGE_PULL_MIN_INTERVAL_MS = 5 min` (`claude.ts:230`) —
  that constant governs the IN-TURN SDK `get_usage` pull for the ACTIVE slot and was never
  dropped. `pickCredentialSlotByUsage` had no throttle, and adding a per-slot one there
  would have been a **no-op**: it is called exactly once per container boot
  (`container/agent-runner/src/index.ts`, the single `await
  provider.pickCredentialSlotByUsage?.()`), and module scope is per-container scope, so a
  process that does the pull once and exits has nothing to throttle. Serving a fresh
  `rate_limit_samples` row instead is no better — those rows live in the SESSION's
  `outbound.db`, so a new session has none and no session can see another's.
  **Measured 2026-09-15 03:53Z** (fix PR `fix/slot-usage-pull-throttle`): the 429 is
  per-IDENTITY, not per-IP — a garbage bearer from the same host IP answered `401` in the
  same second, while `_2`/`_3`/`_4` all answered 429 with `retry-after` decoding to the
  same instant (04:45:48Z), while a slot from a group-scoped credential set on that same
  IP decoded to a different one (04:30:57Z). Identical window ends across three accounts is the
  signature of our own six-way parallel pull advancing every slot's bucket in lockstep, at
  the fleet's spawn rate (~25/hr, bursting 4-8/min). Real fix: the HOST surveys
  `/api/oauth/usage` on its own clock (`src/slot-usage-survey.ts`, one pull per slot per
  `SLOT_USAGE_SURVEY_MIN_INTERVAL_MS`, `retry-after` honoured) and hands each spawn the
  readings in `NANOCLAW_SLOT_USAGE_SURVEY`; the runner picks and records samples exactly as
  before and makes no network call. Request volume is now a function of time and ring size
  alone.
- **deploy.sh label-restamp on a cache hit** is still a real bug for what IS baked (deps,
  tools): a full-cache-hit build restamps `nanoclaw.commit` onto old layers, and the next
  deploy's `git diff $IMAGE_COMMIT HEAD -- container/` then sees no change. Harmless tonight
  (only `bun.lock`/deps are image-baked and didn't change). Fix: stamp only when at least one
  non-CACHED layer ran, or verify a deps fingerprint in the image before stamping. Builder
  cache pruned 22:24Z (83GB → 0; regenerates on next build).
- **Labeler gap:** `.github/labeler.yml` has no risk glob for
  `container/agent-runner/src/providers/claude*.ts`, so #811 — which chooses the OAuth token
  every container authenticates as — scoped `skip` and would have merged on green CI with no
  review. The voluntary Astra pass found a token-in-log path at 0.99. Add that path (and
  `claude-slot-pick.ts`) under `risk:credential`.

## Measurement

Instrument: `turn_usage` (central). Compare with
`strftime('%Y-%m-%dT%H:%M:%fZ','now','-N hours')`, never `datetime('now')`. Never compare
`steps` across providers; use `input_tokens + cache_read_tokens`.

Read at +24h and +7d. Success: Fable meter < 60% at week-end; Sonnet p95 API-turns < 12;
agent-A scheduled $/day < $40; agent-B cache-read/step < 150k after 0.5.

## Sequencing

0.1–0.5 as one PR now (dispatched 2026-09-14). 0.6–0.7 on approval, second PR. 1.1a first
thing tomorrow (one prompt edit). 2.1 in parallel (plugin, isolated). 3.1 when a worker is
free (isolated group). 2.3 after 2.1. 4.x on the next real build or if measurement says so.
1.1c only if a and b don't land it.
