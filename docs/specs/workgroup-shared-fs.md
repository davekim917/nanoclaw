# Workgroup Shared Filesystem — "Same House, Own Bedrooms"

> **Archived implementation record — do not execute this rollout.** The
> workgroup filesystem model shipped, but the Mnemon daemon, feature-flag, and
> migration instructions below are superseded. Current memory behavior is
> defined by [the one-canon design](workgroup-memory-and-session-capabilities/design.md)
> and [memory.md](../memory.md).

**Status (2026-05-26):** Phase 1 (mount + migration + tests, `b4b3ce38`) ✅, Phase 2 (mnemon daemon discovery, `7ccc2ce4`) ✅, Phase 3 agent-facing note in `container/CLAUDE.md` ✅. Built behind a default-off flag `NANOCLAW_WORKGROUP_SHARED_FS`; the live-data migration does not fire until the flag is set and the owner enables it after a controlled test.

**Remaining follow-on (does NOT block enabling for the existing 10 workgroups):** update `/clone-as-codex` + `/clone-as-opencode` step 4 to stop creating per-dir relative symlinks and rely on the `/workspace/workgroup` mount. Relevant only for NEW siblings created *after* the flag is enabled (the existing workgroups are handled by the startup migration). The relative symlinks a clone currently creates would, post-migration, resolve to the seed's container-absolute compat symlink — messy but mount-saved; best fixed when the flag is actually enabled, with flag-aware symlink logic. Tracked here.

**Enable sequence (owner-gated):** (1) `sudo systemctl stop nanoclaw-v2`; confirm no `nanoclaw-v2-*` containers running. (2) set `NANOCLAW_WORKGROUP_SHARED_FS=1` in `.env`. (3) `sudo systemctl start nanoclaw-v2` (migration runs against the quiesced FS) **and** `sudo systemctl restart nanoclaw-memory-daemon` (daemon picks up the data/workgroups discovery root). (4) smoke-test per the Verification plan below from a respawned `madison-reed-codex` session.

## Goal (owner's words)
"Everything within a workgroup should be able to be ACCESSED across agents… They all live in the same house but have their own bedrooms for their specific needs." Every member of a workgroup can access everything shared in that workgroup; each keeps a private space.

## Locked decisions (owner)
1. **All members of a workgroup are SIBLINGS — no "primary"/parent.** The shared store must NOT be any one sibling's folder. (`madison-reed` holds the data today only because it was the first sibling created — historical accident.)
2. **Dedicated shared directory per workgroup**, bind-mounted into every member's container at `/workspace/workgroup` (RW). `/workspace/agent` stays private (the bedroom).
3. **Location:** `data/workgroups/<workgroup_id>/` (sibling to `data/v2-sessions/`, `data/v2-threads/`; inherits the `data/*` gitignore so shared work product is never committed).
4. **Shared-vs-private = "substantive set":** migrate every top-level git repo + `sources` + `conversations` + the bug-victim dirs (`dave_ops`, `mr-state-of-data`) into the shared house; new collaborative work defaults there. Loose scratch/secret files (`_tmp_*.json`, `*.ppk`, `*-auth.json`) stay in the bedroom. The per-workgroup set is COMPUTED (every top-level git repo ∪ sources ∪ conversations ∪ the union of dirs any sibling currently symlinks ∪ operator-named extras) — NOT hardcoded to MR's set.
5. **`CLAUDE.local.md`** stays a per-bedroom file (keep current sibling-symlink behavior; lowest risk).
6. **Rollout:** stop containers → restart host (migration runs against quiesced FS) → respawn. Owner-gated, behind the flag.

## Current mechanism (verified, file:line)
- `src/container-runner.ts:1039` — mounts the group's own folder at `/workspace/agent` RW (private today).
- `src/container-runner.ts:1055-1065` — the ONLY cross-sibling sharing today: iterates top-level SYMLINKS in the group folder, `realpathSync` on host, bind-mounts each resolved target at `/workspace/agent/<name>`. Static + curated + inconsistent across siblings = the root bug (a dir created later, like `dave_ops`, is never shared).
- Sibling symlinks created statically by `.claude/skills/clone-as-codex` + `clone-as-opencode` (step 4).
- Startup ordering (`src/index.ts`): `initDb`(154) → `runMigrations`(155) → `reconcileWorkgroupFsState`(162) → `backfillContainerConfigs`(181) → `migrateGroupsToClaudeLocal`(184) → `ensureContainerRuntimeRunning`(187). The new migration hooks **right after 162**, before any container can spawn.
- Migration-home pattern: `src/modules/workgroup/fs-reconcile.ts` `reconcileWorkgroupFsState(db)` — startup-after-migrations, per-workgroup iteration, idempotent, throws→`process.exit(1)` on FS failure. The new `reconcileWorkgroupSharedDirs(db)` mirrors it.

## THE CRITICAL CATCH (mnemon daemon discovery) — do not miss
The memory daemon (`src/memory-daemon/`, systemd `nanoclaw-memory-daemon.service`, in-repo so it ships in the same build) discovers groups by **walking `GROUPS_DIR`** (`memory-daemon/index.ts:34` `discoverMemoryGroups`) and watching each `<group>/sources/inbox` via inotify. It has special symlink-chain handling because siblings' `sources` are symlinks into the seed today.

If `sources/` moves out of `groups/<seed>/` to `data/workgroups/<wg>/sources/`, the daemon (walking `GROUPS_DIR`) **stops finding the inbox → fact ingestion silently dies.** The advisor's proposed *container-absolute* compat symlinks (`groups/<seed>/sources → /workspace/workgroup/sources`) DANGLE on the host, making this worse (broken symlink at discovery).

**Fix:** extend the daemon's discovery to ALSO walk `data/workgroups/*/sources/inbox` (matches its existing dual-root design — `config.ts:26-32` already notes it "walks [CC projects] in addition to GROUPS_DIR"). Mnemon-store semantics preserved: the workgroup already maps to one store (`workgroups.mnemon_store_id`), and a shared inbox funnels all siblings' captures there — the workgroup-is-the-mnemon-boundary model that already exists. **Trace `discoverMemoryGroups` end-to-end before Phase 2 and confirm the watch-root + agentGroupId resolution for the new root.**

## Container reader repoints (Phase 2) — hardcoded `/workspace/agent/...` paths
- `container/agent-runner/src/mcp-tools/memory-capture.ts:7,15` — `/workspace/agent/sources/{inbox,.tmp}` → `/workspace/workgroup/...`
- `container/agent-runner/src/providers/claude.ts:314` — conversation archiver `/workspace/agent/conversations` → `/workspace/workgroup/conversations`; `:674` — extend the `git clone` block to also forbid `/workspace/workgroup`.
- `container/agent-runner/src/mcp-tools/git-worktrees.ts:24,195,244` — `AGENT_DIR` for `clone_repo`/`create_worktree` base; repos are shared, so the repo root becomes `/workspace/workgroup` (worktrees still land in `/workspace/worktrees`, unchanged).
- Path allowlists: `container/agent-runner/src/poll-loop.ts:48-49` + `mcp-tools/core.ts:24-25` — add `/workspace/workgroup`.
- Compat: spawn-time **container-absolute** symlinks `groups/<folder>/<name> → /workspace/workgroup/<name>` for back-compat with muscle-memory `/workspace/agent/<name>` paths (mirror the `.claude-shared.md -> /app/CLAUDE.md` pattern; host `realpathSync` skips them, valid in-container). These are for the CONTAINER only — the host daemon uses the discovery-root extension above, NOT these symlinks.

## Migration algorithm (`reconcileWorkgroupSharedDirs(db)`, gated on the flag)
Per workgroup_id:
1. Resolve seed = `agent_groups` row where `folder == workgroup_id` (where data lives today). `wgDir = data/workgroups/<workgroup_id>/`.
2. Idempotency: if `wgDir/.migrated` exists, skip the workgroup.
3. Compute shared set = (every top-level dir in seed containing `.git/`) ∪ (`sources`,`conversations` if present) ∪ (union of dirs any sibling currently symlinks) ∪ operator extras (`dave_ops`,`mr-state-of-data` for MR). Dedupe.
4. `mkdir -p wgDir`. For each entry: skip if `wgDir/<name>` exists (idempotent/partial-run safe); else `fs.renameSync(groups/<seed>/<name>, wgDir/<name>)` — **detect EXDEV** (different filesystem) and fall back to copy→verify→remove; never half-move. Then drop a container-absolute compat symlink at `groups/<seed>/<name>`.
5. For each non-seed sibling: replace its relative `<name> -> ../<seed>/<name>` symlinks with container-absolute `<name> -> /workspace/workgroup/<name>`; remove now-broken relative symlinks for moved dirs.
6. Write `wgDir/.migrated` (JSON: timestamp, moved entries, seed id) + append `logs/migration-shared-dirs.log`.

**Fail-safe properties:** idempotent (per-entry skip + `.migrated` marker); partial-move safe (atomic rename or copy-verify-remove on EXDEV); live-session safe (runs at startup before `ensureContainerRuntimeRunning`; warm `systemctl restart` must quiesce containers first — owner-gated rollout); symlink-loop safe (container-absolute, no host realpath chains). Pre-flight: `fs.statSync(DATA_DIR).dev === fs.statSync(GROUPS_DIR).dev` to choose rename vs copy.

## Mount change (`container-runner.ts`, Phase 1)
Replace the symlink-overlay loop (1055-1065). When the flag is set: resolve `workgroupId` (from `agent_groups.workgroup_id`, already authoritative this spawn), `wgDir = data/workgroups/<id>/`, `mkdirSync` idempotent, `mounts.push({ hostPath: wgDir, containerPath: '/workspace/workgroup', readonly: false })`. Keep `/workspace/agent` private. When the flag is OFF, keep the existing symlink-overlay loop unchanged (no behavior change until enabled).

## Clone-skill changes (Phase 3)
`/clone-as-codex` + `/clone-as-opencode` step 4: remove the `sources`/`conversations` symlink lines + the `.git/` repo-symlink loop. Sibling gets the shared tree automatically via the `/workspace/workgroup` mount once `workgroup_id` is set. Keep the `CLAUDE.local.md` symlink. Update skill descriptions + `docs/workgroups.md`.

## Interactions NOT to break (verified by advisor)
- Nested RO `container.json`/`CLAUDE.md`/`.claude-fragments` mounts (1067-1099) — mount on `/workspace/agent`, untouched.
- `/workspace/worktrees` thread mount (984-1010) — orthogonal (per-thread git worktrees, not source repos); keep as-is.
- `.claude` mount triple — session-scoped, unrelated.

## Phases
- **Phase 1 (~250 LOC):** mount change (flag-gated) + `reconcileWorkgroupSharedDirs(db)` + index.ts wiring + EXDEV-safe move + compat symlinks + `.migrated` + report log + unit tests. Validates: data moves cleanly, mounts resolve, no live-session corruption.
- **Phase 2 (~150 LOC):** container reader repoints + **mnemon daemon discovery-root extension** + git clone block. Validates: ingest + archive + clone work against `/workspace/workgroup`.
- **Phase 3 (~100 LOC + docs):** clone-skill rewrites + `container/CLAUDE.md` "Shared workspace" section + `docs/workgroups.md`. Remove flag (make default) only after a green controlled test.

## Verification plan (before flipping the flag default)
Stop containers → enable flag → restart host → migration runs against quiesced FS → smoke-test from a respawned `madison-reed-codex` session: `/workspace/workgroup/sources` and a repo readable; `create_worktree({repo})` works; a memory-capture lands in the inbox AND the daemon ingests it (the critical mnemon check); a sibling sees a file another sibling wrote under `/workspace/workgroup`.

## Rollback
Flag OFF + a reverse script reading `.migrated` reports (move dirs back to seed, restore relative sibling symlinks). Migration only renames (never deletes source until verified on EXDEV-copy), so data is recoverable at every step.
