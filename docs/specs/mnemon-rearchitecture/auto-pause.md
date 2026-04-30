# /team-auto paused at Stage A (Review) — Cycle 3 cap reached

**Stage:** Review
**Reason:** `cap-reached` (3/3 review cycles consumed)
**Cycles consumed:** 3/3
**Last action attempted:** Cycle-3 review completed; 9 MUST-FIX remain

## Why I stopped

Cycle 3 was the last allowed by `/team-review`. The next invocation refuses to run.

**Convergence achieved on architecture.** Reviewer B (best-practice-check, external pattern validation) explicitly validated the design as *"on the right track and well-aligned with the dominant industry pattern. The novel choices are deliberate and well-justified for the constraints."* 11 sources from Mem0, Letta, Aura, Signet, Three Dots Labs, Anthropic engineering, etc. corroborate every major design decision. No new architectural drift surfaced in cycle 3.

**Convergence NOT achieved on spec polish.** The 9 cycle-3 MUST-FIX are all mechanical errors in the design *text*:

| # | Issue | Fix |
|---|---|---|
| M1 | `block-mnemon-real-hook.ts` retained but its claude.ts wiring is deleted | Update import path; replace gate condition |
| M2 | `writeSessionMessageRaw` referenced but doesn't exist | Replace with `insertMessage(...)` + `updateSessionLastActive()` OR add helper |
| M3 | `MemoryStore.remember()` signature missing `idempotencyKey` opts param | Update interface signature |
| M4 | S5 typing-indicator placement contradicts M1 hook location | Move `startTypingRefresh()` ahead of `writeSessionMessage` in router |
| M5 | Daemon classifier missing `channel_type='agent'` filter | Add WHERE clause |
| M6 | scan_cursor + retry creates unbounded re-work | Decouple retries to dead_letters table query |
| M7 | Host Anthropic SDK not specified — supply-chain + auth path | Recommend native fetch via OneCLI proxy (no new SDK) |
| M8 | `getAgentGroupFolder` fictional function in M8 patch | Replace with `getAgentGroup(agentGroupId)?.folder` |
| M9 | systemd unit references `dist/scripts/...` won't exist with current tsconfig | Move daemon source to `src/memory-daemon/` |

None require architectural decisions. None require user judgment. They're spec-text bugs the next reviewer would catch — but cycle 3 is the cap.

## Per team-auto rules — three paths forward

**Path 1: Apply the 9 mechanical fixes inline + proceed.**
- I revise the design directly to address all 9 (no further `/team-review`).
- Proceed to `/team-plan` (Stage B). The plan stage's pre-build drift check will validate that plan claims are grounded in design, catching any residual misalignment.
- Net effect: design becomes correct; review cycle cap is acknowledged but irrelevant since the architecture is validated.
- Risk: any spec-text issue I miss won't be caught until plan or build.

**Path 2: Waive the 9 MUST-FIX with stated reason + proceed.**
- Add 9 waivers to `decisions.yaml` with reason "mechanical spec fix; will be addressed during plan/build with team-plan's drift checks as enforcement."
- Proceed to `/team-plan`.
- The plan stage gets a noisier surface (plan inherits these errors) but the team-plan skill has its own constraint-traceability table.
- Risk: noisier plan stage; some waivers might silently let real bugs through.

**Path 3: Return to `/team-design` for rework.**
- Heavy. Reviewer B's strong validation makes this overkill — there are no architectural problems, just spec polish.
- Not recommended.

## Recommendation

**Path 1.** All 9 are unambiguous mechanical fixes. I can apply them now in a single revision pass, then proceed to `/team-plan`. The cycle cap is not an obstacle — `/team-review` refuses cycle 4, but the 9 fixes don't need review since the architecture they apply to is already validated.

If you concur, I proceed:
1. Apply 9 mechanical revisions to design.md
2. Update decisions.yaml with each as a logged-and-resolved entry
3. Re-invoke `/team-plan` (Stage B of team-auto)
4. team-plan produces plan.md
5. team-auto proceeds through Stage C (Build) and Stage D (QA) per the autonomous workflow

If you prefer Path 2, tell me which MUST-FIX to waive vs fix.
If Path 3, we restart from `/team-design`.

## Findings still open

See `docs/specs/mnemon-rearchitecture/review.md` for full cycle-3 findings (9 MUST-FIX + 7 SHOULD-FIX + 5 WON'T-FIX).
