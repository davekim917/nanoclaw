---
name: render-diagram
description: Produce beautiful diagrams and visuals via the render_diagram MCP tool. Use for architecture, workflows, timelines, comparisons, dashboards, and any visual where layout or relationships matter more than text.
---

# Render Diagram

`render_diagram` renders a PNG and attaches it to the current chat. Three rendering modes — `html` (default), `mermaid`, `svg` — plus five opinionated templates for the `html` mode.

## The rule that actually matters

**The built-in templates are fallbacks, not the goal.** A diagram built from a 3-box `architecture` fallback looks like every other AI-generated architecture diagram ever made. If the user asks for something beautiful, you must design it — choose `template: "custom"` and write the HTML yourself with taste.

Reach for a template when the structure is genuinely generic (e.g. "a simple 4-step flowchart"). Reach for custom HTML when the content deserves more. Err on the side of custom.

## Modes

```
render_diagram(type: "html",    template: "custom", content: "<div>...handcrafted...</div>", title?, subtitle?, caption?)
render_diagram(type: "html",    template: "architecture", content: { layers: [...] }, ...)
render_diagram(type: "mermaid", content: "flowchart TD\n  A[Start] --> B[End]", mermaidTheme?)
render_diagram(type: "svg",     content: "<svg>...</svg>", ...)
```

Leave `width` / `height` unset unless you need a specific size — the renderer measures content and crops tightly. Theme defaults to `light`. Only pass `dark` when the user explicitly asked for it.

## Templates (html mode)

| Template | `content` shape |
|---|---|
| `architecture` | `{ layers: [{ label, items: [[name, desc, style?], ...] }, ...] }` — style: `primary \| secondary \| accent \| data \| external` |
| `flowchart` | `{ steps: ["step", { label, type: "decision" \| "end" }, ...] }` |
| `timeline` | `{ items: [{ date, title, desc? }, ...] }` |
| `comparison` | `{ headers: [...], rows: [[cell, ...], ...] }` |
| `org-chart` | `{ nodes: [{ name, role, children?: [name, ...] }, ...] }` |
| `custom` | raw HTML in `content` (string). **Your best path for quality.** |

If you use a template, include every layer/step/item the user or your prose mentioned. A "five-layer architecture" must render as five rows. Truncating silently is a bug.

## Mermaid

Mermaid is often the right answer — don't reach for custom HTML when mermaid would render the same structure faster and with better layout logic. Best for: sequence diagrams, Gantt, ER diagrams, state machines, process flows with decisions. Its auto-layout handles edges and spacing for you; bespoke HTML for these almost always looks worse.

Default theme is `default` (light background). Don't try to override mermaid's typography — its native look is clean and consistent.

## Design principles for custom HTML

Follow these, don't just acknowledge them.

**Typography.** One display font family is enough — system stack `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif` looks modern without loading webfonts. Title 28–40px, section headers 16–20px, body 13–15px. Tight line-height on headings (1.1–1.2), generous on body (1.5). Use `letter-spacing: -0.02em` on large display text, `letter-spacing: 0.08em` (tracked out) on all-caps section labels.

**Color.** Pick 2 accent hues + 1 muted neutral + 1 surface + 1 text. No more. Examples of palettes that work:
- Cool/technical: `#0284c7` (sky) + `#7c3aed` (violet) + `#64748b` (slate) on `#f8fafc` surface with `#0f172a` text.
- Warm/editorial: `#ea580c` (orange) + `#0f766e` (teal) + `#6b7280` (neutral) on `#fffbf5` surface with `#1c1917` text.
- Mono: a single accent at three opacity steps on a neutral surface.
Assign each color a role — "headings", "arrows", "emphasized box", "de-emphasized box" — and hold the line.

**Whitespace.** Padding 40–64px around the whole canvas. 24–32px between logical sections. 16–24px inside cards. Empty space is not a bug — it's what separates a diagram from a slide.

**Hierarchy.** The reader's eye should land in one place first. Achieve this with size, weight, color contrast — not with "!!" or borders-everywhere. One dominant element per diagram.

**Boxes, arrows, lines.** Rounded corners (8–12px). 1–2px borders, never 4px. Arrows should be thin (1.5–2px stroke) with a subtle arrowhead, not clip-art. Dashed lines for "optional" or "async" paths only.

**Shadows and gradients.** Used sparingly they add depth. Used everywhere they look cheap. Prefer a single subtle shadow (`0 1px 2px rgba(15,23,42,0.06), 0 4px 8px rgba(15,23,42,0.04)`) on the primary element only.

**Labels.** Short. Noun phrases, not sentences. "Worktree pruned" beats "The worktree is pruned". If you need a sentence, it's a caption, not a label.

**Every visual element must explain itself.** If you draw a dot, a dashed line, a colored bar, an icon — the reader has to know what it means without squinting. Either label it directly ("`git worktree add`" next to the line it represents), or put the key in a subtitle/legend at the top or bottom. An unlabeled dot is noise, not data.

**No dead zones.** Every pixel inside the canvas should earn its place. If a column is empty, the layout is wrong — re-flow, don't pad.

## Concrete anti-patterns

- Three-box "Frontend → API → Database" with no real content. Bland.
- Giant empty canvas with a tiny diagram in the corner. (The renderer auto-crops now; don't fight it by passing huge heights.)
- White text on a white card. (Check contrast on every label before shipping.)
- 8 colors, each used once. Pick 3. Reuse them.
- Decorative emoji where a real icon or shape would do.
- Nested rounded rectangles 4 levels deep "grouping" things. Usually a table or a swimlane would be clearer.

## Self-check before calling the tool

Before you invoke `render_diagram`, read your HTML/content and ask:

1. Does the diagram match everything I just wrote in prose? (Five-layer claim → five layers rendered.)
2. Is every label legible? Contrast ≥ 4.5:1 on body text.
3. If I squint, can I tell what the hierarchy is?
4. Would this embarrass me if it were in a pitch deck?

If any answer is "not really," iterate before rendering. The tool is not the taste — you are.

## Data charts

For bar/line/scatter plots of real datasets, prefer Python + `matplotlib` / `plotly` and `send_file`. `render_diagram` is for conceptual visuals, not quantitative charts.
