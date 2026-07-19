---
name: graphify
description: Use the automatic workgroup knowledge graph for knowledge work, prior decisions, cross-artifact lineage, architecture, dependency paths, explanations, and affected-code analysis.
allowed-tools: Bash(graphify:*)
---

# Graphify Workgroup Knowledge Intelligence

Use Graphify as the first read-only navigation aid when a question depends on
relationships across the workgroup. The automatic workgroup knowledge graph
combines workgroup files, canonical clones, conversations, and a thread-local
worktree overlay when the current thread has code changes. It is useful for
knowledge work as well as coding: prior decisions, cross-artifact lineage,
requirements-to-spec-to-SQL/LookML-to-code-to-report connections, architecture,
dependency paths, and affected-code questions.

The graph is selected from trusted session context and maintained automatically.
Graphify automatically reconciles current source before every query, within a
bounded freshness deadline; slower structural and semantic enrichment remains
asynchronous.
You do not need to choose a project, pre-authorize a folder, or manually refresh
an index before asking a question. Queries work from any directory. In a managed
worktree, the gateway reconciles current edits, new files, and deletions as the
thread-local worktree overlay.

## Workflow

Choose the smallest useful read:

```bash
graphify query "What prior decisions shaped the retention model?"
graphify path "retention requirements" "customer_ltv.sql"
graphify explain "customer_ltv"
graphify affected "authorizeRequest"
graphify status
```

Then inspect the source directly by opening the cited file or conversation
provenance before drawing a final conclusion or changing code. Graphify results
are advisory. Source and tests are authoritative; for code changes, run the
repository's normal verification.

`graphify --help` and `graphify <command> --help` show syntax without inspecting
or refreshing a graph. `graphify status` reports workgroup freshness and indexing
state.

## Boundaries and fallback

- Use only `query`, `path`, `explain`, `affected`, and `status` for graph reads.
- Do not pass a workgroup, filesystem root, graph, cache, or output override. The
  gateway derives isolation scope from the trusted caller context.
- Let the service own discovery and freshness. There is no allowlist workflow.
- `.graphifyignore` is a rare opt-out for content that truly must not be indexed,
  not a project-selection mechanism.
- If the workgroup service is temporarily unavailable inside a managed worktree,
  the gateway may explicitly use its code-only fallback. That fallback cannot
  answer conversation or broad workgroup-knowledge questions.
- If Graphify refuses a request, lacks coverage, or returns insufficient context,
  inspect authoritative artifacts directly and state the limitation when it
  materially affects confidence.
