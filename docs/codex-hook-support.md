# Codex app-server hook support (spike result)

**Verified**: 2026-05-14 against `codex-cli 0.128.0` (host) and pinned `@openai/codex@0.130.0` (container).
**Method**: `codex app-server generate-json-schema --out <dir>` then inspected v2 schema.

## Conclusion: Path A (native support) is viable

The app-server JSON-RPC v2 protocol exposes:

| Surface | Path/method |
|---|---|
| Hook config file | `~/.codex/hooks.json` (same JSON shape as Claude Code) |
| List hooks (RPC) | `Hooks/list` |
| Lifecycle events | `Hook/started`, `Hook/completed` notifications streamed to client |
| Event names | `preToolUse`, `permissionRequest`, `postToolUse`, `sessionStart`, `userPromptSubmit`, `stop` |
| Handler types | `command`, `prompt`, `agent` |
| Output kinds | `warning`, `stop`, `feedback`, `context`, `error` |
| Status | `running`, `completed`, `failed`, `blocked`, `stopped` |

`HookOutputEntryKind=stop` lets a hook block the tool call — preserves PreToolUse guardrail semantics from Claude.

## Payload differences from Claude

`codex-claude-shim.cjs` already exists in `~/.codex/hooks/` as the canonical normalizer. Diffs:

- `tool_name`: `exec_command` / `local_shell_call` / `shell` (Codex) ↔ `Bash` (Claude)
- `tool_input.command`: may arrive as array (Codex) ↔ always string (Claude)
- Output envelope: `tool_response` (Codex) ↔ `tool_output` (Claude)

## Implementation plan for Stage 2

1. Extract Claude's hook callbacks from `container/agent-runner/src/providers/claude.ts:985-1025` to a shared module (`container/agent-runner/src/hooks/`).
2. Add thin bun wrapper scripts (one per hook event) that read stdin JSON, normalize via shim logic, dispatch to shared callbacks, write stdout.
3. `codex.ts` writes a per-session `~/.codex/hooks.json` at session start pointing at those wrappers.
4. Claude provider keeps calling them as SDK callbacks (no change); Codex spawns them as subprocesses via hooks.json.

## Confirmed bonus capabilities

- `Turn/steer` RPC method exists → Stage 3 (mid-turn input) is buildable. No fallback needed.
- `Hooks/list` RPC method exists → can verify hooks were loaded at session start.
