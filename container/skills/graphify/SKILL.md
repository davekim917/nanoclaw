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
Ordinary file additions, edits, and deletions are applied as small transactional
deltas. Queries use the latest complete generation immediately instead of
blocking behind a safety rebuild; `graphify status` reports `dirty` or
`reconciling` while a newer generation is in flight. Slower structural
enrichment remains asynchronous.
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

### An empty result means "no term match", not "no such knowledge"

The graph is built from the words that actually appear in your sources, so a
model named `customer_ltv` will not match "retention" if that word is nowhere in
the file. Treat zero nodes as a prompt to widen, not as an answer:

1. Re-query with adjacent vocabulary — a likely table, file, or symbol name, the
   project or person involved, or the term a teammate would have used.
2. As soon as any related node comes back, use `path`, `explain`, or `affected`
   to reach the rest. Those follow real indexed relationships rather than text,
   so they cross the vocabulary gap that a keyword search cannot.

Make the conceptual connection yourself from the sources you retrieve — that
reasoning is yours to do, and it is why the graph does not precompute it. Only
after widening and traversing should you report that the graph lacks coverage.

`graphify --help` and `graphify <command> --help` show syntax without inspecting
or refreshing a graph. `graphify status` reports workgroup freshness and indexing
state. When a conclusion specifically depends on a just-written artifact and the
status is dirty, inspect that authoritative artifact directly while Graphify
finishes the autonomous delta; do not invent a manual index workflow.

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
