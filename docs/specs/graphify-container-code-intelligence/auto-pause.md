# /team-auto ship handoff resolved

**Stage:** Ship complete
**Reason:** D40 authorized full activation of d3773a; D41 records its RootFS-identical, shipped-runtime-source-labeled production form
**Matrices retained:** v1, v2, v3, and v4
**Last action completed:** Published commit `3e2feb7341c5dc171e8514f5464ffecd5adffb7e`, activated production, and verified real Claude and Codex Graphify queries with the full protected topology.
**Resolution:** At 2026-07-19T05:14:23Z the user explicitly approved full activation of the protected `d3773a` candidate. D40 authorized the direct ship path while preserving the frozen v4 result unchanged; D41 records completed activation.

## Final v4 result

The immutable v4 matrix retained all 36 runs. Both arms scored 18/18 exact claims. Graphify improved median files from 18 to 13 (27.777777778%) and median tool-output bytes from 28,753 to 22,889.5 (20.39230689%). Six Graphify rows nevertheless retained a public Graphify `item.started` with no matching `item.completed`, which violates D35's zero-tolerance execution-grounding gate. All 18 Graphify rows raw-started a public query before ordinary source navigation, while the frozen summary reports 12/18 adherence because unmatched starts are excluded from completed `toolCalls`; the failed executions are retained and are not reinterpreted as passing treatment.

## Retained evidence

- Candidate image: `sha256:8f92cba804ec5ea894195724f77c6ea44f2681be3e0581526cdd6f572a83fca6`.
- Raw v4 SHA-256: `b0bb910ed411b8febd684f1e3128a7ff3a105a5ba22325371628a30d9e84216b`.
- Summary SHA-256: `02cb3669b9a7432e777f4d8f9c04b5e7f33f1e07169cb7b2e69ac588a6b41397`.
- The finished-image contract passed 12/12; six deterministic fixture generations scored 1.0; all 38 runtime scenarios passed with 157,425,664-byte peak and no OOM/oom_kill, request overage, cache bleed, orphan, or debris.
- Production `latest` is `sha256:dc6d4e8431106fee8accde525040f73343fc81aa8b0536077f587dc276504274`, whose RootFS is byte-identical to approved candidate d3773a and whose only config difference is the corrected shipped-commit provenance label.

## Former blocked action

Do not rerun, exclude, replace, or reinterpret any v4 row. Activation was blocked under D36 until the user explicitly approved the exact protected `d3773a` candidate; D40 authorized rollout disposition and D41 records completion without changing the v4 result.

## Post-pause remediation retained

The unfinished-call pattern was reproduced as a Codex provider lifecycle defect: `turn/completed` could arrive while an execution item remained open. The runner now fails that state closed and automatically performs one app-server replacement plus same-thread resume without duplicating the prompt.

The protected candidate is `sha256:d3773a52500ae98d8b80c0dd128ef094af1ce87f6a603d912d5d7b9383122f8b`. Its gateway fails before repository, source, cache, or worker access unless the exact shared cache mount, install-wide runtime mount, and private 0700 staging tmpfs capped at 192 MiB are present. It passed 12/12 finished-image contracts, all six automatic-freshness generations at score 1.0, and all 38 production-style runtime scenarios at a 156,975,104-byte peak with zero OOM/oom_kill events, no request overage, stale query, partial promotion, cache bleed, orphan process, stage debris, or repository mutation. Production uses the RootFS-identical image `sha256:dc6d4e8431106fee8accde525040f73343fc81aa8b0536077f587dc276504274` with the shipped commit label.

This deterministic remediation evidence did not change the v4 result. The subsequent explicit D40 authorization lifted only rollout disposition; the service restart and live checks are now complete.

## Live-topology correction

The final audit found that the current system is not a clean pre-feature baseline. A Example Retail container observed during the audit used the July 18 `latest` image, which already contains `/usr/local/bin/graphify`, and exposed the current Graphify skill through a live bind mount. Its host-created topology predated the Graphify host changes: there was no `/workspace/.cache/graphify` or `/run/nanoclaw-graphify` bind mount and no `/workspace/.graphify-stage` tmpfs. The old host also still mounted the host GitNexus plugin directory, although the GitNexus executable was absent. No Graphify execution appeared in the retained container logs.

At that checkpoint the ephemeral agent container had exited and no agent containers were running at 2026-07-19T05:02:22Z. It was only a quiet window: the unchanged old host and `latest` image could recreate the partial topology on the next wake, and the protected candidate's topology guard was not yet active in `latest`.

The partial state is resolved. Live Claude and Codex containers used the protected runtime with exact cache and runtime mounts, a private 192 MiB staging tmpfs, a 2048 MiB reservation, a 5120 MiB hard and swap limit, no GitNexus executable or plugin mount, and zero OOM/oom_kill events. Both returned concrete Graphify 0.9.16 symbol matches from managed `nanoclaw` worktrees. The temporary host-only CLI validation wiring was removed afterward.
