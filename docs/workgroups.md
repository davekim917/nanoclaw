# Workgroups

A **workgroup** is a tenant-level grouping that contains one or more `agent_groups`. It is the data-pool boundary for:

- **Chat archive** — sibling agents in a workgroup can read each other's archived chat history via the existing `resolve_thread_link` / `search_threads` / `read_thread` MCP tools.
- **Graphify knowledge retrieval** — members query one source-grounded graph over shared files, repositories, and conversations.
- **OneCLI secret declarations** — workgroup-level secrets are inherited by all member agent_groups at container spawn time.

Sibling `agent_groups` (e.g., a Claude twin + a Codex twin, plus future siblings like `<x>-research` or `<x>-data-analyst`) are peers — each remains a separate row in the database with its own platform bot user, CLAUDE.md, container, and routing identity. No sibling is a parent of another; the workgroup is the layer **above** them, not a collapse and not a hierarchy.

---

## Why workgroups exist

NanoClaw's sibling-agent architecture requires per-agent bot identity for native `@`-mentions on Slack and Discord. But the data layer was scoped per `agent_group_id`, so siblings could not see each other's chat history, knowledge graph, or shared credentials.

Before workgroups, this was patched up implicitly via scattered symlinks (`CLAUDE.local.md`, `sources/`, `conversations/`). The pairing was implicit (naming convention `<x>` + `<x>-codex`) and broke silently if any wiring drifted.

The workgroup model formalizes the pairing as a first-class concept with explicit semantics.

---

## Identifier model

Workgroups are identified by a **folder slug** (lowercase letters, digits, hyphens — e.g., `"illysium"`, `"axie-dev"`, `"madison-reed"`).

- `workgroups.id` IS the slug.
- `agent_groups.workgroup_id` references it.

For an agent group whose own folder is `<x>` (e.g., `illysium`), the workgroup id is `<x>`. For a codex twin whose folder is `<x>-codex` (e.g., `illysium-codex`), the workgroup id is the base slug `<x>` (`illysium`) — the same workgroup the Claude twin belongs to. They are siblings sharing one workgroup, not parent/child.

A `CHECK` constraint on `workgroups.id` rejects values matching the opaque `agent_groups.id` shape (`ag-<ts>-<rand>`) — this prevents future code from accidentally conflating the two ID namespaces.

---

## Declaration model

- **Operator-facing source of truth:** `container.json.workgroup_id` (optional field).
- **Runtime canonical:** `agent_groups.workgroup_id` (DB column).
- **Reconciliation:** the host re-reads `container.json` on every container spawn and reconciles the DB column atomically. If the operator changes `container.json.workgroup_id`, the next spawn of any group will propagate the change.

When `container.json.workgroup_id` is omitted, the workgroup defaults to the agent group's own folder slug — i.e., a workgroup-of-1 (functionally identical to today's `'self'` mode).

### Auto-pairing (migration 036)

The migration backfills `workgroup_id` for existing agent_groups via a suffix-strip heuristic:

- For each row whose `folder` ends with `-codex`: strip the `-codex` suffix; if a sibling row exists with that base folder, set both rows' `workgroup_id` to the base folder (paired).
- Orphan codex twins (no matching base-slug sibling) get `workgroup_id = own folder` and are flagged in the backfill report under `suffix_strip_unmatched`.
- All other rows get `workgroup_id = own folder` (standalone).

The backfill report is written to `logs/migration-036.log` for operator inspection.

Future siblings beyond the `<x>-codex` convention (e.g., `<x>-research`, `<x>-data-analyst`) must declare `workgroup_id: "<x>"` explicitly in their `container.json` — the auto-pairing heuristic only handles the codex-twin shape.

---

## What pools vs what stays agent-scoped

The per-agent projection (built by the host at every container spawn) widens **only** the chat archive table. All other central-DB tables stay agent-scoped:

| Table | Pool to workgroup? | Why |
|---|---|---|
| `messages_archive` | **Yes** — workgroup-wide projection | Siblings share chat history (Requirement R2) |
| `backlog_items` | No (agent-scoped) | Each agent has its own todo list |
| `ship_log` | No (agent-scoped) | Each agent's commits are its own activity |
| `tasks` | No (filtered by `parent_agent_group_id` — schema column name; refers to the orchestrating agent) | Dispatch ownership is per-agent |
| `agent_group_capabilities` | No (agent-scoped) | Orchestrator role is per-agent — pooling would silently widen capability |

The structural test at `tests/structural/projection-chokepoint.test.ts` enforces this invariant: any future MCP tool query against `messages_archive` must go through the projection's chokepoint, and the agent-scoped tables retain their in-container `WHERE agent_group_id = ?` filters.

---

## Pooled archive dedup

When sibling agents are wired to the same chat channel, each agent's adapter writes its own copy of every inbound user message into the archive. The workgroup-widened projection deduplicates them via `GROUP BY (messaging_group_id, thread_id, role, sender_id, sent_at, text)`:

- User messages (same `sender_id` = originating user) collapse to one row.
- Assistant messages (`sender_id = agent_group_id`, distinct per sibling) survive as separate rows.

`MIN(id)` picks the surviving row deterministically (stabilizes the FTS index across spawns).

---

## Graphify graph routing

Every workgroup has one derived Graphify database under
`data/graphify/workgroups/<workgroup-id>/index.db`. The daemon resolves group
membership from the central DB and indexes all sibling group roots, the shared
workgroup root, canonical clones, and projected conversation history. Git does
not determine eligibility: tracked, untracked, and gitignored knowledge files
are included unless a narrow `.graphifyignore` rule excludes them.

Containers call Graphify through `ncl`, which derives the workgroup from trusted
session context. Callers cannot supply a cross-workgroup override. A current
thread's managed worktree is admitted only after the host validates that the
session belongs to the same workgroup.

---

## OneCLI secret inheritance

Workgroup-level `onecli_secrets` (stored as a JSON array on the `workgroups` row) are inherited by every member at spawn time. The host computes the spawn-time secret set as a **union** (additive, no subtract):

```
finalSecrets = workgroup.onecli_secrets ∪ container.json.onecliSecrets
```

Per-group declarations can ADD to the workgroup baseline (e.g., a single sibling needs `Datafold-MR`). Per-group declarations cannot SUBTRACT from the baseline — this guards against a sibling silently weakening the shared security posture.

### Populating workgroup-level secrets

Use the operator CLI:

```bash
pnpm exec tsx scripts/set-workgroup-secrets.ts <workgroup-id> --secrets <name1,name2,...>
```

Example:

```bash
pnpm exec tsx scripts/set-workgroup-secrets.ts illysium --secrets "Anthropic,Exa,Datafold-Illysium"
```

The CLI validates every name against the OneCLI vault BEFORE writing. Any unresolvable name causes exit 1 with no DB write — this prevents one bad name from breaking every member's spawn.

### Migration report

The migration writes `logs/migration-036-secrets.log` containing per-workgroup intersections of member `container.json.onecliSecrets` — these are candidate entries that could move up to the workgroup level. Consolidation is a manual operator action (not automated by the migration).

---

## Staleness window

The reconciler runs on every container spawn, but does NOT propagate `container.json.workgroup_id` changes to **already-running** containers. Long-running containers hold their `workgroup_id` from spawn time; operator-edited `container.json` doesn't reach them until they restart.

For typical NanoClaw operation (containers restart frequently or per-session), this is acceptable. For long-running scenarios, restart the container after editing its `container.json.workgroup_id`. A future `/reconcile-workgroups` admin command could force a re-read without spawn — currently out of scope.

---

## Slug-as-PK trade-off

The workgroup primary key is the human-readable folder slug rather than an opaque UUID. This is operator-friendly (you can look at a `workgroups` table and immediately understand the rows) but trades against rename safety: if you rename a workgroup, every reference in `agent_groups.workgroup_id` needs to be updated atomically (cascade UPDATE).

For an install with a fixed set of workgroups (no rename activity), slug-as-PK is the right shape. Industry direction is toward opaque PKs for systems with rename or cross-install share concerns (e.g., GitHub moved from app slugs to `client_id` in 2024). The CHECK constraint on `workgroups.id` (`GLOB '[a-z]*' AND NOT LIKE 'ag-%'`) prevents future opaque-id contamination as a partial defense.

### Migration tripwire

The slug-as-PK choice should be revisited if either of these happens:

1. **First workgroup rename** — at that point, the cost of operating slug-as-PK starts to exceed the benefit. Migrate to opaque PK with `slug` as a `UNIQUE` column.
2. **First cross-install share** — if workgroup definitions are ever shared across NanoClaw installs (e.g., the same `madison-reed` workgroup on multiple machines with potentially conflicting slugs), opaque PK becomes mandatory.

The migration path is well-understood (table rebuild with a new column for the opaque PK + foreign-key cascade update). Not blocked by anything; just deferred until the trade-off changes.

---

## Where things live

| What | Where |
|---|---|
| Schema | `src/db/migrations/036-workgroup-id.ts` |
| Per-agent projection | `src/db/per-agent-projections.ts` (`buildArchiveProjection`, `buildCentralProjection`) |
| Scope resolver | `src/modules/memory/scope-resolver.ts` (`resolveWorkgroupMembers`, `resolveWorkgroupStoreId`) |
| Container config types | `src/container-config.ts` (`RecallScope`, `ContainerConfig.workgroup_id`) |
| Spawn-time reconciler | `src/container-runner.ts` (search for `reconcileWorkgroupAtSpawn`) |
| OneCLI secret merge | `src/onecli-secrets.ts` (`mergeWorkgroupAndGroupSecrets`) |
| FS reconciliation (startup) | `src/modules/workgroup/fs-reconcile.ts` (`reconcileWorkgroupFsState`) |
| Operator CLI | `scripts/set-workgroup-secrets.ts` |
| Structural assertion | `tests/structural/projection-chokepoint.test.ts` |

Specification: `docs/specs/workgroup-scoped-data-layer/` (brief, design, review, plan, decisions).
