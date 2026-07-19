## Build State Checkpoint

Last updated: 2026-07-19T05:41:46Z

Team: `graphify-container-code-intelligence-build`

### Groups Completed

- Group A — Graphify Core and Transaction Boundary. Lead read the complete gateway, worker, upstream-contract, supply-chain, and behavioral test surfaces, reviewed both correction attempts, reproduced 33 source-lane tests with 32 passing and the single documented ARM64 wheelhouse test deferred to Group D, and verified diff hygiene, no bytecode artifacts, immutable-source retry semantics, transactional promotion/recovery, private request isolation, bounded metadata/output, kernel/process limits, exact MCP routing, portable AST reuse, and concise fail-closed behavior.
- Group B — Host Cache Lifecycle and Container Projection. Lead read all nine owned files, reviewed the exact diff, reproduced 100 targeted host tests and 23 targeted Bun tests, and verified host build, runner typecheck, diff hygiene, unchanged `isContainerRunning`, cache containment, participant guards, and provider-neutral projection.
- Group C — Complete Container GitNexus Retirement. Lead read every owned implementation and test file, reviewed the exact diff and both correction attempts, reproduced 18 targeted host tests and 60 targeted Bun tests with three documented baseline skips, and verified host build, runner typecheck, diff hygiene, inert legacy parsing, current-generator cleanliness, provider re-entry sanitization, truthful capability output, unrelated-plugin preservation, and unchanged HIGH-impact helper bodies/signatures.
- Group D — Image, Mandatory Skill, and Environment-Scoped Instructions. The approved protected candidate `sha256:d3773a52500ae98d8b80c0dd128ef094af1ce87f6a603d912d5d7b9383122f8b` passed the finished-image contract 12/12. Production `latest` is `sha256:dc6d4e8431106fee8accde525040f73343fc81aa8b0536077f587dc276504274`; it has the identical creation time, size, RootFS layer list, and RootFS SHA-256 `034171e40dd4538f1d10dc80b9e3d23fc070a9e23320fff341360acc64a953d6` as d3773a. The only config difference is the corrected `nanoclaw.commit=3e2feb7341c5dc171e8514f5464ffecd5adffb7e` production runtime-source provenance label.
- Group E1/E2 — Deterministic fixture and production-style runtime gates. The protected candidate scored 1.0 for all six clean/cached/modified/untracked/deleted/data-JSON generations. The 38-scenario runtime matrix passed with 156,975,104-byte peak measured verifier memory, zero OOM/oom_kill events, and no request-accounting overage, stale query, partial promotion, cache bleed, orphan process, staging debris, or repository mutation. Evidence hashes are `9d0c9c2ac2bddbbddc5bdf691650fe279a75d4248b499359cec7f4d40504283e` and `14f32ecbfafd1efaf5505b5f09002abfd71bb95498f177854b29016a2baec261`.

Pre-build drift gate passed: `MISSING 0 · DIVERGED 0 · PARTIAL 0`.

### Frozen Gate Result Retained

- Group E3 — Agent-value activation gate. The one authorized immutable v4 matrix retained all 36 rows and scored 18/18 exact claims in both arms. Graphify improved median files from 18 to 13 (27.777777778%) and median tool-output bytes from 28,753 to 22,889.5 (20.39230689%). It nevertheless failed the zero-tolerance execution-grounding gate: six Graphify rows retained a public Graphify `item.started` with no matching `item.completed` (`container-resource-resolution` repetitions 1/2/3, `graphify-cache-identity` repetition 2, `memory-admission-priority` repetition 3, and `timezone-conversion-contract` repetition 2). All 18 Graphify rows raw-started their public query before ordinary source navigation; the frozen summary reports 12/18 treatment adherence because unmatched starts are excluded from completed `toolCalls`. That discrepancy is retained, not reinterpreted: the same six unfinished tools independently failed D35. Raw and summary hashes are `b0bb910ed411b8febd684f1e3128a7ff3a105a5ba22325371628a30d9e84216b` and `02cb3669b9a7432e777f4d8f9c04b5e7f33f1e07169cb7b2e69ac588a6b41397`. No rerun, replacement, exclusion, or post-result semantic change is permitted.

### Groups Remaining

- None.

### Activation Authorization

- At 2026-07-19T05:14:23Z the user explicitly instructed: `Approve full activation of d3773a`.
- D40 authorizes direct commit and push, activation of the exact protected candidate, service restart, and live Claude/Codex verification.
- This authorization supersedes D36 only for rollout disposition. It does not modify, rerun, replace, or reinterpret the frozen v4 matrix or its failed execution-grounding result.

### Activation Result

- Source commit `3e2feb7341c5dc171e8514f5464ffecd5adffb7e` is published to `origin/main`.
- The service was rebuilt and restarted with production `latest` image `sha256:dc6d4e8431106fee8accde525040f73343fc81aa8b0536077f587dc276504274`, the runtime-identical and correctly runtime-source-labeled form of approved candidate d3773a recorded in D41.
- Effective defaults and live Claude/Codex containers use a 2048 MiB reservation, 5120 MiB hard limit, and 5120 MiB swap limit. Both live containers had the exact dedicated `/workspace/.cache/graphify` and `/run/nanoclaw-graphify` bind mounts plus the private 192 MiB `/workspace/.graphify-stage` tmpfs.
- Claude returned a concrete `sendMessage` match at `container/agent-runner/src/mcp-tools/core.ts`; Codex returned a concrete `sessionGraphifyCacheDir` match at `src/session-manager.ts`. Both queried a 918-source-file managed `nanoclaw` worktree with supervisor `reason:"ok"`.
- `command -v gitnexus` failed in both live containers, neither container mounted `/workspace/plugins/gitnexus`, and both cgroups recorded zero OOM and zero oom_kill events. The temporary CLI validation wiring and messaging group were removed.

### Builder Assignments

- `builder-a`: Group A; only the Group A files in `plan.md` plus the exact Graphify v0.9.16 upstream source as read-only reference.
- `builder-b`: Group B; only the Group B files in `plan.md`.
- `builder-c`: Group C; only the Group C files in `plan.md`.
- `builder-d`: Group D; only the Group D files in `plan.md`.
- `builder-e`: Group E; only the Group E files in `plan.md`.

The assignment file sets are disjoint.

### Decisions Made During Build

- Existing primary worktree is used; no nested worktree was created.
- Cross-model drift diversity is reduced because the installed Claude CLI returned HTTP 401. Two isolated Codex passes converged after reconciliation.
- Legacy `gitnexusInjectAgentsMd` parsing remains inert compatibility; `readContainerConfig` and `isContainerRunning` must not be edited.
- Group C impact preflight found `parseHostMcpServers`, `buildSessionServicesSnapshot`, and `renderSessionCapabilities` HIGH. The builder stopped before edits. Lead verification approved a no-HIGH-symbol route through LOW `buildMergedConfig`, `setupCodexRuntime`, and `getHostCapabilities`; high helper bodies/signatures remain untouched and caller tests must prove unrelated data preservation.
- Group C completion attempt 1 was rejected because `container/nanoclaw-plugin/.claude-plugin/plugin.json` still pointed at deleted hooks and `getHostCapabilities()` still advertised `nanoclaw-hooks`. Correction attempt 1 deleted the manifest, removed the stale built-in capability path, and added a behavioral regression assertion.
- Group C was reopened after correction attempt 1 because `plugins.installed` still enumerated the host-only `~/plugins/gitnexus` directory even though container mounts exclude it. `listHostPlugins` impact is LOW; correction attempt 2 is limited to the container-facing capability list and its behavioral test.
- Group C correction attempt 2 was accepted after `listHostPlugins()` excluded only the exact case-folded `gitnexus` name, preserved an ordinary plugin in the same mocked host directory, and the lead independently reproduced the targeted tests, build, runner typecheck, and diff check.
- Group A initial completion was rejected for cache-path/lock mismatches, stale-after-wait races, non-transactional tmpfs handling, shallow concurrency/failure tests, and an incomplete ABA regression. Correction attempt 1 aligned the runtime contract and replaced synthetic checks with behavioral process/transaction tests.
- Group A correction attempt 2 was required after full source review found unsupported exact-tag root assumptions, MCP dispatch drift, request leakage through a host-shared runtime, unrestricted large AST parsing, query pipe deadlock risk, insufficient metadata capacity, missing cached-query admission, symlink escapes, and raw expected-error tracebacks. The accepted result pins the exact upstream contract, keeps requests private, bounds every artifact and subprocess, validates before promotion/query, and adds behavioral regressions for each failure mode.
- The final Group A acceptance pass additionally required schema checks for decoded candidate metadata and exact case-sensitive MCP filename routing. Lead independently reproduced the final 33-test source lane: 32 passed and only the intentionally image-deferred ARM64 wheelhouse install test skipped.
- Group D's first real image build reached the audited install but rejected package-name case (`RapidFuzz` versus `rapidfuzz`); the exact-version comparison was corrected with package-name normalization. Its first finished-image run then exposed root-only copied contract artifacts, so the image now makes those non-secret files read-only to the runtime user.
- A subsequent rebuild exposed a real TOCTOU race in Group A's process-cleanup test: `/proc/<pid>/stat` could vanish or briefly remain runnable after the initial existence check. The Group A owner tightened the assertion to poll for at most 0.5 seconds and accept only reaped-or-zombie state; 20 repeated timeout tests and the full source suite passed before the final image rebuilt with the correction.
- Group D's final image build ran all 33 source contracts successfully, including the ARM64 offline wheelhouse case. Lead independently reran the finished-image contract, which passed the public/private CLI boundary, exact closure, GitNexus absence, NPROC-zero real extraction/query, portable AST/root attribution, ENOSPC, timeout teardown, and kernel/task-guard checks.
- Safe `query|path|explain|affected --help|-h` forms were added as side-effect-free aliases of root help. Unit and finished-image tests prove they do not resolve a repository, inventory source, create runtime/cache state, or spawn the worker, while help combined with query arguments and all bypass flags still fail closed.
- The evaluation shell-command classifier now tokenizes quotes and command operators before recognizing executables. This fixes v2 false positives where `graphify` appeared only inside an `rg` pattern and retains negative coverage for echo text, lookalike executable names, forbidden interpreters, and actual piped or shell-wrapped Graphify calls.

### Retained Escalation

- D36 records the final v4 result. Claim correctness and efficiency passed, but six unfinished public Graphify tool calls failed zero-tolerance execution grounding. The one authorized matrix remains unchanged and no rerun or reinterpretation occurred. D40 authorized rollout disposition and D41 records the completed activation without changing that result.

### Post-v4 Deterministic Remediation

- The six unfinished public Graphify calls were traced to a Codex lifecycle gap, not to Graphify freshness or query failure: Codex could emit `turn/completed` while an execution item remained open, and the provider cleared that state without rejecting the turn.
- The runner now treats a successful turn with an unfinished execution item as `protocol_desync`, replaces the app-server once, and resumes the same persisted thread without resending the prompt. A normally completed execution lifecycle and reasoning-only lifecycle items remain healthy.
- Focused lifecycle, health, and recovery tests prove fail-closed detection, current Codex nested failed-turn compatibility, one-shot replacement, same-thread resume, and no duplicate prompt. The complete runner suite, host suite, host build, and runner TypeScript typecheck pass.
- An earlier non-live remediation image remains retained as `nanoclaw-agent-v2-2a38bd3e:graphify-finalization-candidate-20260719` (`sha256:a5b998f0ee7def64e67a6828ec04c9eb966c0779043f50eba8bfe2e1ef2d0177`) for audit history.
- The approved protected candidate is `nanoclaw-agent-v2-2a38bd3e:graphify-topology-guard-candidate-20260719` (`sha256:d3773a52500ae98d8b80c0dd128ef094af1ce87f6a603d912d5d7b9383122f8b`). Production uses its RootFS-identical, shipped-runtime-source-labeled form `sha256:dc6d4e8431106fee8accde525040f73343fc81aa8b0536077f587dc276504274`. Before any repository, source, cache, or worker access, the gateway requires exact dedicated writable cache and runtime mounts plus an exact private 0700 tmpfs staging mount owned by the runtime UID and capped at 192 MiB. Root and subcommand help and version remain side-effect-free.
- The protected candidate passed 12/12 finished-image contracts, all six clean/cached/modified/untracked/deleted/data-JSON generations at score 1.0, and all 38 production-style runtime scenarios. The runtime gate measured a 156,975,104-byte peak under the 2048 MiB request and 5120 MiB limit, zero OOM/oom_kill events, zero request overage, no stale query or partial promotion, no cache bleed, no orphan process, no source-stage debris, and a clean repository. Fixture evidence SHA-256 is `9d0c9c2ac2bddbbddc5bdf691650fe279a75d4248b499359cec7f4d40504283e`; runtime evidence SHA-256 is `14f32ecbfafd1efaf5505b5f09002abfd71bb95498f177854b29016a2baec261`.
- Final source regression evidence is 52 Graphify tests passed with two environment-specific skips, 830 Bun runner tests passed with four baseline skips, and 2,469 host tests passed with one skip and one todo. Host build and runner TypeScript typecheck passed. The image/workspace gateway provenance differs only by the deliberate build-time shebang replacement to `/opt/graphify/bin/python`; the remaining bytes are identical.
- This remediation did not modify, rerun, replace, or reinterpret v4. The user subsequently authorized rollout under D40; the service restart and live provider checks completed, and D41 records the runtime-identical production image plus the corrected full topology.

### Known Risks

- A1-A3 and A5-A7 are validated in the rebuilt image and production-style gates. A4/A8 remain formally false because the final v4 matrix failed execution grounding, despite 18/18 exact claims per arm and material file/byte reductions.
- Service/container activation remained excluded from `/team-auto`; the explicitly approved direct ship path completed it.
- D40 explicitly authorizes the protected candidate to advance through that path despite D36; the frozen v4 matrix and its failed D35 execution-grounding result remain unchanged.
- The pre-activation partial-topology observation remains important history, but it is no longer live. Production `latest` now carries the protected gateway, and real Claude and Codex containers proved the exact cache, runtime-lock, and staging mounts together with the 2 GiB reservation / 5 GiB ceiling. The gateway still fails closed if a future image/host rollout becomes partial.
