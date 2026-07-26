# V2 Backlog

Deferred items from the V1→V2 migration. Each entry is self-contained — a
new agent should be able to pick one up cold using only this file + the
referenced code paths.

All items already have `tools` config precedent in v1 and are feature-scope
(not correctness regressions). The migration is operational without them.

When the sqlite-backed backlog MCP ships (item 2 below), migrate these rows
into it. The file is kept as an onboarding reference for future agents.

---

## 1. `render_diagram` MCP tool ✅

**SHIPPED** (2026-04-20). Run `./container/build.sh` to install mmdc in the agent image.

**What v1 did:** accepted Mermaid / HTML / SVG input, rendered to PNG via
headless chromium inside the container, delivered via `send_file`.

**Why deferred:** adds a new container-level npm global (`@mermaid-js/mermaid-cli`)
and a Dockerfile rebuild. Not a regression — agents can paste mermaid source
into chat today; only affects image-output channels.

**How to implement:**

1. Add `@mermaid-js/mermaid-cli@<pinned>` to the pnpm global-install block in
   `container/Dockerfile` alongside `agent-browser` etc.
2. Set `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` and `PUPPETEER_SKIP_DOWNLOAD=1`
   so mmdc reuses the existing chromium rather than downloading its own.
3. Create `container/agent-runner/src/mcp-tools/render-diagram.ts`:
   - Accept `{ source: string, format?: 'mermaid'|'html'|'svg' }`.
   - Write source to `/tmp/<id>.mmd` (or `.html`).
   - `execFile('mmdc', ['-i', ..., '-o', '/tmp/<id>.png'])` for mermaid.
   - For html/svg: launch chromium with `--headless --screenshot=<out.png> file://<in.html>`.
   - Register via `registerTools([...])` and import in `mcp-tools/index.ts`.
   - Deliver via existing `send_file` pattern (30s delivery ack).

**Est:** ~1hr incl. container rebuild.

---

## 2. Ship-log + backlog tracker (sqlite-backed) ✅

**SHIPPED** (2026-04-20).

Files:

- `src/db/backlog.ts` — all accessors for ship_log, backlog_items, commit_digest_state
- `src/db/migrations/015-backlog.ts` — central DB tables
- `src/modules/backlog/index.ts` — delivery action handlers (add_ship_log, add/update/delete_backlog_item)
- `container/agent-runner/src/mcp-tools/backlog.ts` — 7 MCP tools
- `container/agent-runner/src/db/connection.ts` — added `getCentralDb()` for read access
- `src/container-runner.ts` — mounts v2.db read-only at `/workspace/central.db`
- `scripts/migrate-backlog-shiplog.ts` — v1 data migration script
- `scripts/migrate-backlog-shiplog.ts` run: 26 backlog + 146 ship_log + 53 digest state rows migrated

---

## 3. Semantic memory CRUD / provider-native auto-memory authority — retired

**NOT ACTIVE WORK.** v1 used a sqlite-vec store and an early v2 experiment
treated Claude-native auto-memory as durable authority. Both designs are
superseded.

The current contract is one canonical Markdown tree per workgroup at
`data/workgroups/<workgroup-id>/memory`, shared by every sibling provider.
Provider-native memory paths are compatibility views only. The host injects
bounded, source-grounded canonical and archive recall before each admissible
turn, and agents update the canon through `write_memory_file` (or deliberate
shell editing). See [memory.md](memory.md).

Do not resume the old sqlite-vec or native auto-memory plan from this backlog.
Any future semantic index must remain derived, rebuildable retrieval over the
workgroup canon rather than becoming a second memory authority.

---

## Completed in this migration stretch

For context — not active work:

- `/kill` admin command (cdb8f65)
- `read_thread` / `read_thread_by_key` MCP tools (76e654e)
- Haiku semantic rerank on `search_threads` (5128baa)
- Per-agent scoped credential filtering (6578be1)
- Upstream v2 merge (c2b163d)
