# Review Report: Cross-Provider Guard Parity (Cycle 5 — FINAL, CLEARED)

> `/team-review` under `/team-auto` — 2026-06-19
> Reviewers: A (architecture-advisor, Claude) · B (best-practice-check, Claude) · C (codex adversarial, GPT-5.5, run read-only by the lead after the `--yolo` auto-mode block)
> Input: cycle-4-revised `design.md` (D17 Codex both-cores fail-closed + 5 SHOULD-FIX)

## Verdict — CLEARED (MUST-FIX: 0)

- **Reviewer A (architecture):** CONFORMING, 5th consecutive cycle. **NO BLOCKERS.** Verified the cycle-4 deltas against source: `loadFileProtectionCore`/`runFileProtection` really fail open today (runner.ts:178-186/195-196) and the D17 fix is buildable with a **same-repo reference implementation** (Claude's `createBlockGitCloneHook` already does export-type validation + exception→deny + fail-closed at claude.ts:738-748/760-773). M1 genuinely resolved; no new contradiction; D-E and D-G now agree on "uniform fail-closed."
- **Reviewer B (best-practice):** Design now **FULLY CONFORMS**. The cycle-4 changes (required-CI `--check` gate + malformed-core handling) resolve the malformed-core gap and **downgrade the vendoring drift from MEDIUM to an accepted, CI-gated LOW** with a documented escalation path. Validating export types + mapping exceptions→deny on a dynamically-imported guard module matches established secure-plugin-loading / fail-closed-on-malformed-policy practice (SAPL, NIST ABAC, clawdstrike, ImportSpy). No new structural drift.
- **Reviewer C (codex adversarial):** One finding (below) — a real signature bug in the cycle-4 D-A edit, now applied as D18.

**MUST-FIX: 0 · SHOULD-FIX: 1 (applied) · WON'T-FIX/NIT: 2**

## SHOULD-FIX (applied inline — D18)

- **codex-C5-1 [VERIFIED, APPLIED] D-A's `runNanoclawGate` signature change was caller-breaking.** The cycle-4 D-A text proposed `runNanoclawGate(command, reason, action='request_destructive_gate', onStageError?)` and called it "back-compat." But the current signature is `runNanoclawGate(command, reason, onStageError?)` and existing callers pass the callback as **arg 3** (Codex runner.ts:153 `runNanoclawGate(command, reason, () => {…})`, OpenCode opencode-guard.ts:78, Claude block-destructive). Inserting `action` at position 3 shifts the callback → a parity regression in the shared approval primitive; the "back-compat" claim was false. → **Fix (D18, applied):** keep `runNanoclawGate(command, reason, onStageError?)` unchanged; add `action` to the internal `writeGateRequest` + a lower-level `runGateRequest(command, reason, {action, onStageError})`; `runNanoclawGate` = destructive wrapper, `runEmailGate` = bash-gate wrapper; regression test asserts the legacy 3-arg call still emits `request_destructive_gate`. Classified SHOULD-FIX (the TS compiler hard-gates the regression at every call site; A+B found no blockers) and applied inline per /team-auto Principle 3 (in-scope, citable grounding — runner.ts:153).

## WON'T-FIX / NIT / carry-forward

- **A NIT-1 (stale line numbers) — NOT a defect.** Reviewer A read the **vendored** copy (`workflow-agents/block-destructive-core.ts`, which has a prepended vendor banner ⇒ ~+4 line offset, so `:967`/`:1067`). The design cites the **SoT** (`workflow/block-destructive-core.ts`) where the hardcode is `:963` and the sole call `:1063` — independently re-verified by the lead. The SoT is the correct citation target (where edits are authored). No change.
- **A NIT-2 (carry-forward to /team-plan).** When the OpenCode `warn→throw` lands (D-E), also collapse the now-dead `...(guardAvailable ? { plugin: [GUARD_PLUGIN] } : {})` ternary at opencode.ts:347 to an unconditional `plugin: [GUARD_PLUGIN]` (spawn refuses without the guard, so the false branch is dead). Implementation note, not a design blocker.
- **B verification items (carry-forward to /team-plan, already in the design's "validate in build"):** confirm `vendor-guards --check` is a *required / non-bypassable* CI status check (the whole vendoring-drift mitigation rests on it); confirm the bootstrap-mount + claude.ts→codex import-chain invariants hold at spawn.
- **B-LOW (D-B sync/async split, D-F dual workgroup signal)** — within-pattern, mitigated. No change.

---

**Status:** Cycle 5/5 complete — **CLEARED, MUST-FIX: 0.** Architecture CONFORMING 5×. codex-C5-1 applied inline (D18). `/team-auto` Stage A clears → Stage B (`/team-plan`). Carry-forward items recorded for /team-plan.
