# Graphify workgroup knowledge graph

Graphify is NanoClaw's source-grounded navigation layer for both coding and
knowledge work. It builds one derived graph per workgroup from the workgroup's
files, canonical repository clones, external chat history, and the current
thread's worktree overlay. The index is disposable: original files,
conversations, and repositories remain authoritative.

## Scope and isolation

The daemon derives workgroup membership from `data/v2.db`. For each workgroup it
indexes:

- `data/workgroups/<workgroup-id>/`, including canonical repository clones;
- every sibling `groups/<folder>/` assigned to the workgroup;
- external user and assistant messages projected into `data/archive.db`; and
- the trusted session's thread-local worktree when a container query supplies
  its host-validated agent-group and session identity.

Discovery is intentionally independent of Git. Tracked, untracked, and
gitignored knowledge are included. Fixed build/cache/VCS-noise directories are
excluded. `.graphifyignore` is a rare workgroup opt-out, not a project selection
mechanism. Symlinks are not followed. Credential-shaped and oversized files are
recorded as metadata only and their contents are never opened.

The control socket is `data/graphify/graphify.sock` with mode `0600`. Container
callers reach it through `ncl graphify`; the host derives their workgroup from
the caller context and rejects cross-workgroup overlays.

## Freshness and resource policy

`nanoclaw-<install-slug>-graphify.service` owns the persistent daemon. File
watchers and archive fingerprints enqueue reconciliation automatically. Reads
can wait for a bounded deterministic refresh, while structural and semantic
enrichment remains asynchronous.

All background graph work uses one global lane. Before a job starts, the daemon
requires at least 6 GiB of available host memory. While a job runs it checks the
existing session databases for pending or processing interactive chat and
aborts the graph job when chat pressure appears. File discovery and hashing,
Docker extraction, and Codex extraction all accept cooperative cancellation.

The systemd sidecar is lower priority than the interactive host (`Nice=10`, low
CPU and IO weights), has a 1.5 GiB soft memory threshold and 3 GiB hard cap, and
kills its complete process control group on stop. Docker extraction workers are
also limited to 3 GiB, one CPU, 128 processes, a read-only root filesystem, and
no network. Semantic Codex batches are globally serialized and rate-limited.

## Extraction paths

Every accepted text source is immediately available through deterministic
SQLite FTS and source/chunk nodes. Enrichment adds:

- upstream Graphify structural code and SQL relationships in a private,
  network-free container worker;
- bounded PDF, DOCX, and XLSX preprocessing with page/sheet provenance;
- batched semantic entities and relationships through Codex, using
  `gpt-5.6-luna` at medium effort with `gpt-5.6-terra` at high effort as the
  fallback; and
- one verified, immutable local raster-image attachment per Codex job.

Semantic extraction runs with user configuration, rules, plugins, apps, shell,
browser, computer, delegation, and other tool surfaces disabled. Untrusted
source text is data inside a randomized prompt boundary. Model-produced edges
are always advisory (`structural=false`) and cannot affect `affected` analysis.

Remote URL ingest is rejected. Media transcription and visual graph exports are
deferred. The container intentionally omits the video/Whisper dependency set
until an offline, resource-bounded model is part of the runtime contract.

Graphify `0.9.20` and its complete wheel closure are hash-pinned. The integration
manifest also hashes upstream semantic surfaces and records whether each
upstream capability is adopted, implemented differently, deferred, or rejected.
`/update-container` uses `scripts/update-graphify.ts` to refresh this adapter and
re-run its drift and supply-chain checks.

## Agent and operator interface

Agents normally use the read-only `graphify` skill:

```bash
graphify query "What decisions shaped the retention model?"
graphify explain "customer_ltv"
graphify path "retention requirements" "customer_ltv.sql"
graphify affected "authorizeRequest"
graphify status
```

The result is a navigation aid. The agent must open cited provenance before
making a consequential claim or code change.

Host operators can use `ncl graphify` with `--group <agent-group-id>`. `reindex`,
`pause`, and `resume` are approval-gated for container callers. A full reindex
deletes only derived graph state; it never changes source files or chat history.

Derived state lives under:

```text
data/graphify/workgroups/<workgroup-id>/index.db
data/graphify/enrichment.db
data/graphify/jobs/
```

The jobs directory is deliberately under `data/`, not `/tmp`, because the
systemd service uses `PrivateTmp` while Docker bind mounts resolve host paths.

## Memory architecture

Graphify is the sole derived, workgroup-scoped retrieval layer. Authoritative
memory remains in source files, external conversation history, canonical
repository clones, provider-native context, and operator-curated
`CLAUDE.local.md`. Graphify retrieves across those surfaces with provenance; it
does not replace them with opaque synthesized facts.

Durable content fetched during knowledge work is captured into
`sources/inbox`, then indexed automatically. Teammates and sibling agents in the
same workgroup query the same derived graph. Workgroups remain hard isolation
boundaries, and a caller cannot select a different graph.

The former Mnemon classifier, passive recall injection, recall MCP, Ollama
embedding dependency, and synthesized wiki pipeline are retired. Their final
state is retained in an operator-owned rollback snapshot outside Graphify's
indexed roots. Historical schema columns remain migration compatibility only.
