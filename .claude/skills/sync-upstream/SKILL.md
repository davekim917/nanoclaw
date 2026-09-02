---
name: sync-upstream
description: "Bring upstream nanocoai/nanoclaw work into this production-critical, heavily customized fork WITHOUT a big-bang merge — read-only merge-tree triage, theme-by-theme ports via scratch worktree + PR + Codex loop, and a deploy sequence with a spawn-success gate. Use instead of running /update-nanoclaw directly. Triggers: 'sync upstream', 'update nanoclaw', 'catch up with upstream', 'what did upstream ship', 'we are N commits behind', 'cherry-pick upstream', 'Node upgrade on the host'."
---

# Sync Upstream (fork-safe front-end to `/update-nanoclaw`)

This fork diverged from upstream trunk in 2026 (decision recorded 2026-09-02: 2,279 fork commits vs 488 upstream since the 2026-07-21 merge-base; 137 conflicting files, 44 architectural). A full `git merge upstream/main` is a rewrite of the spawn, sweep, router, delivery, session-manager and poll-loop paths, on a host two client groups use daily. This skill replaces "merge and resolve" with "inventory, decide per theme, port one theme per PR, deploy with a gate". `/update-nanoclaw` is still the tool for the cherry-pick mechanics and the A–F audit; this skill decides *what* to feed it and how to land it without downtime.

**Standing decisions (do not re-litigate without a trigger):** the async central-DB, session-driver, mailbox and durable-host seams are DECLINED (upstream ships only SQLite and only Docker behind them). Upstream's Slack Agents provisioning model is DECLINED (fork already runs one app per agent via suffix tokens). Re-open triggers live in fork issue #234.

## When to use

- The daily "Upstream Check" report says N commits behind, or the user asks what upstream shipped.
- A specific upstream fix/feature is wanted (security, CVE, adapter fix, small feature).
- Any host runtime change that upstream forces (Node major, better-sqlite3, pnpm major).

Not for: skill-content refreshes (`/update-skills`), first-time setup, or fresh installs where a clean merge applies.

## Workflow

### 1. Preflight (read-only, ~2 min)

```bash
cd /home/ubuntu/nanoclaw-v2
git status --porcelain            # must be empty; never stash -u here
git fetch upstream --prune
BASE=$(git merge-base HEAD upstream/main)
git rev-list --count $BASE..upstream/main; git rev-list --count $BASE..HEAD
git merge-tree --write-tree --name-only HEAD upstream/main > /tmp/mt.txt; grep -c '^CONFLICT' /tmp/mt.txt
```

`git merge-tree` is an in-memory merge: it never touches the live working tree. Do **not** run the `git merge --no-commit` dry-run from `/update-nanoclaw` Step 3 on this checkout — it rewrites files other agents and bind-mounted containers are reading.

Also check, every time:

| Check | Command | Why |
|---|---|---|
| Upgrade tripwire | `node_modules/.bin/tsx scripts/upgrade-state.ts get` vs `node -p "require('./package.json').version"` | Any port that bumps `version` halts the host on next build+restart. Keep the fork's version; never take upstream's. |
| Migration collision | `git diff --name-only --diff-filter=A $BASE..upstream/main -- src/db/migrations/` and `grep -rn "name: '" src/db/migrations/*.ts` | Ledger is keyed by `name`, NOT file number. Upstream 020–024 collide with fork file numbers; renumber files to the fork's next ordinal, keep upstream's `name`. A same-`name` migration is already applied (e.g. upstream 021 == fork 045). Register right after the aliased upstream `containerConfigs` migration if it ALTERs `container_configs` — that table is created late in the array. |
| Host runtime gate | `git show upstream/main:package.json \| grep -A2 engines` vs `node -v` | Upstream moved to Node ≥22 in 2.3.0. |
| Nested pnpm | use `node_modules/.bin/tsx` / `node_modules/.bin/vitest` directly | `pnpm exec` nested here costs ~80 s CPU and times out tool calls. |

### 2. Triage with parallel workers (read-only)

Spawn three `worker-high` agents at once, all git-against-refs only, writing to the scratchpad:

1. **upstream-inventory** — `git log --first-parent $BASE..upstream/main` grouped by theme with PR counts and hashes; every `[BREAKING]` CHANGELOG line verbatim; new migrations; new env vars; version bumps in `container/Dockerfile`.
2. **conflict-triage** — for each `CONFLICT` path from merge-tree: local intent (`git log $BASE..HEAD -- file`), upstream intent, severity TRIVIAL / SEMANTIC / ARCHITECTURAL / DROP-UPSTREAM.
3. **adapter-delta** — for each installed channel/provider (`src/channels/index.ts`, `src/providers/index.ts`): compare ours vs `upstream/channels` at the feature level, not file level. Our Slack adapter (`src/channels/slack.ts`) is a fork; never re-apply upstream's.

Then write the recommendation per theme: **take** (cherry-pick clean), **port** (re-home onto our shape), **own version** (we already built it differently), **declined** (with trigger), **n/a**. File or update `upstream-port` issues on the fork for anything not done now.

### 3. Port one theme per PR (scratch worktree, never the live checkout)

```bash
W=<scratchpad>/wt-<theme>
git worktree add --detach "$W" origin/main && cd "$W" && git switch -c port/<theme>
ln -s /home/ubuntu/nanoclaw-v2/node_modules "$W/node_modules"   # read-only use; NEVER pnpm install/rebuild in a worktree
git cherry-pick -x <sha>...                                        # resolve against fork intent
node_modules/.bin/tsc --noEmit -p tsconfig.json
node_modules/.bin/vitest run <targeted files>                      # never the whole suite concurrently with other sessions
gh pr create ...   # then run /pr-review-loop; Codex signal is findings OR 👍
git worktree remove "$W"                                           # from the live checkout, after the PR
```

Port rules that have already bitten:

- One producer per Docker flag: `dockerResourceLimitArgs` owns `--pids-limit`/`--memory`; `securityArgs`/`resolveContainerSecurity` owns cap-drop/no-new-privileges.
- Every `ARG *_VERSION` in `container/Dockerfile` must have an entry in `container/update-sources.json` or `src/container-updates.test.ts` fails CI.
- Keep the fork's Bun pin and `allowBuilds` untouched; take only the version bumps upstream intends.
- `package.json` `version` stays the fork's (tripwire). `packageManager` may move.
- Anything under `container/` in the PR ⇒ `./container/build.sh` before the restart.

### 4. Deploy (each PR alone, quiet window, rollback rehearsed)

```bash
gh pr merge <n> --merge            # merge commit, never squash (loses upstream topology)
git pull --ff-only origin main
cp data/v2.db data/v2.db.pre-<mig>-$(date +%s)        # if a migration is included
./container/build.sh               # if container/ changed; verify pins inside the image afterwards
pnpm run build && node -p "require('./dist/BUILD_INFO.json').sha" && git rev-parse HEAD   # must match
sudo systemctl restart nanoclaw-v2
```

**Post-restart gate — all four, or it is not deployed:**

```bash
MP=$(systemctl show -p MainPID --value nanoclaw-v2)
/proc/$MP/exe -v; systemctl show -p NRestarts --value nanoclaw-v2      # expected runtime, no crash loop
sudo tr '\0' '\n' < /proc/$MP/environ | grep -c '^NODE_USE_ENV_PROXY=' # must be 0 (see gotcha 2)
grep -c 'OneCLI gateway applied' logs/nanoclaw.log   # since restart, >0 within 2 min — THE spawn-success signal
docker ps --filter name=nanoclaw-v2- --format '{{.Names}}' | head -1 | xargs -r docker inspect --format '{{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.Config.Image}}'
```

"12 `Channel adapter started` + 0 ERROR" is **not** health: a host that refuses every spawn logs only WARN (`wakeContainer failed — host-sweep will retry`) and looks clean. Time filter the log in **local time** (`TZ=America/New_York`), not UTC — the log stamps are ET.

### 5. Host runtime upgrades (Node major, native addons)

Only `better-sqlite3` is ABI-bound in the host tree (raw V8; lightningcss/rolldown are N-API). Sequence:

1. Stop the timers that shell into tsx/ncl: `sudo systemctl stop nanoclaw-health-sentinel.timer nanoclaw-storage-gc.timer nanoclaw-fleet-drift.timer`.
2. **`sudo systemctl stop nanoclaw-v2`** — accept ~60 s planned downtime.
3. Back up the apt source, swap it, `sudo apt-get install -y nodejs=<ver> && pnpm rebuild better-sqlite3`, then `node -e "require('better-sqlite3')"`.
4. `sudo systemctl start nanoclaw-v2`; `sudo systemctl restart nanoclaw-codex-sync` (holds the deleted old node inode); re-`start` the timers.
5. Run the Step 4 gate. Do not build `dist/` in the same change unless HEAD == BUILD_INFO sha already; one variable per restart.

Rollback: restore the apt source backup, `apt-get install --allow-downgrades nodejs=<old>`, `pnpm rebuild better-sqlite3` (old ABI copy is still in the pnpm store), restart. Never restore `node_modules.pre-deploy/` (`deploy-crash-guard` refuses `runtime-changed` for this reason).

## Gotchas (each one cost real downtime)

1. **Rebuilding a native addon while the host runs segfaults it.** `prebuild-install` overwrites `better_sqlite3.node` in place (hardlinked into the pnpm store); the live process's mmap changes underneath and it dies with SIGSEGV + a 5 GB core dump. Stop the service first. (2026-09-02, ~30 s outage + false unit alert.)
2. **Node ≥22.23 honors `NODE_USE_ENV_PROXY=1`; Node 20 ignored it.** The daemon carries `HTTPS_PROXY` = the OneCLI gateway. On Node 22 the host's own `fetch()` to the OneCLI control API (`127.0.0.1:10254`) went through the proxy and failed → every spawn refused for 11 minutes with the host "healthy". Fixed by `/etc/systemd/system/nanoclaw-v2.service.d/node22-env-proxy.conf` (`ExecStart=… onecli run -- /usr/bin/env -u NODE_USE_ENV_PROXY /usr/bin/node …`). The tell is `[UNDICI-EHPA] EnvHttpProxyAgent is experimental` on process start. Keep the drop-in; verify with the environ grep in the gate.
3. **`/update-nanoclaw`'s live dry-run merge and `migrate-nanoclaw` are wrong tools here** — the first edits the live tree, the second assumes customizations small enough to extract and replay.
4. **`/migrate-slack-agents` must not be run** — it detects an unsuffixed `SLACK_BOT_TOKEN` (we have none) and its later phases assume upstream's provisioning substrate.
5. **Worker reports about "silently skipped migrations" are wrong** — the ledger is name-keyed. Renumber files, keep names.
6. **A pre-existing ~28% intermittent `OneCLI gateway not applied` rate exists (issue #239)** — one refusal after a restart is not a regression; zero successes is.
7. **The image's `pnpm --version` may not equal `PNPM_VERSION`** (issue #240) — verify pins *inside* the built image, not from the Dockerfile.

## References

- Decision + triggers: fork issue #234; memory `project_upstream_trunk_merge_declined_2026_09_02`.
- Node 22 runbook + incidents: memory `project_node22_upgrade_2026_09_02`.
- Backlog: fork issues labeled `upstream-port`.
- Prior full merges (union/keep-ours decisions): memories `project_upstream_merge_2026_07_12`, `project_upstream_merge_2026_06_16`.
