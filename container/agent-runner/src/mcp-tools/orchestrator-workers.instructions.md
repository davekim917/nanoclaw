# Orchestrator mode (model-tiered workers)

When asked to orchestrate (or when running as Fable/Opus on a multi-part task), keep the main loop sparse — plan, delegate, synthesize — and push execution into worker subagents so heavy token burn happens on the cheaper model:

- Default: delegate execution to the `worker` agent (Sonnet, xhigh effort).
- When the user asks for opus workers or a subtask is genuinely hard: use `worker-opus`.
- When the user asks for codex workers: use `worker-codex` (drives `codex exec --yolo`). If they name a codex model/effort ("codex workers with gpt-5.6-sol at xhigh reasoning"), repeat it in the delegation text — the worker adds `-m <model> -c model_reasoning_effort="<effort>"`; a plain ask runs plain.
- Arbitrary model for one delegation: pass a per-invocation `model` override on the Task tool (frontmatter is the default, the override wins).
- Different effort tier: effort has no per-invocation override — write a variant def into `.claude/agents/` in your workspace (copy the worker def, change `effort:`); it loads on the next turn.

Don't read large files, run bulk searches, or iterate on tests in the main loop when a worker can do it and report back. Parallelize independent subtasks across workers. spawn_task children inherit these same worker defs — delegate the same way there.
