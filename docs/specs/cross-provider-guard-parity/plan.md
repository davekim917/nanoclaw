# Plan: Cross-Provider Guard Parity

> `/team-plan` 2026-06-19 · from design.md (CLEARED review cycle 5/5, MUST-FIX:0) + decisions.yaml (C1-C12, D1-D18) + review.md (cycle 5)
> Spans TWO repos: **nanoclaw-v2** `container/agent-runner/` (Bun, `bun:test`) + **bootstrap** `/home/ubuntu/plugins/bootstrap/plugins/workflow/` (SoT, `bun:test`), vendored one-way to `workflow-agents/` via `scripts/vendor-guards.mjs`.
> Already shipped (NOT in scope): steps 1-3 + safe review fixes — git-clone guard → core (`evaluateGitCloneDestination`), all-3-adapter consumption, clone→`repos/` namespace, gate-type narrow, +workgroup to MANAGED_DIR_RE, OpenCode git-clone fail-closed (bootstrap d23df80, nanoclaw f7fa1740 on branch `feat/clone-repos-namespace-git-clone-parity`).

## Overview

Complete the parity pattern for the remaining guards: migrate self-approval / snowflake / email-gate policy into the shared core (pure evaluators), wire OpenCode to consume all of them, make OpenCode AND both Codex container cores fail closed (incl. malformed/throwing-core → deny), move clones to the shared workgroup, and pin the whole thing with a table-driven dispatch-coverage + differential-cores conformance seam. Policy is single-source in the core; adapters stay thin (C1). The denylist stays single-source in nanoclaw `claude.ts` (D15) — verified by a recurring OpenCode tool-enumeration test, not a cross-repo copy.

## Test framework

- Bootstrap guards (Groups A-D) → `bun:test`, co-located `*.test.ts` (precedent: `conformance.test.ts`, `opencode-guard.test.ts`).
- nanoclaw `container/agent-runner` (Groups E-G) → `bun:test`, co-located `*.test.ts` (precedent: `runner.test.ts`, `git-worktrees.test.ts`).
- Group H → docs only (no tests).
- Typecheck gates: bootstrap `bun run typecheck` (if present) / `tsc --noEmit`; nanoclaw container `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`; host `pnpm run build`.

## Dependency graph

```
A  bootstrap core (evaluators + D18 wrappers; email-gate-core.ts)      [no deps]
G  nanoclaw clone→workgroup (git-worktrees + allowlists)               [no deps — independent]
H  /clone-as-* parity docs                                             [no deps — independent]
A ─> B  bootstrap opencode-guard.ts (wire guards + fail-closed exports)
A,B ─> C  bootstrap conformance/parity seam (core verdicts + OpenCode dispatch); C3 differential-cores needs D
A,B ─> D  bootstrap vendor + CI + version bumps (regenerates workflow-agents/*)
D ─> E  nanoclaw Claude+Codex adapters (secret-env.ts extract; claude.ts factories delegate; runner.ts fail-closed both cores; + Claude/Codex dispatch tests)
B,E ─> F  nanoclaw OpenCode provider (opencode.ts throw + env-strip via secret-env.ts + collapse ternary; + OpenCode tool-enumeration test)
```
Build waves: **W1** A, G, H · **W2** B · **W3** C1/C2, D · **W4** C3, E · **W5** F.
Note: dispatch tests are **co-located with their adapter** (repo-boundary constraint) — OpenCode dispatch in bootstrap (C2); Claude+Codex dispatch in nanoclaw (E6); OpenCode tool-enumeration in nanoclaw (F4, where OpenCode's real tool surface lives).

## File Ownership Map

| File | Op | Group/Task | Test file |
|------|----|-----------|-----------|
| `bootstrap: plugins/workflow/hooks/guards/block-destructive-core.ts` | MODIFY | A / A1,A2 | `block-destructive-core.evaluators.test.ts` (A) |
| `bootstrap: plugins/workflow/hooks/guards/email-gate-core.ts` | CREATE | A / A3 | `email-gate-core.test.ts` (A) |
| `bootstrap: plugins/workflow/hooks/guards/block-destructive-core.evaluators.test.ts` | CREATE | A / A1,A2 | (is a test) |
| `bootstrap: plugins/workflow/hooks/guards/email-gate-core.test.ts` | CREATE | A / A3 | (is a test) |
| `bootstrap: plugins/workflow/hooks/guards/opencode-guard.ts` | MODIFY | B / B1-B4 | `opencode-guard.test.ts` (B) |
| `bootstrap: plugins/workflow/hooks/guards/opencode-guard.test.ts` | MODIFY | B / B1-B4 | (is a test) |
| `bootstrap: plugins/workflow/hooks/guards/conformance.test.ts` | MODIFY | C / C1 | (is a test) |
| `bootstrap: plugins/workflow/hooks/guards/opencode-dispatch.test.ts` | CREATE | C / C2 | (is a test) |
| `bootstrap: plugins/workflow/hooks/guards/differential-cores.test.ts` | CREATE | C / C3 (needs D) | (is a test) |
| `bootstrap: scripts/vendor-guards.mjs` | MODIFY | D / D1 | none — reason: build-script, verified via `--check` integration run |
| `bootstrap: plugins/workflow-agents/hooks/guards/*` (generated) | MODIFY (generated) | D / D2 | none — reason: generated artifact, verified by `--check` + differential test (C3) |
| `bootstrap: plugins/workflow/.claude-plugin/plugin.json` | MODIFY | D / D3 | none — reason: manifest version bump |
| `bootstrap: plugins/workflow-agents/.codex-plugin/plugin.json` | MODIFY | D / D3 | none — reason: manifest version bump |
| `bootstrap: .claude-plugin/marketplace.json` | MODIFY | D / D3 | none — reason: manifest version bump |
| `bootstrap: .agents/plugins/marketplace.json` | MODIFY | D / D3 | none — reason: manifest version bump |
| `bootstrap: .github/workflows/vendor-check.yml` | CREATE | D / D4 | none — reason: CI config |
| `nanoclaw: container/agent-runner/src/providers/secret-env.ts` | CREATE | E / E0 | `secret-env.test.ts` (E) |
| `nanoclaw: container/agent-runner/src/providers/secret-env.test.ts` | CREATE | E / E0 | (is a test) |
| `nanoclaw: container/agent-runner/src/providers/claude.ts` | MODIFY | E / E0-E3 | `claude.guards.test.ts` (E) |
| `nanoclaw: container/agent-runner/src/providers/claude.guards.test.ts` | CREATE | E / E1-E3 | (is a test) |
| `nanoclaw: container/agent-runner/src/providers/email-gate.test.ts` | MODIFY | E / E3 | (is a test) |
| `nanoclaw: container/agent-runner/src/codex-hooks/runner.ts` | MODIFY | E / E4,E5 | `runner.test.ts` (E) |
| `nanoclaw: container/agent-runner/src/codex-hooks/runner.test.ts` | MODIFY | E / E4,E5 | (is a test) |
| `nanoclaw: container/agent-runner/src/providers/opencode.ts` | MODIFY | F / F1-F3 | `opencode.failClosed.test.ts` (F) |
| `nanoclaw: container/agent-runner/src/providers/opencode.failClosed.test.ts` | CREATE | F / F1-F3 | (is a test) |
| `nanoclaw: container/agent-runner/src/providers/opencode-tool-enumeration.test.ts` | CREATE | F / F4 | (is a test) |
| `nanoclaw: container/agent-runner/src/mcp-tools/git-worktrees.ts` | MODIFY | G / G1-G3 | `git-worktrees.test.ts` (G) |
| `nanoclaw: container/agent-runner/src/mcp-tools/git-worktrees.test.ts` | MODIFY | G / G1-G3 | (is a test) |
| `nanoclaw: container/agent-runner/src/mcp-tools/core.ts` | MODIFY | G / G4 | `core.test.ts` (G) |
| `nanoclaw: container/agent-runner/src/mcp-tools/core.test.ts` | MODIFY | G / G4 | (is a test) |
| `nanoclaw: container/agent-runner/src/poll-loop.ts` | MODIFY | G / G5 | `poll-loop.allowlist.test.ts` (G) |
| `nanoclaw: container/agent-runner/src/poll-loop.allowlist.test.ts` | CREATE | G / G5 | (is a test) |
| `nanoclaw: .claude/skills/clone-as-codex/SKILL.md` | MODIFY | H / H1 | none — docs |
| `nanoclaw: .claude/skills/clone-as-opencode/SKILL.md` | MODIFY | H / H2 | none — docs |
| `nanoclaw: .claude/skills/clone-as-provider-template/SKILL.md` | CREATE | H / H3 | none — docs |

**File conflict check:** every source file appears in exactly one group. No cross-group write conflicts. `block-destructive-core.ts` (A) vs its vendored copy in `workflow-agents/` (D, generated) — disjoint paths, D writes only via the vendor script. ✓
**Symbol dependency check:** B/C/D import the new evaluators+wrappers from A → resolved by sequencing (B,C,D after A). E imports the vendored core (D) → E after D. **F imports `buildSecretEnvVarList` from `secret-env.ts` (created by E) → F after E** (resolved by sequencing + extracting the symbol to a lightweight shared module, NOT importing claude.ts into the OpenCode provider). No parallel-sibling symbol coupling remains. ✓

## Constraint Traceability

| Entry | Type | Traced to |
|-------|------|-----------|
| C1 single-source policy, thin adapters | HARD | A (core holds policy), B/E (adapters delegate, no inline copy except fail-closed fallback) — ASSERT in A1/B1/E1 |
| C2 workflow SoT, workflow-agents vendored via `--check` | HARD | D1/D2 ASSERT |
| C3 email Claude/Codex flow preserved; core I/O-free | HARD | A3 (evaluator pure), E3 (Claude async awaitDeliveryAck untouched) ASSERT |
| C4 fail-closed incl. guard-absent | HARD | B2 (OpenCode), E4/E5 (both Codex cores + malformed/throwing) ASSERT |
| C5 two-repo; bump plugin versions | HARD | D3 acceptance |
| C6 codex exec unhookable → instruction-only | HARD | H (docs state it) |
| C7 core-conformance + dispatch tests (no cross-repo harness) | SOFT | C1-C4 |
| C9 git-clone advisory | HARD | already shipped; H docs restate |
| C11 new core files vendored only via VENDORED_FILES | HARD | D1 ASSERT (email-gate-core.ts added) |
| C12 env/secret parity | HARD | F2 ASSERT (auth vars stripped from OpenCode child) |
| D15 denylist single-source nanoclaw | decision | C4 (enumeration, not cross-repo copy) — negative ASSERT |
| D17 Codex both cores fail-closed | decision | E4/E5 |
| D18 signature-safe gate wrappers | decision | A2 (negative ASSERT: runNanoclawGate signature unchanged) |
| Rejected: cross-repo denylist copy | rejected | C4 negative ASSERT (no SDK_DISALLOWED_TOOLS in bootstrap) |
| Rejected: positional action arg in runNanoclawGate | rejected | A2 negative ASSERT |
| Rejected: OpenCode warn-and-continue | rejected | F1 negative ASSERT |

## Known Risks / Carry-forward

- **R1 (carry-forward, NIT-2):** when F1 flips OpenCode `warn→throw`, collapse the now-dead `...(guardAvailable ? { plugin: [GUARD_PLUGIN] } : {})` ternary at `opencode.ts:347` to unconditional `plugin: [GUARD_PLUGIN]`. Folded into F1.
- **R2 (validate-in-build, B-MED):** bootstrap has **no `.github/workflows/` today**. D4 CREATES `vendor-check.yml`; making it a *required / non-bypassable* status check is a GitHub **branch-protection** setting (repo-admin action, not code) — carry-forward to ship. Until set, `--check` remains pre-commit-enforced (current behavior) + the differential-cores test (C3) is the in-suite backstop.
- **R3 (assumption A-new):** Codex fail-closed flip assumes the bootstrap mount is an always-present fleet invariant. E5 tests assert fail-closed on missing/malformed; the mount invariant itself is confirmed at spawn (deployment, not code).
- **R4 (deploy):** bootstrap guard changes deploy on container RESPAWN (bind-mounted plugins); nanoclaw `container/agent-runner/src` changes deploy on RESPAWN; no `./container/build.sh` needed unless package.json/Dockerfile change. Host `src/` is not touched. Re-vendor (D2) must run before E (Claude/Codex import the vendored copy).
- **R5 (SOFT C8):** claude.ts is the hot path; E refactors 3 factory bodies — keep edits minimal-risk, tests green at each step.

---

## Group A: Bootstrap shared core — evaluators + signature-safe gate wrappers

**Owns:** `plugins/workflow/hooks/guards/block-destructive-core.ts` (MODIFY), `plugins/workflow/hooks/guards/email-gate-core.ts` (CREATE) + their tests. **Pre-conditions:** none (foundation). **Interface exposed to other groups:** the new pure evaluators + the gate wrappers; consumed by B (opencode-guard), C (tests), and — after vendoring (D) — by E (nanoclaw claude.ts/runner.ts).

### Task A1 — `evaluateSelfApproval` + `evaluateSnowflakeConnector` pure evaluators
- **File:** `plugins/workflow/hooks/guards/block-destructive-core.ts` · **Op:** MODIFY (append two exported pure functions; do not alter existing exports)
- **Test file:** `plugins/workflow/hooks/guards/block-destructive-core.evaluators.test.ts`
- **Approach:** Port the policy (regex + decision) from nanoclaw `claude.ts:470-484` (`createSelfApprovalBlockHook`, `SELF_APPROVAL_RE = /\.claude-destructive-gate/`) and `claude.ts:498-512` (`createBlockSnowflakeConnectorHook`, `SNOWFLAKE_CONNECTOR_EXEC_RE`) into pure verdict functions in the core. Read those exact lines first and transcribe the regexes verbatim — do not re-derive them. Match the existing `evaluateGitCloneDestination` verdict shape already in this file.
- **Interface:**
  ```
  export function evaluateSelfApproval(command: string): { action: 'allow' | 'block'; reason?: string }
  export function evaluateSnowflakeConnector(command: string): { action: 'allow' | 'block'; reason?: string }
  ```
  ```
  ASSERT: evaluateSelfApproval blocks any command whose text matches SELF_APPROVAL_RE (the .claude-destructive-gate self-approval bypass marker); returns {action:'allow'} otherwise
  ASSERT: evaluateSnowflakeConnector blocks python invocations matching SNOWFLAKE_CONNECTOR_EXEC_RE (import of snowflake.connector); allows the `snow` CLI and unrelated commands
  ASSERT: both functions are pure — no env reads, no I/O, deterministic on `command` alone (C1)
  ```
- **Named tests:**
  ```
  test_self_approval_blocks_marker:
    Setup: command touching `.claude-destructive-gate`
    Action: evaluateSelfApproval(command)
    Assert: { action: 'block', reason: <non-empty> }
    Teardown: none
  test_self_approval_allows_plain:
    Setup: an ordinary `ls -la` command
    Action: evaluateSelfApproval(command)
    Assert: { action: 'allow' }
  test_snowflake_blocks_connector_import:
    Setup: `python -c "import snowflake.connector; ..."`
    Action: evaluateSnowflakeConnector(command)
    Assert: { action: 'block' }
  test_snowflake_allows_snow_cli:
    Setup: `snow sql -q "select 1"`
    Action: evaluateSnowflakeConnector(command)
    Assert: { action: 'allow' }
  ```
- **Acceptance:** [ ] both evaluators exported with the exact verdict shape · [ ] regexes byte-match the claude.ts source · [ ] no new imports of `bun:sqlite`/`fs`/env in these functions · [ ] `bun test block-destructive-core.evaluators.test.ts` green

### Task A2 — D18 signature-safe gate-wrapper refactor
- **File:** `plugins/workflow/hooks/guards/block-destructive-core.ts` · **Op:** MODIFY (`writeGateRequest` gains an `action` param; add `runGateRequest`; add `runEmailGate`; `runNanoclawGate` body delegates — signature UNCHANGED)
- **Test file:** `plugins/workflow/hooks/guards/block-destructive-core.evaluators.test.ts` (same file as A1; add a describe block)
- **Approach (D18, the cycle-5 codex-C5-1 fix):** Read `block-destructive-core.ts:951-1072` first. Add an `action` parameter to the **internal** `writeGateRequest` (currently positional `(label, summary, command)`, hardcodes `action:'request_destructive_gate'` at :963). Add a lower-level `runGateRequest(command, reason, { action, onStageError })`. Keep `runNanoclawGate(command, reason, onStageError?)` signature **unchanged** — its body becomes `runGateRequest(command, reason, { action: 'request_destructive_gate', onStageError })`. Add `runEmailGate(command, reason, onStageError?)` = `runGateRequest(command, reason, { action: 'request_bash_gate', onStageError })`. **Do NOT** insert `action` as a positional arg into `runNanoclawGate` (existing callers pass the callback at arg 3 — runner.ts:153, opencode-guard.ts).
- **Interface:**
  ```
  function writeGateRequest(label: string, summary: string, command: string, action?: 'request_destructive_gate' | 'request_bash_gate'): string   // default 'request_destructive_gate'
  export function runGateRequest(command: string, reason: string, opts: { action: 'request_destructive_gate' | 'request_bash_gate'; onStageError?: (err: unknown) => void }): GateDecision
  export function runNanoclawGate(command: string, reason: string, onStageError?: (err: unknown) => void): GateDecision   // SIGNATURE UNCHANGED
  export function runEmailGate(command: string, reason: string, onStageError?: (err: unknown) => void): GateDecision
  ```
  ```
  ASSERT: runNanoclawGate's exported signature is exactly (command, reason, onStageError?) — `action` is NOT a positional parameter (D18, rejected option)
  ASSERT: legacy 3-arg call runNanoclawGate(cmd, reason, cb) stages a message with action 'request_destructive_gate' (no regression)
  ASSERT: runEmailGate stages a message with action 'request_bash_gate'
  ASSERT: onStageError fires with the staging error before the fail-closed 'denied' return (preserved from current runNanoclawGate)
  ```
- **Named tests (use a temp/mock outbound.db or stub the bun:sqlite write so the staged `action` is observable):**
  ```
  test_runNanoclawGate_legacy_3arg_emits_destructive:
    Setup: stub writeGateRequest to capture (action); call with (cmd, reason, ()=>{})
    Action: runNanoclawGate(cmd, reason, cb)
    Assert: captured action === 'request_destructive_gate'; cb wired as onStageError (not mis-bound to action)
  test_runEmailGate_emits_bash_gate:
    Setup: stub writeGateRequest to capture (action)
    Action: runEmailGate(cmd, reason)
    Assert: captured action === 'request_bash_gate'
  test_onStageError_fires_on_staging_failure:
    Setup: force writeGateRequest to throw
    Action: runNanoclawGate(cmd, reason, spy)
    Assert: spy called once with the error; return value 'denied'
  ```
- **Acceptance:** [ ] `runNanoclawGate` signature unchanged (grep the 3 existing call sites still typecheck) · [ ] `runEmailGate` + `runGateRequest` exported · [ ] legacy-3-arg regression test green · [ ] no caller in this repo broken (`bun run typecheck`/`tsc --noEmit`)

### Task A3 — `email-gate-core.ts` pure `evaluateEmailSend`
- **File:** `plugins/workflow/hooks/guards/email-gate-core.ts` · **Op:** CREATE
- **Test file:** `plugins/workflow/hooks/guards/email-gate-core.test.ts`
- **Approach (D-A):** Relocate the **envelope parse + gate decision** (NOT the I/O) from nanoclaw `claude.ts:543-664` / `createEmailGateHook` (claude.ts:604-702). Read those lines first. The function is pure: it takes the command + an env snapshot and returns a verdict + card content. The GWS creds account is parsed from the **command string** (claude.ts:642-643), NOT from env — only `isScheduledTask` comes from the snapshot. No `bun:sqlite`, no `writeMessageOut`, no `awaitDeliveryAck` in this file (those stay in each adapter).
- **Interface:**
  ```
  export interface EnvSnapshot { isScheduledTask: boolean }
  export function evaluateEmailSend(command: string, env: EnvSnapshot): { action: 'allow' | 'gate'; label?: string; summary?: string; reason?: string }
  ```
  ```
  ASSERT (faithful-to-source claude.ts:608-619, in order): not a GWS email-send → allow; `--dry-run`/`--draft` bypass on the gws segment (EMAIL_BYPASS_RE) → allow; isScheduledTask=true → ALLOW (bypass, claude.ts:619); otherwise (interactive real send) → { action:'gate', label, summary }
  ASSERT: the GWS creds account in label/summary is parsed from `command`, not from any env var (C3 / S3)
  ASSERT: module imports neither bun:sqlite nor performs any I/O (pure) — C3 "core stays I/O-free"
  ```
  (CYCLE-FIX: the original ASSERT said `isScheduledTask=true → gate` — that INVERTS the verbatim source. Scheduled tasks BYPASS; interactive sessions GATE. C3 mandates preserving the source flow exactly. Corrected per builder-A's flag, verified at claude.ts:617-619.)
- **Named tests:**
  ```
  test_email_send_interactive_gates:
    Setup: a gmail send command, env={isScheduledTask:false}
    Action: evaluateEmailSend(cmd, env)
    Assert: { action:'gate', label: non-empty, summary: contains the account parsed from cmd }
  test_email_send_scheduled_bypasses:
    Setup: same gmail send command, env={isScheduledTask:true}
    Action: evaluateEmailSend(cmd, env)
    Assert: { action:'allow' }
  test_email_send_dryrun_bypasses:
    Setup: a gmail send command with --dry-run in the gws segment, env={isScheduledTask:false}
    Action: evaluateEmailSend(cmd, env)
    Assert: { action:'allow' }
  test_non_email_allows:
    Setup: `echo hello`, env={isScheduledTask:false}
    Action: evaluateEmailSend(cmd, env)
    Assert: { action:'allow' }
  test_account_from_command_not_env:
    Setup: two commands with different GWS accounts, same env
    Action: evaluateEmailSend each
    Assert: summary reflects each command's account (proves parse-from-command)
  ```
- **Acceptance:** [ ] file created, `evaluateEmailSend` + `EnvSnapshot` exported · [ ] no `bun:sqlite`/`fs` import · [ ] verdict + card content match the claude.ts behavior for the same input · [ ] `bun test email-gate-core.test.ts` green

## Group B: Bootstrap OpenCode adapter — wire all guards + fail-closed export validation

**Owns:** `plugins/workflow/hooks/guards/opencode-guard.ts` (MODIFY) + `opencode-guard.test.ts` (MODIFY). **Pre-conditions:** Group A complete (`evaluateSelfApproval`, `evaluateSnowflakeConnector` in block-destructive-core.ts; `evaluateEmailSend` in email-gate-core.ts; `runEmailGate`). **Interface exposed:** the `NanoclawGuard()['tool.execute.before']` entrypoint now enforces the full guard set; consumed by C (dispatch tests).

Read `opencode-guard.ts` end-to-end first. Today it routes `evaluateBashCommand`+`runNanoclawGate` (destructive), `checkEditProtection` (file-protection), and `evaluateGitCloneDestination` (git-clone, shipped). It is MISSING self-approval, snowflake, and email. The `tool.execute.before` handler is `async` (opencode-guard.ts:99); `gateBashOrThrow` is the sync throw it reuses (D-B).

### Task B1 — Wire self-approval + snowflake into the bash chain
- **File:** `plugins/workflow/hooks/guards/opencode-guard.ts` · **Op:** MODIFY (`gateBashOrThrow`)
- **Test file:** `plugins/workflow/hooks/guards/opencode-guard.test.ts`
- **Approach:** In `gateBashOrThrow`, call `evaluateSelfApproval(command)` and `evaluateSnowflakeConnector(command)` and `throw` (the OpenCode block mechanism) on `action:'block'`. Preserve the Claude/Codex chain ORDER (self-approval → snowflake → git-clone → destructive → email) so verdicts are order-consistent across adapters (C6 dispatch ordering).
- **Interface / invariants:**
  ```
  ASSERT: a `.claude-destructive-gate` command throws (blocked) via the OpenCode guard
  ASSERT: a python `import snowflake.connector` command throws (blocked)
  ASSERT: chain order is self-approval → snowflake → git-clone → destructive → email (matches Codex runner chain)
  ASSERT: policy is delegated to the core evaluators — opencode-guard carries NO inline copy of the regexes (C1)
  ```
- **Named tests:** `test_oc_blocks_self_approval`, `test_oc_blocks_snowflake_connector`, `test_oc_allows_plain_bash`, `test_oc_chain_order` (assert self-approval fires before snowflake before git-clone).
- **Acceptance:** [ ] self-approval + snowflake enforced at the real entrypoint · [ ] no inline regex duplication (imports from core) · [ ] order preserved · [ ] `bun test opencode-guard.test.ts` green

### Task B2 — Wire the email gate (verdict + sync round-trip)
- **File:** `plugins/workflow/hooks/guards/opencode-guard.ts` · **Op:** MODIFY (`gateBashOrThrow`)
- **Test file:** `plugins/workflow/hooks/guards/opencode-guard.test.ts`
- **Approach (D-A/D-B):** Build the env snapshot `{ isScheduledTask: process.env.NANOCLAW_IS_SCHEDULED_TASK === '1' }`, call `evaluateEmailSend(command, env)`; on `action:'gate'`, run the sync round-trip `runEmailGate(command, reason)` → `pollDeliveredTable` and throw on `'denied'`/`'timeout'` (fail-closed). Emits `request_bash_gate` (matching Claude/Codex card), NOT `request_destructive_gate`.
- **Interface / invariants:**
  ```
  ASSERT: an email-send under isScheduledTask gates via runEmailGate and stages action 'request_bash_gate'
  ASSERT: a 'denied' or 'timeout' decision throws (fail-closed); 'approved' proceeds
  ASSERT: verdict + card content come from the shared evaluateEmailSend (no OpenCode-local email policy) — S5/C1
  ```
- **Named tests:** `test_oc_email_gates_with_bash_gate_action` (stub the gate writer, assert action), `test_oc_email_denied_throws`, `test_oc_email_approved_proceeds`, `test_oc_non_email_no_gate`.
- **Acceptance:** [ ] email gated via `runEmailGate` (request_bash_gate) · [ ] fail-closed on denied/timeout · [ ] shared card content · [ ] tests green

### Task B3 — Fail-closed core-export validation ("present ≠ correct")
- **File:** `plugins/workflow/hooks/guards/opencode-guard.ts` · **Op:** MODIFY (load-time assertion)
- **Test file:** `plugins/workflow/hooks/guards/opencode-guard.test.ts`
- **Approach (D-E, C4, cycle-4 C2):** On guard load, assert the imported core exposes — and that each is `typeof === 'function'` — the **verdict evaluators** (`evaluateSelfApproval`, `evaluateSnowflakeConnector`, `evaluateGitCloneDestination`, `evaluateEmailSend`) AND the **gate primitives** (`runEmailGate`, `runNanoclawGate`, `runGateRequest`, `pollDeliveredTable`). If any is missing or mis-typed, throw a clear fail-closed error (the guard refuses to operate against a malformed core) rather than silently no-opping the email/approval path.
- **Interface / invariants:**
  ```
  ASSERT: a missing/mis-typed evaluator OR gate primitive on the core throws at load (fail-closed) — not a silent skip
  ASSERT: the validated set includes the gate wrappers, not just the evaluators (a stale email primitive must NOT pass validation) — cycle-4 C2
  ```
- **Named tests:** `test_oc_export_validation_throws_on_missing_evaluator` (inject a core stub lacking `evaluateEmailSend` → throws), `test_oc_export_validation_throws_on_missing_gate_wrapper` (stub lacking `runEmailGate` → throws), `test_oc_export_validation_passes_on_complete_core`.
- **Acceptance:** [ ] load-time validation covers evaluators + gate primitives · [ ] throws fail-closed on any gap · [ ] complete core passes · [ ] tests green

### Task B4 — Verify the full chain composition (no regression to shipped guards)
- **File:** `plugins/workflow/hooks/guards/opencode-guard.test.ts` · **Op:** MODIFY (add a composition test)
- **Test file:** (self)
- **Approach:** A single test that drives `NanoclawGuard()['tool.execute.before']` through one representative case per guard (self-approval, snowflake, git-clone, destructive, email, file-protection) and asserts each still fires at the real entrypoint — guards against a wiring regression from B1-B3.
- **Interface / invariants:** `ASSERT: each of the 6 guard classes blocks/gates its representative input at the real tool.execute.before entrypoint`
- **Named tests:** `test_oc_full_chain_composition`.
- **Acceptance:** [ ] one assertion per guard class at the real entrypoint · [ ] green

## Group C: Bootstrap conformance / parity seam

**Owns:** `conformance.test.ts` (MODIFY), `opencode-dispatch.test.ts` (CREATE), `differential-cores.test.ts` (CREATE). **Pre-conditions:** A + B (C1, C2); **C3 also needs D** (the vendored copy must exist to diff against). **Scope note:** bootstrap holds only the OpenCode adapter, so OpenCode dispatch lives here; Claude/Codex dispatch + the OpenCode tool-enumeration test are co-located in nanoclaw (E6, F4) per the repo-boundary constraint.

### Task C1 — Extend the conformance verdict manifest
- **File:** `plugins/workflow/hooks/guards/conformance.test.ts` · **Op:** MODIFY (add cases; keep existing cases intact)
- **Test file:** (self)
- **Approach (D-G):** The file already pins `evaluateBashCommand` + `evaluateGitCloneDestination` verdicts as the cross-surface manifest. Add a corpus block pinning `evaluateSelfApproval`, `evaluateSnowflakeConnector` (from block-destructive-core) and `evaluateEmailSend` (from email-gate-core) verdicts — the single readable source of expected verdicts for the new guards.
- **Interface / invariants:**
  ```
  ASSERT: the manifest pins a block verdict for each self-approval / snowflake canonical input and an allow for each safe input
  ASSERT: the manifest pins a gate verdict for the email scheduled-send case and allow for non-email
  ASSERT: imports the SoT core (./block-destructive-core, ./email-gate-core) — the manifest proves verdicts for the SoT
  ```
- **Named tests:** extend existing describe with `self-approval`, `snowflake`, `email-gate` manifest rows.
- **Acceptance:** [ ] new guards pinned in the manifest · [ ] existing rows untouched · [ ] `bun test conformance.test.ts` green

### Task C2 — OpenCode dispatch-coverage (real entrypoint, table-driven)
- **File:** `plugins/workflow/hooks/guards/opencode-dispatch.test.ts` · **Op:** CREATE
- **Test file:** (self)
- **Approach (D-G, S8, C6):** Drive the REAL OpenCode entrypoint `NanoclawGuard()['tool.execute.before']` table-driven over every migrated command-guard (self-approval, snowflake, email-gate, git-clone) + destructive + file-protection. For each, assert: correct outcome (block/gate/allow), **chain ordering**, the **per-gate action** (email→`request_bash_gate`, destructive→`request_destructive_gate`), and the **guard-absence direction** (fail-closed: with the core stubbed missing/malformed, the entrypoint throws — not allow). Not just "bash/edit reached."
- **Interface / invariants:**
  ```
  ASSERT: each guard class blocks/gates its representative input at NanoclawGuard tool.execute.before
  ASSERT: email staging action === 'request_bash_gate'; destructive staging action === 'request_destructive_gate'
  ASSERT: chain order self-approval → snowflake → git-clone → destructive → email is observable
  ASSERT: with a missing/malformed core injected, the entrypoint fails CLOSED (throws), never allows (C4)
  ```
- **Named tests:** `test_oc_dispatch_each_guard`, `test_oc_dispatch_action_per_gate`, `test_oc_dispatch_chain_order`, `test_oc_dispatch_fail_closed_on_absent_core`, `test_oc_dispatch_fail_closed_on_malformed_core`.
- **Acceptance:** [ ] table-driven over all guard classes at the real entrypoint · [ ] per-gate action asserted · [ ] guard-absence fail-closed asserted · [ ] green

### Task C3 — Differential-cores assertion (SoT vs vendored)
- **File:** `plugins/workflow/hooks/guards/differential-cores.test.ts` · **Op:** CREATE
- **Test file:** (self) · **Pre-condition:** Group D complete (vendored `workflow-agents/hooks/guards/*` regenerated).
- **Approach (B-LOW1, C4):** Import BOTH the SoT core (`../../workflow/hooks/guards/block-destructive-core` + `email-gate-core`) and the vendored copy (`../../workflow-agents/hooks/guards/...`) and assert they return **identical verdicts** over the conformance corpus. Supplemental behavioral backstop that fires even if `--check` were skipped; does NOT replace byte-equality (`--check` stays the primary gate — D4).
- **Interface / invariants:**
  ```
  ASSERT: for every corpus input, SoT verdict deep-equals vendored verdict (evaluateBashCommand, evaluateGitCloneDestination, evaluateSelfApproval, evaluateSnowflakeConnector, evaluateEmailSend)
  ASSERT: the test imports from BOTH workflow/ and workflow-agents/ paths (proves it actually diffs two physical copies)
  ```
- **Named tests:** `test_differential_cores_identical_verdicts` (parametrized over the corpus), `test_differential_imports_two_paths`.
- **Acceptance:** [ ] both cores imported + diffed over the corpus · [ ] green after D re-vendors · [ ] documented as supplemental to `--check` (comment)

## Group D: Bootstrap vendor + CI + version bumps

**Owns:** `scripts/vendor-guards.mjs` (MODIFY), the generated `plugins/workflow-agents/hooks/guards/*` (regenerated via the script), `plugins/workflow/.claude-plugin/plugin.json` + `plugins/workflow-agents/.codex-plugin/plugin.json` + `.claude-plugin/marketplace.json` + `.agents/plugins/marketplace.json` (version bumps), `.github/workflows/vendor-check.yml` (CREATE). **Pre-conditions:** A + B complete (vendors A's core; the SoT must be final). **Interface exposed:** the vendored `workflow-agents/` cores that nanoclaw Claude/Codex (E) dynamic-import + the differential test (C3) diffs.

Context: today `VENDORED_FILES = ['block-destructive-core.ts', 'file-protection-core.ts']` (vendor-guards.mjs:33); `TARGET_DIRS = [workflow-agents/hooks/guards]`. The vendor copies the **cores** only (OpenCode uses the SoT `opencode-guard.ts` directly; Claude/Codex import the vendored cores). bootstrap has **no `.github/workflows/` today** — D4 creates it.

### Task D1 — Add `email-gate-core.ts` to the vendor manifest
- **File:** `scripts/vendor-guards.mjs` · **Op:** MODIFY (`VENDORED_FILES`)
- **Test file:** none — reason: build-script; verified by the `--check` integration run in D2 acceptance.
- **Approach (C11, D-H):** Add `'email-gate-core.ts'` to `VENDORED_FILES`. No other logic change.
- **Invariants:** `ASSERT (acceptance): VENDORED_FILES includes 'email-gate-core.ts'` · `ASSERT: new core file is vendored ONLY because it is in VENDORED_FILES (C11)`
- **Acceptance:** [ ] `email-gate-core.ts` in `VENDORED_FILES` · [ ] no other vendor-script behavior changed

### Task D2 — Re-vendor (regenerate workflow-agents cores)
- **File:** `plugins/workflow-agents/hooks/guards/*` · **Op:** MODIFY (generated) · **Pre-condition:** A, B, D1 done.
- **Test file:** none — reason: generated artifact; verified by `--check` (this task) + differential-cores (C3).
- **Approach:** Run `node scripts/vendor-guards.mjs` from the bootstrap repo root. This regenerates `workflow-agents/hooks/guards/block-destructive-core.ts` (now with the A1/A2 additions), `file-protection-core.ts`, and the NEW `email-gate-core.ts` (each with the regenerate banner). Then run `node scripts/vendor-guards.mjs --check` and confirm exit 0.
- **Invariants:**
  ```
  ASSERT: workflow-agents/hooks/guards/email-gate-core.ts exists post-vendor with the regenerate banner
  ASSERT: `node scripts/vendor-guards.mjs --check` exits 0 (no stale copies) — C2
  ASSERT: vendored cores are byte-identical to SoT modulo the banner (the differential test C3 confirms behavioral parity)
  ```
- **Acceptance:** [ ] vendor run regenerates all 3 cores · [ ] `--check` exits 0 · [ ] new `email-gate-core.ts` present in workflow-agents

### Task D3 — Plugin + marketplace version bumps
- **Files:** `plugins/workflow/.claude-plugin/plugin.json`, `plugins/workflow-agents/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json` · **Op:** MODIFY (version field only)
- **Test file:** none — reason: manifest version bump.
- **Approach (C5 + project convention "every plugin change bumps plugin.json AND marketplace.json"):** Bump the patch version in both plugin manifests and BOTH marketplace manifests in lockstep (read current versions first; bump consistently). This is what drives plugin update propagation.
- **Invariants:** `ASSERT (acceptance): all four manifests bumped to the same new version; no manifest left at the old version`
- **Acceptance:** [ ] workflow plugin.json bumped · [ ] workflow-agents plugin.json bumped · [ ] both marketplace.json bumped · [ ] versions consistent

### Task D4 — `vendor-check` CI workflow (required-gate mechanism)
- **File:** `.github/workflows/vendor-check.yml` · **Op:** CREATE
- **Test file:** none — reason: CI config.
- **Approach (codex-C4, B-MED, R2):** Create a GitHub Actions workflow that runs `node scripts/vendor-guards.mjs --check` (and the guard `bun test` suite) on PR + push. This is the *mechanism*; making it a **required, non-bypassable status check** is a branch-protection setting (repo-admin, not code) — see R2, carry-forward to ship.
- **Invariants:** `ASSERT (acceptance): workflow runs vendor-guards --check and fails the job on a stale vendored copy`
- **Acceptance:** [ ] `.github/workflows/vendor-check.yml` created · [ ] runs `--check` + guard tests · [ ] R2 (branch-protection = repo-admin action) recorded as carry-forward, not silently assumed done

## Group E: nanoclaw Claude + Codex adapters

**Owns:** `container/agent-runner/src/providers/secret-env.ts` (CREATE) + `secret-env.test.ts` (CREATE), `container/agent-runner/src/providers/claude.ts` (MODIFY), `claude.guards.test.ts` (CREATE), `providers/email-gate.test.ts` (MODIFY), `codex-hooks/runner.ts` (MODIFY), `runner.test.ts` (MODIFY). **Pre-conditions:** Group D complete (Claude/Codex dynamic-import the **vendored** `workflow-agents` core; the new evaluators + gate wrappers must exist there). **Reference implementation in-repo:** `claude.ts:738-748` (`loadGitCloneEvaluator`) + `claude.ts:760-773` already does export-type validation + exception→fallback + fail-closed for git-clone — mirror this shape for E1-E5 (do NOT invent a new shape). **HARD invariant (review S2):** the factory signatures (`createSelfApprovalBlockHook`, `createBlockSnowflakeConnectorHook`, `createEmailGateHook`) MUST stay unchanged — runner.ts imports them (runner.ts:21-24, 244-250). Refactor BODIES only.

### Task E0 — Extract `buildSecretEnvVarList` to a shared `secret-env.ts`
- **File:** `container/agent-runner/src/providers/secret-env.ts` (CREATE) + `claude.ts` (MODIFY: import from there instead of the local definition) · **Op:** CREATE + MODIFY
- **Test file:** `container/agent-runner/src/providers/secret-env.test.ts`
- **Approach (enables F2 without coupling the OpenCode provider to the Claude SDK module):** Move `buildSecretEnvVarList` (claude.ts:422-429, currently a private function) into a new lightweight `secret-env.ts` with NO Agent-SDK imports; re-export/import it in claude.ts so existing behavior is unchanged. F2 imports it from `./secret-env.js`.
  ```
  ASSERT: secret-env.ts has no import of @anthropic-ai/claude-agent-sdk (lightweight, safe for the OpenCode provider to import)
  ASSERT: buildSecretEnvVarList returns the same list it did inside claude.ts (single-source; no duplication — C1)
  ASSERT: claude.ts behavior unchanged (imports the extracted function)
  ```
- **Named tests:** `test_secret_env_list_stable` (the returned list matches the prior inline list), `test_secret_env_no_sdk_import` (static: no SDK import).
- **Acceptance:** [ ] `secret-env.ts` created, SDK-free · [ ] claude.ts imports it (no duplicate list) · [ ] `bun test secret-env.test.ts` green · [ ] claude.ts typechecks

### Task E1 — `createSelfApprovalBlockHook` delegates to the core
- **File:** `claude.ts` · **Op:** MODIFY (body of `createSelfApprovalBlockHook`, claude.ts:472-484; signature unchanged)
- **Test file:** `claude.guards.test.ts`
- **Approach (D-C):** Refactor the body to dynamic-import `evaluateSelfApproval` from the vendored core (same `GIT_CLONE_CORE_PATH`-style path, `.../workflow-agents/hooks/guards/block-destructive-core.ts`), call it, and `denyBash` on `action:'block'`. Keep an **inline-regex fail-closed fallback** (if the import fails or the export is missing/mis-typed → use the inline `SELF_APPROVAL_RE` and deny on match) exactly like the git-clone hook. Signature returns `HookCallback` unchanged.
  ```
  ASSERT: blocks `.claude-destructive-gate` commands (delegated verdict)
  ASSERT: factory signature unchanged — `createSelfApprovalBlockHook(): HookCallback`
  ASSERT: if the core import fails OR evaluateSelfApproval is missing/mis-typed, the inline fallback still blocks the marker (fail-closed, C1 fallback exception)
  ```
- **Named tests:** `test_claude_self_approval_blocks_via_core`, `test_claude_self_approval_fallback_blocks_when_core_absent`, `test_claude_self_approval_signature_unchanged` (type-level / smoke).
- **Acceptance:** [ ] delegates to core · [ ] inline fail-closed fallback retained · [ ] signature unchanged · [ ] `bun test claude.guards.test.ts` green

### Task E2 — `createBlockSnowflakeConnectorHook` delegates to the core
- **File:** `claude.ts` · **Op:** MODIFY (body of `createBlockSnowflakeConnectorHook`, claude.ts:500-512; signature unchanged)
- **Test file:** `claude.guards.test.ts`
- **Approach:** Same delegation+fallback pattern as E1 for `evaluateSnowflakeConnector`.
  ```
  ASSERT: blocks `import snowflake.connector` python; allows `snow` CLI (delegated verdict)
  ASSERT: signature unchanged; inline fail-closed fallback retained
  ```
- **Named tests:** `test_claude_snowflake_blocks_via_core`, `test_claude_snowflake_allows_snow_cli`, `test_claude_snowflake_fallback_when_core_absent`.
- **Acceptance:** [ ] delegates · [ ] fallback retained · [ ] signature unchanged · [ ] green

### Task E3 — `createEmailGateHook` uses the core verdict, keeps async round-trip
- **File:** `claude.ts` · **Op:** MODIFY (body of `createEmailGateHook`, claude.ts:604-702; signature unchanged) · also **MODIFY** `providers/email-gate.test.ts`
- **Test file:** `providers/email-gate.test.ts` (existing) + `claude.guards.test.ts`
- **Approach (D-A, C3):** Refactor so the **verdict** (allow vs gate + card content) comes from `evaluateEmailSend(command, { isScheduledTask })` imported from the vendored `email-gate-core.ts` (with inline fail-closed fallback). The **approval round-trip is UNCHANGED** — Claude keeps its async `writeMessageOut` + `awaitDeliveryAck` (claude.ts:668-702, already `request_bash_gate` at :681). Build `isScheduledTask` from `process.env.NANOCLAW_IS_SCHEDULED_TASK` (claude.ts:619). The GWS account comes from the evaluator (parsed from command), not re-parsed here.
  ```
  ASSERT: gate verdict + card content come from evaluateEmailSend (no inline email policy except the fail-closed fallback)
  ASSERT: Claude's async awaitDeliveryAck round-trip + request_bash_gate action are byte-for-byte preserved (C3 — no regression)
  ASSERT: factory signature unchanged
  ```
- **Named tests:** `test_claude_email_gate_verdict_from_core`, `test_claude_email_gate_preserves_async_ack` (existing email-gate.test.ts cases still pass), `test_claude_email_gate_fallback_when_core_absent`.
- **Acceptance:** [ ] verdict delegated to core · [ ] async ack flow unchanged (existing email-gate.test.ts green) · [ ] signature unchanged · [ ] fallback retained

### Task E4 — Codex `loadGuardCore`/`runDestructiveGuard` → fail-closed + export-validation
- **File:** `codex-hooks/runner.ts` · **Op:** MODIFY (`loadGuardCore` runner.ts:106-116, `runDestructiveGuard` runner.ts:138-139)
- **Test file:** `codex-hooks/runner.test.ts`
- **Approach (D17, C4, cycle-4 C3):** Change `loadGuardCore` to **validate required export types** and return a typed failure (not bare null) on missing/malformed; change `runDestructiveGuard` so a missing/invalid core → **deny** (not `return null` allow), and **map any evaluator exception to a deny decision** (wrap `core.evaluateBashCommand` runner.ts:141 in try/catch → deny). Mirror `claude.ts:738-748`/`:760-773`.
  ```
  ASSERT: missing core (import throws) → runDestructiveGuard returns a deny decision (was: null/allow)
  ASSERT: malformed core (imports but evaluateBashCommand missing/not-a-function) → deny (not a thrown crash, not allow)
  ASSERT: a throwing evaluator (evaluateBashCommand throws) → deny
  ASSERT: a present, valid core preserves current allow/block/gate behavior (no regression for the happy path)
  ```
- **Named tests:** `test_codex_destructive_fail_closed_missing_core`, `test_codex_destructive_fail_closed_malformed_core`, `test_codex_destructive_fail_closed_throwing_evaluator`, `test_codex_destructive_happy_path_unchanged`.
- **Acceptance:** [ ] missing/malformed/throwing → deny · [ ] happy path unchanged · [ ] `bun test runner.test.ts` green

### Task E5 — Codex `loadFileProtectionCore`/`runFileProtection` → fail-closed + export-validation
- **File:** `codex-hooks/runner.ts` · **Op:** MODIFY (`loadFileProtectionCore` runner.ts:178-186, `runFileProtection` runner.ts:190-201)
- **Test file:** `codex-hooks/runner.test.ts`
- **Approach (D17, M1):** Same treatment as E4 for the file-protection core: validate exports (`EDIT_TOOLS`, `checkEditProtection`), deny on missing/malformed core, map `core.checkEditProtection` (runner.ts:197) exceptions to deny. Today both `loadFileProtectionCore` (returns null) and `runFileProtection` (`if (!core) return null`) fail OPEN — flip to fail-closed.
  ```
  ASSERT: missing file-protection core → runFileProtection denies an edit to a protected path (was: allow)
  ASSERT: malformed core (checkEditProtection missing/not-a-function) → deny
  ASSERT: throwing checkEditProtection → deny
  ASSERT: SKIP_FILE_PROTECTION=1 still bypasses (parity with Claude, unchanged)
  ASSERT: present valid core preserves current behavior (non-edit tools pass; protected edits blocked)
  ```
- **Named tests:** `test_codex_fileprot_fail_closed_missing_core`, `test_codex_fileprot_fail_closed_malformed`, `test_codex_fileprot_throwing_check_denies`, `test_codex_fileprot_skip_env_bypass`, `test_codex_fileprot_happy_path`.
- **Acceptance:** [ ] both file-protection fail-open paths flipped to deny · [ ] malformed/throwing → deny · [ ] SKIP env bypass intact · [ ] green

### Task E6 — Claude + Codex dispatch-coverage tests (real entrypoints)
- **File:** `claude.guards.test.ts` (Claude PreToolUse chain) + `runner.test.ts` (Codex `runPreToolUseChain`) · **Op:** MODIFY/CREATE (add dispatch suites)
- **Test file:** (self)
- **Approach (D-G, S8):** Co-located dispatch-coverage for the two nanoclaw adapters (the bootstrap-side OpenCode dispatch is C2). Drive the REAL entrypoints table-driven over the migrated guards (self-approval, snowflake, email-gate, git-clone) + denylist + destructive + file-protection: assert correct outcome, **chain ordering**, per-gate **action**, and the **uniform fail-closed direction** (after E4/E5). For Codex, assert the denylist is chain-dispatched via `preToolUseHook` (runner.ts:222, first hook).
  ```
  ASSERT (Codex): runPreToolUseChain blocks/gates each guard class at the real entrypoint; guard-absence on BOTH cores → deny (uniform)
  ASSERT (Codex): denylist enforced via preToolUseHook (chain-dispatched, first hook)
  ASSERT (Claude): the PreToolUse hook chain fires each migrated guard; email action request_bash_gate
  ```
- **Named tests:** `test_codex_dispatch_each_guard`, `test_codex_dispatch_uniform_fail_closed_both_cores`, `test_codex_denylist_chain_dispatched`, `test_claude_dispatch_each_guard`.
- **Acceptance:** [ ] both adapters' real entrypoints driven table-driven · [ ] uniform fail-closed asserted for Codex (both cores) · [ ] green

## Group F: nanoclaw OpenCode provider — fail-closed + env-strip

**Owns:** `container/agent-runner/src/providers/opencode.ts` (MODIFY), `opencode.failClosed.test.ts` (CREATE), `opencode-tool-enumeration.test.ts` (CREATE). **Pre-conditions:** Group B (the guard plugin exists for integration) + Group E (imports `buildSecretEnvVarList` from `secret-env.ts`). Read `opencode.ts:300-349` (buildOpenCodeConfig) + `:81-107` (spawnOpencodeServer) first.

### Task F1 — Refuse spawn when the guard plugin is absent (+ collapse dead ternary)
- **File:** `opencode.ts` · **Op:** MODIFY (`buildOpenCodeConfig`, opencode.ts:332-347)
- **Test file:** `opencode.failClosed.test.ts`
- **Approach (D-E, C4, R1/NIT-2):** Today `if (!guardAvailable) { log("WARNING ... WITHOUT the gate") }` (opencode.ts:334-336) warns and continues, and the plugin is mounted conditionally `...(guardAvailable ? { plugin: [GUARD_PLUGIN] } : {})` (opencode.ts:347). Change to **throw** when `!guardAvailable` (refuse to build a config that would run unguarded), and **collapse** the now-dead ternary to unconditional `plugin: [GUARD_PLUGIN]`. Keep the additive `OPENCODE_ALLOW_UNGUARDED=1` dev opt-out (default-closed) per design D-E option C.
  ```
  ASSERT: buildOpenCodeConfig throws when the guard plugin file is absent (was: warn-and-continue) — C4
  ASSERT: the returned config always includes plugin: [GUARD_PLUGIN] (no conditional ternary) — R1
  ASSERT: OPENCODE_ALLOW_UNGUARDED=1 permits an unguarded spawn (explicit dev opt-out, default off)
  ASSERT (negative): no code path returns a config with permission:'allow' AND no guard plugin (rejected: warn-and-continue)
  ```
- **Named tests:** `test_oc_provider_throws_without_guard`, `test_oc_provider_plugin_always_present`, `test_oc_provider_allow_unguarded_optout`.
- **Acceptance:** [ ] throws on absent guard · [ ] ternary collapsed · [ ] opt-out works · [ ] `bun test opencode.failClosed.test.ts` green

### Task F2 — Strip auth env vars from the OpenCode child (env/secret parity)
- **File:** `opencode.ts` · **Op:** MODIFY (`spawnOpencodeServer`, opencode.ts:101-107 child `env`)
- **Test file:** `opencode.failClosed.test.ts`
- **Approach (C12, D-E):** Before spawning `opencode serve`, remove the auth env vars (`buildSecretEnvVarList()` from `./secret-env.js`, Group E) from the child's `env` so OpenCode shell tools never see the raw OneCLI-injected creds. Safe — OpenCode auths via auth.json/XDG (opencode.ts:52), not process.env. Note this strips for the whole session (broader than Claude's per-command unset, A12) — same outcome for shell subprocesses.
  ```
  ASSERT: every var named by buildSecretEnvVarList() is absent from the spawned child's env
  ASSERT: OpenCode auth still resolves (auth.json/XDG path untouched) — the stripped vars are not read by OpenCode auth
  ASSERT: non-secret env (PATH, HOME, NANOCLAW_*) is preserved
  ```
- **Named tests:** `test_oc_child_env_strips_secrets`, `test_oc_child_env_preserves_nonsecret`.
- **Acceptance:** [ ] secret vars stripped from child env · [ ] non-secret preserved · [ ] imports the shared list (no duplication) · [ ] green

### Task F3 — (covered by F1/F2 tests) integration assertion
- Folded into F1/F2 test files; no separate source change. Ensures the failClosed test file also asserts the combined config (throw-on-absent + env-strip) for a realistic spawn input.

### Task F4 — Recurring OpenCode tool-enumeration test (denylist parity)
- **File:** `container/agent-runner/src/providers/opencode-tool-enumeration.test.ts` · **Op:** CREATE
- **Test file:** (self)
- **Approach (D-D, D15, B-LOW2, C3-3):** Enumerate OpenCode's exposed tool inventory — built-ins + the `mcp__server__tool` names produced by `mcpServersToOpenCodeConfig` (mcp-to-opencode.ts) — and classify each against a **minimal capability map**: every exposed tool maps to *known-safe* or *blocked-equivalent*. The test **FAILS on any denied-capability match OR any unrecognized tool**, so the inventory can't rot silently as OpenCode evolves. Assert OpenCode exposes none of the 9 `SDK_DISALLOWED_TOOLS` (claude.ts) by name. Recurring (runs in the normal suite), not a one-time snapshot.
  ```
  ASSERT: none of the 9 SDK_DISALLOWED_TOOLS names appear in OpenCode's exposed tool set (absence = parity, D-D/M3)
  ASSERT: every exposed OpenCode tool classifies as known-safe or blocked-equivalent against the capability map
  ASSERT: an injected unrecognized/denied-capability tool makes the test FAIL (proves the net is live, not vacuous) — B-LOW2/C3-3
  ASSERT (negative): SDK_DISALLOWED_TOOLS is NOT duplicated into the bootstrap repo — it is imported single-source from nanoclaw claude.ts (D15)
  ```
- **Named tests:** `test_oc_exposes_no_denied_builtin`, `test_oc_every_tool_classified`, `test_oc_enumeration_fails_on_unrecognized_tool`, `test_denylist_single_source` (assert the test reads SDK_DISALLOWED_TOOLS from claude.ts, not a copy).
- **Acceptance:** [ ] enumerates built-ins + mcp__ tools · [ ] classify-or-fail map · [ ] fails on injected denied/unknown tool · [ ] single-source denylist asserted · [ ] green

## Group G: nanoclaw clone → shared workgroup + allowlist repoints

**Owns:** `container/agent-runner/src/mcp-tools/git-worktrees.ts` (+`git-worktrees.test.ts`), `container/agent-runner/src/mcp-tools/core.ts` (+`core.test.ts`), `container/agent-runner/src/poll-loop.ts` (+`poll-loop.allowlist.test.ts`). **Pre-conditions:** none (independent of the guard work). Read `git-worktrees.ts:26-40,210-265` first — today `REPOS_DIR = ${AGENT_DIR}/repos` (`/workspace/agent/repos`) and `resolveRepoDir` prefers `repos/<name>` else legacy `agent/<name>`. D-F upgrades the destination to the shared workgroup.

### Task G1 — `getReposDir()` → workgroup-preferred, fail-loud-on-missing
- **File:** `git-worktrees.ts` · **Op:** MODIFY (add `getReposDir`; replace the module-const `REPOS_DIR` usage)
- **Test file:** `git-worktrees.test.ts`
- **Approach (D-F, S6/A8):** Add `getReposDir()` that leads with `fs.existsSync('/workspace/workgroup')` → `/workspace/workgroup/repos`, else `/workspace/agent/repos`. **Fail-loud:** if `process.env.NANOCLAW_WORKGROUP_ID` is set (workgroup expected) but `/workspace/workgroup` is absent → log a loud warning/error (mount failure) and do NOT silently clone private.
  ```
  ASSERT: workgroup present → repos dir is /workspace/workgroup/repos
  ASSERT: no workgroup + no NANOCLAW_WORKGROUP_ID → /workspace/agent/repos (private fallback)
  ASSERT: NANOCLAW_WORKGROUP_ID set but /workspace/workgroup absent → loud warn/error (mount failure), not a silent private clone (S6)
  ```
- **Named tests:** `test_repos_dir_workgroup_present`, `test_repos_dir_no_workgroup_private`, `test_repos_dir_expected_but_missing_warns`.
- **Acceptance:** [ ] dir gate leads with `fs.existsSync` · [ ] fail-loud on expected-but-missing · [ ] green

### Task G2 — `resolveRepoDir` precedence + same-name shadowing guard
- **File:** `git-worktrees.ts` · **Op:** MODIFY (`resolveRepoDir`)
- **Test file:** `git-worktrees.test.ts`
- **Approach (D-F):** Precedence: `workgroup/repos/<name>` → `agent/repos/<name>` → legacy `agent/<name>`. If the same-name repo exists in two locations, **prefer + warn** (don't silently shadow); confirm via origin-match where possible.
  ```
  ASSERT: resolution order is workgroup/repos → agent/repos → legacy agent/<name>
  ASSERT: same-name repo in two locations → prefer the higher-precedence one AND log a warning (no silent shadow)
  ```
- **Named tests:** `test_resolve_precedence_order`, `test_resolve_same_name_two_locations_warns`, `test_resolve_legacy_fallback`.
- **Acceptance:** [ ] precedence correct · [ ] shadowing warns · [ ] green

### Task G3 — `clone_repo` origin-match + rmSync tightening
- **File:** `git-worktrees.ts` · **Op:** MODIFY (`clone_repo`, the rmSync at git-worktrees.ts:221-223)
- **Test file:** `git-worktrees.test.ts`
- **Approach (D-F, S7/A9):** Clone into `getReposDir()/<name>`. Before reusing an existing dir, verify `git config --get-url origin` matches the requested URL. Tighten the destructive cleanup: today it `rmSync`-clears ANY no-`.git` dir (incl. non-empty, git-worktrees.ts:221-223). Change to: only `rmSync` an **empty** no-`.git` dir; for a **non-empty** no-`.git` dir, **return an error** (don't destroy).
  ```
  ASSERT: clone lands under getReposDir()/<name> (workgroup when present)
  ASSERT: reuse only when existing origin URL matches the requested URL; mismatch → error/warn, no silent reuse
  ASSERT: a non-empty no-.git dir is NOT rmSync'd — clone_repo returns an error (behavior change, S7)
  ASSERT: an empty no-.git dir may be cleared (as today)
  ```
- **Named tests:** `test_clone_lands_in_workgroup`, `test_clone_origin_mismatch_errors`, `test_clone_nonempty_no_git_dir_errors`, `test_clone_empty_no_git_dir_cleared`.
- **Acceptance:** [ ] workgroup destination · [ ] origin-match before reuse · [ ] non-empty no-.git → error (no destroy) · [ ] green

### Task G4 — `SEND_FILE_ALLOWED_PREFIXES` += `/workspace/workgroup`
- **File:** `mcp-tools/core.ts` · **Op:** MODIFY (`SEND_FILE_ALLOWED_PREFIXES`, core.ts:23-28)
- **Test file:** `mcp-tools/core.test.ts`
- **Approach (D-F M1):** Add `/workspace/workgroup` to the send-file allowlist so files under the shared workgroup can be sent.
  ```
  ASSERT: a path under /workspace/workgroup is allowed by the send-file check; a path outside all prefixes is rejected
  ```
- **Named tests:** `test_send_file_allows_workgroup`, `test_send_file_rejects_outside`.
- **Acceptance:** [ ] `/workspace/workgroup` in the allowlist · [ ] green

### Task G5 — `FILE_EVENT_ALLOWED_PREFIXES` += `/workspace/workgroup`
- **File:** `poll-loop.ts` · **Op:** MODIFY (`FILE_EVENT_ALLOWED_PREFIXES`, poll-loop.ts:74-80)
- **Test file:** `poll-loop.allowlist.test.ts` (CREATE)
- **Approach (D-F M1):** Add `/workspace/workgroup` to the file-event allowlist so workgroup file events are surfaced (parity with the send-file allowlist).
  ```
  ASSERT: isAllowedFileEventPath returns true for a /workspace/workgroup/<repo> path and false for an unlisted path
  ```
- **Named tests:** `test_file_event_allows_workgroup`, `test_file_event_rejects_outside`.
- **Acceptance:** [ ] `/workspace/workgroup` in the allowlist · [ ] new test file green

## Group H: /clone-as-* parity-contract docs

**Owns:** `.claude/skills/clone-as-codex/SKILL.md` (MODIFY), `.claude/skills/clone-as-opencode/SKILL.md` (MODIFY), `.claude/skills/clone-as-provider-template/SKILL.md` (CREATE). **Pre-conditions:** none (docs; reflects the final contract). **Test file:** none — docs.

### Task H1 — clone-as-codex parity contract
- **File:** `.claude/skills/clone-as-codex/SKILL.md` · **Op:** MODIFY (add a "Guard parity contract" section)
- **Approach:** Document that a Codex sibling is only "done" when its adapter routes ALL command guards (self-approval, snowflake, email-gate, git-clone, destructive, file-protection) through the shared core, fails closed on absent/malformed core (both container cores), and passes the conformance + dispatch-coverage suite. Note C6 (codex exec sub-delegation is unhookable → instruction-only on that path).
- **Acceptance:** [ ] section added listing the guard set + fail-closed requirement + "passes conformance/dispatch suite" gate + the C6 caveat

### Task H2 — clone-as-opencode parity contract
- **File:** `.claude/skills/clone-as-opencode/SKILL.md` · **Op:** MODIFY (add the same section, OpenCode-specific)
- **Approach:** Same contract, OpenCode specifics: the adapter must mount the bootstrap guard plugin, refuse spawn when it's absent (fail-closed), strip auth env vars from the child, and pass the OpenCode dispatch + tool-enumeration tests.
- **Acceptance:** [ ] section added with the OpenCode-specific fail-closed + env-strip + enumeration requirements

### Task H3 — new-provider template
- **File:** `.claude/skills/clone-as-provider-template/SKILL.md` · **Op:** CREATE
- **Approach:** A template for a future `/clone-as-<newprovider>`: the generalized parity contract any new provider adapter MUST satisfy — route every guard through the shared core, fail closed on absent/malformed core, env/secret parity, and pass the conformance + per-adapter dispatch-coverage suite before the sibling is considered shipped. This is the "generalizes to future providers" deliverable from the parity mandate.
- **Acceptance:** [ ] template created · [ ] states the machine-enforced gate (conformance + dispatch suite) as the definition of "done" for any new provider

