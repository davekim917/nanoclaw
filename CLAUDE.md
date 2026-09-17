# ⚠️ STOP — READ THIS FIRST IF YOU ARE CLAUDE ⚠️

**A `git pull`/`merge` from upstream that produces conflicts or a large diff touching this file → HALT.** NanoClaw v2 is a ground-up rewrite with breaking changes throughout; it cannot be merged into a v1 install by hand. Resolving conflicts or running builds corrupts the install.

1. `git merge --abort` (or `git reset --hard ORIG_HEAD` if the merge already completed).
2. Tell the user, verbatim: *"This is the v2 rewrite — it can't be merged into your existing install. Exit Claude Code (or open a separate terminal) and run `bash migrate-v2.sh` from the shell."*
3. Wait for confirmation. Don't run the migration script yourself — it needs an interactive terminal, not Claude Code.

Fresh install (`git clone`, no conflicts) → ignore this banner, continue below.

---

# NanoClaw

Personal AI assistant. See [README.md](README.md) for philosophy and setup. Architecture lives in `docs/`.

## Quick Context

The host is a single Node process orchestrating per-session agent containers. Platform messages land via channel adapters, route through an entity model (users → messaging groups → agent groups → sessions), and get written into the session's inbound DB, waking a container. The agent-runner polls the DB, calls the agent, and writes back to the outbound DB; the host polls that and delivers through the same adapter.

**Everything is a message.** There is no IPC, no file watcher, no stdin piping between host and container. The two session DBs are the sole IO surface.

## Entity Model

`workgroups → agent_groups ⇄ messaging_groups → sessions` (many-to-many via `messaging_group_agents`); `users → user_roles` (owner|admin, global or scoped) `+ agent_group_members`.

A messaging_group is one chat/channel on one platform; an agent_group is one agent identity; a session is the (agent_group, messaging_group, thread) triple owning a container. Easy to get wrong:

- **Privilege is user-level, not agent-group-level** — owner/admin live on `user_roles`. [docs/isolation-model.md](docs/isolation-model.md)
- **Siblings share a workgroup, they don't collapse into one** — the data-pool boundary (chat archive, shared files, OneCLI secrets); each keeps its own bot user, CLAUDE.md, routing identity, engage rules. [docs/workgroups.md](docs/workgroups.md)

Full schema: [docs/db-central.md](docs/db-central.md)

## Databases

Each session has **two** SQLite files under `data/v2-sessions/<session_id>/`: `inbound.db` (host writes, container reads) and `outbound.db` (container writes, host reads) — one writer per file, no cross-mount lock contention. Heartbeat is a file touch at `/workspace/.heartbeat`, not a DB update; host uses even `seq` numbers, container odd. [docs/db-session.md](docs/db-session.md)

`data/v2.db` holds everything that isn't per-session (migrations: `src/db/migrations/`). For ad-hoc queries use `pnpm exec tsx scripts/q.ts <db> "<sql>"`, not the `sqlite3` CLI (setup avoids that binary, `setup/verify.ts:5`; the wrapper uses the installed `better-sqlite3`). [docs/db-central.md](docs/db-central.md)

## Key Files

Most of `src/` is discoverable by reading it. These are the ones you would not guess:

- **`src/guard/`** — the privileged-action decision seam: `guard(action, input)` → allow | hold | deny. `ncl`/delivery actions *demand* a guard at registration; approved replays re-run checks with the approval row as a grant.
- **`src/host-sweep.ts`** — one 60s sweep owns `processing_ack` sync, stale detection, due-message wake, recurrence, ceiling-kill accountability. Anything "on a timer" happens here.
- **`src/router.ts` → `src/delivery.ts`** — the two ends of the message path; everything else hangs off them.
- **`scripts/vendor-design-artifact-loop.ts`** — the design-artifact-loop skill and `design_review` engine are **vendored** from `~/plugins/design-artifact-loop` (develop there, not in-tree); `src/design-artifact-loop-vendor.test.ts` fails on drift.
- **`container/agents/`** — trunk ships **no** worker subagent def. Delegation roles live in the bootstrap orchestrate plugin (`~/plugins/bootstrap/plugins/orchestrate/agents/`) and reach a container through the plugin mount, not through `syncWorkerAgentDefs`. That function still runs, to prune retired defs already in a group's `.claude-shared/agents/` — `MANAGED_WORKER_DEFS` in `src/container-runner.ts` is the only list that removes them.
- **`src/group-init.ts`** — the agent-runner source is a boot snapshot (`src/agent-runner-source.ts`) mounted read-only for every group; edits take effect at the next host restart, not the next spawn.

## Admin CLI (`ncl`)

Queries/modifies the central DB — agent groups, messaging groups, wirings, users, roles, tasks. Host: Unix socket (`src/cli/socket-server.ts`). Container: session-DB transport (`container/agent-runner/src/cli/ncl.ts`). `ncl help` / `ncl <resource> help` are generated from the registry; don't mirror them here.

## Channels and Providers (skill-installed)

Trunk ships no channel adapter or non-default agent provider — those live on long-lived sibling branches (`channels`, `providers`), copied in by idempotent `/add-<name>` skills. Channel skills carry the install steps as `nc:` directive fences, applied via the engine (`scripts/skill-apply.ts`) at setup or as prose by an agent — same install either way. [docs/skill-directives.md](docs/skill-directives.md)

**Channel defaults** are exactly two levels — the adapter's `ChannelDefaults` declaration and the per-wiring override at creation, no per-instance DB config table. A stale/undeclared adapter falls back to behavior-faithful defaults, so a trunk update alone changes nothing. [docs/api-details.md](docs/api-details.md#channel-defaults)

## Self-Modification

`install_packages`/`add_mcp_server` edit an agent group's container config (deps, MCP wiring) behind a single admin approval; `src/modules/self-mod/apply.ts` rebuilds the image if needed and respawns via `on_wake` (race semantics under Container Restart). A second tier (source-level self-edits via draft/activate) is planned, not built. `container/agent-runner/src/mcp-tools/self-mod.ts`

## Container Config

Per-agent-group container runtime config (provider, model, packages, MCP servers, mounts) is split across two stores. `groups/<folder>/container.json` is authoritative: the spawn path reads it (`readContainerConfig`), bind-mounts it read-only, and the runner reads `provider`/`model`/`effort` from it — no DB→file materialization at spawn, only identity fields (`agentGroupId`, `groupName`) sync (`configFromDb()` exists, no callers). `container_configs` (central DB) is a read-side projection for `-m`/`-e` flag vocabulary, scheduled-task validation, and image builds.

`ncl groups config get/update` and the self-mod MCP tools manage both: `config update` writes `provider`/`model`/`effort` to the DB row *and* mirrors them into `container.json`, so a provider change takes effect next restart — writing only the DB row leaves the container booting its old provider.

**`cli_scope`** controls what the agent can do with `ncl` in-container:

| Value | Behavior |
|-------|----------|
| `disabled` | Agent never learns about ncl (excluded from CLAUDE.md); host rejects any `cli_request`. |
| `group` (default) | Scoped to own agent group (`groups`, `sessions`, `destinations`, `members`, `tasks`); `--id` auto-filled; cross-group access rejected; `cli_scope` changes blocked. |
| `global` | Unrestricted. Set only by `scripts/init-first-agent.ts --role owner` — not implied by ownership; zero `global` groups is valid and tighter-than-default, never a drift to "fix" by widening. |

## Container Restart

`ncl groups restart --id <group-id> [--rebuild] [--message <text>]`. With `--message` the host writes an `on_wake` row and respawns via `onExit`; without one, the container waits for the next message. In-container, `--id` auto-fills and only the calling session restarts.

**`on_wake` closes a race**: only picked up on a fresh container's *first* poll, so a dying container still in its SIGTERM grace period can't steal it — `killContainer`'s `onExit` guarantees the old process is gone first. **Ceiling kills are accounted for publicly**: the 30-min idle ceiling (`ABSOLUTE_CEILING_MS`) killing resumable work queues a deferred `ceiling-respawn-*` wake; the fresh container must post done/lost/next (narration is never recovery evidence), capped at `WORK_CONTINUATION_RESUME_MAX_ATTEMPTS` (2) — `decideCeilingFollowUp` in `src/host-sweep.ts`. `continue_work({ task })` (`session_state.work_continuation`, chain cap 50) is the only sanctioned way to promise follow-up — future-tense prose has no control effect; full semantics: [docs/agent-runner-details.md](docs/agent-runner-details.md). `wait` wakes in-thread, same session; `ncl tasks` runs isolated. Host restarts stop install-labeled containers; fresh-work sessions get a deduped `host-restart-*` note (`src/host-restart-warn.ts`).

## Secrets / Credentials / OneCLI

Secrets live in the OneCLI gateway, injected per-request at the proxy boundary — never env vars, chat, or on-disk. `src/onecli-secrets.ts`, `container/skills/onecli-gateway/SKILL.md`.

**Remote MCP servers use OAuth, not a pasted key**: `ncl integrations login|complete|list|remove` runs MCP authorization (discovery → dynamic client registration → PKCE authorization-code), writes the access token into the group's bearer secret, and a sweep duty keeps it fresh. The refresh token is host-side (`data/mcp-oauth/`, 0600) because OneCLI secret values are **write-only** — `PATCH /api/secrets/{id}` exists, no read route does. [docs/mcp-oauth-integrations.md](docs/mcp-oauth-integrations.md)

**Fail-closed, declarative scoping**: `container.json`'s `onecliSecrets` (names/UUIDs) resolves and assigns on every spawn; an unresolvable name aborts the spawn (sweep retries). Workgroup secrets merge as a union with per-group additions — extend only, never subtract. [docs/workgroups.md](docs/workgroups.md) **Gotcha — auto-created agents default to `selective` mode with nothing assigned**: symptom is a `401` from an API whose credential *is* in the vault; fix is declaring `onecliSecrets` above, or `onecli agents set-secrets` / `set-secret-mode --mode all` (looser). Verified against `onecli@1.4.1`. Approval gating is two-sided — a configured gateway rule with no host callback running hangs every credentialed call until timeout.

## Skills

Four types — channel/provider installers, utility skills that ship code, instruction-only operational skills, container skills mounted into agent sessions. Taxonomy: [CONTRIBUTING.md](CONTRIBUTING.md); authoring checklist: [docs/skill-guidelines.md](docs/skill-guidelines.md). Descriptions are the discovery mechanism — run `/help` or read `.claude/skills/*/SKILL.md` and `container/skills/*/SKILL.md`, not a list here.

## Contributing & PR Hygiene

Before a PR, a skill, or any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md) (change types, skill guidelines, `SKILL.md` format, pre-submission checklist). Before a PR **to upstream** (`nanocoai/nanoclaw`): run `git diff upstream/main --stat HEAD` and `git log upstream/main..HEAD --oneline`, show the output, wait for approval — that diff is what upstream would receive. Fork-internal PRs don't need it; the ratchet already reports divergence. Installation-specific files (group files, `.claude/settings.json`, local configs) should not be included.

**Cite the line when you assert another module's behaviour.** A comment or a branch that rests on how some other module behaves — what a predicate returns for a missing file, whether a subclass overrides a method, what an existence check keys on — must name the `file:line` you read. An uncited behavioural claim is a guess wearing a fact's clothes, and it does not fail loudly: it produces code that looks right, a comment that explains it confidently, and a test oracle that paraphrases the same wrong belief and passes. PR #583 spent four review rounds on one such premise (`dbHasRows` short-circuits an absent path to `false` on its first line; it was believed to answer `null`). Two cheap habits prevent it — read the whole declaration, since guard clauses live on the first lines, and `grep override` before asserting what a method does.

Any change to an upstream-owned file must regenerate `src/upstream-ratchet.json` (`pnpm run ratchet:report -- --write`); growth needs `--accept` and a reason in the PR body.

## Development

Run commands directly — don't tell the user to run them.

```bash
# Host (Node + pnpm)
pnpm run dev          # tsx, no watch
pnpm run build        # compile src/
./container/build.sh  # rebuild nanoclaw-agent:latest
pnpm test             # vitest

# Agent-runner (Bun — separate package tree)
cd container/agent-runner && bun install   # after editing deps
cd container/agent-runner && bun run test  # bun:test + hermeticity
```

Container typecheck is a separate tsconfig — after editing `container/agent-runner/src/`, run `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` (or `bun run typecheck` from that dir).

Service management: the host runs as a **system** unit, `nanoclaw-v2.service` — `sudo systemctl start|stop|restart nanoclaw-v2`. There is no `--user` unit; `systemctl --user` finds nothing.

## Module System (host)

Host (`src/`) is ESM. Never use `require()` — `@typescript-eslint/no-require-imports` disables hide a runtime trap: `require` is undefined in built ESM, so the call typechecks but throws/returns null at runtime. For circular imports use `await import('./mod.js')`. Agent-runner (`container/agent-runner/`) is a separate Bun package tree; this rule is host-only.

## Troubleshooting

Check these first when something goes wrong:

| What | Where |
|------|-------|
| Host logs | `logs/nanoclaw.error.log` first (failures, crash-loop backoff, warnings), then `logs/nanoclaw.log` for the full chain |
| Setup logs | `logs/setup.log` (overall), `logs/setup-steps/*.log` (per-step) |
| Session DBs | `data/v2-sessions/<agent-group>/<session>/` — `inbound.db`/`messages_in` (reached container?), `outbound.db`/`messages_out` (agent responded?) |
| Post-restart health | `grep 'OneCLI preflight ok' logs/nanoclaw.log` — adapter counts are not proof; a host that cannot reach the OneCLI control API refuses every spawn at WARN |

Host logs rotate daily via `/etc/logrotate.d/<systemd-unit-name>` (30 days) with `copytruncate` — required: systemd holds the `StandardOutput=append:` redirect open, so rename-based rotation leaves the daemon writing to an unlinked file until restart. Container logs vanish on exit (`--rm`); a silent in-container failure leaves nothing to inspect.

## Timestamps

Two rules, no exceptions:

- **Storage**: every timestamp written from JS is `new Date().toISOString()` (ISO-8601 UTC, `Z`). Never `datetime('now')`: its naive `YYYY-MM-DD HH:MM:SS` parses as local time in `new Date()` and breaks string comparisons against ISO values. Pure SQL uses `strftime('%Y-%m-%dT%H:%M:%fZ','now')`; SQL comparisons wrap both sides in `datetime()`.
- **Display**: anything shown to an agent or user renders in the install timezone via `formatLocalTime`/`formatLocalStamp` (`src/timezone.ts`, runner `timezone.ts`); `--json`, DB values and setup logs (`logs/setup.log`, `logs/setup-steps/`) stay ISO. Host log lines (`logs/nanoclaw*.log`) are stamped in the host process's local time — its `TZ` env, else `/etc/localtime` — with no offset marker (`ts()`, `src/log.ts`); that zone can differ from the install timezone, so convert a UTC window before grepping, or the grep matches nothing and reads as clean.

An agent group can override the install timezone: `ncl groups config update --timezone <IANA>` (`""` clears). The value is validated against the zone database on disk (`/usr/share/zoneinfo`) and stored verbatim, because the container opens it as a case-sensitive POSIX `TZ` path. Validation FAILS CLOSED: fixed offsets, abbreviations, wrong case, and retired aliases are all refused, and on a host with no zone database no override is honoured at all. ICU is never the fallback authority — it maps `Asia/Kolkata` onto `Asia/Calcutta`, whose backward-link file current tzdata omits, so `TZ=Asia/Calcutta` silently yields +0000. The override grounds that group's scheduling — cron interpretation, `--process-after`, run-log stamps — and the container's `TZ` env (on respawn, read from `container.json`). **An already-armed occurrence keeps the absolute instant it was armed at**: a live series moves onto the new grid at its next re-arm, so a daily task can fire once more at the old local time. Tasks created or edited after the change use the new zone right away. Operator-facing host display (`ncl` human output, dashboard rendering) stays in the install timezone. Every caller that needs a group's timezone — scheduling, recurrence, dashboard assembly, host-gated task scripts, the operator scripts under `scripts/` — goes through the one resolver, `resolveGroupTimezone` in `src/container-config.ts`; the spawn path shares its predicate as `effectiveTimezone` because it holds the `container.json` value rather than a group id.

## Supply Chain Security (pnpm)

Tracks latest stable, including majors; prerelease/beta/RC/dev/nightly/draft/yanked/source-only/target-incompatible releases are rejected, no release-age delay. Flow: [docs/dependency-updates.md](docs/dependency-updates.md).

**Do not bypass without explicit human approval:**
- **`allowBuilds`**: never add/enable packages here without approval — build scripts execute arbitrary code during install.
- **`pnpm install --frozen-lockfile`** in CI/automation/container builds — never bare `pnpm install` there.
- **Exact resolution**: commit manifests with regenerated lockfiles; Docker/runtime tools stay exact-pinned; registry failure is `unknown`, never "current."

## Docs Index

`docs/` holds the long-form reference. Start points:

| Topic | Doc |
|---|---|
| Architecture | `architecture.md`, `architecture-diagram.md` |
| DB model | `db.md` → `db-central.md`, `db-session.md` |
| Host API | `api-details.md` |
| Agent-runner, MCP tools | `agent-runner-details.md` |
| Isolation levels | `isolation-model.md` |
| Workgroups | `workgroups.md` |
| Skills | `skills-model.md`, `skill-guidelines.md`, `skill-directives.md`, `skill-engine-seam.md` |
| Runtime, CI | `build-and-runtime.md` |
| Dependency updates | `dependency-updates.md` |
| Remote MCP OAuth | `mcp-oauth-integrations.md` |
| v1→v2 migration | `v1-to-v2-changes.md`, `migration-dev.md` |
| Provider switching | `provider-migration.md` |
| Templates | `templates.md` |
| Memory | `memory.md` |
| Setup, customizing | `setup-wiring.md`, `customizing.md` |
| Directive audit | `always-on-directive-classification.md`, `always-on-directive-baseline.md` |
| Agent mailbox seam | `docs/specs/upstream-mailbox-seam/plan.md` §5 (upstream doc = end state) |
| Upstream divergence ratchet | `upstream-ratchet.md` |

## Container Runtime (Bun)

Agent container: **Bun**. Host: **Node**/pnpm — no shared modules, only session DBs. Buildkit caches the build context aggressively — `--no-cache` alone does NOT invalidate COPY steps; prune the builder, then re-run `./container/build.sh`.

Full gotcha list (`bun:test` vs vitest, pinned global CLIs, Dockerfile entrypoint): [docs/build-and-runtime.md](docs/build-and-runtime.md). Three silent-failure traps worth repeating:

- **`container/agent-runner/` is not a pnpm workspace.** `bun install` there, commit `bun.lock` — `pnpm install` corrupts it. SDK/MCP bumps (`@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`) go through the shared audit/apply flow; never `bun update` blindly.
- **Named SQL params need the prefix in JS keys too.** `bun:sqlite` doesn't auto-strip `$`/`@`/`:` the way `better-sqlite3` does on the host — use `$name` in both SQL and `.run({ $id: msg.id })`. Positional `?` works normally.
- **Session-DB pragmas**: `journal_mode=DELETE` (`container/agent-runner/src/mailbox/sqlite/connection.ts`) is load-bearing for cross-mount visibility — read the comment block there first.

## CJK font support

Off by default (~200MB). Signals: CJK conversation, `Asia/Tokyo|Shanghai|Seoul|Taipei|Hong_Kong` timezone, "tofu" rectangles in screenshots/PDFs. Offer `INSTALL_CJK_FONTS=true` in `.env` + rebuild.
