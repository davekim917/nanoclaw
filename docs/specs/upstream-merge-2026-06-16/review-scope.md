# Focused review scope — upstream merge `bbb706b6`

**What this is.** The 2026-06-16 merge pulled 180 upstream nanoclaw commits into the
davekim917 fork. The 180 upstream commits were already reviewed upstream; the risk
surface is the **34 files I hand-resolved conflict markers in** plus **25 files git
auto-merged where both sides changed** (auto-merge can silently splice two behaviors
wrong). Don't spend review tokens on the 180 imported commits — concentrate here.

**Merge facts**
- Merge commit: `bbb706b6` (2 parents: ours `63ac97eb`, upstream `dd60983f`; base `0683c6ec`)
- New code on top: `ddec9da3` — Codex AGENTS.md size-cap guard (not a conflict, review as new code)
- Validation already green: host `tsc` clean, `pnpm test` 1991 pass / 1 todo, behind-upstream = 0

**How to drive the review.** `/code-review ultra` reviews the whole branch (182 commits
ahead of origin — mostly noise). Point the reviewers at the file groups below and the
per-group "VERIFY" questions. Useful diff commands per file:
- Resolution only (combined diff, just the hand-merged hunks): `git show bbb706b6 -- <file>`
- The two sides that were merged:                               `git diff 63ac97eb dd60983f -- <file>`
- The new cap guard:                                            `git show ddec9da3`

---

## TIER 1 — CRITICAL: hand-resolved logic unions (review every line)

### A. Provider / agent-runner turn loop
These are *unions of two independent behavior sets* — the class of merge most likely to
be subtly wrong even though it compiles + passes tests.

| File | Decision | VERIFY |
|------|----------|--------|
| `container/agent-runner/src/providers/claude.ts` | UNION: our `rotateApiKey`/`isRetryable`/`isContextTooLong` + upstream `maybeRotateContinuation` + `archiveTranscriptFile` + pre-compact autosave→archive | Brace balance (a missing `}` on `rotateApiKey` was caught by typecheck + fixed — confirm the closing brace is correct, not papering over a scope bug); credential-rotation retry still wraps the right try-scope; autosave and archive don't double-write the same transcript |
| `container/agent-runner/src/providers/types.ts` | UNION: added `ProviderExchange`/`onExchangeComplete`/`config.signal` to our provider types | The `/**` doc-opener re-added above `maybeRotateContinuation` (the conflict shared the preceding `/**`, leaving the doc orphaned — confirm no other JSDoc block is half-open) |
| `container/agent-runner/src/poll-loop.ts` | Upstream `processQuery` grew 4→7 params; our 3 retry call sites updated | **Arg ORDER at each of the 3 call sites** — params are positional; confirm `onExchangeComplete`, `prompt`, and `continuation`/`undefined` land in the right slots at every site (a transposition typechecks if types coincide) |
| `container/agent-runner/src/poll-loop.test.ts` | Assertions for the 7-arg signature | Tests assert the resolved signature, not a stale 4-arg shape |
| `container/agent-runner/src/formatter.ts` | ADOPTED upstream: dropped the `<messages>` envelope (now concatenated `<message>` blocks) | No remaining consumer parses for the `<messages>` wrapper; the formatter test was updated to match |

### B. Host container spawn + mounts
| File | Decision | VERIFY |
|------|----------|--------|
| `src/container-runner.ts` | KEPT OURS archive/central projections (security) + `getSessionClaudeMounts` gated on `defaultSurfaces` + `mkdir(sessionDir)` before projections + OneCLI/egress conditionals + MCP assembly. Our `applyContainerConfig` (≈2416) runs **before** the mounts loop (≈2547) — ordering differs from upstream | Projection dirs still created before write; mount order correct (config before mounts loop); egress block is a no-op when lockdown disabled; OneCLI `applyOnecliSecrets` path intact |
| `src/index.ts` | KEPT OURS init order + upstream `enforceUpgradeTripwire()` + egress | Tripwire call present; our migration/adapter/sweep startup sequence intact and in the right order |
| `src/host-sweep.ts` | KEPT OURS sweep + upstream `ensureEgressNetwork()` re-heal | `processing_ack` sync / stale detection / due-wake / recurrence all intact; egress re-heal is no-op by default |
| `src/group-init.ts` | KEPT OURS scaffold | per-group `agent-runner-src/` overlay + skills mounts preserved |

---

## TIER 2 — channel-instance dimension (adopted structurally; we kept channelType siblings)

The instance feature (`messaging_groups.instance NOT NULL`, migration 016) auto-merged
pervasively. We KEPT our `config.channelType` sibling mechanism (siblings are distinct
channel_types: `discord-opencode`, `discord-codex`) and let `instance` backfill to
`channel_type` via the registry's `instance ?? channelType` fallback.

| File | VERIFY |
|------|--------|
| `src/router.ts` | Sibling routing still resolves (channel_type=`discord-opencode`); our non-chat-kind conditional + `effectiveThreadId` preserved alongside `mg.instance` threading |
| `src/delivery.ts` | Our delivery behavior (post-fresh final + delete orphan thinking message) preserved through the instance threading |
| `src/session-manager.ts` | session resolution threads instance without breaking per-thread mode |
| `src/channels/chat-sdk-bridge.ts` | bridge object keeps channelType (taking upstream's instance-only would break sibling routing); adopted upstream's URL-safe instance-name validation |
| `src/db/migrations/index.ts` | migration 016 present exactly once, in order; **already verified safe against live data/v2.db during merge** (column match, backfills instance=channel_type) |
| `src/cli/resources/groups.ts` | instance field threaded through CRUD without dropping our group fields |

---

## TIER 3 — KEPT-OURS features (the review job here is "did anything upstream LEAK IN?")

| File | VERIFY nothing upstream slipped through |
|------|----------------------------------------|
| `src/modules/agent-to-agent/create-agent.ts` + `.test.ts` | Restored from backup. Confirm: ALWAYS routes through admin approval (NO `cli_scope=global` direct-create shortcut); `provider`/`provider_config` passthrough; memory bootstrap; `safeRemoveFolder` rollback |
| `src/webhook-server.ts` + `.test.ts` | KEPT OURS (dashboard-router integrated). Confirm upstream's parallel `registerWebhookHandler` raw-route registry was NOT reintroduced |
| `src/providers/provider-container-registry.ts` | KEPT OURS (codex/opencode siblings + effort/model arch); upstream's provider-switch model not spliced in |
| `src/modules/approvals/response-handler.ts` | our approval-response handlers intact |

---

## TIER 4 — build / deps / supply-chain (high-signal, low-effort checks)

| File | VERIFY |
|------|--------|
| `package.json` / `pnpm-lock.yaml` | onecli kept at `^0.5.0` (NOT upstream's 2.2.1); `@slack/web-api` present; **no `minimumReleaseAgeExclude` / `onlyBuiltDependencies` entries snuck in from upstream** (hard policy) |
| `container/agent-runner/package.json` / `bun.lock` | exact pins preserved (claude-agent-sdk `0.3.154`, @anthropic-ai/sdk `0.93.0` peer, MCP SDK `1.29.0`, cron-parser `5.5.0`) — no caret re-resolution |
| `container/Dockerfile` | KEPT OURS ARG-pinned CLI installs (NOT upstream's `cli-tools.json` manifest); CLI version ARGs present |
| `vitest.config.ts` | agent-runner tree still excluded (vitest can't load `bun:sqlite`) |
| `.gitignore` | merge didn't drop our ignore lines |

---

## TIER 5 — low risk (skim)

- `CLAUDE.md` — verify a stray `=======` conflict marker isn't left (one was found + removed during merge)
- `.claude/skills/add-opencode/SKILL.md`, `.claude/skills/update-nanoclaw/SKILL.md`
- Test files updated to assert resolved behavior: `src/container-runner.test.ts`, `src/session-manager.test.ts`, `src/channels/chat-sdk-bridge.test.ts`

---

## NEW CODE this session (review as new, not as a merge) — commit `ddec9da3`

- `src/codex-project-doc-cap.ts` (+ `.test.ts`) — `capCodexProjectDoc()`: fits the composed
  AGENTS.md under Codex's 32KB `project_doc_max_bytes` by dropping the largest `## ` sections,
  keeping the head, appending an omission note. **Never throws** (a per-spawn throw would ride
  wakeContainer's retry contract → host-sweep respawns forever → group goes silently dark).
  VERIFY: degradation keeps the highest-priority head; head-oversized fallback writes oversized
  rather than bricking; 4 unit tests cover under-cap / near-cap / degrade / head-oversized.
- `src/codex-sync.ts` + `src/claude-md-compose.ts` — one-line integration of the cap at the two
  AGENTS.md write sites (`~/.codex/AGENTS.md` and `groups/<folder>/AGENTS.md`).

---

## The 25 auto-merged both-touched files (Tier-2 sweep, lower priority)
`src/types.ts`, `src/db/schema.ts`, `src/db/messaging-groups.ts`, `src/command-gate.ts`,
`src/channels/adapter.ts`, `src/channels/channel-registry.test.ts`,
`src/modules/approvals/primitive.ts`, `src/modules/permissions/channel-approval.ts`(+`.test.ts`),
`src/modules/permissions/index.ts`, `src/modules/agent-to-agent/agent-route.ts`,
`src/modules/agent-to-agent/index.ts`, `container/agent-runner/src/index.ts`,
`container/agent-runner/src/mcp-tools/agents.ts`, `container/agent-runner/src/integration.test.ts`,
`container/agent-runner/src/formatter.test.ts`, `scripts/init-first-agent.ts`,
`setup/auto.ts`, `setup/register.ts`, `src/host-core.test.ts`, `src/delivery.test.ts`,
`src/modules/permissions/channel-approval.test.ts`, `docs/db-central.md`,
`.claude/skills/add-discord/SKILL.md`, `.claude/skills/add-gcal-tool/SKILL.md`,
`.claude/skills/add-gmail-tool/SKILL.md`
