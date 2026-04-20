# V2 Backlog

Deferred items from the V1→V2 migration. Each entry is self-contained — a
new agent should be able to pick one up cold using only this file + the
referenced code paths.

All items already have `tools` config precedent in v1 and are feature-scope
(not correctness regressions). The migration is operational without them.

When the sqlite-backed backlog MCP ships (item 2 below), migrate these rows
into it and delete the file.

---

## 1. `render_diagram` MCP tool

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

## 2. Ship-log + backlog tracker (sqlite-backed)

**What v1 did:** two tables (`ship_log`, `backlog_items`) + MCP tools for
add/update/delete/list/activity summary + commit scanner. Dave's daily-driver
for scheduled tasks. See v1 `src/db.ts`, `src/ipc.ts` for schema + handlers.

**Why deferred:** new subsystem (schema + 7 MCP tools). Isolated though —
doesn't touch any existing code path.

**How to implement:**
1. New central DB tables in `src/db/schema.ts` + migration under
   `src/db/migrations/`:
   - `ship_log(id, agent_group_id, title, body, commit_sha, shipped_at, created_at)`
   - `backlog_items(id, agent_group_id, title, body, status, priority, created_at, updated_at, completed_at)`
2. Accessors in `src/db/` (mirror v1 patterns).
3. MCP tools in `container/agent-runner/src/mcp-tools/backlog.ts`:
   `add_ship_log`, `add_backlog_item`, `update_backlog_item`,
   `delete_backlog_item`, `list_backlog`, `get_activity_summary`,
   `scan_commits` (reads git log in /workspace/agent). Each emits a system
   action to outbound.db; host-side delivery-action handler mutates the DB.
4. Host-side module at `src/modules/backlog/index.ts` that registers the
   delivery actions (pattern: channel-config module).

**Est:** ~2hr.

---

## 3. Memory CRUD with sqlite-vec

**What v1 did:** semantic memory retrieval via sqlite-vec virtual table
(`vec_memories`) + OpenAI-embedded vectors. MCP tools `save_memory`,
`delete_memory`, `update_memory`, `list_memories`, `search_memories`.
Agents used this for "remember that X" / "what do we know about Y?".

**Why deferred:** biggest remaining item. Requires (a) embedding-provider
decision, (b) new virtual-table subsystem, (c) host-side writer. v2 currently
has `src/db/memories.ts` as a Phase-A **keyword-only** scaffold — NOT a
functional replacement. The scaffold exists so migrations line up; do NOT
rely on it as equivalent to v1's retrieval.

**Open decision for Dave before starting:**
- Embedding provider: OpenAI (v1's choice), Voyage, or host-side via the
  Anthropic Haiku prompt-embedding trick? Choice affects cost + latency +
  whether we need a new env var.

**How to implement (after decision):**
1. `pnpm add sqlite-vec` on host. Load extension at DB-open time.
2. Extend `src/db/memories.ts`:
   - `CREATE VIRTUAL TABLE vec_memories USING vec0(embedding FLOAT[N])` where
     N = embedding dim of chosen provider.
   - Writer path calls provider → writes both the plaintext row and the
     vector row (same rowid).
3. MCP tools in `container/agent-runner/src/mcp-tools/memory.ts` — five
   tools listed above. `search_memories` emits a query → host embeds →
   host runs vec MATCH + keyword fallback → returns ranked results via
   outbound ack. (Container doesn't call the embedding API directly;
   keeps API key out of the container.)
4. Scope every query by `agent_group_id` (same isolation as archive/search).

**Est:** ~3hr after provider decision.

---

## Completed in this migration stretch

For context — not active work:

- `/kill` admin command (cdb8f65)
- `read_thread` / `read_thread_by_key` MCP tools (76e654e)
- Haiku semantic rerank on `search_threads` (5128baa)
- Scoped credential filtering (IN PROGRESS — not this file's scope)
