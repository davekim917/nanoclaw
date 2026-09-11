# Changelog

All notable changes to NanoClaw will be documented in this file.

## [Unreleased]

- **New: a checkout per thread and branch, and independent clones behind `NANOCLAW_CHECKOUT_MODE=clone`.** `create_worktree` takes a `branch`: the thread's checkout at `/workspace/worktrees/<repo>` when it is already on that branch, otherwise that branch's own checkout at `/workspace/worktrees/<repo>@<branch-slug>`, so threads no longer block each other on one shared checkout. `git_commit`, `git_push` and `open_pr` take `branch` to select the checkout they act on, defaulting to the primary. The default mode, `worktree`, makes linked worktrees exactly as before. `clone` has the host build each new checkout as an independent clone that hardlinks the canonical's objects and, with `NANOCLAW_DEPENDENCY_CACHE=apply`, links verified shared `node_modules` farms; it needs containers that run as the host uid. Rollback is flipping the flag back and restarting: clones stay usable in `worktree` mode. Worktree cleanup collects an idle clone only after proving every local branch, HEAD and the stash already on the remote. No migration: existing linked worktrees keep working in both modes. See [docs/workgroups.md](docs/workgroups.md#canonical-repositories-and-topic-worktrees).

- [BREAKING] **Scheduled tasks no longer have their own model/effort default, and no longer inherit an interactive one.** An unpinned scheduled-task fire on a Claude group was forced onto `sonnet` at `xhigh` regardless of what the group was configured to run — invisible in `ncl tasks get`, contradicting the group's own config, and Claude-only. It now resolves to the group's configured model and effort, else the provider's per-family default. **This changes production behaviour on deploy**, and on a group with no `model` in `container.json` an unpinned series moves to `claude-opus-5[1m]` at `high`. A task's OWN `--model`/`--effort` pin still wins over everything.

  A _pure_ task wake that **opens** a query also no longer picks up a per-session sticky `-m`/`-e` a human set in chat — the protection the deleted `sonnet` literal was carrying, now implemented by suppressing the sticky rather than substituting a hardcoded value. A batch that mixes real chat with a task is a human conversation the task rode along with and keeps the sticky. This half is provider-neutral: codex and opencode task wakes inherited the sticky too and no longer do.

  **Known limitation — a task admitted into an already-running turn still inherits that turn's settings.** Suppression applies where a task wake _opens_ a query. If a fire comes due while a query in that series' own session is already streaming, that occurrence joins the running turn and runs on its model and effort, exactly as before this change. **This is narrow:** every series gets its own session (`resolveTaskSession`), so a task never lands in a conversation — the case is reachable only when someone has replied inside that task's thread and the next fire joins the turn their reply opened. Deciding otherwise requires knowing whether the turn being joined is idle or is an in-flight answer to a person, which the admitted batch cannot say — a batch-shaped predicate answers "is this a task wake", not "is anyone waiting on this turn". Tracked in [#585](https://github.com/davekim917/nanoclaw/issues/585).

  **Migration — pin BEFORE you deploy, not after:** [docs/scheduled-task-defaults.md](docs/scheduled-task-defaults.md). Pins are data (no deploy); the removal is code (needs one), so a series you want held on its current model must be pinned first or it runs at the group default for every fire in between.

- [BREAKING] **`ncl groups config update --provider` refuses a switch that would strand scheduled-task pins.** A task's `--model`/`--effort` pin is validated against the group's provider at CREATE time and never re-validated at fire time, so migrating a group's provider used to silently leave every pinned series holding a model the new provider cannot run — failing on every fire, indefinitely, with the pin still reading as valid. The switch now audits every pending/paused series first and refuses with the offending series ids, their pins, and why each is invalid. **Pins are never rewritten automatically** — a pin that changes by itself is not a pin. **Migration:** [docs/task-pin-provider-switch.md](docs/task-pin-provider-switch.md) — detect stranded pins, clear them with the new `ncl tasks repin --target-provider`, then re-run the switch; includes verification at the per-turn ledger and rollback.

- **New: `ncl tasks repin`** — bulk-retarget existing task pins, matching on the current pinned model and setting a new one, scoped to a group or fleet-wide. Validates every candidate against its own group's provider in a pre-flight pass and refuses before the first write rather than half-applying; `--dry-run` previews; per-series results are reported, including any that failed after earlier ones were already written (the writes span separate session DBs and are not atomic across them). `ncl tasks list` now shows a `PIN` column, and `--json` carries `model_pin`/`effort_pin`, so an unpinned series is visible as such for the first time. **Known limitation:** a pin cannot currently be _cleared_ — `--model`/`--effort` merge into the stored pin and an empty flag reads as absent, so there is no `--model ""`. Pinning is a one-way door; see [#578](https://github.com/davekim917/nanoclaw/issues/578).

- [BREAKING] **Agent templates are now Agent Plugins.** `groups create --template <ref>` reads `TEMPLATES_DIR/<ref>` as a conformant Agent Plugin (`plugin.json` manifest, `skills/`, `mcp.json`, plus the optional NanoClaw extension for persona, context, and tasks) and stamps the whole plugin into `groups/<folder>/plugins/<name>` behind a read-only container mount, with a writable `plugin-data/<name>` beside it. A pre-plugin template folder is REJECTED with a migration error, not silently parsed — there is no fallback reader. Every stamped MCP server carries a `plugin` ownership marker in both `container.json` and the `container_configs` projection, so `ncl groups config add-mcp-server` / `remove-mcp-server` and an approved `add_mcp_server` all refuse to overwrite it. **Migration:** installs with no `templates/` content and no template-stamped groups need no action (`ncl groups list` plus an empty `templates/` directory confirms this — the reference install matched). Otherwise, re-fetch each template in Agent Plugin layout before the first `--template` create after this upgrade: move the persona/context/tasks files under the NanoClaw extension, add a `plugin.json`, rename any `.mcp.json` to `mcp.json` (the legacy name is reported and ignored, never read), and add `$schema` plus a declared `type` on every MCP entry. Note that `groups create --template` only ever CREATES: it mints a new group id and suffixes the folder if one already exists, so it cannot update an existing stamped group. Re-stamping an existing group in place lands with the restamp verb later in this series; until then, create a new group from the updated template and retire the old one, or leave the group as stamped. Already-created groups are untouched by this change; only the create path reads templates. See [docs/templates.md](docs/templates.md) for the layout and the exact error text.

- [BREAKING] **Host startup now holds a kernel `flock` ownership claim.** Existing macOS installs need Homebrew's `flock` command, and every service definition must retain the resolved command directory on `PATH`. **Migration:** during `/update-nanoclaw`, in Step 9 after dependency installation, skill updates, required rebuilds/backups, and all audit/memory/migration gates pass, run `pnpm exec tsx setup/index.ts --step service` before any ordinary restart command. On macOS it provisions, and on every platform it functionally preflights, `flock`; it then regenerates the launchd plist or Linux service definition and reloads/restarts that service. Do not run a separate `launchctl kickstart` or `systemctl restart` afterwards; the service step already applies the updated definition.
- **Fix: two of every Claude group's three instruction sections never reached the model.** Claude Code silently drops an `@`-import whose resolved realpath falls outside the project directory. The composed `CLAUDE.md` imported the shared base through `.claude-shared.md` → `/app/CLAUDE.md` and each module fragment through `module-*.md` → `/app/src/mcp-tools/*.instructions.md`, both outside the container's project directory of `/workspace/agent`, so only the inline standing-instructions fragment was ever delivered. `composeGroupClaudeMd` now writes every section into the file itself. Measured inside the real agent image (claude-code 2.1.257) by capturing the outgoing Messages API request body: one of three sentinels present before, three of three after; `--add-dir` on the target directory does not widen the import boundary. Codex and OpenCode were unaffected — they read the already-flat `AGENTS.md`. Also tightened: an inline fragment's body (persona, MCP `instructions`, plugin ruleset) is no longer `@`-expanded host-side, closing the same container-to-host read path `CLAUDE.local.md` already guarded against. No migration — the next spawn recomposes every group.
- [BREAKING] **Minimum supported Node.js raised to >=22.13.0** (was 20), matching the host runtime and the floor the locked build toolchain actually needs (eslint@10 and vite@8 both refuse anything from 22.0 through 22.12). `engines.node`, CI, and docs updated to match; `.nvmrc` and `setup/install-node.sh` already installed 22, and the bootstrap's version gate (`setup.sh`) plus `setup/install-node.sh`'s already-installed/post-install checks now compare the full version — not just the major — against that floor instead of accepting any Node ≥20. **Migration — a running install, not a fresh setup:** `better-sqlite3` is ABI-bound to the Node major, so swapping Node under a live process without rebuilding it crashes the host on the next DB access, and rebuilding it _while the process is still up_ segfaults that process (its mmap changes underneath it). Stop the service first — `sudo systemctl stop nanoclaw-v2` — then either re-run `bash nanoclaw.sh` (its bootstrap step now installs and gates on 22.13.0+ automatically) or run `setup/install-node.sh` directly; run `pnpm rebuild better-sqlite3 && node -e "require('better-sqlite3')"` to confirm the addon loads under the new runtime; then `sudo systemctl start nanoclaw-v2` and confirm `node --version` reports `v22.13.0` or newer. See the `sync-upstream` skill's "Host runtime upgrades" section for the full sequence and rollback.
- **Retired the instruction-fragment delivery mechanism the fix above superseded.** `composeGroupClaudeMd` now reads the shared base and module fragments straight from their host paths instead of writing a `.claude-shared.md` symlink and a `.claude-fragments/` directory for the composed doc to reach through; the `/app/CLAUDE.md` and `/workspace/agent/.claude-fragments` container mounts that backed those symlinks are gone. A one-release cleanup deletes any pre-cutover `.claude-shared.md`/`.claude-fragments/` still on disk the next time a group's `CLAUDE.md` is composed. No behavior change to the composed doc's content — only its plumbing. **Deploy note:** the mount-list change takes effect for containers spawned after the restart; an already-running container keeps its existing mounts until its next spawn.
- **Security: agent containers spawn with `--cap-drop ALL` and `--security-opt no-new-privileges:true`.** Overridable per group via `security` in `groups/<folder>/container.json` (`capDrop`, `capAdd`, `noNewPrivileges`); absent means the hardened defaults. Resource ceilings are unchanged and still come from `resources` / the `CONTAINER_*` env defaults. The container already ran as the non-root `node` user, so nothing the agent could do before is taken away — verified against the live image for chromium, node, bun, pnpm, git, gh, and HTTPS egress. Rebuild the agent image and restart to pick it up.
- **Security: agent-image toolchains bumped past a critical `tar` vulnerability (GHSA-23hp-3jrh-7fpw).** pnpm moves to 10.34.5 (host `packageManager` and container `PNPM_VERSION` in lockstep) and the container pins npm 10.9.9 over the base image's 10.9.8, replacing the vulnerable vendored `tar` in both. Rebuild the agent image to pick it up; no behavior change.
- [BREAKING] **Repository checkouts are now isolated per conversation topic.** Each workgroup/repository pair has one host-owned canonical clone, while each external thread, threadless messaging group, scheduled-task anchor, or private session receives its own standard linked Git worktree; sibling agents in the same topic share that checkout. Existing mirrors, standalone clones, and collided shared-admin checkouts must be migrated losslessly before this runtime is activated. **Migration:** follow the capacity-gated inventory, rescue-ref, rollback, audit, and canary procedure in [the repository workspace plan](docs/specs/server-wide-repository-workspaces/plan.md) and record the execution in its [runbook](docs/specs/server-wide-repository-workspaces/run.md).
- [BREAKING] **Provider-agnostic workgroup memory.** Every sibling provider in a workgroup shares one OKF v0.1-compatible canonical tree at `data/workgroups/<workgroup-id>/memory`; provider-native paths are compatibility views, while persona and provider state remain separate. The host admits bounded, source-grounded context before every eligible turn, including first wake, warm continuation, compaction, and replacement. Existing groups with legacy memory must run `/migrate-memory` before use. See [memory](docs/memory.md) and [provider migration](docs/provider-migration.md).
- [BREAKING] **Channel install skills are now the single source of truth.** The setup wizard installs channels by applying the same `/add-<channel>` SKILL.md a coding agent would follow — a deterministic engine executes the skill's mechanical steps directly from the document, so wizard and skill can never drift, and anything the engine can't do falls back to an agent reading the prose. **Migration:** the bespoke non-interactive channel installers (`setup/add-<channel>.sh`, `setup/install-<channel>.sh`) and the per-channel wizard flows (`setup/channels/<channel>.ts`) are deleted — anything that shelled out to them should apply the skill instead: interactively via the coding agent (`/add-<channel>`) or the setup wizard, or programmatically (see [docs/skill-directives.md](docs/skill-directives.md) for how skills are applied without a human).
- **The guard seam.** Every privileged action crossing the container or channel boundary now passes one decision function — `guard()` in `src/guard/` — before it executes: `allow`, `hold` (the existing approval flows), or `deny`. Today's checks are preserved verbatim as each action's decision; ncl commands and delivery actions cannot register without a guard, and approved replays re-enter carrying the approval row as a **grant** (the forgeable `approved: true` boolean is deleted) with the checks re-run live. Two deliberate outcome changes: **(a)** approving a held a2a message after its destination was revoked no longer delivers it — the requester is told "approved, but not delivered" and the host logs a warning; **(b)** a forged, already-consumed, or mismatched grant refuses the replay instead of executing.
- **Delivery-registry hardening.** Re-registering a guard-wrapped delivery action _without_ a guard spec now throws instead of silently disarming the guard.
- [BREAKING] **`whatsapp-formatting` and `slack-formatting` container skills moved from trunk to the `channels` branch.** They now install with their channel — `/add-whatsapp` / `/add-slack` copy them in (the setup wizard drives the same skills) — so installs without those channels stop carrying channel-specific formatting instructions in every agent's context. **Migration — only if this install has the channel wired** (check `src/channels/whatsapp.ts` / `src/channels/slack.ts`): updating removes both skills from the working tree — WhatsApp agents lose the formatting fragment from their composed CLAUDE.md on next spawn, Slack agents lose the mrkdwn skill from `~/.claude/skills`. Re-run the matching skill, `/add-whatsapp` or `/add-slack` (idempotent), to restore. Installs without the channel need nothing — do NOT run the add-skill just in case; it installs the full channel adapter.
- **Pre-task script failures back their series off instead of spinning.** A `--script` that errors lands the occurrence as a failed run (`script-skip:error` ack → `failed` status); recurrence reads the series' trailing failed streak and re-arms at `max(cron next, now + 2·2^(n−1) min, cap 60)`; after 8 consecutive failures the series is auto-paused with a host-written note in its run log (`ncl tasks resume` revives it). A deliberate `wakeAgent:false` gate is a normal run and never backs off. Also fixed: an explicitly-addressed `<message to>` in a task fire's final text now delivers as a deliberate send (previously suppressed as a turn-reply echo → zero delivery when the agent skipped the MCP tool); identical echoes of an MCP send are dropped in the runner, where the duplication originates.
- [BREAKING] **Explicit destinations and one-door task delivery.** In isolated task sessions, every `send_message` and `send_file` call requires a named `to` destination; only those explicitly addressed tool calls deliver, while final output becomes the automatic run summary and `ncl tasks append-log` adds optional progress notes. Ordinary chat sessions retain reply-in-place behavior when `to` is omitted, and an explicit `to` still redirects to another destination. Existing task DBs need no schema migration; legacy generated task instructions are normalized when read. **Migration:** rebuild the agent image, restart NanoClaw, update custom task instructions that omit `to`, and clear or compact existing task sessions.
- [BREAKING] **Scheduled tasks moved from MCP tools to `ncl tasks`.** The six scheduling MCP tools are no longer exposed to agent containers; agents and operators manage tasks with `ncl tasks list/get/create/update/cancel/pause/resume/delete`. New tasks run from a per-agent-group system session rather than waking the chat session that created them, and task writes are not approval-gated inside the owning group. **Migration:** [docs/ncl-tasks-migration.md](docs/ncl-tasks-migration.md).
- **Optional per-container resource caps.** `CONTAINER_CPU_LIMIT` and `CONTAINER_MEMORY_LIMIT` pass through to `docker run` as `--cpus` / `--memory` (`container-runner.ts`). Both empty by default — no flag added, spawn args byte-identical to today — so existing installs are unaffected. Set them to cap an agent container's CPU/memory so one agent can't monopolize the host (e.g. `CONTAINER_CPU_LIMIT=2`, `CONTAINER_MEMORY_LIMIT=8g`). Swap is intentionally not managed here: `--memory` is a hard cap on a swapless host.
- [BREAKING] **Chat SDK pinned to `4.29.0` (was `4.26.0` via `^4.24.0`).** `chat` and the `@chat-adapter/*` channel adapters are version-locked — the adapter's `ChatInstance` must match the bridge's, so a mismatched pair fails to typecheck at `createChatSdkBridge(...)`. `chat` is therefore pinned exactly, and the channel-adapter install pins move with it — the dependency pins in the `/add-<channel>` SKILL.mds on `main`, plus the adapter code on the `channels` branch. Core installs with no channel (only `cli`) are unaffected. **Migration:** if any channel is installed (Slack, Discord, Telegram, Teams, …), re-run its `/add-<channel>` skill to pull the matching `4.29.0` adapter.
- **Budget/billing-exhausted LLM turns now reach the user instead of being silently dropped.** When a turn ends in a non-retryable provider error (e.g. an Anthropic `403 billing_error`) with no `<message>` wrapping, the agent-runner delivers the provider's notice to the originating channel and stops re-nudging the failing gateway. `providers/claude.ts` now surfaces the SDK's `is_error` flag (and the error subtype's `errors[]` text); `poll-loop.ts` delivers that text and skips the re-wrap retry. Fixes the case where a spend-limit notice produced silence plus a turn-after-turn retry loop.
- [BREAKING] **`@onecli-sh/sdk` 0.5.0 -> 2.2.1 — requires a OneCLI server with the `/v1` API** (older servers 404 every SDK call). The sanctioned gateway and CLI versions are pinned in `versions.json`. **The gateway is a separate component — updating NanoClaw does not upgrade it for you:** `/update-nanoclaw` upgrades it when the pin moves, otherwise upgrade manually. **Migration:** [docs/onecli-upgrades.md](docs/onecli-upgrades.md).
- **New agent provider: Codex (OpenAI) — run `/add-codex`.** Full runtime via `codex app-server` (planning, MCP tools, server-side history, resume). Trunk ships the seams and the skill; the payload installs from the `providers` branch (the skill, the setup picker, or `--step provider-auth codex`). Auth is vault-only — no credential ever enters a container.
- **Setup can now select, install, and authenticate a non-default agent provider.** A provider registry feeds the setup picker, an installer pulls the provider's payload from its branch, a vault auth walkthrough runs (`--step provider-auth`), and the picked provider is set on the first agent (a DB property) before its first spawn. Default (Claude) installs are unaffected — picking Claude changes nothing.
- **New groups inherit an instance-wide default provider.** `DEFAULT_AGENT_PROVIDER` in `.env` (default `claude`) sets which provider newly created agent groups get at creation; provider stays a per-group DB property, overridable via `ncl groups config update --provider` + restart. Existing groups are untouched — no migration, no retroactive flips.
- **Memory migrates via `/migrate-memory`, never through an implicit runtime import.** The workflow inventories every recognized group-local and provider-native source, retains a permanent checksummed snapshot, preserves collisions without overwriting, and activates one canonical workgroup tree only after verification. Provider-native paths become compatibility views of that canon; provider identity, instructions, credentials, and session state remain separate. See [docs/provider-migration.md](docs/provider-migration.md).
- **Per-exchange archiving is provider-owned** — the `onExchangeComplete` hook; the markdown writer ships with the codex payload.
- **Container boot failures now say why** — the last stderr lines are logged at `warn` on a non-zero exit instead of a silent crash loop.
- **Slash commands now interrupt an in-flight turn.** A runner-handled command (`/clear`, `/compact`, `/cost`, …) arriving mid-turn aborts the active stream and runs immediately instead of waiting out the turn.

## [2.1.0] - 2026-06-07

- [BREAKING] **Startup now requires an upgrade marker.** The host refuses to boot unless `data/upgrade-state.json` records that this install reached the current version through a sanctioned path (`/setup`, `/update-nanoclaw`, `/migrate-nanoclaw`). After this update completes — and before restarting the service — stamp the marker by running `pnpm exec tsx scripts/upgrade-state.ts set`. If the host has already tripped on restart with "update did not go through the supported path", that same command clears it. See [docs/upgrade-recovery.md](docs/upgrade-recovery.md).

## [2.0.64] - 2026-05-18

- **`ncl destinations add` and `remove` through the approval flow now reach the receiver immediately.** Approved destinations weren't being projected into the receiving agent's local session state, so a freshly-added destination silently failed at `send_message` with `unknown destination`, and a removed destination stayed resolvable until the next container restart. Both now take effect the moment the approval executes. Direct (non-approval) calls were unaffected.

## [2.0.63] - 2026-05-15

Rollup release covering v2.0.55 through v2.0.63 — everything merged since the v2.0.54 tag. Starting with this release, the goal is to publish a GitHub Release for every `package.json` version bump that lands on `main`; see [RELEASING.md](RELEASING.md).

- [BREAKING] **Service names are now per-install.** On v2 installs the launchd label and systemd unit are slugged to your project root: `com.nanoclaw.<sha1(projectRoot)[:8]>` and `nanoclaw-<slug>.service`. The old `com.nanoclaw` / `nanoclaw.service` names no longer match a real service — update any copy-pasted restart or status commands. Find your install's names with `source setup/lib/install-slug.sh && launchd_label` (macOS) or `systemd_unit` (Linux). The `ncl` transport-error help text and 26 skill files now use the canonical helper-driven pattern; see [setup/lib/install-slug.sh](setup/lib/install-slug.sh).
- **Compaction destination reminder placement fixed.** The reminder injected after SDK auto-compaction now appears at the end of the compaction summary so it isn't stripped during truncation. Replaces the placement shipped in v2.0.54.
- **Stronger message-wrapping enforcement.** The poll loop nudges the agent when its output lacks `<message>` wrapping, and `CLAUDE.md` core instructions now require wrapping even for single-destination agents. The welcome flow no longer double-greets.
- **OneCLI credentials after MCP install.** MCP servers added through `add_mcp_server` now inherit OneCLI gateway routing — fixes the case where the agent kept asking for API keys after installing a new server.
- **CLI scope hardening.** `scopeField` now fails closed when scope is missing, and `sessions get` is guarded against cross-group oracle access from group-scoped agents.
- **gmail/gcal skills aligned with v2.** `/add-gmail-tool` and `/add-gcal-tool` now reflect the v2 container-config model — DB-backed mounts, no dead `TOOL_ALLOWLIST` edits, no `container.json` writes that get clobbered on next spawn. Manual sqlite3/JSON1 invocations corrected.
- **Repo-rename cleanup.** Remaining `qwibitai/nanoclaw` references swept to `nanocoai/nanoclaw` across code and docs; CI workflow guards updated so they no longer no-op after the rename.
- Slack scope checklist now includes `files:read` and `files:write` for skills that read or post attachments.
- The internal-tag description in destination instructions no longer mentions scratchpads (which confused agents into routing them incorrectly).
- Container startup is now graceful when the `on_wake` column is missing on older sessions DBs.

## [2.0.54] - 2026-05-10

- **Per-group model and effort overrides.** Agent groups can now run a specific Claude model and effort level, set via `ncl groups config update --model <model> --effort <level>`. Defaults to the host-configured model when unset.
- **Claude Code 2.1.128.** Container claude-code bumped from 2.1.116 to 2.1.128.
- CLI help text improvements for `ncl groups config` and `ncl groups restart`.

## [2.0.48] - 2026-05-09

- **Container config moved to DB.** Per-agent-group container runtime config (provider, model, packages, MCP servers, mounts, skills) now lives in the `container_configs` table instead of `groups/<folder>/container.json`. Existing filesystem configs are backfilled automatically on startup. Managed via `ncl groups config get/update` and `config add-mcp-server/remove-mcp-server/add-package/remove-package`.
- **Explicit restart with on-wake messages.** Config CLI operations no longer auto-kill containers. New `ncl groups restart` command with `--rebuild` and `--message` flags. On-wake messages (`on_wake` column on `messages_in`) are only picked up by a fresh container's first poll, preventing dying containers from stealing them during the SIGTERM grace period. Self-mod approval handlers (`install_packages`, `add_mcp_server`) use the same race-free mechanism.
- **Per-group CLI scope.** New `cli_scope` setting on container config (`disabled` / `group` / `global`, default `group`). Controls what the agent can access via `ncl` from inside the container. `disabled` excludes CLI instructions from CLAUDE.md and blocks all requests. `group` (default) restricts to own-group resources with auto-filled args. `global` gives unrestricted access (set automatically for owner agent groups). Includes post-handler result filtering to prevent cross-group data leaks and blocks `cli_scope` escalation from group-scoped agents.

## [2.0.45] - 2026-05-08

- **Admin CLI (`ncl`).** New `ncl` command for querying and modifying the central DB — agent groups, messaging groups, wirings, users, roles, members, destinations, sessions, approvals, and dropped messages. Host-side transport via Unix socket; container-side transport via session DB. Write operations from inside containers go through the approval flow. `list` supports column filtering and `--limit`. Run `ncl help` for usage.
- **v1 → v2 migration.** Run `bash migrate-v2.sh` from the v2 checkout. Finds your v1 install (sibling directory or `NANOCLAW_V1_PATH`), merges `.env`, seeds the v2 DB from `registered_groups`, copies group folders (`CLAUDE.md` → `CLAUDE.local.md`), copies session data with conversation continuity, ports scheduled tasks, interactively selects and installs channels (clack multiselect), copies container skills, builds the agent container, and offers a service switchover to test. Hands off to Claude (`/migrate-from-v1`) for owner seeding, access policy, CLAUDE.md cleanup, and fork customization porting. See [docs/migration-dev.md](docs/migration-dev.md) and [docs/v1-to-v2-changes.md](docs/v1-to-v2-changes.md).

## [2.0.0] - 2026-04-22

Major version. NanoClaw v2 is a substantial architectural rewrite. Existing forks should run `/migrate-nanoclaw` (clean-base replay of customizations) or `/update-nanoclaw` (selective cherry-pick) before resuming work.

- [BREAKING] **New entity model.** Users, roles (owner/admin), messaging groups, and agent groups are now tracked as separate entities, wired via `messaging_group_agents`. Privilege is user-level instead of channel-level, so the old "main channel = admin" concept is retired. See [docs/architecture.md](docs/architecture.md) and [docs/isolation-model.md](docs/isolation-model.md).
- [BREAKING] **Two-DB session split.** Each session now has `inbound.db` (host writes, container reads) and `outbound.db` (container writes, host reads) with exactly one writer each. Replaces the single shared session DB and eliminates cross-mount SQLite contention. See [docs/db-session.md](docs/db-session.md).
- [BREAKING] **Install flow replaced.** `bash nanoclaw.sh` is the new default: a scripted installer that hands off to Claude Code for error recovery and guided decisions. The `/setup` Claude-guided skill still works as an alternative.
- [BREAKING] **Channels moved to the `channels` branch.** Trunk no longer ships Discord, Slack, Telegram, WhatsApp, iMessage, Teams, Linear, GitHub, WeChat, Matrix, Google Chat, Webex, Resend, or WhatsApp Cloud. Install them per fork via `/add-<channel>` skills, which copy from the `channels` branch. `/update-nanoclaw` will re-install the channels your fork had.
- [BREAKING] **Alternative providers moved to the `providers` branch.** OpenCode, Codex, and Ollama install via `/add-opencode`, `/add-codex`, `/add-ollama-provider`. Claude remains the default provider baked into trunk.
- [BREAKING] **Three-level channel isolation.** Wire channels to their own agent (separate agent groups), share an agent with independent conversations (`session_mode: 'shared'`), or merge channels into one shared session (`session_mode: 'agent-shared'`). Chosen per channel via `/manage-channels`.
- [BREAKING] **Apple Container removed from default setup.** Still available as an opt-in via `/convert-to-apple-container`.
- **Shared-source agent-runner.** Per-group `agent-runner-src/` overlays are gone; all groups mount the same agent-runner read-only. Per-group customization flows through composed `CLAUDE.md` (shared base + per-group fragments).
- **Agent-runner runtime moved from Node to Bun.** Container image is self-contained; no host-side impact. Host remains on Node + pnpm.
- **OneCLI Agent Vault is the sole credential path.** Containers never receive raw API keys; credentials are injected at request time.

## [1.2.36] - 2026-03-26

- [BREAKING] Replaced pino logger with built-in logger. WhatsApp users must re-merge the WhatsApp fork to pick up the Baileys logger compatibility fix: `git fetch whatsapp main && git merge whatsapp/main`. If the `whatsapp` remote is not configured: `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git`.

## [1.2.35] - 2026-03-26

- [BREAKING] OneCLI Agent Vault replaces the built-in credential proxy. Check your runtime: `grep CONTAINER_RUNTIME_BIN src/container-runtime.ts` — if it shows `'container'` you are on Apple Container, if `'docker'` you are on Docker. Docker users: run `/init-onecli` to install OneCLI and migrate `.env` credentials to the vault. Apple Container users: re-merge the skill branch (`git fetch upstream skill/apple-container && git merge upstream/skill/apple-container`) then run `/convert-to-apple-container` and follow all instructions (configures credential proxy networking) — do NOT run `/init-onecli`, it requires Docker.

## [1.2.21] - 2026-03-22

- Added opt-in diagnostics via PostHog with explicit user consent (Yes / No / Never ask again)

## [1.2.20] - 2026-03-21

- Added ESLint configuration with error-handling rules

## [1.2.19] - 2026-03-19

- Reduced `docker stop` timeout for faster container restarts (`-t 1` flag)

## [1.2.18] - 2026-03-19

- User prompt content no longer logged on container errors — only input metadata
- Added Japanese README translation

## [1.2.17] - 2026-03-18

- Added `/capabilities` and `/status` container-agent skills

## [1.2.16] - 2026-03-18

- Tasks snapshot now refreshes immediately after IPC task mutations

## [1.2.15] - 2026-03-16

- Fixed remote-control prompt auto-accept to prevent immediate exit
- Added `KillMode=process` so remote-control survives service restarts

## [1.2.14] - 2026-03-14

- Added `/remote-control` command for host-level Claude Code access from within containers

## [1.2.13] - 2026-03-14

**Breaking:** Skills are now git branches, channels are separate fork repos.

- Skills live as `skill/*` git branches merged via `git merge`
- Added Docker Sandboxes support
- Fixed setup registration to use correct CLI commands

## [1.2.12] - 2026-03-08

- Added `/compact` skill for manual context compaction
- Enhanced container environment isolation via credential proxy

## [1.2.11] - 2026-03-08

- Added PDF reader, image vision, and WhatsApp reactions skills
- Fixed task container to close promptly when agent uses IPC-only messaging

## [1.2.10] - 2026-03-06

- Added `LIMIT` to unbounded message history queries for better performance

## [1.2.9] - 2026-03-06

- Agent prompts now include timezone context for accurate time references

## [1.2.8] - 2026-03-06

- Fixed misleading `send_message` tool description for scheduled tasks

## [1.2.7] - 2026-03-06

- Added `/add-ollama` skill for local model inference
- Added `update_task` tool and return task ID from `schedule_task`

## [1.2.6] - 2026-03-04

- Updated `claude-agent-sdk` to 0.2.68

## [1.2.5] - 2026-03-04

- CI formatting fix

## [1.2.4] - 2026-03-04

- Fixed `_chatJid` rename to `chatJid` in `onMessage` callback

## [1.2.3] - 2026-03-04

- Added sender allowlist for per-chat access control

## [1.2.2] - 2026-03-04

- Added `/use-local-whisper` skill for local voice transcription
- Atomic task claims prevent scheduled tasks from executing twice

## [1.2.1] - 2026-03-02

- Version bump (no functional changes)

## [1.2.0] - 2026-03-02

**Breaking:** WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add.

- Channel registry: channels self-register at startup via `registerChannel()` factory pattern
- `isMain` flag replaces folder-name-based main group detection
- `ENABLED_CHANNELS` removed — channels detected by credential presence
- Prevent scheduled tasks from executing twice when container runtime exceeds poll interval

## [1.1.6] - 2026-03-01

- Added CJK font support for Chromium screenshots

## [1.1.5] - 2026-03-01

- Fixed wrapped WhatsApp message normalization

## [1.1.4] - 2026-03-01

- Added third-party model support
- Added `/update-nanoclaw` skill for syncing with upstream

## [1.1.3] - 2026-02-25

- Added `/add-slack` skill
- Restructured Gmail skill for new architecture

## [1.1.2] - 2026-02-24

- Improved error handling for WhatsApp Web version fetch

## [1.1.1] - 2026-02-24

- Added Qodo skills and codebase intelligence
- Fixed WhatsApp 405 connection failures

## [1.1.0] - 2026-02-23

- Added `/update` skill to pull upstream changes from within Claude Code
- Enhanced container environment isolation via credential proxy
