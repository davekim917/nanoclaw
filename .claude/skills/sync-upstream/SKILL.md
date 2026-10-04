---
name: sync-upstream
description: "Bring upstream nanocoai/nanoclaw work into this production-critical, heavily customized fork without merging upstream's branch: triage what upstream landed since the ratchet pin, ship safe fixes through a weekly fast lane, port larger themes one PR at a time, then re-pin. Use instead of /update-nanoclaw. Triggers: 'sync upstream', 'update nanoclaw', 'catch up with upstream', 'what did upstream ship', 'cherry-pick upstream', 'upstream fast lane', 'Node upgrade on the host'."
---

# Sync Upstream

This fork ports upstream work into fork-owned code and never merges upstream's branch. `/update-nanoclaw` is the wrong tool here: upstream's version merges `upstream/main`, stops this install's agent containers at cutover, runs the full host suite on this host and resets the live branch to a locally staged commit, and the fork's own copy dry-run merges inside the live checkout. `/migrate-nanoclaw` assumes customizations small enough to replay onto a clean upstream.

A sync is a cycle with one cursor, the ratchet pin (`upstream` in `src/upstream-ratchet.json`). Triage everything upstream landed on `main` since the pin, ship what is safe, queue the rest as issues, then re-pin to the upstream head you triaged. Run one cycle a week; ship a security fix as soon as triage finds it.

## Settled decisions

Reopen one only when upstream ships something that changes its premise.

- **No merges of upstream's branch.** Distance is the ratchet (`pnpm run ratchet:report`, [docs/upstream-ratchet.md](../../../docs/upstream-ratchet.md)). The merge base never advances, so "commits behind" only grows and measures nothing.
- **Seams are ported into, never hand-merged.** The mailbox seam (`src/modules/mailbox/`, `src/mailbox/`), the host-sweep driver and duty registry (`src/host-sweep.ts`, `src/modules/sweep-*/`), the async central-DB driver and the host lifecycle (`src/host-lifecycle-seam/`) are built in the fork's shape. An upstream change there takes upstream's driver or façade shape and keeps the fork's registrations and module bodies, with the drift tests in §3 green before and after.
- **The Slack adapter is the fork's.** Port single upstream fixes into `src/channels/slack.ts`; never copy upstream's file over it. Slack manager-app provisioning is impossible for this install; `ncl slack workspaces add` (hot-attach) is the supported path.
- **`package.json` `version` stays the fork's.** A port that moves it trips the upgrade tripwire and halts the host at its next build and restart.

## 1. Preflight

Read-only, from the live checkout:

```bash
R=/home/ubuntu/nanoclaw-v2
git -C $R status --porcelain --untracked-files=no   # must print nothing
git -C $R fetch upstream --prune
git -C $R fetch origin --prune
PIN=$(node -p "require('$R/src/upstream-ratchet.json').upstream")
UP=$(git -C $R rev-parse upstream/main)
git -C $R rev-list --first-parent --count $PIN..$UP
git -C $R log --first-parent --format='%h %cs %s' $PIN..$UP
```

`$UP` is this cycle's target. Write it down: triage and the re-pin both use that head, even if upstream moves in between.

`.git/shallow` grafts the pin, so it has no parents locally. Count from it with `--first-parent`; a plain `rev-list $PIN..$UP` also counts older history reached through merge commits.

Check on every cycle:

- **Upgrade tripwire:** `node_modules/.bin/tsx scripts/upgrade-state.ts get` matches `node -p "require('./package.json').version"`.
- **Migrations:** `git -C $R diff --name-only --diff-filter=A $PIN $UP -- src/db/migrations/`. The ledger is keyed by `name`, not file number. Skip a migration whose `name` the fork already has; it has already run. A new one keeps upstream's `name` and takes the next free fork ordinal, one above the highest `NNN-` file in `src/db/migrations/`. A migration that ALTERs `container_configs` registers right after the aliased `containerConfigs` migration in `src/db/migrations/index.ts`: the array runs in array order, and that table is created late.
- **Host runtime:** `git -C $R show $UP:package.json | grep -A2 engines` against `node -v`. A Node major goes through §5.
- **Tooling:** call `node_modules/.bin/tsx` and `node_modules/.bin/vitest` directly. A nested `pnpm exec` costs about 80 s of CPU here.

## 2. Triage

Test each first-parent commit for a clean cherry-pick onto fork main. `merge-tree` writes objects, so give it a private object directory; a merge commit's change is its diff against its first parent:

```bash
O=$(mktemp -d)
for c in $(git -C $R rev-list --first-parent --reverse $PIN..$UP); do
  GIT_OBJECT_DIRECTORY=$O GIT_ALTERNATE_OBJECT_DIRECTORIES=$R/.git/objects \
    git -C $R merge-tree --write-tree --name-only --merge-base=$c^1 origin/main $c >/dev/null
  case $? in 0) s=clean ;; 1) s=conflict ;; *) s=error ;; esac
  echo "$s $(git -C $R log -1 --format='%h %cs %s' $c)"
done
```

The daily Upstream Check classifies the same commits against the ratchet; read it as a second opinion.

Put every commit in exactly one place:

- **Fast lane.** It fixes a bug or security issue in code this install runs, or bumps a pin that carries such a fix, and adds no migration, runtime or major-dependency bump, seam-file change, or `package.json` `version` move. A clean pick goes in as is. Most picks conflict, because the fork has diverged in most files upstream changes; port those by hand onto the fork's version of the file, with the customization contract below passing. Host changes and container changes go in separate PRs, because they activate and roll back differently.
- **Theme lane.** Everything else worth having: features, seam changes, migrations, runtime bumps, and fixes too large to port by hand in one sitting. Group by theme and open or update one `upstream-port` issue per theme. Order themes by what the operator asked for first, then by conflict severity.
- **Declined.** Not wanted. Record why, and the trigger that would reopen it, on the theme's `upstream-port` issue.
- **Not applicable.** Code this install doesn't run, such as setup for unused channels, skills it doesn't install, or upstream-only infrastructure.

**Customization contract.** List the fork customizations in files this cycle's upstream commits touch: `git -C $R log --no-merges --format='%h %s' upstream/main..origin/main -- <file>`. For each, write down its intent, its integration point, and the test that proves its behavior. If upstream now ships an equivalent, adopt upstream's version only when that test passes against it. Keep the fork's version when the intent is unclear, and write the missing test before any port touches that file.

**Channels and providers.** Installed adapters ship on upstream's `channels` and `providers` branches, which neither this triage nor the ratchet covers. Run `/update-skills` for them.

**Re-pin** once every commit is placed, to the `$UP` you triaged, in its own PR from a worktree (§3), with the report's full delta in the PR body:

```bash
(cd "$W" && node_modules/.bin/tsx scripts/upstream-ratchet-report.ts --root "$W" --upstream $UP)
```

From then on, a change that moves an upstream-owned file toward upstream reads as shrink, not growth, and the next cycle starts at `$UP`.

## 3. Port

Open one PR per fast-lane batch (host or container) and one per theme. Work in a scratch worktree, never in the live checkout:

```bash
W=<scratchpad>/wt-<topic>
git -C $R worktree add -b port/<topic> "$W" origin/main
ln -s $R/node_modules "$W/node_modules"      # read-only use; never install or rebuild into it
git -C "$W" cherry-pick -x <sha>             # -m 1 for a merge commit; resolve against the customization contract
```

A pick that comes out empty is already in the fork: `git -C "$W" cherry-pick --skip`.

Before pushing, from `$W`:

```bash
node_modules/.bin/tsc --noEmit -p tsconfig.json
flock <scratchpad>/vitest.lock ionice -c3 nice -n 10 node_modules/.bin/eslint src/ scripts/ setup/
flock <scratchpad>/vitest.lock ionice -c3 nice -n 10 node_modules/.bin/vitest run <targeted files> --maxWorkers=2
node_modules/.bin/tsx scripts/upstream-ratchet-report.ts --root "$W" --write [--accept <path>]   # when an upstream-owned file changed
(cd container/agent-runner && bun install && bun run typecheck && bun run test)                 # when container/agent-runner/ changed
(cd $R && pnpm run check:public-boundary -- --root "$W" --index)   # from the live checkout so pnpm resolves; scans $W's index
```

Never run the full host suite on this host. Push, open the PR from `$W` (`gh pr create` takes its head branch from the working directory) with a `Replaces:` line, and drive it with the `pr-review-loop` skill, which owns review rounds, receipts and the merge (`codex-review.sh merge --head <sha>`). After the merge: `git -C $R worktree remove --force "$W"`. The untracked `node_modules` symlink makes a plain remove refuse; git deletes the link, not its target.

Drift tests, green before and after every port:

| Seam | Test |
| --- | --- |
| Mailbox manifest: ported-verbatim upstream files match `src/mailbox/UPSTREAM-MANIFEST.json` | `src/mailbox-seam-upstream.test.ts` |
| Mailbox ratchet: the host allowlist in `src/mailbox/RATCHET.json` never grows | `src/mailbox-seam-ratchet.test.ts` |
| Mailbox composition: every session-provisioning path loads the mailbox composition | `src/mailbox-seam-composition.test.ts` |
| Scripts that reach the seam route through it | `src/mailbox-seam-unreachable-scripts.test.ts`, `scripts/mailbox-seam-unreachable.test.ts` |
| Host-sweep duty registration table | `src/host-sweep-registry.test.ts` |
| Host lifecycle: ported-verbatim files match `src/host-lifecycle-seam/UPSTREAM-MANIFEST.json` | `src/host-lifecycle-seam.test.ts`, `src/host-lifecycle.test.ts` |
| Upstream-ownership ratchet is current | `src/upstream-ratchet.test.ts` |
| Agent-runner hermeticity | `container/agent-runner/src/test-hermeticity.test.ts` |

Port rules:

- **Name the tree in every git command** with `git -C <absolute path>`. A failed `cd` falls through to the live checkout.
- **Never `git stash`,** in the live checkout or in a worktree another session might touch. Live sessions write untracked files a stash sweeps up.
- **The fork is public.** Commits, tests, comments, issues and PR bodies use synthetic ids and no operator, client or agent names. The boundary check refuses them, and it fails closed when the install's identifier registry is missing.
- **One producer per Docker flag.** `dockerResourceLimitArgs` owns `--pids-limit` and `--memory`; `resolveContainerSecurity` owns cap-drop and no-new-privileges.
- **Supply chain.** Keep the fork's Bun pin. Add nothing to `allowBuilds` and no release-age policy without the operator's approval.
- **Mocked modules.** A port that adds an export leaves it undefined in every suite that mocks that module with a bare `vi.mock` factory. Spread `importOriginal()` into the factory rather than stubbing the new export; `./log.js` stays a full stub.
- **New environment reads.** A port that adds a `process.env` read confirms the key is set in `.env` or OneCLI before deploy.
- **Migrations.** Scan a ported migration for `ALTER … NOT NULL` without a default, `DROP`, and bulk `UPDATE` against what the live DB holds, and take the backup in §4 before deploying it.

## 4. Deploy

A merge reaches production only at a deploy, and every deploy needs the operator's approval or a pre-approval in their own words. Report the cycle as an FYI: what ships at the next approved restart, which themes were queued, what was declined and why. Bring the operator a HOLD only for a direction call.

If the deploy carries a migration, take a hot backup first. Never `cp` a live SQLite file, and note that `scripts/deploy.sh` takes no DB backup:

```bash
cd $R && node -e "const D=require('better-sqlite3'); new D('data/v2.db',{readonly:true}).backup('data/v2.db.pre-sync-'+Date.now()).then(()=>process.exit(0))"
```

Deploy with `scripts/deploy.sh` or the Discord `/deploy` command. It pulls, builds the host, rebuilds the agent image when `container/` changed, and restarts. Its crash guard rolls back a boot crash, but it doesn't arm when the deploy ships a migration. A host restart leaves running containers for the new host to adopt; boot stops only the ones it cannot adopt.

Before launching the deploy, checkpoint both logs to a file; shell variables don't survive between tool calls:

```bash
cd $R && echo "$(date +%s) $(wc -l < logs/nanoclaw.log) $(wc -l < logs/nanoclaw.error.log)" > <scratchpad>/log-checkpoint
```

Gate at about 2.5 minutes after the restart. INFO lines go to `logs/nanoclaw.log` and WARN and above to `logs/nanoclaw.error.log`, so read both from the checkpoint. Daily rotation is a `copytruncate` that writes a new `.1` file, so a `.1` created after the checkpoint means the file rotated in between and its earlier lines are in `.1`:

```bash
cd $R && read C L0 E0 < <scratchpad>/log-checkpoint
since() { { if [ "$(stat -c %Z "$1.1" 2>/dev/null || echo 0)" -lt "$C" ]; then tail -n +$(($2 + 1)) "$1"; else tail -n +$(($2 + 1)) "$1.1"; cat "$1"; fi; } | sed 's/\x1b\[[0-9;]*m//g'; }
{ since logs/nanoclaw.log $L0; since logs/nanoclaw.error.log $E0; } > <scratchpad>/since-restart.log
```

In `since-restart.log`:

- `OneCLI preflight ok` is present.
- No line is at level ERROR (`grep -c '^\[[^]]*\] ERROR'` prints 0). Investigate any WARN class not seen in the previous day before calling it green.
- `Host sweep duty failed`, `Host sweep mailbox unopenable` and `tick threw` are absent.
- `Reconciled sessions at startup` shows `stopped=0`, or each stopped container has its own `Stopped an unadoptable container at startup` or `Adoption refused` line giving the reason. An interrupted session with work in flight gets `Wrote host-restart accountability note`.

Outside the logs:

- `systemctl show -p NRestarts --value nanoclaw-v2` prints 0.
- The next spawn succeeds: a container started after the restart appears in `docker ps --filter name=nanoclaw-v2- --format '{{.Names}} {{.Status}}'`. `OneCLI gateway applied` is logged before the spawn, so on its own it doesn't prove one.

To roll back, revert the merge commit through a PR and redeploy. Restore the DB backup if a migration ran.

## 5. Host runtime upgrades (Node major, native addons)

Only `better-sqlite3` is ABI-bound in the host tree. Rebuilding it while the host runs overwrites its mapped `.node` file in place and segfaults the service, so stop first:

1. Checkpoint the logs as in §4, then stop the timers that run this checkout's code and the service. Expect about a minute of planned downtime.

   ```bash
   systemctl list-units --type=timer --state=active --plain --no-legend 'nanoclaw-*' | awk '{print $1}' > <scratchpad>/stopped-timers
   sudo systemctl stop $(cat <scratchpad>/stopped-timers) nanoclaw-v2
   ```

2. Back up the apt source, switch it, then `sudo apt-get install -y nodejs=<version>`, `pnpm rebuild better-sqlite3` and `node -e "require('better-sqlite3')"`.
3. `sudo systemctl start nanoclaw-v2 $(cat <scratchpad>/stopped-timers)`, and restart `nanoclaw-codex-sync`, which still holds the old node binary.
4. Run the §4 gate, and two more checks. The daemon runs the intended Node: `MP=$(systemctl show -p MainPID --value nanoclaw-v2); sudo /proc/$MP/exe -v`. And `NODE_USE_ENV_PROXY` is absent from its environment: `MP=$(systemctl show -p MainPID --value nanoclaw-v2); sudo grep -ac NODE_USE_ENV_PROXY /proc/$MP/environ` prints `0`. Node 22.23 and later honor that variable, and with the OneCLI gateway as `HTTPS_PROXY` the host's own calls to the OneCLI control API would then go through the proxy and every spawn would be refused. The drop-in `/etc/systemd/system/nanoclaw-v2.service.d/node22-env-proxy.conf` unsets it.
5. Change one variable per restart: don't deploy a new `dist/` in the same change.

To roll back, restore the apt source, run `sudo apt-get install --allow-downgrades nodejs=<old>` and `pnpm rebuild better-sqlite3`, then restart. Never restore `node_modules.pre-deploy/`: its snapshots are tied to the old runtime's ABI, which is why the deploy crash guard won't roll back across a Node change.

## References

- [docs/upstream-ratchet.md](../../../docs/upstream-ratchet.md): the divergence measure, its verdicts, and re-pinning.
- `docs/specs/upstream-*/`: the seam plans and run logs. `docs/specs/upstream-mailbox-seam/plan.md` §6 holds the single-deployer protocol, which runs only when the operator asks for it.
- `container/skills/pr-review-loop/SKILL.md`: review rounds, receipts and merging.
- `scripts/deploy.sh`: deploy, crash guard and rollback.
- `/update-skills`: installed channels and providers.
