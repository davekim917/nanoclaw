# Parity Spike Result (Group A / Task 0)

> Status: **A4 vision largely SETTLED empirically (2026-06-25). Claude + Codex PASS via direct CLI vision tests; OpenCode native vision untested on host (env-gated) but COVERED by the proven codex-exec L2 fallback.**

## A4 vision check — empirical results (2026-06-25)

Approach: the poll-loop harness (`scripts/spike-vision.ts`) needs full container env to
respond (timed out bare on host), so vision was tested **directly per provider CLI** —
the actual question (can the provider see a `Read` image?) is a CLI-level property. Each
was asked to view the pre-rendered `vision-sentinel.png` (upper half renders GREEN — a
detail absent from any readable source) and name the colour.

| Provider | Result | Evidence |
|----------|--------|----------|
| **Claude** | **PASS** | Read the sentinel PNG in a live Claude session and correctly described green-upper/cyan-lower. Read→vision confirmed (matches types.ts:79-83). |
| **Codex** | **PASS** | `codex exec --yolo "…name the upper half's colour…"` → answered **"green"**. The source never says green, so it could only get it by viewing pixels. Native Read→vision confirmed. |
| **OpenCode** | **INCONCLUSIVE on host (NOT a vision failure)** | Bare `opencode run` errors `UnknownError: Unexpected server error` even on a trivial non-vision prompt → host lacks the container's OPENCODE_* endpoint/auth env. Native vision must be tested inside a real container. **Covered regardless:** the design's documented L2 fallback for OpenCode's critic is `codex exec --yolo`, whose vision is now PROVEN. |

**Conclusion:** the render-grounded critic premise holds. Claude + Codex use native
L1 (Read→vision); OpenCode uses the codex-exec L2 fallback (proven) until its native
vision is confirmed in-container. No provider lacks a working critic path → C1 parity
holds for v0.

The spike's two load-bearing unknowns (A3 skill+tool surfacing, A4 critic vision
ingestion) were de-risked by code investigation + the operator's corrections; the
remaining confirmation is a deployment-time integration run.

## Settled by evidence (not a live run)

| Check | Finding | Evidence |
|-------|---------|----------|
| Render at parity (C2) | YES — agent-browser@0.28.0 + system chromium in the single shared image, all providers | Dockerfile:49,338,278-285; container-runner.ts:416 |
| `design_review` invocable on all 3 (A7) | YES — registered in the one `nanoclaw` MCP server (barrel `index.ts`); Claude SDK mcpServers, Codex `[mcp_servers.nanoclaw]` TOML, OpenCode `{type:'local'}` | Reviewer A S1; index.ts barrel edit |
| Skill surfaces to all 3 (A3) | YES — `~/plugins` + `container/skills` mounted; `syncAgentSkillsMirror` → shared `~/.agents/skills` for every runtime. OpenCode gets it as AGENTS.md text (no loader) — SKILL.md is written to be self-sufficient as plain text | Reviewer A S3, F3 |
| impeccable in-container | YES (operator-confirmed) — `/home/ubuntu/plugins/impeccable` mounted RO, `CLAUDE_PLUGINS_ROOT` auto-discovery | container-runner.ts:1363-1391 |
| Critic vision via `Read` (A4) | YES for Claude — the agent's `Read` yields base64 image (vision) blocks; the F4 text-ref path is the inbound CHAT-message formatter, which the critic AVOIDS by reading the file | types.ts:79-83; formatter.ts:480-493 |

## DEFERRED — must run against the rebuilt/deployed image

1. **Codex + OpenCode `Read`-vision in-container:** confirm a critic in a codex and an
   opencode container can `Read` `fixtures/vision-sentinel.html`'s PNG and **name the
   upper wedge's rendered colour** (a detail absent from the source). If a provider
   cannot, its documented fallback is `codex exec --yolo` (L2); a provider with no
   working critic path ships v0 disabled for that provider (C1 — surfaced, not silently
   downgraded).
2. **End-to-end loop on each provider:** write artifact → `design_review` renders both
   viewports with deterministic findings (slop fixture flags, good fixture passes —
   already unit-proven) → critic round-trip → `blocked`/`shipped-with-disclosures`.
3. **OpenCode follows the loop from AGENTS.md text** (no `/skill` loader).

## How to run (after `./container/build.sh` + restart)
- In a claude, a codex, and an opencode session: invoke the skill on a real request,
  confirm `design_review` is callable, render fixtures, and run the sentinel vision check.
- Record PASS/FAIL per provider here; escalate any provider with no critic path.
