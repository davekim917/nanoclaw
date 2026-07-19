---
name: graphify
description: Use Graphify for source-grounded codebase exploration, architecture questions, dependency paths, symbol explanations, and affected-code analysis inside NanoClaw managed worktrees.
allowed-tools: Bash(graphify:*)
---

# Graphify Code Intelligence

Use Graphify as a read-only navigation aid for code work in a managed worktree.
The gateway automatically reconciles current source before every read, including
tracked edits, new files, and deletions.

## Workflow

1. Create or reuse the repository with the managed `create_worktree` tool.
2. Change directory into the repository under `/workspace/worktrees/`.
3. Choose the smallest useful read command:

   ```bash
   graphify query "authentication middleware"
   graphify path "routeHandler" "authorizeRequest"
   graphify explain "authorizeRequest"
   graphify affected "authorizeRequest"
   ```

   For syntax only, `graphify --help` and `graphify <command> --help` are
   side-effect-free and do not inspect or refresh a repository.

4. Open the exact files and tests named by the result before drawing a
   conclusion or changing code. Graphify is advisory; source and tests are authoritative.
5. Run the repository's normal tests and verification after any change.

## Boundaries and fallback

- Use only `query`, `path`, `explain`, and `affected` for graph reads.
- Let the gateway own freshness, cache location, graph selection, deadlines,
  and failure recovery. Do not choose an output or cache location.
- Keep repository lifecycle operations in `create_worktree`; Graphify does not
  create, switch, fetch, or rebase repositories.
- If Graphify refuses the repository, times out, lacks language coverage, or
  returns insufficient context, inspect the source directly. Report the
  limitation when it materially affects confidence, and retry Graphify later
  only when useful.
