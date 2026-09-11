# Workgroups

A **workgroup** is a tenant-level grouping that contains one or more `agent_groups`. It is the data-pool boundary for:

- **Chat archive** — sibling agents in a workgroup can read each other's archived chat history via the existing `resolve_thread_link` / `search_threads` / `read_thread` MCP tools.
- **Durable memory** — siblings read and edit one canonical Markdown tree and receive workgroup-wide recall before every admissible turn.
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

`data/workgroups/<workgroup-id>/memory/generated/memory.md` is a shared
read-only artifact of the removed background curator. Claude, Codex, and
OpenCode all recall from it; there is no provider-specific generated store, and
nothing writes it any more.

Before every admissible turn, the host supplies actual session capabilities,
canonical memory, same-thread evidence, workgroup-wide archive recall, and
exact Slack/Discord permalink provenance. Missing or failed sources produce an
explicit degraded notice; they never broaden the workgroup boundary.

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

## Cross-workgroup read grants

Workgroups remain isolated unless the host operator declares a bounded,
read-only cross-workgroup policy. The grant is workgroup-scoped, so every
provider sibling receives the same access at its next spawn. See
[Cross-workgroup read access](workgroup-read-access.md) for the policy schema,
mounted paths, activation, and rollback.

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

### Attention sources pool too — and so do the items they produce

`workgroups.attention_sources` (migration 057) is declared on the **workgroup** row, and the files it points at live under `groups/<workgroup>/<root>`. Both sides of that are workgroup data by the same rule as the shared files around them, so the items read out of it pool as well.

| Table / source                 | Pool to workgroup?                       | Why                                                             |
| ------------------------------ | ---------------------------------------- | --------------------------------------------------------------- |
| `workgroups.attention_sources` | **Yes** — the column is on the workgroup | The declared root is a directory in the shared workgroup folder |

The consequence is worth stating outright, because it is coarser than every other row on the Observatory's thread endpoint: **a caller entitled to any ONE agent group in a workgroup sees every attention item that workgroup declares.** An attention item is ownerless by construction — that is what makes it an attention item — so it carries no `agent_group_id` to filter on, and there is nothing finer to gate against without inventing an owner.

The reader that enforces the other half of this boundary is `readReleaseBoardSource` (`src/dashboard/api/board-attention.ts`): the declared `root` is resolved through symlinks and checked to still be inside `groups/<workgroup>/` before anything is read, because that directory is bind-mounted read-write into the workgroup's own containers. Pooling **within** a workgroup is the design; reading **across** two of them is not.

Full rule and rationale: [observatory-console/DESIGN.md §3.6](specs/observatory-console/DESIGN.md).

---

## Pooled archive dedup

When sibling agents are wired to the same chat channel, each agent's adapter writes its own copy of every inbound user message into the archive. The workgroup-widened projection deduplicates them via `GROUP BY (messaging_group_id, thread_id, role, sender_id, sent_at, text)`:

- User messages (same `sender_id` = originating user) collapse to one row.
- Assistant messages (`sender_id = agent_group_id`, distinct per sibling) survive as separate rows.

`MIN(id)` picks the surviving row deterministically (stabilizes the FTS index across spawns).

A projection extended in place rather than rebuilt (`appendArchiveProjection`, #360) reproduces this exactly. A sibling's duplicate arriving in a later batch is merged into the row already projected, not discarded: `id` and `created_at` take the lower value, `channel_type`, `channel_name`, `platform_id` and `sender_name` the higher, so the result matches a full build including ids. The merge uses NULL-safe comparisons, because SQLite's two-argument scalar `min()`/`max()` return NULL if either argument is NULL while the aggregates used by the full build skip NULLs.

---

## Canonical repositories and topic worktrees

Each `(workgroup, repository)` has one host-owned normal clone at
`data/repositories/<workgroup>/<repo>`. Its working tree is never mounted into
agent containers; host tooling reads that clean tree directly.

Each conversation topic keeps its checkouts under
`data/v2-topics/<workgroup>/<work-unit>/worktrees/`, mounted at
`/workspace/worktrees/`. `<repo>` is the thread's primary checkout. In `clone`
mode, `<repo>@<slug>` holds any other branch the thread asks for
(`create_worktree` with `branch`), so threads never contend for one shared
checkout; in `worktree` mode a thread keeps one checkout per repository, and a
request for another branch is refused. Sibling
agents in the same topic resolve the same work-unit and checkouts. Different
topics have distinct paths, branches, indexes, and Git admin directories.
Existing checkouts are never automatically rebased, branch-switched, or reset,
and a checkout no longer on the branch it was created for is refused, not
reused.

`NANOCLAW_CHECKOUT_MODE` decides how a NEW checkout is made. `worktree` (the
default) makes a standard linked worktree of the canonical, as before. `clone`
has the host build an independent clone (`repository_checkout`): it hardlinks
the canonical's objects, is built in a staging dir beside `worktrees/` that no
container mounts, and appears with one rename only once fully initialized.
With `NANOCLAW_DEPENDENCY_CACHE=apply`, each package dir whose lockfile has a
verified cache entry holding every package npm would install on this platform
gets a shared read-only `node_modules` farm; any other gets none, and `npm ci`
makes a private copy. `clone` needs containers that run as the host uid and is
refused, with a WARN when first
used, otherwise. Resolution is shape-aware in
both modes, so switching back to `worktree` strands no clone. Worktree cleanup
collects an idle clone only after proving that the commits of every local ref,
HEAD and the stash are already on `origin`.

Containers fetch with their scoped OneCLI identity. The host never performs a
credentialed Git network operation: it publishes validated local clones and
advances a clean canonical only from refs already fetched into its mounted Git
metadata. One stable host lock inode serializes create/fetch, refresh, transfer,
cleanup, and maintenance. Origin pins and transfer tombstones live in
`data/repository-state/<workgroup>/<repo>` and are not agent-writable.

`repository_publish`, `repository_transfer` and `repository_refresh` are handled
off the serial outbound-delivery drain (`src/modules/repository-workspaces/job-runner.ts`):
the delivery loop acks the row and one global FIFO chain runs the action, so no
other session's messages queue behind a publication. That is what lets the mount
quiescence wait `NANOCLAW_REPOSITORY_QUIESCE_TIMEOUT_MS` (default 600000, ten
minutes) for sibling containers to reach a safe point before it kills them;
every other `quiesceSessionsForRepositoryMounts` caller keeps the 120s default.
Each action gets one attempt per host process — a retry would re-fence and
re-kill every sibling — and a host that dies mid-action replays it on the next
start, because the undelivered `messages_out` row is the durable record.

`scripts/migrate-repo-store.ts` inventories legacy clones, mirrors, and collided
worktrees read-only by default. `--execute --quiesced` is accepted only with a
stopped service, zero install containers, no repository writers, and a passing
allocated-byte capacity gate. It keeps hash-bound manifests, synthetic rescue
refs, external bundles, and the complete old topology in host-only migration
storage through audit and rollback retention.

---

## Per-agent Git identity

An agent group may declare its Git author and committer identity in that
agent's `groups/<agent-folder>/container.json`:

```json
{
  "gitIdentity": {
    "name": "Example Build Agent",
    "email": "example-build-agent@example.invalid"
  }
}
```

`name` and `email` are an all-or-nothing pair. The host supplies both author
and committer variables on that agent's next spawn, so ordinary Git commands
and the built-in `git_commit` MCP tool record the same identity. Omit the field
to preserve the existing `credentialFolder`-scoped Git variables, including
their behavior through the built-in MCP tool.

This is agent-scoped rather than workgroup-scoped. To enable it only for one
workgroup, add the field only to the intended agents' files; every other
workgroup keeps its current identity behavior. Git signing is separate and is
not configured by this field.

The host snapshots runner source at boot, and a container receives its Git
environment at spawn. After adding support or changing this field, restart the
host to refresh the runner snapshot, then recycle the affected containers or
allow fresh spawns; a host restart can preserve running containers.

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
