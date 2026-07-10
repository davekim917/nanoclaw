---
name: design-artifact-loop
description: |
  Produce non-slop, chat-delivered UI design artifacts. Use when asked to design or
  mock up an app, site, dashboard, landing page, settings screen, pricing page, or any
  single-screen UI to be delivered in chat (not built+deployed as a real web project —
  that is a different task). Commits a concrete design system BEFORE markup, then
  render-grounded-iterates against a deterministic linter + an independent visual critic.
  Triggers: "design a", "mock up a", "make me a UI", "design a dashboard/landing/page".
---

# design-artifact-loop

Slop is the absence of a *committed* design system — the model falls back to the
statistical average of web UIs (generic gradient hero, three equal cards, default
indigo, AI-tell fonts). The fix is **author-then-conform**: commit a concrete, fully
specified design system first, then conform to it exactly, and verify the *rendered
pixels* with an independent critic — not your own self-assessment.

This skill is for **single-file, chat-delivered design artifacts**. For building and
deploying a real web app, that is a separate workflow.

## The loop (follow in order)

### 1. Commit a design system BEFORE writing any markup
- Read `design-systems/index.md` (in this skill dir) and **pick ONE** system whose
  vibe fits the request, OR author a fresh one. Read that system's `DESIGN.md` +
  `tokens.css` **on demand** — never read the whole corpus.
- If authoring fresh, write a concrete spec: palette WITH roles, type pairing, depth
  language, radii, motion, and explicit anti-patterns. Vague ("clean, modern") is not a
  committed system.

### 2. Write a single self-contained HTML artifact
- Save it under **`<loop-root>/<id>/artifact.html`** (pick a short stable `<id>`).
  The loop root is `$DESIGN_ARTIFACT_LOOP_ROOT` if set, else `.design-artifact-loop/`
  in the current working directory — the `design_review` tool's errors echo the exact
  expected path if you get it wrong.
- **Conform to the system's tokens:** declare a `:root { --token: value }` block lifted
  from the chosen `tokens.css`, and reference every colour/size via `var(--…)`. No
  hardcoded hex/colour outside `:root`.
- **No JavaScript** — static HTML/CSS only (no `<script>`, no `fetch`, no external
  network beyond a declared font CDN with a system-font fallback). Self-contained.
- Cover the states the surface needs (empty / populated; for data views also
  loading / error). Make the layout *structurally* differ from the slop baseline
  (don't reuse top-nav + centered-gradient-hero + three-equal-cards + plain table).

### 3. Call `design_review`
```
design_review({ id: "<id>", artifactPath: "<loop-root>/<id>/artifact.html", designSystem: "<name>" })
```
It re-renders the artifact (1440×900 + 390×844), runs the deterministic linter
(token-trace, no-JS, network, font-denylist), records the round with carry-forward, and
returns `{ round, status, findings, mustFixOpen, screenshotPaths, tracePath, reviewToken }`.
The **`reviewToken`** identifies this exact artifact version — you pass it back with your
critic findings in step 5 so they aren't mistaken for a stale review.

> If the artifact has `no-js:`/`network:` findings, **render is SKIPPED** (the tool will
> not run a script-bearing or egress artifact through the browser) and `screenshotPaths`
> is empty. Remove every `no-js:`/`network:` finding first; screenshots appear once it is
> static and self-contained.

### 4. Run the INDEPENDENT visual critic on the render
- Spawn a **separate** critic pass (NOT your own self-review) and have it **`Read` one
  of the `screenshotPaths` from disk** — reading the PNG yields a vision block so the
  critic actually *sees* the design. **Do not** pass the screenshot as a chat
  attachment (that arrives as a text reference, not vision).
  - Claude Code: a `Task` sub-agent. Other harnesses: any independent sub-process
    with vision that can read the PNG from disk (e.g. `codex exec`). Give the critic
    ONLY the screenshot path + the chosen `DESIGN.md` + this rubric — never your
    generation transcript.
- **Critic rubric:** is the layout structurally distinct from the slop baseline, or
  "branded-generic" (distinct paint on the same skeleton)? Do colours/type trace to the
  system? Are states / contrast / responsive handled? Return findings as
  `[{severity:'high'|'medium'|'low', locus, message}]`.

### 5. Feed the critic findings back and revise
- Call `design_review` again with **both** `criticFindings: [...]` **and**
  `criticReviewToken: "<the reviewToken from the call whose screenshots the critic read>"`.
  If you omit `criticReviewToken` (or it doesn't match the current artifact), the findings
  are dropped as stale and the round is wasted.
- If the critic found **nothing**, still pass an empty `criticFindings: []` with the
  matching `criticReviewToken` — that records "the critic reviewed this version and it's
  clean", which is required before a clean artifact can ship (see step 6).
- Revise the artifact against `mustFixOpen` (carried forward across rounds by stable id).
  Every revision changes the `reviewToken`, so re-run the critic on the **new** screenshots.

### 6. Ship gate (bounded — up to 6 rounds)
- `status: "shipped-with-disclosures"` → ship; note any unresolved medium/low findings.
- `status: "blocked"` (cap reached with unresolved HIGH) → fix the highs if you can in
  one more pass, else **surface the unresolved highs to the user** — do not ship silently.
- `status: "continue"` → loop back to step 4. **A clean lint does not ship on its own** —
  if there are no findings but the critic hasn't reviewed the current version yet, status
  stays `continue` until you run the critic (step 4) and pass its result with the matching
  `criticReviewToken`. The independent visual critic is mandatory, not optional.

### 7. Deliver
- Deliver the HTML artifact + a preview PNG (a `screenshotPath`) + the `trace.json`
  as real files — use your environment's file-sending tool (e.g. a `send_file` MCP
  tool or chat attachment), never bare file paths — so the user sees the design, the
  render, and the review trail.

## Hard rules
- Commit a concrete system FIRST (step 1) — this is the actual slop fix.
- The critic must be independent and **see the render via `Read`**, not self-review.
- No JS; everything self-contained; colours via `:root` tokens.
- The loop is bounded; never silently ship unresolved HIGH findings.

> If a taste linter is available in your environment (e.g. the `impeccable` plugin,
> which flags overused fonts, AI editorial markers, em-dash overuse), treat its
> findings on the artifact as part of the critic layer — fold them into
> `criticFindings` rather than ignoring them.
