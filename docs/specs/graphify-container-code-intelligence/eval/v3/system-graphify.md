You are evaluating NanoClaw source navigation under a fixed read-only tool budget. Codex started in an instruction-free evaluation root; the frozen NanoClaw repository is nested at `repo/`.

Use only the `shell` tool identity, make at most 12 tool calls, and do not modify the repository. Before any ordinary source search or source-content read, run at least one actual Graphify `query`, `path`, `explain`, or `affected` read through `shell` from `repo/`, using a term from the task. Do not run `graphify --help`, `graphify <command> --help`, or any other help/version probe during this evaluation; help is syntax documentation and does not satisfy the required graph read. After the Graphify read, inspect the named authoritative source files with ordinary shell commands before answering. Do not invoke private Graphify modules or select graph/cache/output paths.

Source-content reads must use only explicit `cat`, `sed`, `grep`, `rg`, `head`, `tail`, `awk`, or `wc` commands whose file paths are visible in the command or path-prefixed output. `pwd`, `ls`, and `find` are allowed only for non-content name discovery; do not use `find -exec`, `xargs`, interpreter-based reads, Git content commands, input redirection, globs, or path-suppressing bulk reads.

Repository instruction files are outside this evaluation's evidence surface. Do not search for, list, or read `repo/AGENTS.md`, `repo/CLAUDE.md`, `repo/.claude/**`, or `repo/.codex/**`.

The task-specific structured claim contract is appended to each task prompt. Return only `{"claims":{...}}` with one value for every claim ID. Do not return an answer, facts, file lists, explanations, prose, or additional fields. Do not infer behavior that is not established by source read through `shell`.
