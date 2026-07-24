# Memory and knowledge retrieval

NanoClaw keeps authoritative memory in sources rather than in a second opaque
fact store:

- provider-native conversation context;
- external user and assistant messages projected into `data/archive.db`;
- workgroup and sibling files, including tracked, untracked, and gitignored
  knowledge artifacts;
- each group’s portable Markdown memory tree under `groups/<folder>/memory/`;
- canonical repository clones and the current thread's managed worktree; and
- operator-curated `CLAUDE.local.md` instructions and preferences.

Graphify is the sole derived retrieval layer over those sources. It builds one
disposable graph per workgroup, returns file or conversation provenance, and
cannot be used to cross the caller's workgroup boundary. Source artifacts stay
authoritative; agents must open cited provenance before consequential claims or
changes.

## Portable file memory

Inside a container, the group memory tree is `/workspace/agent/memory/`:

```text
memory/
├── index.md
└── system/
    ├── index.md
    └── definition.md
```

The runner creates missing scaffold files at boot and never overwrites existing
content. `index.md` holds concise core memory and pointers; deeper facts,
projects, decisions, and people live in linked Markdown files.
`system/definition.md` documents the memory conventions. Concept files use the
Open Knowledge Format (OKF) v0.1 frontmatter convention, but malformed or
legacy Markdown remains readable and is not rejected.

The runner registers the same lifecycle memory seam for Claude, Codex, and
OpenCode. It supplies `index.md` and `system/definition.md` as authoritative
context with a 16k-character budget per file; deeper context is read directly
from linked files. This is source loading, not a second retrieval engine:
Graphify indexes the same on-disk tree and remains the only derived retrieval
layer.

`CLAUDE.local.md` is separate. It remains operator-curated standing
instructions and is never an agent memory write target. Claude native
auto-memory and Codex’s opaque summary-memory store are disabled.

## Autonomous capture and freshness

The host daemon watches indexed roots and the chat archive. Durable attachments,
WebFetch results, Google Workspace reads, and selected MCP results are mirrored
to `sources/inbox` automatically. They become queryable through deterministic
reconciliation without an allowlist or manual index command. Structural and
semantic enrichment follows asynchronously under resource-pressure controls.

Sibling agents and teammates in the same workgroup use the same graph. Agent
containers call the `graphify` CLI; host operators use `ncl graphify --group
<agent-group-id>`. The gateway derives the final workgroup from trusted session
or DB context.

See [graphify.md](graphify.md) for extraction, security, freshness, resource,
and command details.

## Retired architecture

The former Mnemon classifier, passive pre-turn injection, recall MCP, Ollama
embedding dependency, recall judge, and synthesized wiki jobs are retired. The
retirement intentionally removes low-signal derived facts and their compute
pipeline; it does not delete original conversations, source files, or repos.

Before live data removal, operators must create a checksummed snapshot outside
Graphify's indexed roots. Historical `mnemon_*` migrations and the
`workgroups.mnemon_store_id` column remain in the append-only schema so old
databases migrate safely; active runtime code does not read them.

## Rollback

This installation's retirement snapshot lives under
`data/retired-memory/<date>-retirement/` and includes a manifest plus Mnemon and
runtime-state archives. Restoring it is an explicit operator rollback, not an
automatic fallback: reinstall the retired code revision and image, restore the
archives, then re-enable the old service. Do not expose the snapshot to
containers or add it to Graphify discovery roots.
