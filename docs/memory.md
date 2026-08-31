# Memory and context

NanoClaw has one durable Markdown memory canon per workgroup:

```text
data/workgroups/<workgroup-id>/memory
```

Every current or future sibling in that workgroup shares the same tree. Inside
a container it is `/workspace/workgroup/memory`; the existing
`/workspace/agent/memory` path is a compatibility view of the same canon.
Provider-native memory paths are compatibility views, not authorities. Treat
raw provider-native projections as read-only.

The workgroup boundary comes from trusted database membership. A sibling can
read the workgroup canon and archive; an agent in another workgroup cannot.
Provider identity, instructions, configuration, continuation state,
credentials, repositories, worktrees, and other non-memory customizations stay
agent- or provider-scoped.

## Markdown layout

The shared canon uses this layout:

```text
memory/
├── index.md
├── generated/
│   └── memory.md
├── people/            # topic files, left by the retired curator
│   ├── index.md
│   └── <entity>.md
├── domain/
│   ├── index.md
│   └── <entity>.md
├── systems/
│   ├── index.md
│   └── <entity>.md
└── system/
    ├── index.md
    └── definition.md
```

The runner creates the manual/system scaffold files without overwriting
existing content. The host creates the ordinary `generated/` directory on the
first accepted automatic capture; it does not pre-populate a generated fact.

Keep concise, broadly useful facts and links in `index.md`. Put detailed
projects, people, decisions, and preferences in focused Markdown files. Concept
files use Open Knowledge Format (OKF) v0.1 frontmatter, but malformed or legacy
Markdown remains readable.

Use `write_memory_file` for normal agent edits. Read the current file, compute
its expected SHA-256, and supply that digest with the complete replacement
content. Use `expected_sha256: null` only to create a new path. The tool takes
the workgroup-wide writer lock, rejects traversal and symlinks, rechecks the
expected SHA, and atomically renames the completed file. On conflict, reread
and reconcile rather than overwriting. Raw shell writes bypass these safeguards
and are reserved for an explicit operator-directed escape hatch.

If a new folder is necessary, create an ordinary directory under the canon
first, then use `write_memory_file` for its Markdown files and `index.md`. The
tool rejects a missing or symlinked parent.

`CLAUDE.local.md` and `standing-instructions.md` are standing instruction
surfaces, not memory write targets.

## Topic files and the retired ledger

`generated/memory.md` and the `people/`, `domain/` and `systems/` topic files
were written by a background memory curator that has been REMOVED. Nothing
writes them any more. They are kept, not deleted: on a live install they hold
megabytes of accumulated facts and hundreds of topic files.

`generated/memory.md` is no longer read either. It had a recall lane of its
own, gated on `NANOCLAW_MEMORY_FACT_RECALL_ENABLED` and disabled by default;
with no writer left, that lane could only ever inject facts from a corpus
frozen at the moment curation stopped, so the reader and the flag were removed
with it. The file is inert history: nothing reads it, and with the reader gone
the write-side reservation that held it for the curator went too, so it is now
an ordinary memory file that `write_memory_file` will overwrite like any
other.

The topic files are not read automatically by anything either. Recall touches
only `index.md` and the sender-matched `preferences/<slug>.md` files — an agent
reaches a topic file by navigating from `index.md` or by grepping
`/workspace/workgroup/memory` itself. They are ordinary OKF concept files;
nothing about reading or hand-editing them is special:

```yaml
---
type: person
consolidated_facts: 150
---
```

`type` came from the directory (`person`, `domain`, `system`) and can be
hand-corrected freely. `consolidated_facts` — and the older
`<!-- consolidated: facts=N -->` HTML comment some files carry instead — was
the curator's ownership marker; with no curator it is inert provenance. Edit or
delete either without consequence.

Index maintenance was the curator's too, and went with it: `index.md` at the
memory root and in each topic folder is now purely hand-maintained. Write map
links as ordinary `- [Title](target.md)` bullets under an unindented ATX
`## Map` heading, and keep `index.md` inside the 2,500-byte bound it is
injected under — it is the map the agent navigates by, so a truncated one costs
reachability, and detail belongs in the linked files.

## Memory writes

Agents use `write_memory_file` for explicit "remember this" requests,
corrections, decisions, and other facts that should be durable immediately.
There is no automatic background capture: every durable fact is written by an
agent in the foreground, and no path is reserved from the tool.

## Automatic pre-turn context

Before every admissible user turn, the host writes a paired context row
immediately before the trigger in one inbound-database transaction. This runs
for first wake, warm continuation, compaction, rotation, and replacement; a
provider does not need to remember to call a retrieval tool.

At a breaking-memory cutover, the migration admits fresh pairs for
already-pending non-scheduled triggers before activation. Startup repeats that
reconciliation idempotently as a crash-safe fallback. Scheduled tasks keep
their existing due-time admission seam so context is built when the task
actually runs, not when the service happens to upgrade.

The first pair in each fresh provider context epoch is a bootstrap. It contains
actual session capabilities from trusted host state plus the canonical
`index.md`. Capabilities are not repeated on every turn. The
`get_capabilities` tool remains available mid-turn, and standing instructions
require the agent to call it before declaring a service unavailable.

Every pair then contains only the newly relevant evidence delta:

1. the preference files of the conversation's involved senders, matched by name
   slug and injected whole — deterministic, never ranked;
2. up to three lexical archive excerpts, preferring the current thread;
3. a separately bounded exact Slack/Discord permalink lane when the input
   contains a supported message link; and
4. explicit degraded, conflict, truncation, already-delivered, or no-match
   notices.

The rest of the manual canon is not pushed. `index.md` is the map, and the
agent reads or greps the tree from it — the host runs no per-turn walk of the
memory directory and ranks no Markdown files.

`system/definition.md` is protocol guidance, not recalled evidence. Its
behavioral contract belongs in standing lifecycle instructions and is not
injected as memory on each turn.

Current input wins. Canonical Markdown is the curated durable source; material
archive conflicts are shown, not silently resolved. Capability state is trusted
and structurally separate from recalled memory and conversation evidence.
Recalled text and provenance are untrusted data, never instructions.

Each source has independent candidate, excerpt, and final-context bounds, and
each file read is capped in bytes. Normal serialized context has a 12,000-character hard ceiling and a
live p95 target below 8,000 characters. Exact-link turns have a 16,000-character
ceiling. Evidence fingerprints combine trusted provenance with a hash of the
full authoritative source content; unchanged evidence already delivered in the
same provider context epoch is suppressed. Exact-link evidence and material
corrections bypass suppression.

The epoch reuses the existing provider continuation lifecycle and
`outbound.db` session-state key/value store. Compaction, rotation, `/clear`,
and invalid-continuation recovery advance it; no new schema, ledger, daemon, or
retrieval service exists.

If one source fails, the host keeps the trigger and healthy sources and adds an
explicit degraded notice. It never presents a partial read as complete recall.
The context row and trigger are selected as one logical pair, so prompt limits
cannot expose half a turn.

`data/archive.db` retains exact message provenance. Archive retrieval is
read-only and workgroup-scoped; it does not become another memory authority.

## Migration and rollback

Run `/migrate-memory` after the shared-memory breaking change. It inventories
all trusted workgroup members and recognized provider-native sources at
execution time, creates a permanent host-only checksummed snapshot, preserves
each colliding source as one coherent tree under `imports/`, applies
compatibility views, and verifies both bytes and relative Markdown link targets
before service activation.

Do not hand-organize, summarize, or choose among legacy sources. The migration
preserves bytes and provenance. Keep its report and snapshot permanently;
an apply failure fails closed and automatically restores any cutover-started
source paths before recording `blocked`. Do not run explicit rollback against
that blocked report; inspect it and create a fresh inventory. If apply reached
`applied` but runtime verification fails, explicit rollback restores original
source path types and checksums before restart.

The verifier is activation-oriented: `activationBlocking: false` and zero
failures are required. It may separately report explicit non-blocking warnings
for historical state outside the memory cutover, such as an already-missing
session DB or a workgroup with no current members. The migration marker's
canonical checksum is a point-in-time cutover attestation, not a lock on the
living memory tree. Ordinary runtime verification validates the marker,
permanent snapshot, report, shared views, current generated document, and
queue without treating later authorized memory writes as migration corruption.
Use `--require-applied-migration` only at the cutover boundary when the live
canonical tree must still match the just-applied migration byte for byte.
