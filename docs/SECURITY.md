# NanoClaw Security Model

> The canonical, continuously-verified version of this model lives at
> [docs.nanoclaw.dev/concepts/security](https://docs.nanoclaw.dev/concepts/security).
> This in-repo copy can drift; if the two disagree, verify against
> `src/container-runner.ts` (`buildMounts`).

## Trust Model

Privilege is **user-level**, persisted in the `user_roles` table (owner /
admin, global or scoped to an agent group) plus `agent_group_members` (the
unprivileged access gate).

| Entity                                | Trust Level  | Rationale                                                                                |
| ------------------------------------- | ------------ | ---------------------------------------------------------------------------------------- |
| Owners / admins (`user_roles`)        | Trusted      | Hold owner/admin roles; gate admin commands and approve credentialed actions             |
| Group members (`agent_group_members`) | Access-gated | Membership grants access to an agent group, but their messages are still untrusted input |
| Unregistered senders                  | Untrusted    | Subject to each messaging group's `unknown_sender_policy`                                |
| Agent containers                      | Sandboxed    | Long-lived per-session container; isolated by mounts, non-root, no host reach            |
| Incoming messages                     | User input   | Potential prompt injection regardless of who sent them                                   |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in containers (Docker), providing:

- **Process isolation** — container processes cannot affect the host
- **Filesystem isolation** — only explicitly mounted directories are visible
- **Non-root execution** — runs as an unprivileged user (`node`, uid 1000, or the host uid remapped in)
- **Per-session containers** — one long-lived container per session polls that session's DBs and handles many messages, then is torn down (`--rm`) when the session goes idle.

This is the primary security boundary. Rather than relying on application-level
permission checks, the attack surface is limited by what's mounted.

### 2. Mount Security

`buildMounts` (`src/container-runner.ts`) composes a fixed set of mounts per
spawn. For the default (Claude) provider these are:

| Container path                       | Host source                                | Mode                    | Purpose                                                             |
| ------------------------------------ | ------------------------------------------ | ----------------------- | ------------------------------------------------------------------- |
| `/workspace`                         | `data/v2-sessions/<group>/<session>/`      | RW                      | Session folder — `inbound.db`, `outbound.db`, `outbox/`, `.claude/` |
| `/workspace/agent`                   | `groups/<folder>/`                         | RW                      | Agent group working files + `CLAUDE.local.md`                       |
| `/workspace/agent/container.json`    | group `container.json`                     | RO                      | Container config — readable, not writable                           |
| `/workspace/agent/CLAUDE.md`         | composed `CLAUDE.md`                       | RO                      | Regenerated every spawn; agent edits would be clobbered             |
| `/workspace/agent/.claude-fragments` | group `.claude-fragments/`                 | RO                      | Composer skill/MCP fragments                                        |
| `/app/CLAUDE.md`                     | `container/CLAUDE.md`                      | RO                      | Shared base doc imported by the composed entry point                |
| `/home/node/.claude`                 | `data/v2-sessions/<group>/.claude-shared/` | RW                      | Claude state, settings, skill symlinks                              |
| `/app/src`                           | `container/agent-runner/src/`              | RO                      | Shared agent-runner source (same for all groups)                    |
| `/app/skills`                        | `container/skills/`                        | RO                      | Shared container skills                                             |
| `/workspace/extra/<name>`            | allowlisted host dir                       | RO (RW only if allowed) | Operator-configured additional mounts                               |

The config mounts (`container.json`, `CLAUDE.md`, `.claude-fragments`) are
**nested read-only mounts on top of the read-write group dir** — the agent can
read its config but cannot modify it. The project root is **never mounted**: the
container only ever sees the paths above plus any provider-contributed mounts
(e.g. an OpenCode XDG dir). Host application source (`src/`, `dist/`,
`package.json`) is not reachable.

Shared memory content is read only by the provider's SessionStart hook inside
the container. Host-side project-document composers emit pointers but never
open `memory/index.md` or linked agent-controlled files. A memory symlink can
therefore reach only paths already visible inside that container, not arbitrary
host files.

**Additional-mount allowlist** — extra mounts from a group's container config
are validated against an allowlist at `~/.config/nanoclaw/mount-allowlist.json`,
which is:

- Outside the project root
- Never mounted into containers
- Not modifiable by agents

Its schema:

```json
{
  "allowedRoots": [
    { "path": "~/projects", "allowReadWrite": true, "description": "Dev projects" },
    { "path": "~/Documents/work", "allowReadWrite": false, "description": "Read-only" }
  ],
  "blockedPatterns": ["password", "secret", "token"]
}
```

**Default blocked patterns** (merged with any in the file):

```
.ssh, .gnupg, .gpg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, .pypirc, id_rsa, id_ed25519,
private_key, .secret
```

**Enforcement** (`src/modules/mount-security/index.ts`):

- **No allowlist file ⇒ every additional mount is blocked** — the fixed mounts above are unaffected, but nothing extra is granted until the operator creates the file.
- Symlinks are resolved to their real path (`realpathSync`) before any check, defeating traversal via symlink.
- The real path is rejected if it matches a blocked pattern, and rejected unless it sits under one of `allowedRoots`.
- The container path is validated: relative, non-empty, no `..`, no leading `/`, no `:` (blocks Docker `-v` option injection). It is mounted under `/workspace/extra/`.
- **Read-write is granted only when the mount requests it (`readonly: false`) _and_ the matched root has `allowReadWrite: true`.** Otherwise the mount is forced read-only.

### 3. Session Isolation

Per-session state lives under `data/v2-sessions/<agent-group>/<session>/`
(`inbound.db`, `outbound.db`, `outbox/`, `.claude/`). Claude state
(`.claude-shared`) and the working folder are scoped to the agent group, so:

- Different agent groups cannot see each other's conversation history or files.
- A group's sessions share that group's memory but keep separate message DBs.

This prevents cross-group information disclosure.

### 4. Credential Isolation (OneCLI Agent Vault)

Real API credentials **never enter containers**. NanoClaw uses [OneCLI's Agent Vault](https://github.com/onecli/onecli) to proxy outbound requests and inject credentials at the gateway level.

**How it works:**

1. Credentials are registered once with `onecli secrets create`, stored and managed by OneCLI
2. When NanoClaw spawns a container, it calls `applyContainerConfig()` to route outbound HTTPS through the OneCLI gateway
3. The gateway matches requests by host and path, injects the real credential, and forwards
4. Agents cannot discover real credentials — not in environment, stdin, files, or `/proc`

**Per-agent policies:**
Each NanoClaw group gets its own OneCLI agent identity. This allows different credential policies per group (e.g. your sales agent vs. support agent). OneCLI supports rate limits, and time-bound access and approval flows are on the roadmap.

**Never on the container filesystem:**

- The project root and `.env` — never mounted; the container only receives the paths in the mount table above.
- The mount allowlist — external (`~/.config/nanoclaw/…`), never mounted.
- Real credentials — injected per request by the OneCLI gateway, never written into any mount.

### 5. Egress Lockdown (Forced Proxy)

The `HTTPS_PROXY` env var only redirects _proxy-aware_ clients — a tool that
ignores it (or a raw socket) could reach the internet directly and bypass
credential injection, approvals, and audit. Egress lockdown closes that hole at
the network layer.

**How it works:** agents are placed on a Docker `--internal` network
(`nanoclaw-egress`) that has **no route to the internet**. The OneCLI gateway
container is attached to that network, aliased as `host.docker.internal`, so the
injected proxy URL (`…@host.docker.internal:10255`) resolves to the gateway
_container-to-container_. The gateway is therefore the **only reachable hop** —
anything else has nowhere to go. The agent is non-root with no `NET_ADMIN`, so
it cannot undo this. Identical mechanism on macOS and Linux (no host firewall,
no `host-gateway` route).

- **Self-healing:** the gateway is re-attached to the network at every spawn and
  on each host-sweep tick, so an out-of-band detach (e.g. `docker compose up` on
  the OneCLI stack — its compose lives in `~/.onecli`, not this repo) recovers
  automatically.
- **Fail-fast:** if lockdown is on but the network can't be created or the
  gateway can't be attached (e.g. a non-standard gateway container name, or the
  gateway isn't running), nanoclaw **refuses to spawn the agent** and surfaces a
  clear error — it never silently falls back to open egress. Fix the cause (or
  set `NANOCLAW_EGRESS_LOCKDOWN=false`) and retry. The host-sweep re-heal is the
  exception: a heal failure there is logged but not fatal, since already-running
  agents stay on the internal net (no leak) until the gateway returns.

**Default: egress is open.** Lockdown is **off** unless you opt in; by default
the agent reaches the OneCLI gateway over the host-gateway path and outbound
traffic is not confined to the internal network.

**Configuration:**

| Env                        | Default           | Meaning                                                         |
| -------------------------- | ----------------- | --------------------------------------------------------------- |
| `NANOCLAW_EGRESS_LOCKDOWN` | `false`           | Set `true` to opt in (otherwise the host-gateway path is used). |
| `NANOCLAW_EGRESS_NETWORK`  | `nanoclaw-egress` | Network name.                                                   |
| `ONECLI_GATEWAY_CONTAINER` | `onecli`          | Gateway container to attach.                                    |

These variables are read from the **host process** environment (the service's
environment / `.env`), not from inside the container. The agent container is
started with only `TZ` and any provider-declared variables — host environment
variables, including secrets, are never forwarded into the agent.

**⚠ Behavior when enabled:** with lockdown on, agents have **no direct
internet** — all traffic must go through OneCLI. Proxy-aware clients (npm, pnpm,
pip, curl, node/bun with the proxy env) are unaffected. Any workflow that relies
on a **non-proxy-aware** tool reaching the internet directly will fail by design.
Lockdown is **off by default**; opt in with `NANOCLAW_EGRESS_LOCKDOWN=true`.

## Resource Limits

Every agent session container is memory- and PID-bounded by default. The host
also reserves each container's declared memory request before spawn and queues
wakes in FIFO order when admitting another container would exceed the host
memory budget.

| Env                            | Default                   | Meaning                                                                        |
| ------------------------------ | ------------------------- | ------------------------------------------------------------------------------ |
| `CONTAINER_CPU_LIMIT`          | _(empty — unbounded)_     | Passed to `--cpus` when set (e.g. `2`).                                        |
| `CONTAINER_MEMORY_LIMIT`       | `3g`                      | Install-wide `--memory` fallback.                                              |
| `CONTAINER_MEMORY_RESERVATION` | same as memory limit      | Install-wide admission request and `--memory-reservation` fallback.            |
| `CONTAINER_MEMORY_SWAP_LIMIT`  | same as memory limit      | Docker RAM-plus-swap total. Equal to the memory limit disables container swap. |
| `CONTAINER_MEMORY_BUDGET`      | 80% of Docker-visible RAM | Maximum sum of active and in-flight container memory requests.                 |
| `CONTAINER_PIDS_LIMIT`         | `1024`                    | Per-container PID ceiling.                                                     |
| `MAX_CONCURRENT_CONTAINERS`    | `24`                      | Secondary container-count ceiling. `0` disables only this count cap.           |

Per-group overrides are file-canonical in `groups/<folder>/container.json`:

```json
{
  "resources": {
    "memory": {
      "requestMb": 5120,
      "limitMb": 5120,
      "memorySwapLimitMb": 5120
    },
    "cpus": 2,
    "pidsLimit": 1024
  }
}
```

Codex groups also bound native subagent collaboration independently of the
Docker ceiling. The default is seven concurrent threads (one coordinator plus
six workers), and completed workers are instructed to call `close_agent` so
their MCP process trees are released. Exceptional groups can override the
provider cap without removing the container safety boundary:

```json
{
  "providerConfig": {
    "max_concurrent_threads_per_session": 5
  }
}
```

`ncl groups config update` exposes the same fields through
`--memory-request-mb`, `--memory-limit-mb`, `--memory-swap-limit-mb`,
`--cpus`, and `--pids-limit`. Changes take effect on the next container spawn.
Each session container consumes its own request, even when several sessions
belong to the same agent group.

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  Incoming Messages (potentially malicious)                         │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, input escaping
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing                                                │
│  • Role / access checks (user_roles, agent_group_members)        │
│  • Mount validation (external allowlist)                          │
│  • Container lifecycle                                            │
│  • OneCLI Agent Vault (injects credentials, enforces policies)   │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts only, no secrets
┌──────────────────────────────────────────────────────────────────┐
│                CONTAINER (ISOLATED/SANDBOXED)                     │
│  • Agent execution                                                │
│  • Bash commands (sandboxed)                                      │
│  • File operations (limited to mounts)                            │
│  • API calls routed through OneCLI Agent Vault                   │
│  • No real credentials in environment or filesystem              │
└──────────────────────────────────────────────────────────────────┘
```

## Supply Chain Security

NanoClaw intentionally tracks the latest stable dependency releases without a release-age delay. The shared release adapter rejects prerelease/beta/RC/dev/nightly, draft, yanked, source-only Graphify, and target-incompatible candidates. A registry error is reported as unknown and cannot be treated as current.

`bun scripts/container-updates.ts audit --format json` is the canonical audit for host pnpm dependencies, agent-runner Bun dependencies, Dockerfile pins, Graphify, and Codex-synchronized files. `apply` requires explicit item IDs and a writable clone. The Monday task is advisory only; `/update-container` asks for human selection and prepares reviewed PRs. Neither path merges or deploys.

Release freshness is not the safety boundary. These controls are:

- exact Docker/runtime pins and committed pnpm/Bun/Graphify lockfiles;
- unchanged build-script allowlists unless a human explicitly approves a new entry;
- test, build, diff, and manual-merge gates;
- separate host and container PRs because they have different activation and rollback boundaries;
- Graphify patch, upstream source, skill hash, wheel hash, platform, and capability-ledger checks.

### Build Script Allowlist

`allowBuilds` restricts which packages can execute install/postinstall scripts. Only packages set to `true` in this map are permitted to run build scripts during `pnpm install`. Currently allowed:

- `better-sqlite3` — compiles native SQLite bindings
- `esbuild` — downloads platform-specific binary
- `protobufjs` — generates protobuf bindings (used by Baileys/libsignal)
- `sharp` — downloads platform-specific image processing binary

Adding or enabling a package in this map requires human approval — build scripts execute arbitrary code with the installing user's permissions. `minimumReleaseAge: 0` is explicit because pnpm 11 otherwise defaults to a one-day delay; the project relies on exact locks, hashes, review, and build-script approvals instead.
