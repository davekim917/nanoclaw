# Native frontier worker trial

The managed general worker roster is only `worker-frontier`. Cross-provider
transport invokes the Bootstrap CLI helper directly, without a wrapper agent. Specialized and operator-owned
agents stay available. Fleet primary model settings are separate.

Claude's frontier definition uses `claude-opus-5[1m]` with `effort: high`.
The installed SDK's native `AgentInput` has no per-call effort field. For an
explicit task override, use Bootstrap's `scripts/frontier-worker.mjs` helper
(discovered through its orchestrate skill) with `--runtime claude --effort`.
It scopes `CLAUDE_CODE_EFFORT_LEVEL` to the foreground child invocation;
writing an effort request in a prompt is insufficient.

Codex's converted frontier role pins `gpt-5.6-sol` and deliberately omits
`model_reasoning_effort`. Both generated primary and companion configs set
`[agents].default_subagent_reasoning_effort = "high"`. This leaves native
spawn `reasoning_effort` available for an explicit task override. The default
applies to otherwise unpinned specialized subagents too. Fable 5.1 / Astra 6 stay reachable as the judgment-shape escalation through a
per-dispatch model override on the same `worker-frontier` name, never a second
agent definition.

Keep implementation, test, and correction in the same worker session. Resume
an exact recorded ID; never use a global latest-session selector. Independent
review starts in a fresh context. Keep CLI children foreground-attached for
cancellation; background concurrency belongs to the parent worker layer.

Choose native dispatch or the CLI helper at task start. A native subagent handle
belongs to its parent session; it cannot be resumed as the helper's CLI UUID.
For effort changes across resumptions, start with the helper and repeat the
chosen model/effort on each exact-ID resume. Native Codex effort overrides apply
at spawn; native follow-ups retain their current configuration unless that
runtime explicitly exposes an update. Failed cross-transport resume is a
recovery decision, never permission to silently restart the build.

Ordinary coordinators use Sonnet/xhigh (Claude) and Terra/xhigh (Codex) for this
trial. High is the default worker effort; the default worker is `claude-opus-5` on Claude and `gpt-5.6-sol` on Codex. Fable/Astra
are the judgment-shape escalation and run at medium, selected with helper --model
from task start. Escalating the model does not also escalate the effort. QA/release roots that still own
technical verdicts remain separate until their judgment responsibilities move
to frontier owners. Existing scheduled-task pins are separate from group defaults.

## Activate and verify

Host personal agent definitions outrank plugin definitions in discovery.
Reconcile known managed old `worker-fast`, `worker`, `worker-high`, and
`worker-opus` and `worker-codex` definitions in both places before running Codex subagent sync.
That sync deletes stale TOMLs only when they carry its managed marker, and
preserves manually authored TOMLs. Resolve any manual same-name conflict
explicitly; do not erase it just to make the roster match.

After deployment, a fresh container spawn copies the current Claude roster
and removes those known retired filenames from the shared managed directory.
Group project-scope overrides can still shadow shared definitions and need an
operator audit. Codex primary config is generated on spawn; the companion
runner change also requires a refreshed host source snapshot. Existing agent
sessions keep their already loaded instructions/configuration. Publication,
host restart, fresh spawn, and observed runtime model/effort are separate proof.

Verification covers generated config defaults, absence of an effort lock in
the Codex role, managed roster retirement, preservation of custom/specialized
agents, and reviewer-model allowlist generation. Prior Fable/Astra reviewer IDs
remain eligible for receipt compatibility, including existing exact-head
approvals; this does not reintroduce their retired dispatch roles. CLI argv/config checks do not
prove a model inference ran. Roll back by restoring prior source definitions,
converter and config generators, reconciling host managed profiles, and
refreshing affected sessions through the same activation path.
