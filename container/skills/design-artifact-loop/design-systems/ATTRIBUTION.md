# Attribution

The design systems in this directory (`<name>/DESIGN.md` + `<name>/tokens.css`) are
vendored verbatim from **Open Design** — <https://github.com/nexu-io/open-design> —
which is licensed **Apache-2.0** (see `LICENSE` in this directory).

Open Design is a local-first, open-source design tool. This plugin vendors a curated
subset of its `design-systems/` corpus to use as concrete generative targets (the
"author-then-conform" mechanism). No modifications were made to the vendored
`DESIGN.md` / `tokens.css` files.

Curated subset (46 systems): airbnb, airtable, ant, apple, application, arc, atelier-zero, bento, brutalism, cal, claude, clean, clickhouse, cohere, coinbase, composio, corporate, cursor, dashboard, duolingo, editorial, framer, github, glassmorphism, kami, linear-app, luxury, minimal, mono, neobrutalism, nike, notion, publication, raycast, retro, revolut, shadcn, spotify, starbucks, stripe, theverge, tom-modern, trading-terminal, vercel, warm-editorial, wired.

To add more systems, copy additional `design-systems/<name>/{DESIGN.md,tokens.css}` from
the upstream repo and add a row to `index.md`.
