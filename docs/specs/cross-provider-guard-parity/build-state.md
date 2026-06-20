# Build State — cross-provider-guard-parity (lead checkpoint)

> /team-build under /team-auto. Lead orchestrates; builders write code. Updated per group completion.
>
> **STATUS: ALL STAGES COMPLETE → ship gate.** A(review 5/5, MUST-FIX 0) · B(plan 8 groups) · C(build 8/8, post-build drift CONFIRMED) · D(qa: 1 MUST-FIX M-QA1 FIXED+tested, MUST-FIX 0). 1 HIGH pre-existing escalated (codex #2 email bypass), 2 SHOULD-FIX for ship review. Stopped at Stage E — awaiting Dave's /team-ship.

## Repos / branches
- nanoclaw-v2: `/home/ubuntu/nanoclaw-v2`, branch `feat/clone-repos-namespace-git-clone-parity` (Groups E, F, G + H docs). Container tests: `cd /home/ubuntu/nanoclaw-v2/container/agent-runner && bun test <file>`. Typecheck: `cd /home/ubuntu/nanoclaw-v2 && pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`.
- bootstrap: `/home/ubuntu/plugins/bootstrap`, branch `main` (Groups A, B, C, D). Guard tests: `cd /home/ubuntu/plugins/bootstrap/plugins/workflow/hooks/guards && bun test <file>`.

## Pre-build drift: MISSING 0, DIVERGED 0, 13 CONFIRMED ✓

## Build waves
- W1 (independent): A, G, H
- W2 (needs A): B
- W3 (needs A+B): C1/C2, D
- W4 (needs D): C3, E
- W5 (needs B+E): F

## Group status
| Group | Repo | Status | Tests verified | Notes |
|-------|------|--------|----------------|-------|
| A | bootstrap | ✅ COMPLETE | 27/27 named + 240/240 suite, tsc 0 err | evaluateSelfApproval(:128)+evaluateSnowflakeConnector(:155)+runGateRequest(:1113)+runNanoclawGate(:1143 sig UNCHANGED)+runEmailGate(:1157); email-gate-core.ts pure; A3 faithful-to-source (scheduled bypasses, +dryrun bypass +segment-scoping pin). Lead-verified: tests grep'd+run, purity confirmed, D18 callers intact, typecheck clean. |
| B | bootstrap | ✅ COMPLETE | 13+ named, 256/256 full suite, tsc 0 err | opencode-guard wires self-approval/snowflake/git-clone/destructive/email (chain order matched); assertCoreExports(:63) fail-closed on missing evaluator OR gate wrapper; email→request_bash_gate via runEmailGate. Lead-verified: full suite 256 pass (A's tests GREEN in combined run = mock-leak fixed), assertCoreExports present, named tests exist. ⚠ HAZARD for C/E: Bun mock.restore() does NOT undo mock.module() — capture pristine core at load + restore via mock.module in afterEach (B's pattern). |
| C | bootstrap | ✅ COMPLETE | 117 new, 373/373 full suite, tsc 0 | C1 conformance manifest (+self-approval/snowflake/email rows), C2 opencode-dispatch (real entrypoint, per-gate action + chain order + guard-absence fail-closed), C3 differential-cores (SoT==vendored over corpus). Lead-verified: 373/0 (no mock leak), --check still 0 (E did NOT touch SoT — C's "E editing bootstrap" note was a misattribution of A's working-tree changes), probes cleaned. Deviation: fail-closed driven via spyOn(assertCoreExports)+realValidator(broken) due to Bun mock.module namespace limit — faithful (real entrypoint+validator+broken core). |
| D | bootstrap | ✅ COMPLETE | --check exit 0, 256/256 suite | VENDORED_FILES+=email-gate-core.ts; re-vendored (vendored block core has A's exports, new vendored email-gate-core.ts w/ banner); bumped workflow plugin 2.5.2→2.5.3, workflow-agents codex 0.4.2→0.4.3, .claude-plugin/marketplace 2.5.3; vendor-check.yml created (R2 comment). Lead-verified: --check 0, deviation (.agents/plugins/marketplace.json has NO version field) CONFIRMED correct (3 manifests bumped, not 4). |
| E | nanoclaw | ✅ COMPLETE | 64/64 E tests isolated, tsc 0; full suite 10 fail = known flakes only | E0 secret-env.ts (SDK-free, single-source, 0 dup in claude.ts); E1-E3 claude.ts factories delegate to vendored core + inline fail-closed fallback, SIGNATURES UNCHANGED, Claude async ack+request_bash_gate preserved; E4/E5 BOTH Codex cores fail-closed on missing/malformed/throwing→deny; E6 dispatch tests. runner.test.ts:160 contract INVERTED (fail-open→fail-closed). Lead-verified: isolation 64/0, factory sigs unchanged, :160 inverted, typecheck 0, full-suite 10 fail = documented spawn_*/send_message/poll-loop flakes (pass in isolation, NOT E's files). Deviation: +1 line db/connection.ts (test-fixture delivered.error column — real schema.ts:215 HAS it; verified parity fix, unowned file, flagged not silent). Used spyOn not mock.module (hazard avoided). |
| F | nanoclaw | ✅ COMPLETE | 12/12 F tests, tsc 0; full suite 10 fail = known flakes | F1 buildOpenCodeConfig THROWS on absent guard + ternary collapsed (unconditional plugin) + OPENCODE_ALLOW_UNGUARDED opt-out; F2 buildOpencodeServerEnv strips secrets via shared buildSecretEnvVarList (no dup); F4 enumeration grounded in LIVE opencode@1.15.7 binary (14 built-ins), classify-or-fail + SDK_DISALLOWED_TOOLS absence + single-source import from claude.ts. Lead-verified: failClosed 8/0 + enumeration 4/0, throw+collapse+opt-out present, single-source (0 dup defs), full-suite 10 fail = known flakes only (none F's), typecheck 0. |
| G | nanoclaw | ✅ COMPLETE | 24/24 named, tsc 0 err | getReposDir/resolveRepoDir/clone_repo origin-match + rmSync tightening + both allowlists + isAllowedFilePath boundary hardening (closes prefix-lookalike, matches poll-loop:87-88). Lead-verified: tests run, env-overrides default canonical, rmSync refuses non-empty no-.git, lookalike rejected. |
| H | nanoclaw | ✅ COMPLETE | docs (no tests) | clone-as-codex + clone-as-opencode + new clone-as-provider-template; normative contract (gap-notes removed after revision), shared cores named (incl email-gate-core.ts), conformance/dispatch "done" gate, C6 caveat + codex no-op caveat kept. Lead-verified: grep clean, frontmatter valid, scope clean. |

## Builder assignments (file ownership — no overlap)
- builder-A → bootstrap: block-destructive-core.ts, email-gate-core.ts (+evaluators.test.ts, email-gate-core.test.ts)
- builder-G → nanoclaw: mcp-tools/git-worktrees.ts(+test), mcp-tools/core.ts(+test), poll-loop.ts(+poll-loop.allowlist.test.ts)
- builder-H → nanoclaw: .claude/skills/clone-as-codex/SKILL.md, clone-as-opencode/SKILL.md, clone-as-provider-template/SKILL.md (new)

## Validation log
(per-group: files exist, named tests grep'd + run individually, acceptance criteria checked, typecheck clean)
