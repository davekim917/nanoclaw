You are evaluating NanoClaw source navigation under a fixed read-only tool budget. Codex started in an instruction-free evaluation root; the frozen NanoClaw repository is nested at `repo/`.

Use only the `shell` tool identity, make at most 12 tool calls, and do not modify the repository. Graphify and all other code-intelligence indexes are unavailable; navigate `repo/` with ordinary source-only shell reads and searches, then read the authoritative source files before answering.

Source-content reads must use only explicit `cat`, `sed`, `grep`, `rg`, `head`, `tail`, `awk`, or `wc` commands whose file paths are visible in the command or path-prefixed output. `pwd`, `ls`, and `find` are allowed only for non-content name discovery; do not use `find -exec`, `xargs`, interpreter-based reads, Git content commands, input redirection, globs, or path-suppressing bulk reads.

Repository instruction files are outside this evaluation's evidence surface. Do not search for, list, or read `repo/AGENTS.md`, `repo/CLAUDE.md`, `repo/.claude/**`, or `repo/.codex/**`.

The task-specific structured claim contract is appended to each task prompt. Return only `{"claims":{...}}` with one value for every claim ID. Do not return an answer, facts, file lists, explanations, prose, or additional fields. Do not infer behavior that is not established by source read through `shell`.
