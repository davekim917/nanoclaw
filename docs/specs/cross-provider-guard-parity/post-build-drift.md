# Post-Build Drift Check — Plan vs. Implementation (cross-provider-guard-parity)

> `/team-drift` (lead-performed) 2026-06-19 · SOT = `plan.md` (8 groups / 33 tasks) · Target = the implemented files
> Method: every plan task validated against its implementation during /team-build (files read, named tests grep'd + run individually, acceptance criteria checked, full-suite regression + typecheck per group). This report consolidates that validation.

## Summary

**CONFIRMED: 33 · PARTIAL: 0 · MISSING: 0 · DIVERGED (acknowledged): 2**

All 33 tasks implemented and lead-verified. No task missing. Two implementation-level divergences from the literal plan, both **acknowledged** (recorded in `decisions.yaml` `auto_judgments`, stage Build) — both are additive hardening / verified parity fixes, neither weakens scope.

## Aggregate gates (both repos)

| Gate | Result |
|---|---|
| bootstrap guards suite (`bun test`) | 373 pass / 0 fail (8 files) |
| bootstrap `vendor-guards --check` | exit 0 (vendored == SoT) |
| bootstrap hooks typecheck (`bun run check`) | exit 0 |
| nanoclaw container suite (`bun test`) | 545 pass / 10 fail / 3 skip — the 10 are the documented pre-existing parallel-DB-race flakes (spawn_*/send_message/poll-loop `/clear`), all pass in isolation, none from this feature (memory: feedback_agent_runner_flaky_db_tests) |
| nanoclaw container typecheck (`tsc -p …`) | 0 real errors (only the harmless `bun:test` IDE-resolution suggestion on test files) |

## Per-group confirmation

| Group | Tasks | Verdict | Evidence |
|---|---|---|---|
| A (core evaluators + D18 wrappers + email-gate-core) | A1-A3 | CONFIRMED | 27 named + 240 suite; email-gate-core.ts pure; runNanoclawGate sig unchanged; A3 faithful-to-source |
| B (opencode-guard wiring + export validation) | B1-B4 | CONFIRMED | assertCoreExports covers evaluators+wrappers; 256 full suite (A green in combined run = mock-leak fixed) |
| C (conformance + dispatch + differential) | C1-C3 | CONFIRMED | 373 full suite; real-entrypoint dispatch w/ per-gate action + guard-absence fail-closed; differential SoT==vendored |
| D (vendor + CI + versions) | D1-D4 | CONFIRMED | --check 0; vendored core has A's exports; 3 manifests bumped; vendor-check.yml created |
| E (Claude+Codex adapters) | E0-E6 | CONFIRMED | 64 isolated; both Codex cores fail-closed (missing/malformed/throwing→deny); factory sigs unchanged; :160 inverted; secret-env single-source |
| F (OpenCode provider) | F1-F4 | CONFIRMED | 12 tests; throw+collapsed ternary+opt-out; env-strip shared list; live-binary enumeration + single-source denylist |
| G (clone→workgroup + allowlists) | G1-G5 | CONFIRMED | 24 named; getReposDir/resolveRepoDir/origin-match/rmSync; both allowlists + boundary hardening |
| H (clone-as-* parity docs) | H1-H3 | CONFIRMED | normative contract, shared cores named, conformance gate as "done"; frontmatter valid |

## DIVERGED (acknowledged — see decisions.yaml auto_judgments, stage Build)

1. **G — `isAllowedFilePath` boundary hardening (core.ts).** Beyond G4's literal "add the prefix" scope: also fixed bare `startsWith` → `path.sep` boundary (matching poll-loop.ts:87-88) so the send_file allowlist rejects prefix-lookalikes. Additive security hardening on the same allowlist G modified; lead-directed (owner-mode, grounded in the in-repo reference pattern + project security_surface). Test `test_send_file_rejects_prefix_lookalike` added.
2. **E — `db/connection.ts` +1 line (outside E's ownership).** Added `error TEXT` to `initTestSessionDb`'s `delivered` test-fixture table. Verified the REAL schema (schema.ts:215) has the column — a test-fixture/production parity fix, not a behavior change; the file is owned by no group (no conflict); E flagged it rather than silently expanding.

Also corrected during build (plan updated, so NOT a divergence): the A3 email-gate ASSERT polarity was inverted in the original plan (scheduled→gate); corrected to faithful-to-source (scheduled→bypass, interactive→gate) per C3 + verified at claude.ts:617-619; plan.md A3 updated to match.

## MISSING

None.

**Gate result:** MISSING == 0; both DIVERGED entries acknowledged (auto_judgments). Implementation matches the (corrected) plan. → Build gate.
