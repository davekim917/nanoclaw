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

The container image also has pnpm + Node inside for global CLIs (`@anthropic-ai/claude-code`, `agent-browser`, `vercel`). Those are Node binaries the agent invokes at runtime, not library deps. Keeping them on pnpm preserves the supply-chain policy for CLI versions.

## Lockfiles

| Tree         | Lockfile                          | Manager                  | Regenerate after dep change                |
| ------------ | --------------------------------- | ------------------------ | ------------------------------------------ |
| Host         | `pnpm-lock.yaml`                  | package.json-pinned pnpm | `pnpm install`                             |
| Agent-runner | `container/agent-runner/bun.lock` | Bun 1.3+                 | `cd container/agent-runner && bun install` |

All are committed. CI and the Dockerfile run frozen/hash-locked install variants — any dependency drift fails the build.

## Supply chain

- **Host + global CLIs** (pnpm): latest stable releases, including majors, with committed manifests/lockfiles and the unchanged `allowBuilds` map. `minimumReleaseAge: 0` makes the no-delay policy explicit across pnpm 10 and 11. See `pnpm-workspace.yaml`, `docs/SECURITY.md`, and `docs/dependency-updates.md`.
- **Agent-runner** (Bun): the same latest-stable policy, exact manifest declarations, and committed `bun.lock`. High-impact SDK majors still require review and the full container test lane.

## Image build surface

`container/Dockerfile` uses a pinned helper stage for MCP Toolbox, then a `node:22-slim` runtime stage:

- **Pinned ARGs** — Bun, pnpm, helper tools, and global Node CLI versions are explicit Dockerfile build arguments. Bump deliberately in PRs. `INSTALL_CJK_FONTS` is the only feature-style build argument.
- **CJK fonts** — `ARG INSTALL_CJK_FONTS=false`. `container/build.sh` reads `INSTALL_CJK_FONTS` from `.env` and passes it through. Default build saves ~200MB; opt in when the user works with Chinese/Japanese/Korean content.
- **BuildKit cache mounts** — `/var/cache/apt`, `/var/lib/apt`, `/root/.bun/install/cache`, `/root/.cache/pnpm`. Rebuilds where `package.json`/`bun.lock` haven't changed are fast. Requires BuildKit (default on Docker 23+, Apple Container-compat).
- **`tini` as init** — reaps Chromium zombies, forwards signals so in-flight `outbound.db` writes finalize on SIGTERM.
- **`entrypoint.sh`** (extracted) — `exec bun run /app/src/index.ts` under tini. Readable and diffable.
- **No compiled `/app/dist`** — Bun runs TS directly. The host also mounts source over `/app/src` at session start. Since PR 0 of the mailbox seam (`src/agent-runner-source.ts`), that mount is a snapshot of `container/agent-runner/src` taken once at host boot, not the live checkout — a runner-source edit takes effect at the next host restart, not the next spawn. `NANOCLAW_AGENT_RUNNER_SRC_LIVE=1` mounts the checkout directly for local dev.

## Build versus activation

`./container/build.sh` produces and exercises a candidate image only. It does
not restart `nanoclaw-v2.service`, replace an active container, or make the
candidate live. Rollout is a separate decision that must check in-flight turns
before activation.

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

## Test hermeticity

Unit tests on both trees run behind a tripwire that records and reports any call
reaching outside the process (issue #305). It exists because two suites were
found doing exactly that on the same day: one advanced fake timers past the
plugin updater's startup delay and ran a real `git pull` across every repo under
`~/plugins` — a live, fail-closed mount into every agent container, where a
mid-pull tree denies every tool fleet-wide — and another had been doing a real
disk walk plus a GitHub and an Anthropic API call since before anyone looked.

- Host: `src/test-hermeticity.ts`, loaded from `setupFiles` in `vitest.config.ts`.
- Agent-runner: `container/agent-runner/src/test-hermeticity.ts`, loaded from
  `preload` in `bunfig.toml` ahead of the composition barrel.

Three seams are guarded. `child_process` and `node:child_process` have every
spawning export wrapped. `globalThis.fetch`, and `undici`'s `fetch`/`request` on
the host, are wrapped the same way. Writes through `fs` and `fs/promises` are
checked against a denylist of paths a unit test has no business touching:
`~/plugins`, and the checkout's own `data/`, `groups/`, `dist/`, `logs/` and
`node_modules/`, plus `$HOME` dotfiles. Writes under the temp directory, where
`uniqueTmpRoot` puts every fixture, are untouched — a denylist rather than an
allowlist, because fixtures live all over `/tmp` while the escapes worth
catching are a short known list.

A test that legitimately needs one of these opts in by name, so the exemption
shows up in the diff:

```ts
import { allowSubprocess, allowNetwork, allowWritesTo } from './test-hermeticity.js';
beforeAll(() => allowSubprocess(['git']));
```

`NANOCLAW_TEST_HERMETICITY` sets the mode: `warn` (the default) records and logs
the call site, `enforce` throws, `off` disables the guard. The default is `warn`
because the suite is not clean yet — the first full host run under the guard
failed 40 of 313 files, nearly all of them suites that shell out to real `git`
against a scratch checkout. The ratchet is per file: a host suite that is
hermetic calls `enforceHermeticity()` in its own body and can never regress.
There is no per-file equivalent on the runner, because `bun test` shares one
process across every file and flipping the mode would silently enforce
everything that ran afterwards; a runner suite wraps the call in
`withHermeticityMode('enforce', ...)` instead.

Recording matters independently of throwing. Most host callers already wrap
their real work in `try`/`catch` so a git or network failure never crashes the
host, which means a throw-only tripwire can fire and still leave a test green.

## Key invariants

- **Session DBs must use `journal_mode=DELETE`.** WAL's `-shm` memory-map doesn't cross VirtioFS between host and guest. See the doc comment at the top of `container/agent-runner/src/db/connection.ts` and `src/session-manager.ts`.
- **Named SQL parameters in the container require the prefix in JS object keys.** `bun:sqlite` does not auto-strip `@`/`$`/`:` the way `better-sqlite3` does on the host. Use `$name` in both SQL and keys: `.run({ $id: msg.id })`. Positional `?` params work normally.
- **Agent-runner tests run under `bun:test`, not vitest.** `vitest.config.ts` excludes the `container/agent-runner/` tree because vitest runs on Node and can't load `bun:sqlite`.
- **No tsc build step in the container image.** Re-adding one would reintroduce the ~200-500ms per-session-wake cost we removed.
- **Global container CLIs stay on pnpm, not Bun.** `agent-browser`, `@anthropic-ai/claude-code`, `vercel` and any future Node CLIs the agent invokes should be pinned versions under the Dockerfile's pnpm global-install block. `bun install -g` would bypass the pnpm supply-chain policy.

## Migration history

This structure replaced a uniform npm-on-Node stack across both host and container. The pnpm migration landed first (PR #1771) to bring the host under supply-chain policy, then the container moved to Bun to eliminate native-module compilation and the per-wake tsc step. The split was chosen over going full-Bun because Baileys' native deps are the main risk surface on the host — the container has no such deps, so it benefits from Bun without taking the risk.
