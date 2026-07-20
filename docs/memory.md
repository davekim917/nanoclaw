# Memory and knowledge retrieval

NanoClaw keeps authoritative memory in sources rather than in a second opaque
fact store:

- provider-native conversation context;
- external user and assistant messages projected into `data/archive.db`;
- workgroup and sibling files, including tracked, untracked, and gitignored
  knowledge artifacts;
- canonical repository clones and the current thread's managed worktree; and
- operator-curated `CLAUDE.local.md` instructions and preferences.

Graphify is the sole derived retrieval layer over those sources. It builds one
disposable graph per workgroup, returns file or conversation provenance, and
cannot be used to cross the caller's workgroup boundary. Source artifacts stay
authoritative; agents must open cited provenance before consequential claims or
changes.

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
