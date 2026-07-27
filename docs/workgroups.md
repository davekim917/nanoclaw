# Workgroups

A **workgroup** is a tenant-level grouping that contains one or more `agent_groups`. It is the data-pool boundary for:

- **Chat archive** — sibling agents in a workgroup can read each other's archived chat history via the existing `resolve_thread_link` / `search_threads` / `read_thread` MCP tools.
- **Durable memory** — siblings read and edit one canonical Markdown tree and receive workgroup-wide recall before every admissible turn.
- **Graphify knowledge retrieval** — members may query one advisory graph over shared files, repositories, and conversations.
- **OneCLI secret declarations** — workgroup-level secrets are inherited by all member agent_groups at container spawn time.

Sibling `agent_groups` (e.g., a Claude twin + a Codex twin, plus future siblings like `<x>-research` or `<x>-data-analyst`) are peers — each remains a separate row in the database with its own platform bot user, CLAUDE.md, container, and routing identity. No sibling is a parent of another; the workgroup is the layer **above** them, not a collapse and not a hierarchy.

---

## Why workgroups exist

NanoClaw's sibling-agent architecture requires per-agent bot identity for native `@`-mentions on Slack and Discord. But the data layer was scoped per `agent_group_id`, so siblings could not see each other's chat history, knowledge graph, or shared credentials.

Before workgroups, this was patched up implicitly via scattered symlinks (`CLAUDE.local.md`, `sources/`, `conversations/`). The pairing was implicit (naming convention `<x>` + `<x>-codex`) and broke silently if any wiring drifted.

The workgroup model formalizes the pairing as a first-class concept with explicit semantics.

---

## Shared memory, background capture, and pre-turn context

The single memory authority for a workgroup is
`data/workgroups/<workgroup-id>/memory`. Containers mount it at
`/workspace/workgroup/memory`; `/workspace/agent/memory` and recognized
provider-native paths are compatibility views of the same files, not
authorities.

Use `write_memory_file` for direct Markdown edits. Its expected SHA-256 check
and atomic replacement prevent a sibling from silently overwriting an edit made
after it last read the file. Treat raw provider-native projections as
read-only. Ordinary same-file raw shell writes retain normal filesystem
last-writer semantics and are an explicit operator escape hatch.

When automatic curation is enabled, all siblings also feed one durable
workgroup episode queue in `data/archive.db`. After an idle debounce, one host
worker selectively writes only
`data/workgroups/<workgroup-id>/memory/generated/memory.md`. Claude, Codex, and
OpenCode therefore generate and recall from the same automatic-memory canon;
there is no provider-specific generated store. Imported/manual files remain
protected, failed jobs retain their cursor, and fixed admission limits leave
excess work queued rather than dropping it.

Before every admissible turn, the host supplies actual session capabilities,
canonical memory, same-thread evidence, workgroup-wide archive recall, and
exact Slack/Discord permalink provenance. Missing or failed sources produce an
explicit degraded notice; they never broaden the workgroup boundary. Graphify
is advisory rather than a memory authority, but agents must use it on demand
when a task depends on code, architecture, requirements, prior decisions, or
cross-artifact lineage. It is not a prerequisite for basic first-response
memory recall.

Provider identity, instructions, configuration, continuation state, and all
non-memory customizations remain sibling-scoped. Sharing memory does not merge
bots, sessions, worktrees, routing identity, permissions, or credentials.

---

## Identifier model

Workgroups are identified by a **folder slug** (lowercase letters, digits, hyphens — e.g., `"example-labs"`, `"example-dev"`, `"example-retail"`).

- `workgroups.id` IS the slug.
- `agent_groups.workgroup_id` references it.

For an agent group whose own folder is `<x>` (e.g., `example-labs`), the workgroup id is `<x>`. For a codex twin whose folder is `<x>-codex` (e.g., `example-labs-codex`), the workgroup id is the base slug `<x>` (`example-labs`) — the same workgroup the Claude twin belongs to. They are siblings sharing one workgroup, not parent/child.

A `CHECK` constraint on `workgroups.id` rejects values matching the opaque `agent_groups.id` shape (`ag-<ts>-<rand>`) — this prevents future code from accidentally conflating the two ID namespaces.

---

## Declaration model

- **Operator-facing source of truth:** `container.json.workgroup_id` (optional field).
- **Runtime canonical:** `agent_groups.workgroup_id` (DB column).
- **Reconciliation:** the host re-reads `container.json` on every container spawn and reconciles the DB column atomically. An explicit `container.json.workgroup_id` replaces the current DB assignment.

Omitting `container.json.workgroup_id` preserves an existing non-null DB
assignment, including sibling pairings created by migration 036. Only a group
with neither an explicit config value nor an existing DB assignment defaults to
its own folder slug as a workgroup-of-1. To intentionally unpair an existing
member, set `container.json.workgroup_id` explicitly to that member's own folder
slug and restart its containers; removing the field does not unpair it.

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

| Table                      | Pool to workgroup?                                                                               | Why                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `messages_archive`         | **Yes** — workgroup-wide projection                                                              | Siblings share chat history (Requirement R2)                             |
| `backlog_items`            | No (agent-scoped)                                                                                | Each agent has its own todo list                                         |
| `ship_log`                 | No (agent-scoped)                                                                                | Each agent's commits are its own activity                                |
| `tasks`                    | No (filtered by `parent_agent_group_id` — schema column name; refers to the orchestrating agent) | Dispatch ownership is per-agent                                          |
| `agent_group_capabilities` | No (agent-scoped)                                                                                | Orchestrator role is per-agent — pooling would silently widen capability |

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
session belongs to the same workgroup. Graphify output is optional and
advisory. Canonical Markdown and exact archive provenance remain authoritative.

---

## OneCLI secret inheritance

Workgroup-level `onecli_secrets` (stored as a JSON array on the `workgroups` row) are inherited by every member at spawn time. The host computes the spawn-time secret set as a **union** (additive, no subtract):

```
finalSecrets = workgroup.onecli_secrets ∪ container.json.onecliSecrets
```

Per-group declarations can ADD to the workgroup baseline (e.g., a single sibling needs `Datafold-Example-Retail`). Per-group declarations cannot SUBTRACT from the baseline — this guards against a sibling silently weakening the shared security posture.

### Populating workgroup-level secrets

Use the operator CLI:

```bash
pnpm exec tsx scripts/set-workgroup-secrets.ts <workgroup-id> --secrets <name1,name2,...>
```

Example:

```bash
pnpm exec tsx scripts/set-workgroup-secrets.ts example-labs --secrets "Anthropic,Exa,Datafold-Example Labs"
```

The CLI validates every name against the OneCLI vault BEFORE writing. Any unresolvable name causes exit 1 with no DB write — this prevents one bad name from breaking every member's spawn.

### Migration report

The migration writes `logs/migration-036-secrets.log` containing per-workgroup intersections of member `container.json.onecliSecrets` — these are candidate entries that could move up to the workgroup level. Consolidation is a manual operator action (not automated by the migration).

---

## Staleness window

The reconciler runs on every container spawn, but does NOT propagate explicit
`container.json.workgroup_id` changes to **already-running** containers.
Long-running containers hold their `workgroup_id` from spawn time;
operator-edited `container.json` doesn't reach them until they restart. Removing
the field is not a change request: it preserves the current DB assignment.

For typical NanoClaw operation (containers restart frequently or per-session), this is acceptable. For long-running scenarios, restart the container after editing its `container.json.workgroup_id`. A future `/reconcile-workgroups` admin command could force a re-read without spawn — currently out of scope.

---

## Slug-as-PK trade-off

The workgroup primary key is the human-readable folder slug rather than an opaque UUID. This is operator-friendly (you can look at a `workgroups` table and immediately understand the rows) but trades against rename safety: if you rename a workgroup, every reference in `agent_groups.workgroup_id` needs to be updated atomically (cascade UPDATE).

For an install with a fixed set of workgroups (no rename activity), slug-as-PK is the right shape. Industry direction is toward opaque PKs for systems with rename or cross-install share concerns (e.g., GitHub moved from app slugs to `client_id` in 2024). The CHECK constraint on `workgroups.id` (`GLOB '[a-z]*' AND NOT LIKE 'ag-%'`) prevents future opaque-id contamination as a partial defense.

### Migration tripwire

The slug-as-PK choice should be revisited if either of these happens:

1. **First workgroup rename** — at that point, the cost of operating slug-as-PK starts to exceed the benefit. Migrate to opaque PK with `slug` as a `UNIQUE` column.
2. **First cross-install share** — if workgroup definitions are ever shared across NanoClaw installs (e.g., the same `example-retail` workgroup on multiple machines with potentially conflicting slugs), opaque PK becomes mandatory.

The migration path is well-understood (table rebuild with a new column for the opaque PK + foreign-key cascade update). Not blocked by anything; just deferred until the trade-off changes.

---

## Where things live

| What                                 | Where                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| Schema                               | `src/db/migrations/036-workgroup-id.ts`                                                   |
| Per-agent projection                 | `src/db/per-agent-projections.ts` (`buildArchiveProjection`, `buildCentralProjection`)    |
| Trusted pre-turn scope and recall    | `src/modules/memory/pre-turn-context.ts` (`buildPreTurnContext`)                          |
| Container config types               | `src/container-config.ts` (`ContainerConfig.workgroup_id`)                                |
| Spawn-time reconciler                | `src/container-runner.ts` (search for `reconcileWorkgroupAtSpawn`)                        |
| OneCLI secret merge                  | `src/onecli-secrets.ts` (`mergeWorkgroupAndGroupSecrets`)                                 |
| FS reconciliation (startup)          | `src/modules/workgroup/fs-reconcile.ts` (`reconcileWorkgroupFsState`)                     |
| Memory canon and compatibility views | `src/modules/workgroup/shared-dirs.ts` (`workgroupMemoryDir`, `reconcileWorkgroupMemory`) |
| Operator CLI                         | `scripts/set-workgroup-secrets.ts`                                                        |
| Structural assertion                 | `tests/structural/projection-chokepoint.test.ts`                                          |

Current memory contract:
`docs/specs/workgroup-memory-and-session-capabilities/design.md`. The original
workgroup entity-model history remains under
`docs/specs/workgroup-scoped-data-layer/`.
