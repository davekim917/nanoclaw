# /team-auto paused at Stage A (Review)

**Stage:** Review (cycle 3)
**Reason:** `hard-constraint` — product-scope decision (existing overlapping skill discovered)
**Cycles consumed:** 3/5 (2 prior Codex brief+design reviews, 1 architecture review)
**Last action attempted:** Reviewer A (architecture/codebase-fit) completed; verified its key finding (F5) against source before acting.

## Why I stopped

Reviewer A — reading the actual codebase, which the two prior Codex passes could not —
found that `container/skills/frontend-engineer/SKILL.md` **already implements** the
render-grounded verification loop this feature proposed: agent-browser screenshots at
desktop/tablet viewports, a 3-iteration cap, WCAG-AA contrast, no-horizontal-overflow
check, consistent empty/loading/error states, semantic-HTML/a11y rules, an anti-pattern
denylist, and "never declare done until visually verified in a real browser." I read the
file end-to-end and confirmed it.

That makes the question "should design-artifact-loop be a new skill, extend
frontend-engineer, or compose with it?" a **product-scope decision** — it changes which
capabilities exist and which skill fires on "design me a UI." `/team-auto`'s rules say to
escalate (not guess) when a decision changes user-facing product intent or scope, and the
right answer depends on your intent, which I can't derive. Auto-picking would risk
building a parallel, partially-redundant skill or silently changing an existing one.

I did not run Reviewers B (best-practice) and C (Codex adversarial) yet: the scope
decision will materially change the design, and `/team-review`'s own rule is that a
changed design needs a fresh assessment — so running B/C on the current design now would
be wasted.

## What design-artifact-loop adds that frontend-engineer does NOT have

(So the scope decision is informed — these are the genuinely net-new pieces:)
1. **Author-then-conform design-system corpus** — ~15-20 vendored concrete DESIGN.md
   systems + index, with "commit a concrete system BEFORE markup." frontend-engineer only
   says "use tokens if a design system exists" — it has no curated library and no
   commit-first discipline. **This is the actual slop fix and is absent today.**
2. **Independent (L1) critic** — frontend-engineer self-reviews (L0). The whole point of
   this feature was a *separate* critic.
3. **Deterministic linter** (token-trace via `:root`, font denylist, severity taxonomy).
4. **Chat-delivery focus** — single self-contained HTML + preview via `send_file`, vs
   frontend-engineer's build-and-deploy-to-Vercel orientation.

## Findings still open (from Reviewer A — see review.md)

- **F5 [ESCALATED — scope]:** frontend-engineer overlap. **Your call.**
- **F1 [MUST-FIX]:** cross-round state can't live in MCP-tool module memory (Codex tears
  it down per query); rehydrate from a disk file. — I can fix on resume.
- **F2 [MUST-FIX]:** `/workspace/outbox/<id>/` is deleted after delivery and isn't a
  valid `send_file` source; use `/workspace/agent/` for state/trace. — I can fix on resume.
- **F4 [MUST-FIX risk]:** the inbound formatter passes images as **text references**, not
  vision blocks (`formatter.ts:480-493`) — so the critic actually *seeing* the screenshot
  is unproven on every provider; OpenCode has no same-provider subagent spawn (its only
  separate-process critic is `codex exec`, which is L2). The mandatory spike must prove
  vision ingestion per provider. — calibration fix + spike hardening on resume.
- **F3, F6, F7, F8 [SHOULD-FIX]:** OpenCode skill = text-injection not a loader; egress
  lockdown makes font-CDN moot; stale `verified` flag; linter should flag all
  network-capable constructs. — I can fix on resume.

## What I would do next if I had answers

Tell me the scope direction (one of):
- **(A) New separate skill** with a crisp boundary (design-artifact = chat-delivered
  single-file design artifact + corpus + critic; frontend-engineer = build/ship real web
  projects). Risk: both fire on overlapping intent — needs a sharp trigger boundary.
- **(B) Extend frontend-engineer** — fold the net-new pieces (corpus + author-then-conform
  + L1 critic + linter) into the existing skill. Lowest sprawl, one render-grounded design
  skill; but changes that skill's behavior for all frontend tasks.
- **(C) Compose** *(my lean)* — a focused new skill owns the corpus + author-then-conform
  + independent critic + `design_review` MCP tool, and explicitly **reuses**
  frontend-engineer's render-verify discipline rather than re-implementing it. Clean
  separation of "design taste/system" from "build/verify mechanics."

Once you pick, I'll revise the design accordingly (and apply F1/F2/F3/F4/F6/F7/F8), then
re-run review fresh (B + C included) and continue team-auto.
