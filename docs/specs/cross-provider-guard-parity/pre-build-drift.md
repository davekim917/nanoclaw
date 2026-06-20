# Pre-Build Drift Check — Design vs. Plan (cross-provider-guard-parity)

> `/team-drift` (lead-performed) 2026-06-19 · SOT = `design.md` (CLEARED review cycle 5/5) · Target = `plan.md` (8 groups / 33 tasks)
> Method: each design component (D-A..D-H) + cycle-fix decisions (D15/D17/D18) + carry-forwards mapped to the plan task(s) that implement it; verified the plan neither omits a design element (MISSING) nor contradicts one (DIVERGED).

## Summary

**CONFIRMED: 13 · PARTIAL: 0 · MISSING: 0 · DIVERGED: 0**

The plan faithfully reflects the design. Every design component maps to one or more concrete plan tasks with matching constraints; no design element is omitted; no plan task contradicts the design.

## Component-by-component trace

| Design element (SOT) | Plan coverage (Target) | Verdict |
|---|---|---|
| **D-A** email-gate → pure `evaluateEmailSend` + verdict/card shared; per-adapter round-trip | A3 (evaluator), B2 (OpenCode round-trip via runEmailGate), E3 (Claude verdict-from-core, async ack untouched) | CONFIRMED |
| **D-A/D18** signature-safe gate wrappers (`writeGateRequest` action param, `runGateRequest`, `runNanoclawGate` sig unchanged, `runEmailGate`) | A2 (core refactor + negative ASSERT: runNanoclawGate sig unchanged + legacy-3arg regression test) | CONFIRMED |
| **D-B** approval primitive — OpenCode reuses sync Bun gate; Claude/Codex async | A2 (runEmailGate sync path), B2 (OpenCode uses it), E3 (Claude keeps async awaitDeliveryAck) | CONFIRMED |
| **D-C** self-approval + snowflake → core evaluators; preserve claude.ts→codex import chain | A1 (evaluators), E1/E2 (claude.ts factory bodies delegate, signatures unchanged — HARD invariant in group note) | CONFIRMED |
| **D-D** OpenCode tool-access parity — single-source nanoclaw denylist (D15) + recurring enumeration; no runtime OpenCode denylist | F4 (recurring enumeration test, classify-or-fail, single-source ASSERT); B (no inline denylist) | CONFIRMED |
| **D-E** fail-closed: OpenCode + BOTH Codex cores (D17) + malformed/throwing→deny + export-validation (incl. gate primitives) + env parity (C12) | B3 (OpenCode export-validation), E4 (loadGuardCore), E5 (loadFileProtectionCore — the cycle-4 M1 gap), F1 (OpenCode refuse-spawn), F2 (env-strip) | CONFIRMED |
| **D-F** clone → workgroup/repos + getReposDir + resolveRepoDir + origin-match + rmSync tightening + allowlist repoints | G1 (getReposDir), G2 (resolveRepoDir), G3 (clone_repo origin-match + rmSync), G4 (SEND_FILE allowlist), G5 (FILE_EVENT allowlist) | CONFIRMED |
| **D-G** conformance seam — dispatch-coverage (real entrypoints) + differential-cores + guard-absence direction | C1 (core verdicts), C2 (OpenCode dispatch), C3 (differential-cores), E6 (Claude+Codex dispatch) | CONFIRMED |
| **D-H** email-gate-core.ts vendored + `--check` required CI gate + packaging tradeoff | D1 (VENDORED_FILES += email-gate-core.ts), D2 (re-vendor), D4 (vendor-check.yml CI) | CONFIRMED |
| **/clone-as-* parity contract** (generalizes to future providers) | H1 (codex), H2 (opencode), H3 (new-provider template) | CONFIRMED |
| **Carry-forward NIT-2** collapse dead `plugin:` ternary at opencode.ts:347 | F1 (R1, folded in) | CONFIRMED |
| **Carry-forward** `--check` required/non-bypassable = branch-protection (repo-admin) | D4 + Known Risk R2 (explicitly flagged, not silently assumed) | CONFIRMED |
| **Plugin/marketplace version bumps** (C5) | D3 (both plugin.json + both marketplace.json) | CONFIRMED |

## DIVERGED entries

None. (No acks file needed.)

## MISSING entries

None.

## PARTIAL / known risks carried into build

- R2 (branch-protection for `--check` is a repo-admin setting, not code) — carried as a build Known Risk, surfaced at ship.
- R3 (Codex fail-closed flip assumes always-present mount) — E5 tests assert fail-closed; mount invariant confirmed at spawn.
- These are design-acknowledged ("validate in build" items), not plan defects.

**Gate result:** MISSING == 0, effective_DIVERGED == 0 → proceed to team creation.
