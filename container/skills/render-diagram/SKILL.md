---
name: render-diagram
description: Render polished diagrams and visuals as PNG images using Mermaid, HTML, or SVG via the render_diagram tool. Use instead of ASCII art when a professional visual would be more effective.
allowed-tools: render_diagram
---

# Rendering Diagrams

You have the `render_diagram` tool. It renders Mermaid diagrams, HTML pages, or SVG graphics as PNG images and sends them directly to chat.

## When to use

- Architecture diagrams, flowcharts, sequence diagrams, org charts, timelines
- Any visual where layout, color, or relationships matter more than raw text
- When the user asks for a diagram, chart, or visual

## When NOT to use

- Simple lists or hierarchies that read fine as text
- Quick inline sketches where ASCII is clearer (e.g. `A -> B -> C`)
- Data charts (bar, line, scatter) — use Python with plotly/matplotlib and `send_file` instead

## Mermaid examples

Architecture:
```
render_diagram(type: "mermaid", title: "architecture", content: `
graph TD
    A[Client] -->|REST| B[API Gateway]
    B --> C[Auth Service]
    B --> D[Order Service]
    D --> E[(PostgreSQL)]
    D --> F[(Redis Cache)]
    C --> G[OAuth Provider]
`, theme: "default")
```

Sequence:
```
render_diagram(type: "mermaid", title: "auth-flow", content: `
sequenceDiagram
    participant U as User
    participant A as API
    participant DB as Database
    U->>A: POST /login
    A->>DB: Verify credentials
    DB-->>A: User record
    A-->>U: JWT token
`, theme: "neutral")
```

## HTML for custom visuals

When Mermaid is too limiting, use HTML with modern CSS for full creative control:

```
render_diagram(type: "html", title: "system-overview", width: 1400, height: 900, content: `
<!DOCTYPE html>
<html>
<head>
<style>
  * { margin: 0; box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 40px; }
  h1 { font-size: 24px; font-weight: 600; margin-bottom: 32px; color: #f8fafc; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
  .card { background: #1e293b; border-radius: 12px; padding: 24px; border: 1px solid #334155; }
  .card h3 { color: #38bdf8; font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
  .card p { font-size: 14px; line-height: 1.5; color: #94a3b8; }
  .arrow { text-align: center; color: #475569; font-size: 24px; padding: 8px; }
</style>
</head>
<body>
  <h1>System Architecture</h1>
  <div class="grid">
    <div class="card"><h3>Frontend</h3><p>React SPA</p></div>
    <div class="card"><h3>API</h3><p>Node.js + Express</p></div>
    <div class="card"><h3>Database</h3><p>PostgreSQL</p></div>
  </div>
</body>
</html>
`)
```

## Tips

- **Mermaid themes**: `default` (blue/gray), `dark` (dark background), `forest` (green), `neutral` (minimal)
- **Background**: set `background: "transparent"` for a clean look, or match the chat's theme
- **HTML sizing**: set `width` and `height` to match your content — avoid excess whitespace
- **Keep it simple**: a clear diagram with 5-10 nodes communicates better than a busy one with 30
