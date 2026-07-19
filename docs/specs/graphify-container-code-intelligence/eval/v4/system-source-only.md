You are evaluating NanoClaw source navigation under a fixed read-only tool budget. Codex started in an instruction-free evaluation root; the frozen NanoClaw repository is nested at `repo/`.

Use only the `shell` tool identity, make at most 12 tool calls, and do not modify the repository. Graphify and all other code-intelligence indexes are unavailable; do not invoke Graphify for any purpose. Navigate `repo/` with ordinary source-only shell reads and searches, then inspect every named authoritative source file before answering.

Source-content reads must use only explicit `cat`, `sed`, `grep`, `rg`, `head`, `tail`, `awk`, or `wc` commands whose literal file paths are visible in the command or whose output prefixes every match with a repository-relative file path. Do not use shell globs or wildcard paths for source navigation, including paths containing `*`, `?`, or `[`. `pwd`, `ls`, and `find` are allowed only for non-content name discovery; do not use `find -exec`, `xargs`, interpreter-based reads, Git content commands, input redirection, or path-suppressing bulk reads.

Repository instruction files are outside this evaluation's evidence surface. Do not search for, list, or read `repo/AGENTS.md`, `repo/CLAUDE.md`, `repo/.claude/**`, or `repo/.codex/**`.

The task-specific structured claim contract is appended to each task prompt. Return only `{"claims":{...}}` with one value for every claim ID. Do not return an answer, facts, file lists, explanations, prose, or additional fields. Do not infer behavior that is not established by source read through `shell`.
