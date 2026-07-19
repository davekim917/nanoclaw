# /team-auto paused at Stage Build

**Stage:** Build
**Reason:** the one authorized frozen v4 matrix failed zero-tolerance execution grounding
**Matrices retained:** v1, v2, v3, and v4
**Last action completed:** Retained and diagnosed the complete immutable v4 36-row matrix without rerun or reinterpretation.
**Resolution:** At 2026-07-19T05:14:23Z the user explicitly approved full activation of the protected `d3773a` candidate. D40 authorizes the direct ship path while preserving the frozen v4 result unchanged.

## Final v4 result

The immutable v4 matrix retained all 36 runs. Both arms scored 18/18 exact claims. Graphify improved median files from 18 to 13 (27.777777778%) and median tool-output bytes from 28,753 to 22,889.5 (20.39230689%). Six Graphify rows nevertheless retained a public Graphify `item.started` with no matching `item.completed`, which violates D35's zero-tolerance execution-grounding gate. All 18 Graphify rows raw-started a public query before ordinary source navigation, while the frozen summary reports 12/18 adherence because unmatched starts are excluded from completed `toolCalls`; the failed executions are retained and are not reinterpreted as passing treatment.

## Retained evidence

- Candidate image: `sha256:8f92cba804ec5ea894195724f77c6ea44f2681be3e0581526cdd6f572a83fca6`.
- Raw v4 SHA-256: `b0bb910ed411b8febd684f1e3128a7ff3a105a5ba22325371628a30d9e84216b`.
- Summary SHA-256: `02cb3669b9a7432e777f4d8f9c04b5e7f33f1e07169cb7b2e69ac588a6b41397`.
- The finished-image contract passed 12/12; six deterministic fixture generations scored 1.0; all 38 runtime scenarios passed with 157,425,664-byte peak and no OOM/oom_kill, request overage, cache bleed, orphan, or debris.
- The default `latest` remains `sha256:d23404afc6a6fc459687227b6520b1f538fc04511adeab261174672974acb968`; no deliberate service restart or candidate activation occurred.

## Blocked action

Do not rerun, exclude, replace, or reinterpret any v4 row. Activation was blocked under D36 until the user explicitly approved the exact protected `d3773a` candidate; D40 now authorizes rollout disposition without changing the v4 result.

## Post-pause remediation retained

The unfinished-call pattern was reproduced as a Codex provider lifecycle defect: `turn/completed` could arrive while an execution item remained open. The runner now fails that state closed and automatically performs one app-server replacement plus same-thread resume without duplicating the prompt.

The current protected non-live image is `sha256:d3773a52500ae98d8b80c0dd128ef094af1ce87f6a603d912d5d7b9383122f8b`. Its gateway fails before repository, source, cache, or worker access unless the exact shared cache mount, install-wide runtime mount, and private 0700 staging tmpfs capped at 192 MiB are present. It passed 12/12 finished-image contracts, all six automatic-freshness generations at score 1.0, and all 38 production-style runtime scenarios at a 156,975,104-byte peak with zero OOM/oom_kill events, no request overage, stale query, partial promotion, cache bleed, orphan process, stage debris, or repository mutation. The complete Graphify, runner, and host test suites plus both TypeScript checks also passed.

This is deterministic remediation evidence only. It does not change the v4 result or lift this pause. No service or live container was restarted, and activation still requires a new explicit user decision.

## Live-topology correction

The final audit found that the current system is not a clean pre-feature baseline. A Madison Reed container observed during the audit used the July 18 `latest` image, which already contains `/usr/local/bin/graphify`, and exposed the current Graphify skill through a live bind mount. Its host-created topology predated the Graphify host changes: there was no `/workspace/.cache/graphify` or `/run/nanoclaw-graphify` bind mount and no `/workspace/.graphify-stage` tmpfs. The old host also still mounted the host GitNexus plugin directory, although the GitNexus executable was absent. No Graphify execution appeared in the retained container logs.

That ephemeral agent container has exited, and no agent containers were running at 2026-07-19T05:02:22Z. This is only a quiet window: the unchanged old host and `latest` image can recreate the partial topology on the next wake, and the protected candidate's topology guard is not active in `latest`.

Do not leave this partial state as the final outcome. The user selected complete validated activation of the exact protected `d3773a` candidate; direct commit, push, service restart, and live Claude/Codex verification are authorized under D40.
