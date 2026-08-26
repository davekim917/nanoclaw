# ⚠️ STOP — READ THIS FIRST IF YOU ARE CLAUDE ⚠️

**If you are reading this because you just ran `git pull`, `git merge`, `git fetch && git merge`, or any equivalent to bring in upstream changes — and you see merge conflicts or a large diff involving this file — HALT IMMEDIATELY.**

This is NanoClaw v2, a ground-up rewrite with breaking changes throughout. It cannot be merged into an existing v1 install. Attempting to resolve the conflicts by hand, run builds, or "fix" anything will corrupt the user's install and burn tokens for no result.

**Do this instead:**
1. Abort the merge: `git merge --abort` (or `git reset --hard ORIG_HEAD` if the merge already completed).
2. Tell the user, verbatim: *"This is the v2 rewrite — it can't be merged into your existing install. Exit Claude Code (or open a separate terminal) and run `bash migrate-v2.sh` from the shell."*
3. Wait for the user to confirm before doing anything else. Do not run the migration script yourself — it requires an interactive terminal and cannot be run from within Claude Code.

If you are a fresh install (you ran `git clone`, not `git pull`) and there are no conflicts, ignore this banner and continue below.

---

# NanoClaw

Personal AI assistant. See [README.md](README.md) for philosophy and setup. Architecture lives in `docs/`.

## Quick Context

The host is a single Node process that orchestrates per-session agent containers. Platform messages land via channel adapters, route through an entity model (users → messaging groups → agent groups → sessions), get written into the session's inbound DB, and wake a container. The agent-runner inside the container polls the DB, calls the agent, and writes back to the outbound DB. The host polls the outbound DB and delivers through the same adapter.

**Everything is a message.** There is no IPC, no file watcher, no stdin piping between host and container. The two session DBs are the sole IO surface.

## Entity Model

```
workgroups  →  agent_groups  ⇄  messaging_groups  →  sessions
                    (many-to-many via messaging_group_agents)
users → user_roles (owner|admin, global or scoped) + agent_group_members
```

A **messaging_group** is one chat/channel on one platform; an **agent_group** is
one agent identity; a **session** is the (agent_group, messaging_group, thread)
triple that owns a container.

Two things that are easy to get wrong:

- **Privilege is user-level, not agent-group-level** — owner/admin live on
  `user_roles`. See [docs/isolation-model.md](docs/isolation-model.md).
- **Siblings share a workgroup, they do not collapse into one.** The workgroup is
  the data-pool boundary (chat archive, shared files, OneCLI
  secret declarations); each sibling keeps its own bot user, CLAUDE.md, routing
  identity, and engage rules. See [docs/workgroups.md](docs/workgroups.md).

Full schema: [docs/db-central.md](docs/db-central.md).

## Two-DB Session Split

Each session has **two** SQLite files under `data/v2-sessions/<session_id>/`:

- `inbound.db` — host writes, container reads. `messages_in`, delivered, destinations, session_routing.
- `outbound.db` — container writes, host reads. `messages_out`, processing_ack, session_state, container_state.

Exactly one writer per file — no cross-mount lock contention. Heartbeat is a file touch at `/workspace/.heartbeat`, not a DB update. Host uses even `seq` numbers, container uses odd.

## Central DB

`data/v2.db` holds everything that isn't per-session. Migrations live at
`src/db/migrations/`; schema reference is [docs/db-central.md](docs/db-central.md).

For ad-hoc queries use the in-tree wrapper, not the `sqlite3` CLI:
`pnpm exec tsx scripts/q.ts <db> "<sql>"`. Setup intentionally avoids depending
on the `sqlite3` binary (`setup/verify.ts:5`); the wrapper goes through the
`better-sqlite3` dep setup already installs. Output matches `sqlite3 -list`, so
existing skill text reads identically.

## Key Files

Most of `src/` is discoverable by reading it. These are the ones you would not
guess:

- **`src/guard/`** — the privileged-action decision seam. `guard(action, input)`
  → allow | hold | deny. `ncl` commands and delivery actions *demand* a guard at
  registration, and approved replays re-run the checks with the approval row as
  a grant. Conformance test: `src/guard/conformance.test.ts`.
- **`src/host-sweep.ts`** — one 60s sweep owns `processing_ack` sync, stale
  detection, due-message wake, recurrence, and ceiling-kill accountability. If
  something happens "on a timer," it happens here.
- **`src/router.ts` → `src/delivery.ts`** — the two ends of the message path;
  everything else hangs off them.
- **`scripts/vendor-design-artifact-loop.ts`** — the design-artifact-loop skill
  and `design_review` engine are **vendored**. Develop them in
  `~/plugins/design-artifact-loop` (OSS at davekim917/design-artifact-loop), not
  in-tree; `src/design-artifact-loop-vendor.test.ts` fails on drift.
- **`src/group-init.ts`** — the agent-runner source is a shared read-only mount,
  NOT copied per group. Editing it affects every group on next spawn.
- **`migrate-v2.sh`** — standalone, requires an interactive terminal, and cannot
  be run from inside Claude Code.

## Admin CLI (`ncl`)

`ncl` queries and modifies the central DB — agent groups, messaging groups,
wirings, users, roles, tasks, and more. On the host it connects over a Unix
socket (`src/cli/socket-server.ts`); inside containers it uses the session-DB
transport (`container/agent-runner/src/cli/ncl.ts`).

```
ncl <resource> <verb> [<id>] [--flags]
ncl <resource> help
ncl help
```

Run `ncl help` for the resource list and `ncl <resource> help` for fields and
enums — that output is generated from the registry, so it is always current.
Don't mirror it here; this file goes stale, `ncl help` doesn't.

Key files: `src/cli/dispatch.ts` (dispatcher + approval handler),
`src/cli/crud.ts` (generic CRUD registration), `src/cli/resources/`.

## Channels and Providers (skill-installed)

Trunk does not ship any specific channel adapter or non-default agent provider. The codebase is the registry/infra; the actual adapters and providers live on long-lived sibling branches and get copied in by skills:

- **`channels` branch** — Discord, Slack, Telegram, WhatsApp, Teams, Linear, GitHub, iMessage, Webex, Resend, Matrix, Google Chat, WhatsApp Cloud, Signal, WeChat, DeltaChat, Emacs (+ helpers, tests, channel-specific setup steps). Installed via `/add-<channel>` skills.
- **`providers` branch** — OpenCode (and any future non-default agent providers). Installed via `/add-opencode`.

Each `/add-<name>` skill is idempotent: `git fetch origin <branch>` → copy module(s) into the standard paths → append a self-registration import to the relevant barrel → `pnpm install <pkg>@<pinned-version>` → build. Channel skills carry these steps as `nc:` directive fences: setup applies them via the engine (`scripts/skill-apply.ts`), an agent applies the prose — same install either way. See [docs/skill-directives.md](docs/skill-directives.md).

**Channel defaults.** Each adapter declares its wiring-time defaults (`ChannelDefaults`: per DM/group context — engage mode/pattern, thread policy, unknown-sender policy — plus mention signaling). Exactly two levels: the adapter declaration, and the per-wiring override chosen at creation — no per-instance DB config table. Undeclared (stale) adapters resolve through a behavior-faithful fallback, so a trunk update alone changes nothing. See [docs/api-details.md](docs/api-details.md#channel-defaults) and `src/channels/channel-defaults.ts`.

## Self-Modification

One tier of agent self-modification today:

1. **`install_packages` / `add_mcp_server`** — changes to the per-agent-group container config in the DB (apt/npm deps, wire an existing MCP server). Single admin approval per request; on approve, the handler in `src/modules/self-mod/apply.ts` rebuilds the image when needed (`install_packages` only), writes an `on_wake` message, kills the container, and respawns via `onExit` callback. The on-wake message is only picked up by the fresh container's first poll — dying containers can never steal it. `container/agent-runner/src/mcp-tools/self-mod.ts`.

A second tier (direct source-level self-edits via a draft/activate flow) is planned but not yet implemented.

## Container Config

Per-agent-group container runtime config (provider, model, packages, MCP servers, mounts, etc.) is split across two stores, and the split is easy to get wrong:

- **`groups/<folder>/container.json` is authoritative for the runtime.** The spawn path reads it (`readContainerConfig`), bind-mounts it read-only, and the in-container runner reads `provider`/`model`/`effort` from it. There is no DB→file materialization at spawn — the spawn path only syncs identity fields (`agentGroupId`, `groupName`). `configFromDb()` exists but has no callers.
- **`container_configs` (central DB) is a read-side projection** used for `-m`/`-e` flag vocabulary (`src/router.ts`), scheduled-task flag validation, and image builds (packages).

`ncl groups config get/update` and the self-mod MCP tools manage both: as of the mirror fix, `config update` writes `provider`/`model`/`effort` to the DB row *and* mirrors them into `container.json`, so a provider change actually takes effect on the next `ncl groups restart`. Anything that writes only the DB row will leave the container booting its old provider.

**`cli_scope`** — controls what the agent can do with `ncl` from inside the container:

| Value | Behavior |
|-------|----------|
| `disabled` | Agent never learns about ncl (instructions excluded from CLAUDE.md). Host dispatch rejects any `cli_request`. |
| `group` (default) | Agent can access `groups`, `sessions`, `destinations`, `members`, `tasks` only, scoped to its own agent group. `--id` and group args are auto-filled. Cross-group access rejected. `cli_scope` changes blocked. |
| `global` | Unrestricted. Set by `scripts/init-first-agent.ts` **only** when it runs with `--role owner` (`init-first-agent.ts:272`). It is not implied by ownership: an install can run every group at `group` (stricter), and a fleet commonly does — a DB with zero `global` groups is a valid, tighter-than-default state, never a drift to "fix" by widening. |

Key files: `src/db/container-configs.ts`, `src/container-config.ts`, `src/cli/dispatch.ts` (scope enforcement), `src/claude-md-compose.ts` (instructions exclusion).

## Container Restart

`ncl groups restart --id <group-id> [--rebuild] [--message <text>]`. With
`--message` the host writes an `on_wake` row and respawns via the `onExit`
callback; without one, the container returns on the next user message. From
inside a container `--id` is auto-filled and only the calling session restarts.

The invariants worth knowing before you touch this path:

- **`on_wake` exists to close a race.** A wake message is only picked up by a
  fresh container's *first* poll, so a dying container still inside its SIGTERM
  grace period cannot steal it. `killContainer`'s `onExit` callback guarantees
  the old process is gone before the new one spawns.
- **Ceiling kills must be accounted for publicly.** When the 30-min idle ceiling
  (`ABSOLUTE_CEILING_MS`) kills a container with resumable work or a freshly
  started tool in flight, the sweep queues a deferred `ceiling-respawn-*` wake and
  the fresh container must post done / lost / next. Narration and status output
  are deliberately **not** recovery evidence. Capped at
  `WORK_CONTINUATION_RESUME_MAX_ATTEMPTS` (2). Decision:
  `decideCeilingFollowUp` in `src/host-sweep.ts`.
- **`continue_work({ task })` is the only sanctioned way to promise follow-up.**
  It persists an ID-bearing record in `session_state.work_continuation` and runs
  after any already-arrived user input; `cancel_continuation()` cancels it.
  Only a delivered result bound to the active continuation ID completes it —
  errors and empty streams requeue. Plain future-tense prose and `NEXT:` text
  have no control effect. Chain cap 50; host recovery throttled to 10 minutes and
  capped at 2 attempts before a visible parked notice.
- **`wait` is an in-thread wake, `ncl tasks` is not.** `wait` writes a
  `schedule_wake` action that becomes a `process_after` row in the SAME session
  (full context preserved). `ncl tasks` fires in an isolated task session and
  posts to a destination.
- **Every host start stops all install-labeled containers** — quiescence is a
  hard precondition for workgroup FS reconciliation. Sessions with fresh work
  evidence get a deferred `host-restart-*` note (`src/host-restart-warn.ts`),
  deduplicated within a ten-minute restart episode.

Agent-facing contract: `container/CLAUDE.md` "Container lifecycle".
Implementation: [docs/agent-runner-details.md](docs/agent-runner-details.md).
Key files: `src/container-restart.ts`, `src/container-runner.ts`
(`killContainer`), `container/agent-runner/src/db/messages-in.ts`.

## Secrets / Credentials / OneCLI

Secrets live in the OneCLI gateway and are injected per-request at the proxy
boundary — never via env vars, never in chat, never on disk in usable form.
Host wiring: `src/modules/approvals/onecli-approvals.ts`, `ensureAgent()` +
`applyOnecliSecrets()` in `container-runner.ts`. Container side:
`container/skills/onecli-gateway/SKILL.md`. `onecli --help` for commands.

**Per-group scoping is declarative.** `container.json` may carry
`onecliSecrets: ["Datafold-ExampleRetail", "Anthropic", ...]` (names or UUIDs).
On every spawn `applyOnecliSecrets()` resolves names → UUIDs, forces the agent to
`selective` mode, and assigns exactly that set. **Fail-closed** — an unresolvable
name throws, the spawn aborts, the sweep retries. No declaration is a no-op, so
operator-set assignments survive. See `src/onecli-secrets.ts`.

**Workgroup secrets are inherited as a union.** Workgroup-level `onecli_secrets`
merge with per-group additions — a group can extend the baseline, never subtract
from it. Populate via `scripts/set-workgroup-secrets.ts`, which validates names
against the vault *before* writing so one bad name can't break every member's
spawn. See [docs/workgroups.md](docs/workgroups.md).

**Gotcha — auto-created agents start in `selective` mode with nothing assigned.**
OneCLI's `POST /api/agents` defaults to `selective`, so a freshly created agent
gets no secrets even when matching ones exist in the vault. Symptom: proxy and CA
wired correctly, but `401` from an API whose credential *is* in the vault. Right
fix is declaring `onecliSecrets` above. Escape hatches:
`onecli agents set-secrets --id <uuid> --secret-ids <ids>`, or
`set-secret-mode --mode all` (looser — cross-tenant risk if vault patterns
overlap groups). Verified against `onecli@1.4.1`.

**Approval-gating credentialed actions is two-sided.** The gateway decides *when*
to hold a request (configure via the web UI at `http://127.0.0.1:10254` — the CLI
still only exposes `block`/`rate_limit`, not `approve`), and the host routes the
pending approval to a human via `onecli.configureManualApproval(cb)`. Approvers
resolve from `user_roles`: scoped admins → global admins → owners. There is no
admin env var. If approvals are configured server-side but the host callback
isn't running, every credentialed call hangs until the gateway times out; if the
gateway has no rule, the callback never fires no matter how it's wired.

## Skills

Four types — channel/provider installers, utility skills that ship code,
instruction-only operational skills, and container skills mounted into agent
sessions. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and
[docs/skill-guidelines.md](docs/skill-guidelines.md) for the authoring checklist.

Skill descriptions are the discovery mechanism — run `/help` or read
`.claude/skills/*/SKILL.md` and `container/skills/*/SKILL.md` rather than
consulting a list here.

Non-obvious: channel skills carry their install steps as `nc:` directive fences,
so setup applies them via `scripts/skill-apply.ts` and an agent applies the same
steps as prose — identical install either way. See
[docs/skill-directives.md](docs/skill-directives.md).

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, `SKILL.md` format rules, and the pre-submission checklist.

## PR Hygiene

Before creating a PR, run these checks:

```bash
git diff upstream/main --stat HEAD
git log upstream/main..HEAD --oneline
```

Show the output and wait for approval. Installation-specific files (group files, .claude/settings.json, local configs) should not be included.

## Development

Run commands directly — don't tell the user to run them.

```bash
# Host (Node + pnpm)
pnpm run dev          # Host via tsx (no watch)
pnpm run build        # Compile host TypeScript (src/)
./container/build.sh  # Rebuild agent container image (nanoclaw-agent:latest)
pnpm test             # Host tests (vitest)

# Agent-runner (Bun — separate package tree under container/agent-runner/)
cd container/agent-runner && bun install   # After editing agent-runner deps
cd container/agent-runner && bun test      # Container tests (bun:test)
```

Container typecheck is a separate tsconfig — if you edit `container/agent-runner/src/`, run `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` from root (or `bun run typecheck` from `container/agent-runner/`).

Service management:
```bash
# macOS (launchd)
launchctl load   ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start|stop|restart nanoclaw
```

## Module System (host)

Host (`src/`) is ESM. Never use `require()` — `@typescript-eslint/no-require-imports` disables hide a runtime trap: `require` is undefined in built ESM, so the call typechecks but throws/returns null at runtime. For circular imports use `await import('./mod.js')`. Agent-runner (`container/agent-runner/`) is a separate Bun package tree; this rule is host-only.

## Troubleshooting

Check these first when something goes wrong:

| What | Where |
|------|-------|
| Host logs | `logs/nanoclaw.error.log` first (delivery failures, crash-loop backoff, warnings), then `logs/nanoclaw.log` for the full routing chain |
| Setup logs | `logs/setup.log` (overall), `logs/setup-steps/*.log` (per-step: bootstrap, environment, container, onecli, mounts, service, etc.) |
| Session DBs | `data/v2-sessions/<agent-group>/<session>/` — `inbound.db` (`messages_in`: did the message reach the container?), `outbound.db` (`messages_out`: did the agent produce a response?) |

Host logs rotate daily via `/etc/logrotate.d/<systemd-unit-name>` (30-day retention, `data/logrotate/nanoclaw-v2` is the checked-in reference; installed by `setup/service.ts` on every root setup run). `copytruncate` is required there, not optional — the unit's `StandardOutput=append:`/`StandardError=append:` redirect is opened by systemd itself, so a normal rename-based rotation would leave the daemon writing to an unlinked file until a restart.

Note: container logs are lost after the container exits (`--rm` flag). If the agent silently failed inside the container, there's no persistent log to inspect.

## Timestamps

Two rules, no exceptions:

- **Storage**: every timestamp written from JS is `new Date().toISOString()` (ISO-8601 UTC with `Z`). Never `datetime('now')` — its naive `YYYY-MM-DD HH:MM:SS` shape is misparsed as local time by `new Date()` and breaks string comparisons against ISO values. In pure-SQL contexts (skill snippets) use `strftime('%Y-%m-%dT%H:%M:%fZ','now')`. SQL-side *comparisons* wrap both sides in `datetime()`.
- **Display**: anything shown to an agent or a user renders in the install timezone — `formatLocalTime` (prose) or `formatLocalStamp` (log lines) from `src/timezone.ts` / `container/agent-runner/src/timezone.ts`. `--json` output, DB values, and operator logs stay ISO.

## Supply Chain Security (pnpm)

This project intentionally tracks the latest stable releases, including majors. Prerelease, beta, RC, dev, nightly, draft, yanked, source-only, and target-incompatible releases are rejected. There is no release-age delay.

**Rules — do not bypass without explicit human approval:**
- **Deterministic updates**: Audit with `bun scripts/container-updates.ts audit`; apply only explicitly approved item IDs in a writable clone. Weekly automation is advisory and never opens, merges, or deploys PRs.
- **Exact resolution**: Commit package manifests with their regenerated lockfiles; Docker/runtime tools stay exact-pinned. Registry failure is `unknown`, never "current."
- **`allowBuilds`**: Never add or enable packages in this map without human approval — build scripts execute arbitrary code during install.
- **`pnpm install --frozen-lockfile`** should be used in CI, automation, and container builds. Never run bare `pnpm install` in those contexts.

## Docs Index

`docs/` holds the long-form reference. Start points:

| Topic | Doc |
|---|---|
| Architecture, end to end | `architecture.md`, `architecture-diagram.md` |
| DB model | `db.md` → `db-central.md`, `db-session.md` |
| Host API + schema detail | `api-details.md` |
| Agent-runner internals, MCP tools | `agent-runner-details.md` |
| Channel isolation levels | `isolation-model.md` |
| Workgroups / siblings | `workgroups.md` |
| Skills: model, guidelines, directives, engine seam | `skills-model.md`, `skill-guidelines.md`, `skill-directives.md`, `skill-engine-seam.md` |
| Runtime split, lockfiles, CI | `build-and-runtime.md` |
| Migration (v1→v2) | `v1-to-v2-changes.md`, `migration-dev.md` |
| Provider switching | `provider-migration.md` |
| Templates | `templates.md` |
| Memory | `memory.md` |
| Setup wiring, customizing | `setup-wiring.md`, `customizing.md` |
| CJK fonts | `cjk-fonts.md` |
| Always-on directive audit | `always-on-directive-classification.md`, `always-on-directive-baseline.md` |

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

## Container Runtime (Bun)

The agent container runs on **Bun**; the host runs on **Node** (pnpm). They communicate only via session DBs — no shared modules. Details and rationale: [docs/build-and-runtime.md](docs/build-and-runtime.md).

**Gotchas — trigger + action:**

- **Adding or bumping a runtime dep in `container/agent-runner/`** → edit `package.json`, then `cd container/agent-runner && bun install` and commit the updated `bun.lock`. Do not run `pnpm install` there — agent-runner is not a pnpm workspace.
- **Bumping `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, or any agent-runner runtime dep** → use the shared latest-stable audit/apply flow, review majors deliberately, and commit the regenerated `bun.lock`; never run `bun update` blindly.
- **Writing a new named-param SQL insert/update in the container** → use `$name` in both SQL and JS keys: `.run({ $id: msg.id })`. `bun:sqlite` does not auto-strip the prefix the way `better-sqlite3` does on the host. Positional `?` params work normally.
- **Adding a test in `container/agent-runner/src/`** → import from `bun:test`, not `vitest`. Vitest runs on Node and can't load `bun:sqlite`. `vitest.config.ts` excludes this tree.
- **Adding a Node CLI the agent invokes at runtime** (like `agent-browser`, `claude-code`, `vercel`) → put it in the Dockerfile's pnpm global-install block, pinned to an exact version via a new `ARG`. Don't use `bun install -g` — that bypasses the pnpm supply-chain policy.
- **Changing the Dockerfile entrypoint or the dynamic-spawn command** (`src/container-runner.ts` line ~503) → keep `exec bun ...` so signals forward cleanly. The image has no `/app/dist`; don't reintroduce a tsc build step.
- **Changing session-DB pragmas** (`container/agent-runner/src/db/connection.ts`) → `journal_mode=DELETE` is load-bearing for cross-mount visibility. Read the comment block at the top of the file first.

## CJK font support

Off by default (~200MB). On signals the user works with CJK content (CJK conversation, `Asia/Tokyo|Shanghai|Seoul|Taipei|Hong_Kong` timezone, screenshots/PDFs needing CJK render — symptom is "tofu" rectangles), offer to set `INSTALL_CJK_FONTS=true` in `.env` and rebuild the image.
