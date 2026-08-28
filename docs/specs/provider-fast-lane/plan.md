# Provider Fast Lane and Runtime Baseline

**Status:** Approved by Dave on 2026-08-28, latest Claude pair selected  
**Scope:** Repair PRs #176 and #177, then land one isolated host-dependency PR  
**Activation boundaries:** Host runtime, host dependencies, and container image stay separate

## Outcome

NanoClaw keeps Claude Code plus its Agent SDK, Codex, and OpenCode CLI plus SDK
at their latest compatible releases without using production as the test
environment. Dependencies shared with upstream adopt upstream's full runtime
contract. Fork-only dependencies move only after their affected harness path
passes a candidate-image smoke.

Target provider versions, resolved from npm on 2026-08-28 and frozen for this run:

| Surface | Target |
|---|---:|
| `@anthropic-ai/claude-code` | `2.1.250` |
| `@anthropic-ai/claude-agent-sdk` | `0.3.250` |
| `@openai/codex` | `0.150.1` |
| `opencode-ai` + `@opencode-ai/sdk` | `1.18.23` |

The direct `@anthropic-ai/sdk` is not part of the fast lane. NanoClaw has no
direct source import, and Agent SDK `0.3.250` accepts any version `>=0.93.0`.
Leave the existing `0.115.0` pin unchanged unless Dave explicitly adds it.

Dave selected the latest pair. npm currently tags `2.1.250` as both `latest`
and `next`; Agent SDK `0.3.250` declares that exact Claude Code version.
Neither member moves alone.

## Premise ledger

- `[verified: npm registry metadata]` Agent SDK `0.3.250` declares Claude Code `2.1.250`.
- `[verified: npm registry metadata]` Undici `8.10.0` requires Node `>=22.19.0`; better-sqlite3 `13.0.3` requires Node `>=22`.
- `[verified: upstream source at nanocoai/nanoclaw main]` Upstream moved Node engines, installation, CI 22/24, docs, and better-sqlite3 together.
- `[verified: GitHub CI runs 33081745944/33115763473/33094571599]` PRs #176/#177 add failures beyond red `main`.
- `[assumed]` The production service still executes `/usr/bin/node`, and its version may be below `22.19.0`; the host gate must verify both before any merge.

## Policy

### Provider fast lane

Move these as atomic families:

- Claude: Docker `CLAUDE_CODE_VERSION`, Agent SDK, and executable/SDK parity assertions.
- Codex: Docker `CODEX_VERSION`, setup verifier, installer skill, and provider-contract tests.
- OpenCode: Docker `OPENCODE_VERSION`, SDK, tool-capture version, installer/removal/clone instructions, and provider-contract tests.

"Latest" is resolved at implementation start and frozen to exact versions in the
diff. A release published during review belongs to the next run.

### Upstream lane

Adopting an upstream dependency also adopts every load-bearing runtime change
required by it. The current host dependency set needs Node `>=22.19.0`, so the
runtime migration lands and proves healthy before those dependencies.

Upstream declares Node `>=22`. NanoClaw deliberately raises that to `>=22.19.0`
because Undici `8.10.0` requires the stricter floor. This is a documented
compatibility divergence, not exact upstream parity.

The fork retains `allowBuilds: better-sqlite3: false`. Version 13 ships native
prebuilts; allowing a build makes pnpm attempt an unnecessary gyp compile.

### Fork-only lane

A fork-only package moves only when its install path and one real harness path
pass. "Minor version" and "no upstream signal" are not compatibility evidence.

The unrelated Docker, Bun, Python, MCP, browser, and Remotion bumps leave PR #177.
They get a later candidate-image batch with tool-specific canaries.

## Delivery sequence

### Stage A: PR #176, Node runtime contract only

1. Revert the Slack, Undici, and better-sqlite3 dependency bumps from #176.
2. Set the declared runtime floor to Node `>=22.19.0`.
3. Add `.npmrc` `engine-strict=true` so an old runtime fails during install,
   before build or restart. This protects the first rollout even though the old
   deploy script is still running.
4. Make setup and `setup/install-node.sh` upgrade an existing unsupported Node,
   not report it as already installed.
5. Add a dependency-free Node-floor predicate reused by setup, installer, and
   deploy preflight.
6. Test the exact minimum `22.19.0` and Node 24 in CI while preserving the
   required aggregate check name `ci`.
7. Set `.nvmrc` to `22.19.0`. Update README translations, build/runtime docs,
   changelog, setup tests, and platform expectations as one runtime contract.
8. Before merge, Dave verifies the production service's actual `ExecStart` and
   upgrades that executable to Node `>=22.19.0` while the old service keeps running.
9. Restart the old dependency set on Node 22.19+, then prove normal channel and
   outbound HTTP behavior. This isolates the runtime change from package changes.

### Stage B: PR #177, provider image only

1. Update Claude Code and Agent SDK to the exact matching latest pair.
2. Keep direct `@anthropic-ai/sdk` at `0.115.0`.
3. Keep Codex at latest and replace operational `0.145.0` hard-coding with an
   exact-pin invariant. Historical protocol-provenance comments stay unchanged.
4. Keep OpenCode CLI/SDK/captured tools at one exact version and repair every
   mutating installer, removal, clone, and provider-contract path.
5. Add compiler-enforced parity between the Claude SDK `EffortLevel` and the
   five-value runtime schema.
6. Revert Bun to `1.3.14` in both `container/Dockerfile` and the hand-synced
   `.github/workflows/ci.yml` mirror. Revert all unrelated Docker, Python, MCP,
   browser, and Remotion churn. The latest provider set already passes typecheck
   and imports on Bun `1.3.14`.
7. Build a non-canonical candidate and require two-turn harness canaries for all
   three providers before promotion.

### Stage C: new host dependency PR

Only after Stage A is healthy on production Node:

1. Update `@slack/web-api` to the approved current 8.1.x release.
2. Update Undici to `8.10.0` and better-sqlite3 to `13.0.3`.
3. Keep the explicit better-sqlite3 build denial and corrected security docs.
4. Add a deterministic host runtime smoke: Undici import, Slack `WebClient`
   construction, in-memory SQLite `SELECT 1`, and clean close.
5. Validate a copy of the production database under better-sqlite3 13, including
   `integrity_check`, migrations, and opening the unchanged copy again under v11.

Stages A and B may be reviewed in parallel, but Stage C cannot activate before
Stage A is healthy. Each stage has its own rollback and never hides another
stage's failure.

## Design

### Single Node-floor predicate

Add one dependency-free executable predicate, usable before installation:

```text
node scripts/check-node-version.mjs [version]
```

It exits 0 for `>=22.19.0`, non-zero otherwise, and exposes its pure comparison
function for tests. Setup, installer, and deploy reuse it rather than maintaining
three comparisons.

- Missing Node: installer follows its existing installation path.
- Old Node: installer upgrades; setup reports unsupported; deploy stops before restart.
- Node 22.19+ and Node 24+: accepted.

### Version-invariant contracts

- Claude Docker CLI equals the Agent SDK package's `claudeCodeVersion`.
- OpenCode Docker CLI, SDK, and live-capture constant are equal.
- Codex accepts any stable exact numeric pin and rejects missing, ranged, `latest`,
  or unconsumed values. No verifier embeds the current release.
- Operational provider instructions derive from the Docker pin rather than
  embedding a second mutable version source.

### Candidate-image canary

Build `pr177-provider-canary` through `container/build.sh`; it must remain labeled
as a candidate and must never receive the canonical tag.

For Claude, Codex, and OpenCode independently:

1. Start `/app/entrypoint.sh` with disposable inbound/outbound databases and
   production-equivalent read-only source/auth mounts.
2. Send a prompt requiring one harmless read-only tool call and the exact marker
   `CANARY_TOOL_OK`.
3. Require a completed processing acknowledgement and exact outbound result.
4. Send a second turn in the same session requiring `CANARY_RESUME_OK`.
5. Require successful continuation, then terminate and verify a clean exit.

This exercises the real harness paths: Claude SDK to `/pnpm/claude`, Codex
app-server initialize/thread/turn, and OpenCode serve plus SDK.

## Executable acceptance criteria

Team-build materializes these before implementation and observes the relevant
new tests fail against current PR heads.

### Node/runtime

1. **`test_node_floor_boundaries`** rejects `20.20.2` and `22.18.0`; accepts
   `22.19.0`, later 22.x, and 24.x.
2. **`test_install_node_upgrades_unsupported_existing_node`** sends an existing
   old Node through upgrade, not `already-installed`.
3. **`test_deploy_stops_before_restart_on_unsupported_node`** exits before
   install, build, status-ok, or systemctl.
4. **`test_engine_strict_blocks_old_node`** proves a frozen install cannot proceed
   on an unsupported runtime during the first rollout.
5. **Node 22.19/24 CI matrix** runs the engine-strict frozen install on both
   versions, then format, public boundary, host/container typechecks, host tests,
   and container tests; aggregate `ci` remains. This catches both a floor violation
   and a dependency that excludes Node 24.

### Provider lockstep

6. **`test_claude_cli_agent_sdk_lockstep`** verifies Docker Claude Code equals
   Agent SDK `claudeCodeVersion` and the approved exact target.
7. **`test_claude_effort_contract`** fails typecheck if SDK and runtime schema differ.
8. **`test_codex_pin_is_exact_and_consumed`** accepts `0.150.1`-style exact pins
   and rejects ranged, `latest`, missing, or unconsumed pins.
9. **`test_opencode_all_operational_pins_match`** covers Docker, SDK, capture,
   add/remove/clone flows, and provider contract.
10. **`test_no_stale_operational_provider_pins`** excludes old literals from
    mutating instructions and verifier expectations; historical evidence is exempt.
11. **Provider suites** pass for Claude, Codex, OpenCode, and tool/schema guards.

### Host dependencies and rollback

12. **`test_host_runtime_smoke`** imports Undici, constructs Slack, opens SQLite,
    executes `SELECT 1`, and closes.
13. **Database copy check** passes SQLite `integrity_check`, app startup/migrations,
    representative session reads/writes, and v11 rollback open.
14. **Provider image canaries** pass two turns through each real provider path.
15. **Rollback rehearsal** retains the current image digest and host commit;
    failed candidate smoke changes neither canonical tag nor running service.

## Verification commands

Implementation review runs fresh output from:

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run format:check
pnpm run check:public-boundary -- --portable
pnpm exec vitest run --maxWorkers=2
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
cd container/agent-runner && bun install --frozen-lockfile && bun test
```

Also run Node-floor tests under Node `22.19.0` and 24, provider version probes
inside the candidate image, the three authenticated canaries, and the database-copy
round trip. Candidate image build, host runtime upgrade, restart, and deployment
remain operator actions; their exact command/output is recorded before ship.

## Rollout and rollback

- **Stage A host runtime:** keep the service running while installing Node 22.19+;
  verify the service's actual executable, restart once, then check 60 seconds of
  stable process state, zero restart growth, clean logs, one channel round-trip,
  one proxied Undici request, and Slack `auth.test` where configured.
- **Stage A rollback:** restore the previous Node executable/path and pre-stage
  commit, frozen-install, rebuild, and restart. No dependency format changed.
- **Stage B provider image:** retain the current canonical digest under a rollback
  tag. Candidate failures never promote. On post-promotion failure, retag the
  retained digest and restart only affected/new sessions.
- **Stage C host dependencies:** retain the pre-stage commit, lockfile, and database
  copy. Roll back code and dependencies together; the compatibility check proves
  the unchanged database copy still opens under v11.

Dave controls every merge, host runtime change, image promotion, deployment, and
restart. Agents prepare changes, tests, candidate commands, and evidence only.

## Known risks

- The production service executable and Node version remain unverified. This is a
  hard gate, not an inferred detail.
- Claude `2.1.250` was newer than Anthropic's `stable` npm tag and had little soak
  when resolved. Dave explicitly selected the latest pair. The real two-turn
  canary remains mandatory.
- Agent SDK releases changed default Todo/Task exposure and PDF result placement;
  focused provider tests plus the real canary must cover both tool and result flow.
- Codex app-server is experimental; start, turn, tool call, resume, and steer paths
  must pass against `0.150.1`.
- `main` is already red from PR #175. Review compares exact failing-test names and
  requires zero branch-specific failures before merge.

## Non-goals

- No merge, deployment, service restart, host runtime mutation, or canonical image
  build by agents.
- No direct Anthropic SDK bump, unrelated container/tool bump, models-cache reset,
  or broad update-service abstraction.
