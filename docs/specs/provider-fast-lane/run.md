# Provider Fast Lane — Run Log

## 2026-08-28 — plan stage

- Primary: Axie-Codex, Codex model family.
- Target heads: #176 `321793b776442bd5964f30be7d7b709aaf55eca7`; #177 `5ca5a5e5194fa3154e84b13ba6c7888fdf003eda`.
- Verified npm latest: Claude Code `2.1.250`, Agent SDK `0.3.250`, Anthropic SDK `0.122.0`, Codex `0.150.1`, OpenCode CLI/SDK `1.18.23`.
- Verified Agent SDK `0.3.250` declares `claudeCodeVersion: 2.1.250` and retains the five-value `EffortLevel`.
- Verified upstream current source moves Node engine, bootstrap, installer upgrade, CI 22/24, docs, and better-sqlite3 together.
- Verified effective fork dependency floor is Node `22.19.0` because of Undici `8.10.0`.
- Verified #176 adds Node-20 Undici failures and a better-sqlite3 crash path beyond red `main`.
- Verified #177 adds a Codex verifier failure and leaves OpenCode operational pins stale.
- Planning research delegated in parallel: provider version matrix, Node migration scope, and container repair/canary scope.
- Provider research verified the latest Claude pair on Bun 1.3.14 and found no removed harness methods in the Codex 0.145-to-0.150 schema delta.
- Node research found upstream's migration is a runtime contract, while the fork's effective minimum is `22.19.0` because of Undici.
- Container research recommended removing every unrelated tool bump from #177 and canarying the three provider stacks through `/app/entrypoint.sh`.
- Delivery was split into Node runtime, provider image, and host dependency stages so failures and rollbacks remain attributable.
- Independent Claude-family review by Axie: `must_fix`, two findings.
- Accepted finding: Bun rollback must update both Docker and its CI mirror.
- Accepted finding: `.nvmrc` must declare the exact `22.19.0` floor.
- Accepted addition: engine-strict frozen install must run on Node 22.19 and 24.
- Verified review decision: Claude stable is `2.1.236` paired with Agent SDK `0.3.236`; latest is `2.1.250` paired with Agent SDK `0.3.250`.
- Both must-fix findings are incorporated. Cross-model coverage is complete.
- No production code changed at plan stage.

## 2026-08-28 — build stage

- Dave explicitly approved the reviewed plan and selected Claude Code `2.1.250` with Agent SDK `0.3.250`.
- Work claim `nanoclaw-provider-update-policy` taken for four hours.
- Build starts on #176 branch `chore/deps-host-aug27`; existing user and plan files preserved.
- Stage A materialized `scripts/node-runtime-contract.test.ts`; the first run failed all five criteria for the expected missing-contract reasons.
- Stage A reverted the Slack, Undici, and better-sqlite3 changes from #176 and restored the main lockfile/build policy.
- Stage A implemented Node `>=22.19.0` metadata, exact `.nvmrc`, engine-strict install, shared version predicate, setup upgrade behavior, deploy preflight, Node 22.19/24 CI, and runtime documentation.
- Fresh lead verification: runtime contract plus platform tests `18/18` passed; format, public boundary, host build, host/container typechecks, shell syntax, and `git diff --check` passed.
- Builder also verified frozen install plus runtime tests on exact Node `22.19.0` and `24.0.0`; Node `20.20.2` frozen install failed closed with `ERR_PNPM_UNSUPPORTED_ENGINE`.
- Full host Vitest was run with two workers. It reproduced inherited failures, generated excessive migration logs, and had not settled after roughly seven minutes; it was stopped with exit 130. No full-suite pass is claimed. CI remains the authoritative complete run after push.
- Stage A live production `ExecStart` and Node version remain operator gates. No host mutation, restart, merge, or deploy occurred.
- GitHub Codex review found the deploy preflight defaulted to `/usr/bin/node`, while setup can pin another executable in `ExecStart`; accepted as a real Node-contract violation.
- The slash launcher now passes its authoritative `process.execPath`, and the deploy script fails closed when that path is absent.
- A follow-up review found later deploy commands still resolved bare `node` from the inherited PATH. The launcher now prepends the running service Node directory, so preflight, pnpm, and build use one runtime.
- Focused runtime/slash tests passed `8/8`, including stale-value override, missing-path fail-closed, and unsupported-Node fail-closed cases.
- Host build, format, public-boundary structural checks, shell syntax, and `git diff --check` passed after the correction.
- GitHub Codex review found setup's Node upgrade stayed inside child shells; accepted. `nanoclaw.sh` and `migrate-v2.sh` now reactivate setup's emitted `NODE_PATH` before any parent-side pnpm.
- Parent handoff tests cover old-to-new Node/pnpm selection, stale PATH override, invalid-path fail-closed, and both launcher call sites; focused runtime/platform tests pass `24/24`.
- Independent review found #176/#177 add/add spec conflicts. Stage B now removes its duplicate plan/run files; `git merge-tree --write-tree` exits `0`.
- Independent review found #178 had no CI and clarified its remote-dependent activation. The registry gate now composes payloads onto current `main`; publication follows #177 promotion and has a forward-revert rollback window.
- Version contract tests now assert exact/relational invariants without embedding the current release. The reviewed Docker diff remains the approval record for frozen targets.
- CI comparison against main run `33081745944` found a deterministic 51-failure baseline: 50 thread-list tests used a fixed injected clock while the session query used ambient `Date.now()`, and one upstream-policy test assumed Actions checkout had `upstream/main`.
- Stage 0 PR #179 fixes both root causes without changing production defaults; its required aggregate `ci` check is green and it must merge before #176/#177 full-suite results are interpreted.
- #176 CI now disables matrix fail-fast and runs Bun with `if: ${{ !cancelled() }}` so a host failure remains blocking without hiding the Node 24 or container evidence.
- #176 run `33194243469` completed the Node 22.19 host suite with the same 51
  inherited failures as main and completed both Bun legs with `1116` passed,
  `4` skipped, and `0` failed.
- The Node 24.19 host leg is not green: Vitest reported `25` workers exiting
  unexpectedly, without an exit signal, OOM, native-addon error, or file binding.
- An isolated exact-Node `24.19.0` reproduction loaded a scratch-built
  better-sqlite3 11.10.0 and ran for 72 seconds with zero worker exits and zero
  cgroup OOM events before it was stopped. The run was incomplete and does not
  validate Node 24 support.
