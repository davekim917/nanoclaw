---
name: sync-upstream
description: "Bring upstream nanocoai/nanoclaw work into this production-critical, heavily customized fork WITHOUT a big-bang merge — read-only merge-tree triage, theme-by-theme ports via scratch worktree + PR + Codex loop, and a deploy sequence with a spawn-success gate. Use instead of running /update-nanoclaw directly. Triggers: 'sync upstream', 'update nanoclaw', 'catch up with upstream', 'what did upstream ship', 'we are N commits behind', 'cherry-pick upstream', 'Node upgrade on the host'."
---

# Sync Upstream (fork-safe front-end to `/update-nanoclaw`)

This fork diverged from upstream trunk in 2026 around the spawn, sweep, router, delivery, session-manager and poll-loop paths, on a host the two production workgroups use daily. As of 2026-09-04 the fork is **490 commits behind upstream/main** (488 of those predate 2026-09-02 — upstream shipped only 2 more in the two days since). A read-only dry-run (`git merge-tree --write-tree`) touches 389 files on both sides, ~100 of them with real content conflicts, concentrated by area: `agent-runner/src` 26, `modules/permissions` 12, `setup` 11, `.claude` 11, `docs` 8, `cli/resources` 7, `agent-to-agent` 6, `approvals` 5, `scheduling` 4. A full `git merge upstream/main` is still never attempted directly — it would touch every one of the fork's own architectural seams at once. This skill replaces "merge and resolve" with "inventory, decide per theme, port one theme per PR, deploy with a gate". `/update-nanoclaw` is still the tool for the cherry-pick mechanics and the A–F audit; this skill decides *what* to feed it and how to land it without downtime.

**Standing decisions (do not re-litigate without a trigger):** the agent-mailbox seam and the host-lifecycle/host-sweep-duty-registry seam are **ADOPTED**, built in the fork's own shape rather than upstream's literal `src/mailbox/`/`src/drivers/` code (`docs/specs/upstream-mailbox-seam/plan.md`, `docs/specs/upstream-host-sweep-seam/plan.md`). All host session-DB access funnels through `src/modules/mailbox/` — the host allowlist is down to the two documented KEEP-PATCH exemptions — and `src/host-sweep.ts` is driver + registry only, with duties registered in `src/modules/sweep-*/` behind a 41-entry pinned registration table (`src/host-sweep-registry.test.ts`). When an upstream change lands in one of these areas, **port it INTO the seam**: take upstream's driver/façade shape, keep the fork's own registrations and module bodies, and re-run the drift tests (§1 below) — never hand-merge a seam file directly.

The remaining three items fork issue #234 recorded as declined on 2026-09-02 are **no longer declined** — treat that issue as a record of a decision since reversed, not as current guidance. **Async central-DB** (upstream's `[BREAKING] refactor(db): adopt async central database safely`, #3334) is being ported first, as **seam 3**: the fork's sync `better-sqlite3` central-DB access conflicts with upstream's async driver in nearly every theme, so seam 3 goes in ahead of general theme ports rather than being re-derived per theme forever. The **session-driver seam** (`adoptRunningSessions()`) plus the **durable-host coordination** rollup (upstream #3653: claim fencing, durable delivery attempts, durable respawn intent) are a committed **seam 4** — restart survival without pausing agent work is the operator's own stated must-have and needs both halves, landing alongside a redesign of the fork's boot-time workgroup shared-FS reconcile (which today forces every container to stop on host start, contradicting session adoption). Upstream's **Slack Agents provisioning/onboarding model is in scope**: port it and solve the suffix-token compatibility (the fork's `SLACK_BOT_TOKEN_<SUFFIX>` per-agent-app model) as an engineering problem, with a migration path for the fork's existing apps, rather than treating the incompatibility as a reason to decline. **Nothing from seam 3, seam 4, or the provisioning port merges or deploys without the operator's explicit go** — triage, plans, and PRs may proceed ahead of that, deploys don't.

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
| Migration collision | `git diff --name-only --diff-filter=A $BASE..upstream/main -- src/db/migrations/` and `grep -rn "name: '" src/db/migrations/*.ts` | Ledger is keyed by `name`, NOT file number. Fork's own migrations run 065–069 (065 `container-config-timezone`, 066 `approvals-instance`, 067 `cli-request-executions`, 068 `sessions-sweep-quiet-until`, 069 `messaging-group-name-source`); the next fork ordinal is **070**. An upstream migration file that collides with an already-used fork number gets renumbered to the fork's next free ordinal — keep upstream's `name` verbatim. A same-`name` migration is already applied; don't re-add it. A ported migration that ALTERs `container_configs` is registered right after the aliased `containerConfigs` migration in `src/db/migrations/index.ts` — the array runs in ARRAY order, not filename order, and that table is created late. |
| Host runtime gate | `git show upstream/main:package.json \| grep -A2 engines` vs `node -v` | Upstream moved to Node ≥22 in 2.3.0; fork is on Node 22 as of 2026-09-02. |
| Nested pnpm | use `node_modules/.bin/tsx` / `node_modules/.bin/vitest` directly | `pnpm exec` nested here costs ~80 s CPU and times out tool calls. |

**Drift tests — green before AND after every port, not just at the end.** These are the seams' own correctness gates; a port that fails one of them is not done, whatever the diff looks like:

| Seam | Test(s) | What it pins |
|---|---|---|
| Mailbox manifest | `src/mailbox-seam-upstream.test.ts` | every ported-verbatim upstream file's content hash matches `src/mailbox/UPSTREAM-MANIFEST.json` |
| Mailbox ratchet | `src/mailbox-seam-ratchet.test.ts` | the host allowlist (`src/mailbox/RATCHET.json`) never grows past its two documented KEEP-PATCH files |
| Mailbox composition | `src/mailbox-seam-composition.test.ts` | every code path that provisions a session actually loads the mailbox composition, not a bypass |
| Scripts-reach tripwire | `src/mailbox-seam-unreachable-scripts.test.ts` (+ `scripts/mailbox-seam-unreachable.test.ts`) | standalone scripts that are import-graph-reachable to the seam either route through it or are proven, by actual call graph, never to touch a session DB |
| Host-sweep registry pin | `src/host-sweep-registry.test.ts` | the 41-entry duty registration table; a moved or renamed duty without a matching table update fails here first |
| Host-lifecycle seam manifest | `src/host-lifecycle-seam.test.ts`, `src/host-lifecycle.test.ts` | ported-verbatim files against `src/host-lifecycle-seam/UPSTREAM-MANIFEST.json` |
| Agent-runner hermeticity | `container/agent-runner/src/test-hermeticity.test.ts` | no runner test reaches real network/filesystem outside its sandbox |

**Upstream-ownership ratchet — when present.** A generalized version of `storage-manager.ts`'s `computeOffenders` pattern (an allowlist of upstream-owned files the fork may still differ in, with a pinned per-file diff budget: growth fails the test, shrinkage is always allowed) is being built as part of the host-sweep seam's remaining work. It is not shipped yet as of 2026-09-04 — if its test file exists when you run this skill, add it to the drift-test table above and treat it the same as the others; if it doesn't, skip it.

### 2. Triage with parallel workers (read-only)

Spawn three `worker-high` agents at once, all git-against-refs only, writing to the scratchpad:

1. **upstream-inventory** — `git log --first-parent $BASE..upstream/main` grouped by theme with PR counts and hashes; every `[BREAKING]` CHANGELOG line verbatim; new migrations; new env vars; version bumps in `container/Dockerfile`.
2. **conflict-triage** — for each `CONFLICT` path from merge-tree: local intent (`git log $BASE..HEAD -- file`), upstream intent, severity TRIVIAL / SEMANTIC / ARCHITECTURAL / DROP-UPSTREAM. **A conflict inside a seam file (`src/modules/mailbox/**`, `src/mailbox/**`, `src/host-sweep.ts`, `src/modules/sweep-*/**`, `src/host-lifecycle-seam/**`) is never SEMANTIC-or-below by hand-merge** — its severity call is "port into the seam per the standing decision above", resolved by taking upstream's driver/façade shape and re-registering the fork's own duties/ops, not by merging the two files' bodies together.
3. **adapter-delta** — for each installed channel/provider (`src/channels/index.ts`, `src/providers/index.ts`): compare ours vs `upstream/channels` at the feature level, not file level. Our Slack adapter (`src/channels/slack.ts`) is a fork; never re-apply upstream's.

Then write the recommendation per theme: **take** (cherry-pick clean), **port** (re-home onto our shape), **own version** (we already built it differently), **declined** (with trigger), **n/a**. File or update `upstream-port` issues on the fork for anything not done now.

**Theme order:** the operator's own priorities first, then conflict severity. As of the 2026-09-04 kickoff the two named priorities are (a) agents surviving host restarts without their work pausing, and (b) Slack agent improvements — verify each actually exists in the upstream commit range before promising it; upstream subject lines are not proof of scope. Everything else orders by conflict severity from step 2, with seam-boundary conflicts (ported, not hand-merged) sequenced ahead of ordinary ARCHITECTURAL conflicts since they have a known resolution shape.

### 3. Port one theme per PR (scratch worktree, never the live checkout)

```bash
W=<scratchpad>/wt-<theme>
git -C /home/ubuntu/nanoclaw-v2 worktree add --detach "$W" origin/main
git -C "$W" switch -c port/<theme>
ln -s /home/ubuntu/nanoclaw-v2/node_modules "$W/node_modules"   # read-only use; NEVER pnpm install/rebuild in a worktree
git -C "$W" cherry-pick -x <sha>...                                # resolve against fork intent
(cd "$W" && node_modules/.bin/tsc --noEmit -p tsconfig.json)
(cd "$W" && ionice -c3 nice -n 10 node_modules/.bin/vitest run --pool=forks --maxWorkers=2 <targeted files>)   # load < 8; never the whole suite
# If the theme touches container/agent-runner/**: the root tsconfig only includes src/**/*, and the root
# vitest config excludes runner tests (they run under Bun, not Node) — the two commands above never see
# runner code at all. Verify it separately, including the mandatory hermeticity gate:
(cd "$W/container/agent-runner" && bun install && bun run typecheck && bun run test)
(cd /home/ubuntu/nanoclaw-v2 && pnpm run check:public-boundary -- --root "$W" --index)   # scans $W's commits; run from the live checkout only so pnpm/tsx resolve
(cd "$W" && gh pr create ...)   # gh's head branch is inferred from cwd — must run from $W; then run the pr-review-loop skill
git -C /home/ubuntu/nanoclaw-v2 worktree remove "$W"               # from the live checkout, after the PR
```

Port rules that have already bitten:

- **Every git command in a port worker's brief is `git -C /abs/path ...`**, never a bare `cd && git`; a fallen-through `cd` chain has landed a `git checkout <sha> -- .` in the live checkout before.
- **Never `git stash`, `-u` or otherwise**, in the live checkout or a worktree a peer might touch — live sessions write untracked files a stash would sweep up.
- **Synthetic ids only** in anything committed — source, tests, comments. A real `sess-…`/`ag-…`/`mg-…` id or an operator/client name in a comment blocks the next push from the live checkout (the boundary hook is blind in a worktree, and a GitHub merge runs no hook at all).
- **Before any push from a worktree**, run the boundary check with `--root` pointing at the *worktree* (that's the content it scans — `--index` reads each tracked file via `git show :<file>` under `--root`), executed from the live checkout so `pnpm`/`tsx` resolve — the same split the repo's own pre-push hook uses: `(cd /home/ubuntu/nanoclaw-v2 && pnpm run check:public-boundary -- --root "$W" --index)`. Pointing `--root` at the live checkout instead scans the live checkout's own (usually empty) index and proves nothing about the worktree's commits. **Read the message, not just the exit code**: if it says `structural patterns only — no identifier registry found` instead of `identifiers from main checkout`/`identifiers from local install`, the check was blind to real names and ids — it still exits 0, so a green run is not proof — do not push until the registry resolves (fork issue #374 tracks making this fail closed).
- **Targeted vitest only**, never a full suite concurrently with another session: `ionice -c3 nice -n 10 node_modules/.bin/vitest run --pool=forks --maxWorkers=2 <files>` at load < 8.
- **A bare `vi.mock` factory of a project module must spread `importOriginal`** (`vi.mock('../foo.js', async (importOriginal) => ({ ...(await importOriginal()), ... }))`) so a batch that adds an export doesn't silently undefine it for every mocking suite — except `./log.js`, which is intentionally a full stub (mocking the logger's real implementation is never wanted).
- **Codex thread counts come from the GraphQL `reviewThreads` API only** — the REST login filter silently returns 0 and reads as a clean review that never happened.
- **Codex silent for 15 minutes → fall back to a cross-model reviewer** (opencode or gemini) rather than waiting indefinitely or merging unreviewed.
- **The churn gate applies**: `codex-review.sh gate`/`push` refuse the next commit once one finding class has drawn findings across 3+ review rounds with severity not falling — the fix at that point is a reframe at the shared primitive, named in a `Reframe: <invariant> enforced in <primitive>` commit trailer, not another patch at the next site. For heuristic/classifier-style code specifically, decide the posture up front (e.g. "ambiguity makes the check fail closed"), cap the review budget at 3 rounds regardless of severity, and file any remaining low-severity residue as an issue rather than chasing it to zero.
- One producer per Docker flag: `dockerResourceLimitArgs` owns `--pids-limit`/`--memory`; `securityArgs`/`resolveContainerSecurity` owns cap-drop/no-new-privileges.
- Every `ARG *_VERSION` in `container/Dockerfile` must have an entry in `container/update-sources.json` or `src/container-updates.test.ts` fails CI.
- Keep the fork's Bun pin and `allowBuilds` untouched; take only the version bumps upstream intends.
- `package.json` `version` stays the fork's (tripwire). `packageManager` may move.
- Anything under `container/` in the PR ⇒ `./container/build.sh` before the restart.

### 4. Deploy (live checkout has exactly one writer — the deployer)

The live checkout `/home/ubuntu/nanoclaw-v2` is shared by every session in the convergence program; only the session executing THIS deploy writes to it. Everyone else sends `git format-patch` files into the deployer's scratchpad inbox instead of touching the checkout directly (see "Multi-session protocol" below).

```bash
cd /home/ubuntu/nanoclaw-v2
# 1. Announce BUILD START first — no merges or pushes to main by anyone (including origin) until the gate result lands.
gh pr merge <n> --merge            # merge commit, never squash (loses upstream topology)
gh pr view <n> --json state,mergeCommit --jq '.state, .mergeCommit.oid'   # must print MERGED and a real sha before pulling —
                                    # `gh pr merge` only guarantees the merge if it landed immediately; with required
                                    # checks pending it enables auto-merge/queues instead, and a pull right after can
                                    # silently stay on the OLD origin/main (the sha-equality check downstream still
                                    # "passes" for that old commit)
git pull --ff-only origin main     # HEAD must now equal origin/main; a non-fast-forward here means announce again and retry
```

If the PR includes a migration, back up the live DB with a **hot** `better-sqlite3` backup — never `cp` a live SQLite file:

```bash
node -e "const Database = require('better-sqlite3'); const db = new Database('data/v2.db', { readonly: true }); db.backup('data/v2.db.pre-<slot>-' + Date.now()).then(() => process.exit(0));"
```

Build under the `check-build-clean` guard (`scripts/check-build-clean.ts`), which refuses to build unless `HEAD == origin/main` and refuses (postbuild) if `HEAD` moved while the build ran; docs-only dirt is exempted, everything else blocks:

```bash
./container/build.sh               # first, if anything under container/ changed; verify pins inside the built image afterwards
pnpm run build
node -p "require('./dist/BUILD_INFO.json').sha" && git rev-parse HEAD && git rev-parse origin/main   # all three must match
grep -c <a-symbol-the-PR-introduced> dist/<file>.js   # content proof — a sha match alone is not proof the PR is in dist
```

**Restart only when the fleet is actually quiet** — the full rule (`docs/specs/upstream-mailbox-seam/plan.md` §6): no deliveries for 10 minutes and no container younger than 5 minutes. "No deliveries" means both delivery log lines, not just one — `src/delivery.ts` logs `Status delivered` for status-message updates and a separate `Message delivered` for ordinary chat replies; a check that greps only the first can call the fleet quiet while a container is mid-turn on a normal reply. A short waiter loop against both lines, plus `docker ps` for container age, is fine. Then checkpoint the logs (they're append-only across restarts; logrotate is daily via `copytruncate`, not per-restart, so a whole-file grep after the first successful boot ever is permanently non-zero and proves nothing about *this* restart) before restarting:

```bash
LOG0=$(wc -l < logs/nanoclaw.log 2>/dev/null || echo 0)
ERR0=$(wc -l < logs/nanoclaw.error.log 2>/dev/null || echo 0)
sudo systemctl restart nanoclaw-v2
```

**Checkpoint caveat:** the host logs rotate daily with `copytruncate`; if rotation fires between the checkpoint and the read, the file shrinks and the scoped tail is empty. If `wc -l < logs/nanoclaw.log` is smaller than `$LOG0`, scope from the last `OneCLI preflight ok` line instead (`tail -n +$(grep -n 'OneCLI preflight ok' logs/nanoclaw.log | tail -1 | cut -d: -f1)`), and likewise for the error log from its first line after the restart timestamp.

**Post-restart gate, read at +2.5 minutes with ANSI codes stripped, scoped to `tail -n +$((LOG0+1)) logs/nanoclaw.log` / `tail -n +$((ERR0+1)) logs/nanoclaw.error.log` — all required rows, or it is not deployed:**

| Check | What passes |
|---|---|
| Preflight | `OneCLI preflight ok` present in the scoped tail |
| OneCLI gateway | `OneCLI gateway applied` count > 0 in the scoped tail within 2 min — the spawn-success signal |
| Channel adapters | 12 `Channel adapter started` lines in the scoped tail |
| Errors | 0 `ERROR` lines in the scoped tail |
| Warnings | every WARN class present in the scoped error-log tail is compared against the previous few hours; a class never seen before is investigated before calling the deploy green, a familiar recurring one is not |
| Restarts | `NRestarts` 0 (no crash loop) |
| Container started | `docker ps --filter name=nanoclaw-v2- --format '{{.Names}} {{.Status}}'` shows at least one container created after the restart — `OneCLI gateway applied` is logged during argument assembly, BEFORE the actual `spawn`, so a mount or egress failure after that line still leaves no container |
| Runtime (host upgrades, §5) | `MP=$(systemctl show -p MainPID --value nanoclaw-v2); /proc/$MP/exe -v` prints the intended Node version — systemd can restart through an old executable path and every other row still passes |
| Env proxy | `NODE_USE_ENV_PROXY` absent from the daemon environ |
| Seam counters | in the scoped tail: `Host sweep duty failed` = 0; `Host sweep mailbox unopenable` = 0; `tick threw` = 0 |
| Quiet cache | `Host sweep quiet cache warmed warmed=N` present in the scoped tail, N roughly the fleet size after the first post-boot tick |
| First tick timing | *conditional, not required*: `src/host-sweep.ts` only emits `Host sweep tick timing` when that sweep took ≥1 s, so its absence on a fast, healthy first sweep is not a failure — if the line does appear in the scoped tail, `spawnWaitMs` must be near 0 |
| Independent read | a second session re-reads the same checks at +6 minutes when one is available — a single reader's clean read is not the same guarantee |

Record every restart — time, PRs riding it, gate result — in `groups/_ops/upstream-rebaseline-2026-09/deploy-schedule.md` (private groups repo, not this one).

**Restart approval**: explicit per restart unless the operator has granted a standing window for this session; ask before running the `systemctl restart`, not after. Each restart kills every in-flight container turn — the restart-note predicate writes an accountability note for a streaming session, but it does not resume the turn — so prefer a genuinely quiet moment over a merely-approved one.

### 5. Host runtime upgrades (Node major, native addons)

Only `better-sqlite3` is ABI-bound in the host tree (raw V8; lightningcss/rolldown are N-API). Sequence:

1. Stop the timers that shell into tsx/ncl: `sudo systemctl stop nanoclaw-health-sentinel.timer nanoclaw-storage-gc.timer nanoclaw-fleet-drift.timer`.
2. **`sudo systemctl stop nanoclaw-v2`** — accept ~60 s planned downtime.
3. Back up the apt source, swap it, `sudo apt-get install -y nodejs=<ver> && pnpm rebuild better-sqlite3`, then `node -e "require('better-sqlite3')"`.
4. `sudo systemctl start nanoclaw-v2`; `sudo systemctl restart nanoclaw-codex-sync` (holds the deleted old node inode); re-`start` the timers.
5. Run the §4 gate. Do not build `dist/` in the same change unless HEAD == BUILD_INFO sha already; one variable per restart.

Rollback: restore the apt source backup, `apt-get install --allow-downgrades nodejs=<old>`, `pnpm rebuild better-sqlite3` (old ABI copy is still in the pnpm store), restart. Never restore `node_modules.pre-deploy/` (`deploy-crash-guard` refuses `runtime-changed` for this reason).

## Multi-session protocol

The upstream sync runs with several sessions up at once, sharing the fork and the live checkout. Roles (adjust names to whoever is actually running each): an **orchestrator/deployer**, who is the live checkout's single writer and owns the triage pass, the deploy schedule, and the process/docs conflict themes (this skill included); a **mailbox/runner owner**, who takes the `agent-runner/src` and mailbox-adjacent conflict themes; a **seam-2 owner**, who takes the host-sweep/scheduling/permissions/agent-to-agent/cli-resources themes and any seam-2 follow-up work (such as the ownership ratchet in §1).

- **Fences during a gate window.** While a deploy gate is running, no other session runs vitest against the live checkout's tree — host suites already collide across concurrent worktrees on shared fixture paths, and a gate read competing with a builder's I/O is not a clean read.
- **Patch inbox, not direct writes.** A session that isn't the deployer never commits to the live checkout. It produces `git format-patch` files into the deployer's scratchpad inbox and messages the filenames; the deployer applies them with `git am` in a **scratch worktree**, never directly onto the live checkout. The live checkout is checked out on `main`; a `git am` run there commits straight onto local `main` ahead of `origin/main`, which `check-build-clean`'s freshness gate then refuses to build from, and it skips the PR/review step every other change goes through. Apply the patch in a worktree, push the branch, and land it through the normal §3 PR flow before it ever reaches the live checkout via `git pull --ff-only`.
- **Check "is this mine?" before touching any dirt in the live checkout.** `git status --porcelain` plus `/proc/*/cwd` for every process rooted there — a change you didn't make is not automatically a peer's mistake to clean up; it may be an operator-side tool.
- **Operator-side tools may edit the live checkout directly** — an interactive editor, an interactive Codex TUI launched in that directory. That's expected, not a collision to fix. If you find dirt you didn't create and can't attribute to a known peer session, rescue it to a patch file before doing anything destructive; never `reset`/`checkout -- .`/`clean` without first knowing whose work it is.
- **If the operator's tool needs to move its work off the live checkout** (because it's mid-edit, still on `main`, when a deploy window needs the tree clean), give the exact commands — "commit to a branch" alone reads as switching the shared checkout, which breaks every other session's assumption that it's on `main`. Branch **before** committing (a commit made first lands on shared `main`, not on a branch that doesn't exist yet), and stage only the paths that are actually the operator's WIP (`git add -A` sweeps up any other session's or operator-side tool's untracked dirt too):
  ```bash
  git -C /home/ubuntu/nanoclaw-v2 status --porcelain                         # attribute what's dirty before touching any of it
  git -C /home/ubuntu/nanoclaw-v2 switch -c wip/<topic>                      # branch first, off the current (still-main) tree
  git -C /home/ubuntu/nanoclaw-v2 add <the attributed paths>                 # explicit paths only, never -A
  git -C /home/ubuntu/nanoclaw-v2 commit -m "<wip>"
  git -C /home/ubuntu/nanoclaw-v2 switch main
  git -C /home/ubuntu/nanoclaw-v2 worktree add /home/ubuntu/nanoclaw-wt-<topic> wip/<topic>
  # continue editing in /home/ubuntu/nanoclaw-wt-<topic> from here
  ```
  If the tool already created its own branch (the `git switch -c` case in gotcha 9 below), skip the branch-creation step and commit directly onto that branch, then continue from `switch main`.

## Gotchas (each one cost real downtime or a blocked push)

1. **Rebuilding a native addon while the host runs segfaults it.** `prebuild-install` overwrites `better_sqlite3.node` in place (hardlinked into the pnpm store); the live process's mmap changes underneath and it dies with SIGSEGV + a 5 GB core dump. Stop the service first. (2026-09-02, ~30 s outage + false unit alert.)
2. **Node ≥22.23 honors `NODE_USE_ENV_PROXY=1`; Node 20 ignored it.** The daemon carries `HTTPS_PROXY` = the OneCLI gateway. On Node 22 the host's own `fetch()` to the OneCLI control API (`127.0.0.1:10254`) went through the proxy and failed → every spawn refused for 11 minutes with the host "healthy". Fixed by `/etc/systemd/system/nanoclaw-v2.service.d/node22-env-proxy.conf` (`ExecStart=… onecli run -- /usr/bin/env -u NODE_USE_ENV_PROXY /usr/bin/node …`). The tell is `[UNDICI-EHPA] EnvHttpProxyAgent is experimental` on process start. Keep the drop-in; verify with the environ grep in the gate.
3. **`/update-nanoclaw`'s live dry-run merge and `migrate-nanoclaw` are wrong tools here** — the first edits the live tree, the second assumes customizations small enough to extract and replay.
4. **`/migrate-slack-agents` — not until the provisioning port lands.** As shipped today it detects an unsuffixed `SLACK_BOT_TOKEN` (the fork has none, only the suffixed per-agent form) and its later phases assume upstream's provisioning substrate outright; running it now would misfire. The provisioning model itself is in scope (standing decisions, above) — this gotcha retires once the seam that solves suffix-token compatibility and the migration path lands, not before.
5. **Worker reports about "silently skipped migrations" are wrong** — the ledger is name-keyed. Renumber files, keep names.
6. **A pre-existing ~28% intermittent `OneCLI gateway not applied` rate exists (issue #239)** — one refusal after a restart is not a regression; zero successes is.
7. **The image's `pnpm --version` may not equal `PNPM_VERSION`** (issue #240) — verify pins *inside* the built image, not from the Dockerfile.
8. **A worker's `cd <dir> && git ...` chain fell through to the live checkout when the `cd` silently failed**, and the subsequent `git checkout <sha> -- .` ran there instead of in the intended worktree. Use `git -C /abs/path` for every command in a worker brief so a bad path is a hard error, not a silent fallthrough to `main`.
9. **`git switch -c` inside the live checkout, run by an operator-side tool** (not a worker), left the shared checkout on a feature branch mid-session, which every other session read as "we aren't on `main`". Recovery is the five commands in "Multi-session protocol" above, not a bare `git switch main` (that alone discards nothing but leaves the operator's WIP commit orphaned if the branch isn't kept).
10. **A real install id in a source comment blocked the next push from the live checkout.** The boundary hook that catches this is blind inside a worktree and a GitHub merge runs no hook at all, so a worker can land a `sess-…`/`ag-…`/`mg-…` id or an operator/client name straight onto `main` without ever tripping the check — it only surfaces when the deployer's own push from the live checkout gets refused. Run the boundary check against the live root before every push from a worktree (§3).
11. **GitHub Actions is quota-dead on this private repo.** There is no CI gate to lean on — the gate is local targeted vitest, the Codex review loop, and the 15-minute fallback reviewer when Codex goes quiet. Don't wait on a check that will never run.
12. **A session going unresponsive for hours while holding the deploy window stalls the whole program** — nobody else can merge or restart until it either finishes or is recognized as stuck. Fences (the patch-inbox rule, the single-writer rule) need a timeout in practice, not just in principle: if the deployer session hasn't posted a gate result or a status update in a reasonable window, escalate to the operator rather than waiting indefinitely or working around the fence yourself.

## References

- Seam design + PR series + deploy protocol: `docs/specs/upstream-mailbox-seam/plan.md`, `docs/specs/upstream-host-sweep-seam/plan.md`.
- Original decline record, now partially reversed (see "Standing decisions" above for current state): fork issue #234; the reversal itself and the operator's own words on it: memory `project_upstream_sync_phase_2026_09_04`.
- Node 22 runbook + incidents: memory `project_node22_upgrade_2026_09_02`.
- Live-checkout single-writer rule: memory `feedback_live_checkout_single_writer`.
- Boundary hook / real-id scrubbing: memory `feedback_boundary_hook_flags_names_in_docs`.
- Review-round stopping rule + churn gate: memory `feedback_review_rounds_need_a_stopping_rule`; the pr-review-loop skill.
- Backlog: fork issues labeled `upstream-port`.
- Prior full merges (union/keep-ours decisions): memories `project_upstream_merge_2026_07_12`, `project_upstream_merge_2026_06_16`.
