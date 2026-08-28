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

## 2026-08-28 — Stage B build (provider image)

- Builder: provider-only repair on `chore/deps-container-aug27`; no commit, push, image build, merge, deploy, or restart.
- Materialized `scripts/provider-version-contract.test.ts`; against the original #177 head all four provider-version contracts failed as expected.
- Reverted every unrelated #177 Docker, Bun, CI-mirror, and Remotion change to `origin/main`; the resulting Docker diff contains only Claude Code `2.1.250`, Codex `0.150.1`, and OpenCode `1.18.23`.
- Updated Agent SDK to `0.3.250`, retained direct Anthropic SDK `0.115.0`, retained MCP SDK `1.29.0`, and retained Bun `1.3.14` in both Docker and CI.
- Reinstalled agent-runner dependencies with Bun `1.3.14`; installed Agent SDK metadata reports `0.3.250` and `claudeCodeVersion: 2.1.250`.
- Replaced operational Codex version literals with an exact-numeric Docker ARG invariant; verifier tests now accept any consumed exact pin and reject missing, ranged, `latest`, and unconsumed pins.
- Changed OpenCode add and clone instructions to derive their SDK and host CLI version from `OPENCODE_VERSION`; removal now carries no stale version literal.
- Added the compiler-enforced Claude `EffortLevel` union equality contract and an executable schema test.
- Re-captured OpenCode `1.18.23` live at `/experimental/tool/ids`; the fourteen tool IDs matched the committed capture byte-for-byte.
- Focused provider, setup, and payload tests passed: 39/39 host Vitest; Claude schema and OpenCode capture Bun tests passed; host and container TypeScript checks passed.
- Build passed with `BUILD_ALLOW_DIRTY=1`; format, public boundary, and `git diff --check` passed. Dashboard dependencies were absent, so the SPA was not rebuilt.
- Full `bun test` was started twice. The first run showed unrelated Codex companion, upload-trace, destination, and poll-loop failures before its terminal session detached. The bounded second run was stopped after approximately 40 seconds; no full-suite verdict is claimed.
- The candidate Docker build and three two-turn provider canaries remain operator-only gates and were not run.
- Fresh lead verification repeated the focused host suite (39/39), focused Bun suite (44/44), frozen Bun 1.3.14 install, both TypeScript checks, formatting, portable public-boundary, and diff hygiene; all passed.
- The first full provider-directory Bun run exposed one environment-dependent test defect: ambient `CLAUDE_CODE_OAUTH_TOKEN_2` and `_4` values escaped the test's partial cleanup. The test now removes and restores every regex-matching auth variable; its initial failure is preserved by the run, and the complete provider suite passes 403/403 under the real agent environment.
- A fresh live `opencode-ai@1.18.23` server returned the expected 14 tool IDs in the committed order; the server was stopped and its port released after capture.
- Live npm metadata still reports Claude Code `2.1.250`, Agent SDK `0.3.250`, and Codex `0.150.1` at the frozen targets. OpenCode advanced from the frozen `1.18.23` target to `1.18.25` during review; the approved policy assigns that release to the next fast-lane run instead of invalidating this run's capture and verification.
- PR #176 CI exercised install, formatting, boundary, and both typechecks successfully on Node `22.19.0` and Node 24. Both matrix legs then failed only `src/container-updates.test.ts` and `src/dashboard/api/threads.test.ts`, the same two failing files as the `main` control run `33081745944`; no new failing test file appeared. The required aggregate `ci` check remains red, so Stage A is not merge-ready.

### Stage B blocker — providers branch payload parity

- `origin/providers` was already non-identical to the current Codex and OpenCode payload rosters before these Stage B edits.
- `provider-memory-contract --match-ref origin/providers` fails for both providers: the remote branch is missing multiple roster paths and differs on the remaining source files.
- The new OpenCode installer contract is correct in this PR but cannot make `/add-opencode` safe until the long-lived `providers` branch receives byte-identical payload updates.
- No remote providers-branch mutation was attempted from this container PR. This is a required follow-up before provider installation/reapplication can be claimed healthy.

### GitHub Codex review round 2

- Accepted: the fresh-trunk OpenCode installer cannot execute a placeholder Docker ARG. The add skill now writes the reviewed frozen `1.18.23` pin, then derives every SDK mutation from that Docker value. The acceptance test requires the exact frozen target and still rejects old operational literals.
