# Attribution

The design systems in this directory (`<name>/DESIGN.md` + `<name>/tokens.css`) are
vendored verbatim from **Open Design** — <https://github.com/nexu-io/open-design> —
which is licensed **Apache-2.0** (see `LICENSE` in this directory).

Open Design is a local-first, open-source design tool. This plugin vendors a curated
subset of its `design-systems/` corpus to use as concrete generative targets (the
"author-then-conform" mechanism). No modifications were made to the vendored
`DESIGN.md` / `tokens.css` files.

Curated subset (59 systems): airbnb, airtable, ant, apple, application, arc, atelier-zero, bento, bmw, brutalism, cal, claude, claymorphism, clean, clickhouse, cohere, coinbase, composio, corporate, cursor, dashboard, dithered, doodle, duolingo, editorial, framer, github, glassmorphism, hud, ibm, kami, linear-app, luxury, mastercard, minimal, mission-control, mono, neobrutalism, nike, notion, pacman, publication, raycast, retro, revolut, shadcn, spotify, starbucks, stripe, tesla, tetris, theverge, tom-modern, trading-terminal, vercel, vintage, vodafone, warm-editorial, wired.

To add more systems, copy additional `design-systems/<name>/{DESIGN.md,tokens.css}` from
the upstream repo and add a row to `index.md`.
