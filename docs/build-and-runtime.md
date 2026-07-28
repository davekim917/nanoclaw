# Build & Runtime

NanoClaw runs a split stack: the host is Node + pnpm, the agent container is Bun. They communicate exclusively through two SQLite files per session — there are no shared modules between them, which is what lets them use different runtimes cleanly.

## Why the split

- **Host stays on Node** because Baileys (WhatsApp) depends on `libsignal-node` native bindings and a long-tested WebSocket/HTTP stack. Bun's Node-API compat has improved, but this isn't where we want risk.
- **Container runs Bun** because `bun:sqlite` is built-in (no native compile of `better-sqlite3` per image rebuild), source runs directly (no tsc build step at image build or session wake), and `bun install` is ~5-10× faster than `npm install`.

Host and container each have their own package tree:

```
/                             pnpm + Node 22
  pnpm-lock.yaml              host deps (channels, Chat SDK, Baileys, better-sqlite3, etc.)
  pnpm-workspace.yaml         allowBuilds + latest-stable policy

/container/agent-runner/      Bun 1.3+
  bun.lock                    agent-runner runtime deps (Claude Agent SDK, MCP SDK, zod, etc.)
  package.json                @types/bun, typescript devDeps for type-checking
```

The container image also has pnpm + Node inside for global CLIs (`@anthropic-ai/claude-code`, `agent-browser`, `vercel`). Those are Node binaries the agent invokes at runtime, not library deps. Keeping them on pnpm preserves the supply-chain policy for CLI versions. Graphify is different: it is an isolated Python environment used only through NanoClaw's enforcing gateway.

## Lockfiles

| Tree         | Lockfile                               | Manager                      | Regenerate after dep change                                |
| ------------ | -------------------------------------- | ---------------------------- | ---------------------------------------------------------- |
| Host         | `pnpm-lock.yaml`                       | package.json-pinned pnpm     | `pnpm install`                                             |
| Agent-runner | `container/agent-runner/bun.lock`      | Bun 1.3+                     | `cd container/agent-runner && bun install`                 |
| Graphify     | `container/graphify-requirements.lock` | uv + pip, exact wheel hashes | `bun scripts/update-graphify.ts --version <latest-stable>` |

All are committed. CI and the Dockerfile run frozen/hash-locked install variants — any dependency drift fails the build.

## Supply chain

- **Host + global CLIs** (pnpm): latest stable releases, including majors, with committed manifests/lockfiles and the unchanged `allowBuilds` map. `minimumReleaseAge: 0` makes the no-delay policy explicit across pnpm 10 and 11. See `pnpm-workspace.yaml`, `docs/SECURITY.md`, and `docs/dependency-updates.md`.
- **Agent-runner** (Bun): the same latest-stable policy, exact manifest declarations, and committed `bun.lock`. High-impact SDK majors still require review and the full container test lane.
- **Graphify** (Python): [`graphify-integration.json`](../container/graphify-integration.json) is the canonical release/commit/optional-compatibility-patch/capability ledger. [`graphify-requirements.lock`](../container/graphify-requirements.lock) and [`graphify-wheel-audit.json`](../container/graphify-wheel-audit.json) define the complete Python 3.11/Linux ARM64, wheel-only closure without an age cutoff. The image downloads with hashes, then installs offline with `--require-hashes --only-binary=:all: --no-deps`; no package range or source build is resolved during installation. When active, [`graphify-typescript-namespaces.patch`](../container/graphify-typescript-namespaces.patch) applies once with exact-context and reverse-application checks after the candidate engine has been behavior-tested.

## Image build surface

`container/Dockerfile` uses pinned helper stages for MCP Toolbox and RTK, then a `node:22-slim` runtime stage:

- **Pinned ARGs** — Bun, pnpm, helper tools, and global Node CLI versions are explicit Dockerfile build arguments. Bump deliberately in PRs. `INSTALL_CJK_FONTS` is the only feature-style build argument.
- **CJK fonts** — `ARG INSTALL_CJK_FONTS=false`. `container/build.sh` reads `INSTALL_CJK_FONTS` from `.env` and passes it through. Default build saves ~200MB; opt in when the user works with Chinese/Japanese/Korean content.
- **BuildKit cache mounts** — `/var/cache/apt`, `/var/lib/apt`, `/root/.bun/install/cache`, `/root/.cache/pnpm`. Rebuilds where `package.json`/`bun.lock` haven't changed are fast. Requires BuildKit (default on Docker 23+, Apple Container-compat).
- **`tini` as init** — reaps Chromium zombies, forwards signals so in-flight `outbound.db` writes finalize on SIGTERM.
- **`entrypoint.sh`** (extracted) — `exec bun run /app/src/index.ts` under tini. Readable and diffable.
- **No compiled `/app/dist`** — Bun runs TS directly. The host also mounts fresh source over `/app/src` at session start, so host edits take effect without rebuilding the image.

## Container code intelligence (Graphify)

Container sessions and host/operator work use Graphify for advisory source navigation. The Graphify runtime has a deliberately narrow public/private split:

- `/opt/graphify` is a private, wheel-locked Python environment. Its upstream console script is removed and its `bin` directory is not added to `PATH`.
- `/usr/local/bin/graphify` is NanoClaw's public, standard-library gateway from [`graphify-gateway.py`](../container/graphify-gateway.py). It exposes only `query`, `path`, `explain`, and `affected`, plus side-effect-free help/version.
- `/opt/graphify/graphify-worker.py` is the private worker from [`graphify-worker.py`](../container/graphify-worker.py). The gateway invokes it by absolute path after applying command, freshness, admission, and resource policy. Agents do not run extraction, installation, watch, MCP, global-graph, or user-selected output paths.

The mandatory [`graphify` skill](../container/skills/graphify/SKILL.md) tells container agents to create or reuse a managed checkout below `/workspace/worktrees` and invoke a read command from there. There is no startup scan, background indexer, commit hook, or manual refresh step. Every read inventories the current checkout, including tracked edits, untracked source, and deletions.

Engine releases are accepted by installed behavior, not by matching Graphify's
internal file layout or upstream agent instructions. The ARM64 wheel closure is
hash-locked, and `container/tests/graphify_engine_contract.py` verifies
deterministic TypeScript type/value namespace extraction. The manifest's
temporary compatibility patch is applied only while unmodified upstream fails
that contract; upstream skill and prompt changes are reviewed on their own
lifecycle.

For a changed generation, the gateway captures an immutable source copy, verifies that capture against fresh live inventories, runs Graphify in a limited private process, validates the complete graph and per-file contribution, and only then promotes the candidate. Promotion uses same-filesystem renames to provide process-atomic namespace visibility; it is not a claim of an atomic live-filesystem snapshot or power-loss durability. If capture, extraction, validation, admission, or promotion fails after source changed, the command returns an error with direct-source-inspection guidance and never queries a stale prior graph.

### Cache and lifecycle

Graph data never lives in a checkout or Git-private metadata. `src/container-runner.ts` mounts host application state at `/workspace/.cache/graphify`: a session cache normally, or a shared thread cache when sibling thread worktrees are enabled. It also mounts the install-scoped runtime directory at `/run/nanoclaw-graphify`; `worker.lock` there serializes every extraction and cached query to one Graphify worker across the host. Valid cache survives container restarts.

`src/worktree-cleanup.ts` removes a repository cache only through the corresponding safe worktree lifecycle. It skips live participants, dirty worktrees, unpushed work, and unknown session mappings; it also prunes an orphan cache only when the matching worktree is gone and the participant guards pass. Corrupt-worktree replacement invalidates that repository's cache before replacement.

### Resource boundary

Each container gets an empty-on-start 192 MiB tmpfs at `/workspace/.graphify-stage`; all newly generated Graphify output starts there. The gateway refuses more than 4,000 detected code files, any code file over 5 MiB, or aggregate detected input over 64 MiB. Reusable AST seeds are capped at 128 MiB and the accepted graph at 64 MiB.

The private worker is single-process and child-free: native thread counts are one, `RLIMIT_AS` is 1,024 MiB, `RLIMIT_FSIZE` is 64 MiB, and `RLIMIT_NPROC` is zero. Before spawning it, the gateway checks cgroup v2 headroom for the worker, bounded staging, and a 512 MiB protected runner reserve. Timeouts terminate the worker process group with TERM, a bounded grace period, then KILL/reap before locks are released.

The approved production-style Graphify profile keeps `requestMb=2048` as normal-residency admission accounting and `limitMb=5120` as the hard burst/OOM boundary. The request is not a Graphify memory ceiling: one host-wide admitted worker may use a bounded transient burst, while the hard limit and 512 MiB reserve remain the safety gate. Group E runtime QA must prove those numbers on the candidate image before activation; it may not silently raise the request or any Graphify limit.

### Build versus activation

`./container/build.sh` and the Group D/E checks produce and exercise a candidate image only. They do not restart `nanoclaw-v2.service`, replace an active container, or make the candidate live. After image, freshness, cache-isolation, resource, and agent-value gates pass, `/team-ship` owns the separate rollout decision and must check in-flight turns before activation.

## Session wake (two paths)

1. **Base image ENTRYPOINT** — used for stdin-piped test invocations like the sample in `container/build.sh`: `tini --> entrypoint.sh` captures stdin to `/tmp/input.json`, then `exec bun run src/index.ts`.
2. **Host-spawned session** — `src/container-runner.ts` at line ~503 uses `--entrypoint bash` with `-c 'exec bun run /app/src/index.ts'`. Bypasses tini (Docker's default PID 1 handling applies). Stdin is unused; all IO flows through the mounted session DBs.

Both paths end with Bun running the same source file from `/app/src/index.ts`.

## Host liveness and channel catch-up

Storage inventory and cleanup remain enabled, but their synchronous filesystem walks, SQLite reads, recursive cache removals, and Docker commands run in a persistent Node worker thread (`src/storage-maintenance-worker*.ts`). The host sweep only submits/coalesces work and handles the resulting pressure report. Normal container admission uses an asynchronous `statfs` probe; only a filesystem at cleanup pressure enters the serialized maintenance queue. This keeps the main Node event loop available for channel heartbeats and inbound routing without weakening disk-pressure admission.

Channel recovery is an adapter contract rather than a Discord special case. Before platform initialization, each Chat SDK bridge durably preserves the prior cursor as an unresolved startup gap. The host then catches up after startup, transport reconnects, and detected event-loop stalls; platform adapters can augment wired roots and known sessions with native thread discovery (including threads created while the host was unavailable). Live callbacks received during partial startup are held in arrival order until the first recovery pass has run and permissions/delivery wiring is ready. Replayed messages traverse the normal router and are deduplicated by platform message ID at channel ingress and again in each session DB. A cursor advances only after every target was covered successfully, while incomplete passes retain the earliest gap and retry autonomously with bounded exponential backoff.

## CI shape

`.github/workflows/ci.yml` installs both Node (with pnpm cache) and Bun, then runs in order:

1. `pnpm install --frozen-lockfile` (host)
2. `bun install --frozen-lockfile` in `container/agent-runner/` (container)
3. `pnpm run format:check`
4. `pnpm exec tsc --noEmit` (host typecheck)
5. `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` (container typecheck)
6. `pnpm exec vitest run` (host tests)
7. `bun test --max-concurrency 1` in `container/agent-runner/` (container tests; the suite shares process-global session fixtures)

Any failure fails the PR.

## Key invariants

- **Session DBs must use `journal_mode=DELETE`.** WAL's `-shm` memory-map doesn't cross VirtioFS between host and guest. See the doc comment at the top of `container/agent-runner/src/db/connection.ts` and `src/session-manager.ts`.
- **Named SQL parameters in the container require the prefix in JS object keys.** `bun:sqlite` does not auto-strip `@`/`$`/`:` the way `better-sqlite3` does on the host. Use `$name` in both SQL and keys: `.run({ $id: msg.id })`. Positional `?` params work normally.
- **Agent-runner tests run under `bun:test`, not vitest.** `vitest.config.ts` excludes the `container/agent-runner/` tree because vitest runs on Node and can't load `bun:sqlite`.
- **No tsc build step in the container image.** Re-adding one would reintroduce the ~200-500ms per-session-wake cost we removed.
- **Global container CLIs stay on pnpm, not Bun.** `agent-browser`, `@anthropic-ai/claude-code`, `vercel` and any future Node CLIs the agent invokes should be pinned versions under the Dockerfile's pnpm global-install block. `bun install -g` would bypass the pnpm supply-chain policy.

## Migration history

This structure replaced a uniform npm-on-Node stack across both host and container. The pnpm migration landed first (PR #1771) to bring the host under supply-chain policy, then the container moved to Bun to eliminate native-module compilation and the per-wake tsc step. The split was chosen over going full-Bun because Baileys' native deps are the main risk surface on the host — the container has no such deps, so it benefits from Bun without taking the risk.
