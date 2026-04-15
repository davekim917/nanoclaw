---
name: render-diagram
description: Render diagrams and visuals as PNG images via the render_diagram tool. Use for architecture, workflows, dashboards, and anything where a visual beats text.
---

# Rendering Diagrams

`render_diagram` renders Mermaid, HTML, or SVG as PNG and sends it to chat.

## Usage

```
render_diagram(type: "html", title: "name", width: 1200, height: 800, content: "<html>...</html>")
render_diagram(type: "mermaid", title: "name", content: "graph TD\n  A-->B")
```

## When to use

- Architecture, flowcharts, sequence diagrams, org charts, timelines
- KPI dashboards, status reports, comparison matrices
- Any visual where layout, color, or relationships matter more than text

## Guidelines

- **Prefer `type: "html"`** for polished visuals — full control over styling. Use `type: "mermaid"` for quick structural diagrams or when the user asks for something simple.
- **Light background by default** unless the user asks for dark.
- **Clean typography** — system fonts, clear size hierarchy (title 28-36px, headers 18-22px, body 13-15px).
- **Limited palette** — 4-5 colors max plus a neutral. Assign each color a role.
- **Generous whitespace** — 32-48px between sections, 20-28px inside cards.
- For data charts with real datasets (bar, line, scatter), use Python with matplotlib/plotly and `send_file` instead.
