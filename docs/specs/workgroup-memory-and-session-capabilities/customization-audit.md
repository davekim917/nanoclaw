# Customization Preservation Audit

Date: 2026-07-26

Verdict: PASS for implementation and merge preservation. Activation remains
outside this audit, and the independent Claude implementation review is
currently unavailable because the account is rate-limited.

## Baseline

| Item                          | Value                                      |
| ----------------------------- | ------------------------------------------ |
| Common base                   | `a30547fb6a4da455150c0acc1d95e7d8d73b95e8` |
| Rollback tag                  | `pre-update-6c889556-20260724-162840`      |
| Upstream                      | `641963c1e4b7ba4f000a18dfc5e2fea29069feec` |
| Merge commit                  | `ceb3fcd1a7f9b31f555efd6f20a0aab54ece605a` |
| Pre-merge customized files    | 982                                        |
| Upstream-changed files        | 268                                        |
| Dual-touched files            | 64                                         |
| Functional dual-touched files | 54                                         |

The upstream SHA is the merge commit's exact second parent. The merge commit
has two parents and is an ancestor of the current HEAD.

## High-risk customization contracts

| ID  | Intent and integration point                                                                 | Upstream overlap and preservation requirement                                                                                                      | Verification                                                              |
| --- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| C1  | Skill-installed channel adapters plus this fork's multi-bot Discord behavior                 | Upstream removed `setup/channels/discord.ts`; preserve the customized runtime adapter and registration barrel                                      | Customized Discord and registry suites: 85/85                             |
| C2  | Claude, Codex, and OpenCode provider lifecycle, model/effort controls, retries, and recovery | Upstream changed provider and poll-loop contracts; preserve every provider and fresh-context transition                                            | Focused provider/memory: 174/174; full runner: 928 pass                   |
| C3  | Atomic destination, thread, delivery, session, and agent-to-agent routing                    | Upstream changed formatter/session/routing shapes; preserve thread anchors, no self-loop, and correct destination fallback                         | Focused customization suite: 423 pass; full host: 3,031 pass              |
| C4  | Workgroup boundary, shared filesystem, mounts, and sibling parity                            | Upstream introduced native group memory; preserve the workgroup-above-group tenancy model and one canon shared by all siblings                     | Workgroup/context/verifier suite: 122/122; live verifier: 0 failures      |
| C5  | Task and scheduling routing through the same admissible context seam                         | Upstream changed task/CLI contracts; preserve inert writes, due admission, routing, and retries                                                    | Task/context suite included in 122/122 and customization suite            |
| C6  | Permissions, approvals, self-modification, and agent-to-agent guards                         | Upstream changed action registration and guard surfaces; preserve fail-closed authorization and real handler wiring                                | Focused customization suite and full host suite                           |
| C7  | Capability scope, group initialization, and container spawn configuration                    | Preserve exact sibling capability access, once-per-provider-context bootstrap, and `get_capabilities` mid-turn                                     | Capability/group/container tests in 423-pass suite; provider behavior 6/6 |
| C8  | Lossless memory migration into one workgroup Markdown authority                              | Retire row-based runtime memory without deleting historical schema/data; preserve every source tree, link, collision, and rollback byte            | Migration/context/verifier/provider suites all pass                       |
| C9  | Container dependencies and runtime tools                                                     | Container changes require a valid expected image; agent-runner source remains a shared read-only mount                                             | Container build passed; expected image present; both typechecks pass      |
| C10 | Customization-first update and provider/channel replay skills                                | Upstream changed skill directives and branch model; preserve create-only/fail-closed replay and the full-merge audit contract for Claude and Codex | Skill replay/conformance tests included in 423-pass suite                 |

## Deleted and renamed surfaces

- `setup/channels/discord.ts`: legitimate upstream branch-model replacement.
  The customized installed adapter remains at `src/channels/discord.ts`, its
  barrel import remains present, its exact dependency remains installed, and
  behavior/registry tests pass.
- `src/db/memories.ts`, `Memory`, and `MemoryType`: deliberate retirement of a
  second runtime memory authority. Migration 013 and existing table data are
  retained. The replacement is the canonical workgroup Markdown tree,
  compatibility links, bounded recall, atomic memory-write tool, lossless
  migrator, and read-only runtime verifier.
- `A2A_MESSAGE_GATE_ACTION`: moved to the guard module and re-exported from the
  original route surface; customized callers still resolve.
- `applyInstallPackages` and `applyAddMcpServer`: preserved as async exported
  handlers and still registered by the self-mod module.
- Other reported missing exports from removed channel setup helpers or the old
  duplicate-send helper have no remaining customized callers.

## Update audit gates

| Gate                          | Result                                           |
| ----------------------------- | ------------------------------------------------ |
| A. Customization preservation | PASS                                             |
| B. Expected container image   | PASS                                             |
| C. Live central migrations    | PASS; 43/43 defined migrations applied           |
| D. Environment drift          | PASS with legacy unused-key flags left untouched |
| E. Supply-chain policy        | PASS; no new age gate or build allowlist         |
| F. Merge ancestry             | PASS                                             |

The service has not been restarted for the uncommitted implementation. A live
post-activation smoke is therefore intentionally not claimed here.
