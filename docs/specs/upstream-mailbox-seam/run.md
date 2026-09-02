# Run record: upstream-mailbox-seam

## Stage: plan (2026-09-02)

Primary runtime/model: Claude, Fable 5.1 (orchestrator). Grounding delegated to two Sonnet workers (ledger extraction; fork session-DB inventory) — reports verified against source before use.

### Grounding evidence

- Memory read in order: convergence program, spikes, re-baseline ledger, production-critical, main-only checkout rule, Node 22 gate.
- Record read: README, ledger §3/§4/§8.2/§10, spike-mailbox.md, spike-verification.md (end to end), spike-poll-loop.md (via worker), seam-catalog §17, spike-mailbox.patch (subclass, admission-gate, poll-loop hunks).
- Upstream `5c3082a1` read from the fork's `upstream` remote objects: `docs/agent-mailbox-seam-migration.md`, `src/mailbox/{types,index,compose}.ts`, `src/mailbox/sqlite/{index,schema,session-db}.ts` (lifecycle, migrations, PRAGMAs), `src/session-manager.ts` exports + `withMailboxSession` block, `src/container-runner.ts:290-330`, runner `mailbox/{types,index,compose}.ts`, `mailbox/sqlite/{index,connection}.ts`, `index.ts` boot, `package.json` mailbox-model scripts.
- Fork inventory (worker, read-only): 38 exports of `src/db/session-db.ts` mapped to upstream ops; 23 host callers with symbols and call-site counts; `container-restart.ts` engine vs upstream (1 export); runner `db/*` exports mapped; 25 runner callers incl. `poll-loop.ts` zones; migrations 045 name and the two `sessions` partial UNIQUE indexes; 46 test files touching the raw layer.
- Live checks: `codex` 0.151.0 present with `--ignore-user-config/--ephemeral/--output-schema/--output-last-message`; logged in; fork has no `src/mailbox`, no `src/nc`, no `src/test-setup.ts`, no runner `modules/`; canary group folder exists; public-boundary check is structural + registry (plan avoids install identifiers).

### Decisions taken in the plan (engineering, per the program's delegation)

1. Fork module locations `src/modules/mailbox/` and `container/agent-runner/src/modules/mailbox/` (fork convention), not the spike's `src/nc/`.
2. `session-db.ts` becomes a re-export façade during transition (one SQL implementation at all times), deleted in PR 7.
3. Runner callers keep upstream's compat shims byte-identical; fork-only ops are imported from the module (import-path rewrite, no call-site change).
4. Fork inbound `kind` values stay on disk; the fork parser accepts the measured set. No wire-format change.
5. `registerAdmissionGate` contract renamed to boundary-observer semantics (side effect documented, every gate evaluated, one open per poll).
6. Drift test = sha256 manifest (CI has no upstream objects) + raw-access ratchet with a subset-only allowlist.
7. Deploy order 1 → (2 ∥ R1) → 3 → 5 → 4 → 6 → R2 → 7 → R3, one per quiet-hour window; QA seat restarted first after each gate.

### Cross-model review (plan stage)

- Stage: plan. Primary: Claude (Fable 5.1). Reviewer: Codex CLI 0.151.0, requested `gpt-5.6-sol`, `model_reasoning_effort="high"`, `--ignore-user-config --ephemeral --yolo`, `--output-schema references/codex-review-output.schema.json`, `--output-last-message review.json`. Prompt: vendored `codex-adversarial-prompt.md` with the four markers filled (target = plan.md; focus = deploy safety, runner-before-host window, same-key nesting, inbound kinds, acceptance-criteria strength + plan-fidelity/verification-quality/simplicity lenses + `docs/review-policy.md`; collection guidance = read-only archive of fork HEAD and upstream 5c3082a1 under the review dir; input = plan.md revision 1). Prompt 51,220 bytes on stdin.
- Command run in the foreground from `<scratchpad>/review-tree`, `timeout 3540` inside a 3,600,000 ms tool timeout. Start 23:15:30Z, end 23:22:05Z, exit 0. Status: **completed**. Output: valid JSON, verdict `needs-attention`, 5 findings, all schema fields present → recorded as **must_fix**. Codex metadata reports no model/effort field to cross-check (the CLI does not echo it in `--output-last-message`); effective settings are the explicit flags.
- Raw artifacts: `<scratchpad>/review-tree/{prompt.txt,review.json,codex-stdout.log}` (stdout log 672 KB, not copied here).

| # | Codex finding (severity, confidence) | Lead verification | Disposition |
|---|---|---|---|
| 1 | QA runner cannot be guaranteed first on new code; `git pull` updates the live bind-mounted runner tree non-atomically before the host restart (high, 0.99) | Confirmed: `src/container-runner.ts:2155-2156` mounts `<checkout>/container/agent-runner/src`; memory `project_agent_runner_source_bind_mounted` documents the live-mount behavior; nothing snapshots it | **MUST-FIX** → PR 0 boot snapshot (§4.8), I-1 rewritten, H-0a/H-0b, rollback rehearsal on R1 |
| 2 | PR 4 puts `writeSessionMessage` behind the guard while delivery handlers still run inside the delivery session; `spawn_cancel` writes to its own parent session inside a try/catch → notification silently lost, row acked (high, 0.98) | Confirmed: fork `DeliveryActionHandler(content, session, inDb)` at `src/delivery.ts:1405-1409`; `modules/orchestrator-dispatch/cancellation.ts:84-99` catches the write failure; upstream's handler is two-argument (`delivery.ts:570` @5c3082a1) | **MUST-FIX** (data loss class) → §4.5b, I-9, PR 3 scope = contract + 15 `inDb` receivers, H-12, PR 4 gated on PR 3 soak |
| 3 | R1 may ship before the inbound-kind set is measured (PR 2 measures it, R1 parallel); R-3 tests one presumed value; `status` is an outbound kind (high, 0.94) | Confirmed sequencing hole; the `status` claim came from a runner predicate, not a measured inbound population | **MUST-FIX** (silent row drop) → M-1 in PR 1, checked-in `inbound-kinds.ts`, R1 depends on it, R-3 parameterized + negative control via the compat surface |
| 4 | H-1 completeness only covers `mailbox/**`; docs/shims/heartbeat/barrel could be omitted or patched (medium, 0.99) | Confirmed against plan text | **SHOULD-FIX**, folded in → explicit `UPSTREAM_FILES` constant, set-equality assertion |
| 5 | Ratchet misses SQL executed on a handle passed from elsewhere (delivery `inDb`); 15 receivers, 4 execute SQL (medium, 0.96) | Confirmed: `grep -rl inDb src/modules src/cli src/dashboard` = 15 files; `.prepare/.exec` on it in 4 | **SHOULD-FIX**, folded in → ratchet patterns (d) handle names + (e) arity-2 type assertion; receivers in PR 3 scope |

Rejected findings: none. Coverage: other-family review **completed** (Codex). One correction batch applied (plan revision 2); no further review loop per the contract. Residual: PR 0 is new scope the operator should see (operator-visible habit change noted in §9).

### Program-level assumption carried (not this seam's scope)

Received from the orchestrating session after the review: the G01 credential lane (~895 lines, spawn path) is expected to be avoidable without an upstream change — host-minted GitHub App token written to a per-group file (truncate-in-place), mounted read-only, consumed by a git credential helper + `gh` shim instead of `GITHUB_TOKEN` env; upstream already admits by-reference credentials. No credential-lane PR to upstream; issue #3701 question 2 asks upstream to confirm. Size G01 at ~50 fork lines when the session-driver seam is planned. Nothing in this plan depends on it.

### Open for the operator

§9 Q1 (deploy cadence, 11 restarts) and Q2 (two public upstream asks). Approval of plan.md revision 2 is required before `/team-build`.

## Approval (2026-09-02)

Operator approved plan.md revision 2 via the orchestrating session. Answers: Q1 = 11 single quiet-hour restarts, one PR per restart, never paired (one variable per restart). Q2 = both public upstream asks covered by standing approval; post when the plan says to and mention each in the report. Standing conditions restated: every host restart is surfaced to the operator for approval before it runs; post-restart check = sync-upstream §4 gate (spawn success within 2 min + a running container); Slack announce first; QA seat first; report to the orchestrating session at each PR merge and before each restart.

## Stage: build — PR 0 (runner source boot snapshot)

Started 2026-09-02. Record continues below.
