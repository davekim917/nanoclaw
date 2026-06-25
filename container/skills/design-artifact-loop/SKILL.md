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
- Save it under **`/workspace/agent/design-artifact-loop/<id>/artifact.html`** (pick a
  short stable `<id>`). This dir is persistent and `send_file`-able; do not author under
  `/workspace/outbox`.
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
design_review({ id: "<id>", artifactPath: "/workspace/agent/design-artifact-loop/<id>/artifact.html", designSystem: "<name>" })
```
It re-renders the artifact (1440×900 + 390×844), runs the deterministic linter
(token-trace, no-JS, network, font-denylist), records the round with carry-forward, and
returns `{ round, status, findings, mustFixOpen, screenshotPaths, tracePath }`.

### 4. Run the INDEPENDENT visual critic on the render
- Spawn a **separate** critic pass (NOT your own self-review) and have it **`Read` one
  of the `screenshotPaths` from disk** — reading the PNG yields a vision block so the
  critic actually *sees* the design. **Do not** pass the screenshot as a chat
  attachment (that arrives as a text reference, not vision).
  - Claude: a `Task` sub-agent. Codex: `codex exec --yolo`. OpenCode: its task/subagent
    primitive, or `codex exec --yolo` as the cross-process fallback. Give the critic
    ONLY the screenshot path + the chosen `DESIGN.md` + this rubric — never your
    generation transcript.
- **Critic rubric:** is the layout structurally distinct from the slop baseline, or
  "branded-generic" (distinct paint on the same skeleton)? Do colours/type trace to the
  system? Are states / contrast / responsive handled? Return findings as
  `[{severity:'high'|'medium'|'low', locus, message}]`.

### 5. Feed the critic findings back and revise
- Call `design_review` again with `criticFindings: [...]`. Revise the artifact against
  `mustFixOpen` (carried forward across rounds by stable id).

### 6. Ship gate (bounded — max 3 rounds)
- `status: "shipped-with-disclosures"` → ship; note any unresolved medium/low findings.
- `status: "blocked"` (cap reached with unresolved HIGH) → fix the highs if you can in
  one more pass, else **surface the unresolved highs to the user** — do not ship silently.
- `status: "continue"` → loop back to step 4.

### 7. Deliver
- `send_file` the HTML artifact + a preview PNG (a `screenshotPath`) + the
  `trace.json` so the user sees the design, the render, and the review trail.

## Hard rules
- Commit a concrete system FIRST (step 1) — this is the actual slop fix.
- The critic must be independent and **see the render via `Read`**, not self-review.
- No JS; everything self-contained; colours via `:root` tokens.
- The loop is bounded; never silently ship unresolved HIGH findings.

> impeccable (mounted in this container) also flags taste-tells (overused fonts, AI
> editorial markers) on files you write — treat its findings as part of the critic layer.
