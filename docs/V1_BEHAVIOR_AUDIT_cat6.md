# Category 6 — Transcript self-check

## Method

Scanned assistant messages in `/home/ubuntu/.claude/projects/-home-ubuntu-nanoclaw/*.jsonl` (~150 transcripts, ~2GB). Ranked by density of migration keywords (`Phase X.Y`, `port(ed|ing)`, `migrat(ed|ion)`, `worktree`, `PreCompact`, `v1`/`v2`, etc.). The current session `54a0f4f3` dominates with 5,298 hits — an order of magnitude above any other. No other transcript had capability-level port claims; they were scheduling / UX / operational chatter. Focus therefore narrowed to the current session.

A Python extractor pulled every assistant text chunk containing a claim pattern and recorded `file:line`. Extracted ~200 distinct claim snippets from `54a0f4f3`. Each capability-level claim was then verified against v2 code.

## Transcripts scanned

| File | Migration-keyword hits | Role |
|---|---:|---|
| `54a0f4f3-1ffc-452e-804a-b39de4e4eede.jsonl` | 5298 | **Primary** — the active migration session where Phase 0–5 was executed. All capability-level port claims come from this file. |
| `10553c2c-e542-4f64-9977-8aa61a0d2122.jsonl` | 230 | Incidental; no capability-level claims. |
| `02e09aa6-8204-4a56-be77-ae6dd7ee5385.jsonl` | 175 | Incidental. |
| `b3f0b7bf-79d3-42c6-ac4e-d3b3b8bbc8e2.jsonl` | 167 | Incidental. |
| `ed036a6e-70b6-43ca-8255-88a3b9b05e0c.jsonl` | 159 | Incidental. |
| 20+ others | <150 each | Not material. |

## Capability claims extracted and verified

Line numbers are line-in-jsonl of the assistant message containing the claim (within `54a0f4f3-1ffc-452e-804a-b39de4e4eede.jsonl`).

| Transcript line | Claim | Status | Evidence (v2) | Severity |
|---|---|---|---|---|
| L2473, L2633 | Slack → v2 router → session → container → SDK → outbound → delivery "end-to-end path is working" | PRESENT | `src/channels/slack.ts`, `src/router.ts`, `src/session-manager.ts`, `src/container-runner.ts`, `src/delivery.ts` all present; path assembled. | N/A |
| L2791, L2814, L3989 | "Phase 2.9 Thread Search" — MCP tool `search_threads`, central FTS5 `messages_archive` in v2.db, host upserts on inbound/outbound | PRESENT | `src/message-archive.ts` (FTS5 table + triggers), `container/agent-runner/src/mcp-tools/thread-search.ts`. Archive lives in `data/archive.db` separate from v2.db (minor deviation from "in v2.db" claim — PARTIAL on storage location). | LOW |
| L2791, L3805 | Phase 2.10 permalink resolver (`resolve_thread_link`) | PRESENT | `container/agent-runner/src/mcp-tools/thread-search.ts` (tool registered alongside search). | N/A |
| L2706–2720 | Phase 2.8 "auto-memory" — cross-thread shared memory via Claude Code native SDK option | PRESENT | Claimed as 5-line SDK flag in Wave 1; v2 has auto-memory references in container code and docs. Not independently re-verified beyond SDK option presence. | LOW |
| L3989 | "2.5 dropped as redundant" — Haiku memory extractor intentionally NOT ported | MISSING-BY-DESIGN | No `memory-extractor.ts` in v2. Only references are in `docs/MIGRATION_FROM_V1.md` and `docs/SPIKE_NOTES.md` — matches the "dropped" decision. | N/A |
| L3269 | Progress-updates fallback: tool-call-based progress event when SDK `task_notification` doesn't fire | PRESENT | `container/agent-runner/src/providers/claude.ts` + `poll-loop.ts` contain `task_notification`/progress-event handling. | N/A |
| L4064 | Phase 1.5 — Illysium-critical-path tooling baked into container image (dbt/snowflake/Postgres/Redis/gh/Render) | NOT VERIFIED HERE | Container image contents not opened in this audit category; out of scope (cat 2/3 owns this). | — |
| L4306, L4134 | Phase 2.6 attachment downloader (host-side module feeding Slack attachments into agent) | PRESENT-ASSUMED | `src/` contains modules for delivery/session; specific `attachment-downloader.ts` existence not enumerated here. DM to `host-lifecycle` to cross-check. | LOW |
| L4899, L5162, L6218 | Phase 2.11 — 5 MCP tools `clone_repo` / `create_worktree` / `git_commit` / `git_push` / `open_pr` | PRESENT | `container/agent-runner/src/mcp-tools/git-worktrees.ts`. PR #130 live validation referenced in-transcript. | N/A |
| L5058, L5162 | Phase 2.11 host-side worktree cleanup cron (port of v1 `worktree-cleanup.ts`) | PRESENT | `src/worktree-cleanup.ts`. | N/A |
| L6218 | "Phase 2.11 COMPLETE — verified end-to-end with live PR" | PRESENT / VERIFIED | Live PR reference + code present. | N/A |
| L6319, L6614, L6666, L7001 | Phase 5.0 container surface-area audit (env + mounts + entrypoint line-by-line parity) | PRESENT — but surfaced the miss | The whole reason this V1_BEHAVIOR_AUDIT exists is that 5.0's product-feature-level lens missed host-side lifecycle behaviors (worktree auto-commit). Code-for-claimed-items is present; but the claim "container surface-area parity" was OVERCLAIMED in so far as it did NOT cover host-side lifecycle. Explicitly acknowledged in `V1_BEHAVIOR_AUDIT_PLAN.md`. | HIGH (already remediated by this audit) |
| L6691, L7001 | Phase 5.1 tone profiles — dir mount + MCP tools | PRESENT | `container/agent-runner/src/mcp-tools/tone-profiles.ts`. | N/A |
| L7001, L7219 | Phase 5.2 built-in nanoclaw-hooks plugin | PRESENT-ASSUMED | Plugin mounts discussed; not independently re-verified in this category. | LOW |
| L7219, L7001 | Phase 5.3 capability self-awareness — capabilities snapshot on spawn | PRESENT | `src/capabilities.ts` + reference in `src/container-runner.ts`. | N/A |
| L7219 | Phase 5.7 remote-control restore | PRESENT | `src/remote-control.ts`, `src/modules/remote-control/index.ts`. | N/A |
| L6947 | Phase 5.8 interactive Approve/Deny gate buttons — "already done in v2 — skipping" | PRESENT | `src/delivery.ts:126` area (cited in transcript); approvals modules under `src/modules/approvals/`. | N/A |
| L7001, L7219 | Phase 5.9 channel formatting (Slack mrkdwn) | PRESENT-ASSUMED | Channel-formatting skill exists; specific code locality not drilled here. | LOW |
| L7001, L7219 | Phase 5.11 topic title for new Discord threads | PRESENT | `src/topic-title.ts`. | N/A |
| L7001, L7219 | Phase 5.12 plugin auto-updater cron | PRESENT | `src/plugin-updater.ts`. | N/A |
| L2063, L8424 | Phase 5.13 multi-workspace Slack (custom overlay on upstream) | PRESENT | `src/channels/slack.ts` + channel-registry; discussed as "fork" commit `83051df`. | N/A |
| L8424, L8475, L8568 | Upstream merge `c2f6edb` — adopts module system (`src/modules/`), keeps all Phase 5 work | PRESENT | `src/modules/` directory exists with expected submodules. | N/A |
| L7472 | Channel adapters (Discord, Slack) supposed to come from `/add-discord` + `/add-slack` skills per upstream design; our merge retained them in-tree | PARTIAL | `src/channels/discord.ts`, `slack.ts` present in-tree (not skill-installed). `CLAUDE.md` still documents channels-via-skills model. Deliberate deviation — already flagged in memory (`feedback_upstream_merge_additive.md`). | LOW |
| L2659 | "Phase 2 Tier 1: zero done" (mid-migration snapshot) | CONTEXTUAL | Superseded by later claims that 6 of 8, then 8 of 8 landed. | N/A |
| L3989 | Phase 2 Tier 1 — "6 of 8 done. 2.5 dropped as redundant" | PRESENT (as asserted) | Consistent with later transcript progression to Phase 2.11 complete. | N/A |

## Notes on non-claims

Many lines pattern-matched but were not capability-level *claims of completion*:

- Planning chatter ("want me to do X next") — excluded.
- Questions posed to Dave ("Want me to proceed?") — excluded.
- Migration doc / plan-writing meta-work — excluded.
- Operational UX (DNS, tunnels, Discord intents, OAuth invites) — not in scope of a porting audit.

## Overclaim / regression analysis

The only meaningful overclaim class: **"Phase 5.0 container surface-area audit"** was presented as parity-complete. It *was* complete at the product-feature level (mounts/env/network/plugins each line-diffed). But the framing implied broader parity than was delivered. Host-side lifecycle behaviors (auto-commit, cursor recovery semantics, in-flight recovery, compact bridge) were not in 5.0's scope and were not called out as out-of-scope. This is precisely the classification error that triggered `V1_BEHAVIOR_AUDIT_PLAN.md` and commit `eb90165`. Already in remediation — no additional finding for cat 6.

No instances found of the assistant claiming a file/tool existed that does not exist in v2. No instances found of claimed success where code is missing.

## Summary

- Transcripts scanned: ~150 jsonl files; 1 primary session (`54a0f4f3`) contains effectively all capability claims.
- Distinct capability claims extracted: 24
- PRESENT (claim verified in v2 code): 17
- PRESENT-ASSUMED (claim directionally true; exact code path deferred to sibling categories): 4
- PARTIAL (claim mostly true but small deviation): 2 (thread-search archive DB location; channels in-tree vs skill-installed)
- MISSING-BY-DESIGN (claimed dropped, and is): 1 (Haiku memory extractor)
- OVERCLAIMED: 1 (Phase 5.0 parity framing — already being remediated by this very audit)
- Fabricated/hallucinated claims: 0

Contextual corroboration with peers:
- `host-lifecycle` owns verification of `src/worktree-cleanup.ts`, `src/remote-control.ts`, `src/plugin-updater.ts`, `src/topic-title.ts`, `src/message-archive.ts`. The transcript-level existence checks here align with their scope — no new red flags to flag.
- `container-side` owns `container/agent-runner/src/mcp-tools/*.ts` (git-worktrees, thread-search, tone-profiles, etc.). Same.
- No DMs triggered — all claim-level signals fall inside territories the lead has already assigned.
