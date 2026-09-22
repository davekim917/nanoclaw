# One controller-owned QA phase

This task is one accepted phase of a durable campaign. Read its full brief and the smoke-test skill. Verify run ID, source SHA and coordinator owner token against `controller/wake.json` and the completion contract before writing. Existing artifacts and findings survive this fresh coordinator context.

Create `controller/brief-<step>.ack` after accepting the brief. This acknowledges ownership only; it never proves QA success. Use one retained provider-native `qa-smoke-worker` for this phase. Supply the bounded current brief and required role context; on Codex start with `fork_turns: "none"`. Preserve that worker through build, tests and repairs. Never resume a native handle from a different parent session.

Write only the artifacts named by the phase brief. Preserve prior findings. Before scaffold or barrier commands source the group's gate environment and pass the owner token from the saved wake as `SMOKE_GATE_OWNER`. A missing active owner or failed phase requires an explicit recovery disposition preserving artifacts, not silent replacement.

Use `continue_work` for unfinished work within this phase. Stop after the phase artifacts are durable and all owned workers finish. Do not wait for or start the next phase. The host controller checks artifacts and settled execution before dispatching the next decision in a fresh context.

No chat, GitHub comments/issues, gate finish/release verbs, or campaign verdict publication. The existing controller remains the sole reporter and release authority. A late callback must verify that its phase is still open before writing; if already accepted or campaign terminal, record no new work and stop.
