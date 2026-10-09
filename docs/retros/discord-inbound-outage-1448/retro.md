# Retro: Discord inbound outage from #1448

**Date:** 2026-10-07
**Scope:** PR #1448, the chat SDK bump (`chat`, `@chat-adapter/slack` and `@chat-adapter/discord` 4.29.0 → 4.41.1). It covers the deploy, the roughly 18-hour Discord inbound outage that followed, the fix (#1480) and the prevention PRs (#1469, #1482, #1483, #1484, #1485, #1486, #1487) up to 2026-10-07 19:15Z. The question: why mocked tests and a preflight-only deploy check let it ship, and which checks would have caught it.
**Author:** the retro session (claude-opus-5-5). It worked read-only, and this file is the only change.

## Status (2026-10-09)

What has landed since this retro was written, all deployed in build `2f9a9d1aa` (2026-10-09 02:59Z):

- **Class B, plan request 1:** #1490. The inbound verdict fails on a partial break, runs on every boot, and pages after the 30-minute window; its test replays the 2026-10-06 sequence and is red on the old rule.
- **Classes A and C, plan request 2:** #1484 (dependency gate), #1485 (Discord live-path test, which absorbed `discord-gateway-forward.test.ts` so it runs per PR), #1486 (attachments). The #1448 replay is recorded in #1490's body: the gate and the live-path mention case both refuse it without #1480's hunk.
- **Class D, plan request 3:** #1497 (issue #1492). `.pnpmfile.cjs` refuses any pnpm command when `node_modules` is a link or resolves outside the checkout, and `deploy.sh` plus host boot check for package links resolving outside the checkout. Worktrees created before #1497 keep their link until they pick up main.
- **Class E:** no change; it is an instruction-level judgment call.
- **Rules to delete:** the agent-memory rules for classes C and D are retired. The `CLAUDE.md` preflight row and the `sync-upstream` health line still stand next to the inbound row; folding them is a separate decision.

## Outcome

Every Discord guild message that @-mentioned someone failed inside the adapter from the 2026-10-06 21:37Z restart until a hot-patch restart at 2026-10-07 15:43:54Z. Messages that mentioned no one, and reactions, still forwarded. The operator found it when one of his own messages got no reply: he reported it at 14:42Z, about 17 hours after the deploy. The fix session had the root cause three minutes later. The messages sent during the outage are lost. Operator directive: "This CANNOT EVER HAPPEN AGAIN."

**Mechanism** (verified in #1480's test and body). The 4.41 adapter queues the gateway forward (`enqueueOrderedForward`) and awaits `resolveBotToken()` before it calls `JSON.stringify`. 4.29 serialized synchronously inside discord.js's `raw` listener. discord.js 14.27 emits `raw` and then builds a `Message` from the same packet object. For a mention, `MessageMentions` sets `mention.member.user = mention`, so by the time 4.41 serializes, the packet is circular. Upstream's 4.41.0 changelog does list the change, framed as a reactions fix: "Events for the same channel are forwarded in the order the Gateway delivered them".

**Timeline (UTC)**

| When | What |
|---|---|
| 10-06 04:27:30 | Round-5 substitute review approves #1448. Its receipt says "live platform behavior was not tested". |
| 10-06 04:28:01 | #1448 merged, 31 s after the approval. |
| 10-06 15:48 | Nightly full suite on `1e4d7b45a` (contains #1448): **success**. |
| 10-06 21:25:39 | The dependency-update session launches `scripts/deploy.sh`, which pulls 73 commits. A second session launches another deploy at 21:29:47. That deploy's prebuild fails and its rollback trap restores `dist`/`node_modules` while the first deploy is still running. |
| 10-06 21:37:10 | Host restarts. The crash guard is "NOT armed" because the deploy ships migrations (`logs/deploy.log`). |
| 10-06 21:38–21:40 | Session check: deploy status, `BUILD_INFO`, `systemctl is-active`, `OneCLI preflight ok` count, a 5-line error-log tail, image tool versions, spawn refusals. Then "Deploy is verified." |
| 10-06 21:42 | A live Discord message that mentions no one forwards and routes normally. |
| 10-06 ~21:49 | First `Error forwarding Gateway event … circular structure`, timed by the nearest stamped line (the console lines carry no stamp). |
| 10-07 13:39 | Asked "are we done here?", the session answers "Merged and live … preflight ok, no spawn refusals." |
| 10-07 14:42 | The operator reports that his Discord messages get no thread and no reply. |
| 10-07 15:06–16:20 | GitHub outage: #1480's CI sits queued and GraphQL returns 500s. |
| 10-07 15:43:54 | The reviewed fix is hot-patched into live `node_modules` and the host restarted, under the operator's pre-approval. Discord routes again at 15:44:41. |
| 10-07 16:25:50 | #1480 merged. #1483 merges at 16:50, #1482 at 18:18. #1484, #1485 and #1486 are open. **None of them is deployed.** The live checkout is still at `1e4d7b45a`. |

Forward-error lines: 86 in `logs/nanoclaw.error.log` and 12 in `.1`, all before the 15:43:54Z restart and none after. That is 83 `GATEWAY_MESSAGE_CREATE` and 3 `GATEWAY_MESSAGE_UPDATE` in the current file, and 12 `GATEWAY_MESSAGE_CREATE` in `.1`. The lines arrive in threes, which fits three Discord bots each logging the same event. That is an inference, so the count of user messages is roughly a third of the line count, not a measured number.

## Sources read

- `gh pr view` bodies and comments for #1448 (all five substitute-review receipts and the churn note), #1480, #1482, #1483, #1484, #1485, #1486, #1481 and #1487. The diffs of #1482 (`post-deploy-inbound.ts`, the bridge hunk, `deploy-status.ts`, `main.ts`) and #1484's `container/dependency-paths.json`. #1480's `src/channels/discord-gateway-forward.test.ts` on `origin/main`.
- `src/channels/discord.test.ts`, `src/channels/chat-adapter-code-spans.test.ts` and the `refineInboundMention` site in `src/channels/chat-sdk-bridge.ts`. `git show 040bee1ab`.
- `scripts/deploy.sh` (verify and status steps), `logs/deploy.log` for 21:25–21:37Z, `logs/deploy-launch.out` (empty), `logs/nanoclaw.error.log{,.1}` and `logs/nanoclaw.log{,.1}` around the deploy and the hot-patch, and `gh run list` for `ci-full.yml`.
- `.github/workflows/ci.yml` (HEAD and `origin/main`), `docs/dependency-updates.md`, `CLAUDE.md` (Troubleshooting, and the change #1482 made to it), `.claude/skills/sync-upstream/SKILL.md:162`, `.husky/pre-commit` and `.husky/pre-push`.
- Upstream `adapter-discord` CHANGELOG, 4.29.0 → 4.41.1.
- Transcripts, by targeted extraction only: the dependency-update session (authored #1448, deployed it, and owns the prevention PRs) and the fix session (diagnosis, #1480, the hot-patch).
- Earlier evidence: `docs/retros/mnemon-rearchitecture/retro.md`, `docs/retros/instrumented-memory-recall/retro.md`, `docs/retros/_workflow-recommendations.md`, and agent memory notes on the 2026-09-07 OneCLI fd-leak outage, the 2026-04-28 OneCLI upgrade smoke test, the 2026-09-15 Codex host/container version skew (#812), the 2026-09-03/04 live-checkout collisions, the 2026-08-23 write through a symlink into the pnpm store (recorded in `.husky/pre-commit`), and the 2026-09-29 note "never run `pnpm install` in a worktree whose `node_modules` is symlinked to the live checkout".

**Not verified here.** #1484's replay ("refuses #1448: 13 problems, 6 blocks") is reported by its author, and I did not re-run it. No vitest was run. A search of `groups/` for an `/update-container` skill timed out. No such skill exists in the repo's `.claude/skills`, in `container/skills` or in the plugins.

**Corrections to the brief.**
- The Slack DM demotion that #1483 found was **not caused by #1448**. #1483 dates it to `040bee1ab` (2026-08-05), the code-span demotion in the bridge, so it had been live for two months. It belongs to class A below, not to "a second regression from the bump".
- The fix session's first root cause blamed the wrong mutation: `Message.js:342`, the author's member. #1480's round 1 corrected it to `MessageMentions.js:100`.

## Mistake classes

A class counts once it has happened twice, in this scope or in earlier evidence. Levels: 1 = architecture, 2 = type, lint or test, 3 = instructions.

| # | Class | Evidence (this scope + earlier) | Occ. | Level | Why not higher |
|---|---|---|---|---|---|
| A | **Boundary tests stand in for the real library, so they pass while the live path is broken** | #1448. `discord.test.ts` stubs REST and `postMessage`. Its inbound tests feed hand-built objects to `isUserMessage`. No test drives gateway `raw` → forward → bridge. Five review rounds, local channel suites and the nightly full suite (10-06 15:48Z and 10-07 16:16Z, both on commits carrying the bug) all passed. Slack DMs in mention mode were demoted from 08-05 to 10-07 because the bridge tests feed ready-made messages (#1483). Earlier: #812's Codex RPC fixtures mirrored the code's own request, 09-15. The OneCLI 1.18.6 upgrade was smoke-tested with curl only and three client regressions shipped, 04-28. The mnemon recall feature passed 423 tests while working in 0% of production cases (earlier retro). | 5 | 2: a test that runs the real library over a fake network (#1483 for Slack, #1485 for Discord), required by a gate (#1484) | The behaviour lives in third-party code that our architecture does not own. The only way to observe it is to run it. |
| B | **"Healthy" declared from a proxy signal. The user-facing path is never exercised after deploy, and the operator finds the failure** | 10-06 21:40Z "Deploy is verified", from preflight, process and image checks. 10-07 13:39Z "merged and live", 16 h into the outage. `CLAUDE.md`'s "Post-restart health" row prescribes exactly `grep 'OneCLI preflight ok'`. `sync-upstream/SKILL.md:162` says the same. Earlier: 09-07 OneCLI fd leak, where Docker reported `(healthy)` for about 6 h. The mnemon retro says the headline UX was broken for hours until the operator tested it. Its recommendation R8/S1 (live verification after deploy) never reached `team-ship`, which has no such step today. | 3 incidents, 2 false "done" reports here | 1: the host owns a per-platform verdict and alerts the owner (#1482). As built, it does **not** catch this incident (see Unwired checks). | It already is level 1. The prose rules (R8, the CLAUDE.md row) are what failed. |
| C | **Dependency behaviour changes are read but not mapped to host paths, and review spends its rounds on the code the author wrote** | The upstream changelog was read by the author and by every reviewer. It names ordered forwarding (4.41.0) and a 25 MB download cap (4.39.0). Neither reached #1448's behaviour-change list. Rounds 1–5 all argued about code-span regex parity in the fork's own patch. The cap was then called a regression (14:47Z), not a regression (15:44Z, relayed to the operator), then a regression again (16:16Z, relayed). Earlier: OneCLI 1.7 → 1.18.6, "the minor-version bump was a major behavioral change", 04-28. #812, where the host CLI version was not the container's. | 3 | 2: #1484 blocks a live package's new versions anywhere in its exact-version closure until a registered live-path test exists at the base, and a ledger names each behaviour change | No architecture removes upstream behaviour change. That the ledger covers every changelog entry stays a judgment call, and #1484 says so. |
| D | **More than one writer to the live install (checkout, `dist`, `node_modules`)** | 10-06: two `deploy.sh` runs overlapped. The second one's rollback restored `dist`/`node_modules` mid-way through the first (`deploy.log` 21:29–21:31Z). 10-07 16:29Z and 16:50Z: the dependency-update session ran `pnpm install --frozen-lockfile --offline` in a worktree whose `node_modules` is a symlink to the live one. pnpm asked to purge the modules directory, and the session re-ran with `CI=true` to skip the prompt. The live host's adapter directory was rewritten under the running process, and `node_modules` now matches a worktree lockfile, not the live checkout's. No module errors followed. Earlier: 09-03, four collisions in the live checkout (a commit and reset mid-build mis-stamped `dist`). 09-04, a worker ran `git checkout -- .` in the live checkout. 08-23, a worker `cp`-ed through a symlink into the shared pnpm store. | 5 days, 9+ events | 1: one owner of the live install. #1469 (`flock` on `deploy.sh`) closes the deploy-overlap case. | Prose rules exist (memory notes from 09-03 and 09-29, plus the single-writer rule) and were broken anyway, so the class needs architecture, not more rules. |
| E | **Causal or impact claims sent before they are verified, then reversed** | The attachment cap flip-flopped twice, and both versions reached the operator. The first root-cause message named the wrong discord.js mutation, and the first #1480 test used a synthetic cycle. Both were corrected in round 1. The brief for this retro attributed the DM demotion to the bump. #1448's body claimed CommonMark completeness, which cost three churn rounds. Earlier: #583 (`dbHasRows`), now a CLAUDE.md rule. | 5 | 3, with a level-2 assist: a before/after oracle (a live-path test or a session-DB query) before a regression claim leaves the session | No check can read a chat message. The CLAUDE.md rule from #583 exists and was broken, so the class moves one step closer to architecture through the oracle, not more prose. |

## Product and code failures vs workflow obstruction

**Product and code failures**
- Upstream 4.41 deferred the serialization in a listener whose packet discord.js mutates afterwards. The fix is a one-hunk fork patch (#1480). There is no newer upstream release.
- Fork code: Slack DM mention demotion since 2026-08-05 (#1483).
- Upstream: the 25 MiB download cap. The fork's own router cap was also commented as "Slack's own limit", which is wrong (#1486).

**Workflow obstruction** (it cost time; it did not cause the outage)
- **The Codex connector was at its usage limit**, so every #1448 round was a substitute review on a secondary account. The reviews were thorough. The problem was their scope (class C), not their availability.
- **GitHub outage, 15:06–16:20Z.** #1480's CI stuck in `queued` could not be cancelled or re-run. The session pushed an empty commit (`4ff58655e`) to start fresh CI and carried the approval forward. The hot-patch was the right call, and it left production ahead of `main` for 42 minutes.
- **The public-boundary pre-commit hook failed on every local commit from 18:09Z**, because a new messaging group was named after a common English word (#1487 allowlists it). This is the second time a boundary or push hook has blocked work on lines nobody changed. The first, on 09-11, was the pre-push exit 127 in worktrees. #1487 itself notes that the structural fix belongs to the checker's owner.
- **Host load** made `scripts/review-notes.test.ts` need `--testTimeout=60000` on #1482 and #1484.
- **#1484's round-2 review report was lost to a context reset.** That round has no receipt.

## Unwired checks, checks that cannot run, and checks that pass without checking

1. **Mocked Discord tests pass with inbound dead.** `discord.test.ts` never exercises the gateway inbound path. The nightly full suite was green on two commits that carried the bug.
2. **`deploy.sh` verifies nothing after the restart.** It writes `status: ok` *before* `systemctl restart`. The crash guard only covers a process that crashes, and it was not armed for this deploy because migrations shipped. Every check after the restart was ad hoc session work, and `CLAUDE.md` told the session to use preflight.
3. **#1482 would have passed this incident.**
   - Its verdict is `liveInbound > 0 ? 'verified' : …`, and errors only count when there is no live inbound. In this outage a live Discord message that mentions no one routed at 21:42Z, inside the window, before the first forward error. Discord would have read **verified**. #1482's own body lists "a partial break … reads as verified" as a known limit, and this outage was exactly that kind of break.
   - It runs only on a boot that follows an `ok` deploy status written within 5 minutes, or on a window restarted after a crash. The 15:43Z hot-patch restart, like any manual `systemctl restart`, gets no check.
   - Once the 30-minute window closes, nothing watches inbound at all.
4. **#1480's regression test is not in the per-PR lane.** `discord-gateway-forward.test.ts` does not match the `vitest run live-path` filter #1483 added. It cannot be registered in #1484's registry either, which requires `*live-path*.test.ts`. Today it runs only nightly.
5. **A review that names the gap still approves.** #1448's approving receipt said "live platform behavior was not tested" as a non-blocking note, and the gate merged 31 s later. #812's reviewer recorded "live app-server response unobserved" the same way. Until #1484 merges, nothing turns that note into a block.
6. **The prevention is merged but not live.** #1482, #1483 and #1469 (the deploy lock) take effect on the next deploy. The running host is the `1e4d7b45a` build, with the hot-patched adapter loaded and a `node_modules` tree rewritten afterwards from a worktree lockfile (class D).
7. **The documented dependency workflow names gates no file defines.** `docs/dependency-updates.md` says `/update-container` "runs the relevant gates". I found no skill file for that workflow (search incomplete, see Sources).

## Do #1482, #1483 and #1484 close the classes?

| Class | Closed by | Left open |
|---|---|---|
| A | **Slack: yes** (#1483, merged; a live-path step in `ci.yml` per PR). | **Discord: no** until #1485 merges; it is stacked on #1484, and both are open. Attachment download: #1486 is open. The provider, MCP and OneCLI live paths are registered with no tests, so #1484 blocks their upgrades, including security patches. That puts pressure on `Override:` and reclassification, and #1484 restricts both. |
| B | Partly. #1482 makes the host own the verdict and alerts the owner through `notifyOperators`, so the deploying session no longer has to be watching. | Its verdict passes partial breaks like this one. Restarts not done by `deploy.sh` get no check. Nothing runs after the window. It is not yet deployed. |
| C | Mostly, once merged. Blocking follows exact versions across the transitive closure, so it would also catch a behaviour change inside a dependency's own dependencies, which is how the 25 MiB cap arrived (`@chat-adapter/shared`). | The ledger cannot be checked against the changelog. A wrong `kind` in `dependency-paths.json` (for example `undici: runtime`) downgrades the gate to a ledger entry. A live-path test only blocks the behaviours it actually drives. |
| D | The deploy-overlap case, by #1469 (in effect at the next deploy). | A worktree install writing the live `node_modules`, which happened twice today. Nothing prevents it. |
| E | None of them. #1486's tests give the attachment claim an oracle. | It stays judgment. |

## Rules to delete once enforced

- **`CLAUDE.md` → Troubleshooting → "Post-restart health: `grep 'OneCLI preflight ok'`"**, and the health line at `sync-upstream/SKILL.md:162`. Fold both into the post-deploy inbound row once the verdict fails on this incident (plan request 1). Today the preflight row sits next to #1482's row and contradicts it.
- **Agent memory: "never run `pnpm install` in a worktree with `node_modules` symlinked to the live checkout"** (09-29), and the single-writer prose for deploy overlap. Delete them once the install refuses (plan request 3) and #1469 is live.
- **The fix session's memory pointer "verify per-platform inbound after EVERY deploy"**, and the earlier retros' R8/S1 (live verification after deploy, as prose in `team-ship`). The host check replaces both. Do not add them as prose.
- **The dependency-update lane's note "treat a channel-adapter or SDK bump as live I/O that needs a real-library test"**, once #1484 is merged: the gate enforces it.

## Learnings

1. **Next time, call a deploy healthy only on a per-platform inbound verdict the host computes from live traffic**, because the 10-06 deploy was "verified" from preflight 9 minutes before the first failed Discord forward, and was still reported as "live" 16 hours later.
2. **Next time a live-I/O dependency moves, merge it only with a test that runs the real library over a fake network**, because #1448's mocked tests, five review rounds and two nightly full suites all passed while every Discord @-mention failed.
3. **Next time a reviewer writes "live behaviour not tested" on a live-path change, treat it as blocking**, because #1448's approval said exactly that and merged 31 seconds later.
4. **Next time a check is built after an incident, replay that incident's own evidence through it before merging**, because #1482's verdict, fed this outage's logs, reports Discord as verified.
5. **Next time a worktree needs dependencies, give it its own install, never a writable link to production's**, because on 10-07 a worktree install purged and rewrote the running host's `node_modules` twice, despite a written rule against it.

## `/team-plan` requests

These are the most frequent classes fixable at level 1 or 2. None has been started. Request 2 overlaps open PRs owned by the dependency-update lane (#1484–#1486). It is written to finish and prove that work, not to run a parallel build.

**1. Class B: a post-deploy verdict that fails on partial breaks and covers every restart**

> /team-plan Make the host's post-deploy inbound verdict (`src/channels/post-deploy-inbound.ts`, from #1482) fail on a partial platform break, start on every host boot rather than only boots after `deploy.sh` (a manual `systemctl restart`, a crash restart, a hot-patch restart), and keep alerting after the 30-minute window when a platform's adapter starts failing. Acceptance: a test replays the 2026-10-06 sequence: one live Discord message that mentions no one routed at 21:42Z, then `Error forwarding Gateway event` (`GATEWAY_MESSAGE_CREATE`, circular JSON) from about 21:49Z on all three Discord bots while plain messages keep routing. It asserts the Discord verdict is `failing` and the owner is alerted. The same test is red against `a5a0d9b5b`'s logic, which returns `verified`. A second case shows that a boot with no fresh `ok` deploy status still opens the window. A third case shows that forward errors with only occasional successes, starting 2 hours after boot, still alert. When it lands, merge the `CLAUDE.md` "Post-restart health" preflight row into the inbound row and delete the preflight-as-health line in `sync-upstream/SKILL.md`.

**2. Classes A and C: prove the gate and the live-path tests reject #1448, and put the existing Discord regression test in the PR lane**

> /team-plan Coordinate with the dependency-update lane that owns #1484, #1485 and #1486. Do not build a parallel gate. Define and run the acceptance that proves the combination rejects #1448, then close the wiring gaps. Acceptance: on a branch cut from `378c0f029^1` (main before #1448) with #1484 and #1485 applied, re-applying #1448's `package.json`, `pnpm-lock.yaml` and `patches/` (without #1480's snapshot hunk) fails the PR CI lane in both configurations. Before Discord tests are registered, `scripts/dependency-gate.ts check` refuses it and names `discord-inbound`. After registration, `vitest run live-path` fails with `Converting circular structure to JSON` on the guild-mention case. The same replay with #1480's hunk passes. Also, `src/channels/discord-gateway-forward.test.ts` runs in the per-PR lane (renamed into the `live-path` filter or folded into #1485's test), and a reviewer receipt that says live behaviour was not tested cannot sit on an approving receipt for a PR the gate classifies as touching a live package.

**3. Class D: one owner of the live install, with no writable path into the live `node_modules` from a worktree**

> /team-plan Give agent worktrees one supported way to get working dependencies (their own install that builds the native bindings `.husky/pre-commit` says a worktree install leaves unbuilt, or a read-only equivalent). Delete the practice of symlinking the live checkout's `node_modules` into worktrees. Make an install through such a link impossible. Acceptance: reproduce the 2026-10-07 16:29Z event in a scratch worktree whose `node_modules` is a symlink to the live checkout's. `pnpm install --frozen-lockfile --offline`, run both plain and with `CI=true`, exits non-zero before writing anything: the live `node_modules/.modules.yaml` mtime and every `node_modules/.pnpm/*` directory name are unchanged. The supported worktree setup passes `tsc --noEmit` and one `better-sqlite3`-backed test without touching the live tree. The pre-push and pre-commit hooks still run from a worktree. When it lands, delete the 09-29 memory rule against symlinked installs.
