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
├── people/            # curator-maintained topic files
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

`CLAUDE.local.md` and `instructions.prepend.md` are standing instruction
surfaces, not memory write targets.

## Curator-maintained topic files

`people/`, `domain/` and `systems/` hold the background curator's consolidated
views, distilled from `generated/memory.md`. They are ordinary OKF concept
files — nothing about reading or hand-editing them is special:

```yaml
---
type: person
consolidated_facts: 150
---
```

Frontmatter is metadata the agent reads, not host-ranked text. `title` and
`description` ("used when scanning indexes and search hits") and `tags`
("cross-cutting labels for search and grouping") are what make a file findable
when the agent greps the tree; `resource` is a path or a URL. The host does not
walk, read or rank these files per turn — it hands the agent `index.md` and the
OKF contract, and the agent follows the links or greps
`/workspace/workgroup/memory` itself.

Setting `title:` or `description:` by hand is also how you fix an ugly map
entry — the curator carries both forward untouched and prefers them over the
slug-derived title and the lead-line hook. It never writes either field itself.

`type` comes from the directory (`person`, `domain`, `system`) and can be
hand-corrected to better vocabulary; the curator carries a changed `type`, and
every other frontmatter key it does not recognize, forward untouched.
`consolidated_facts` is the provenance and ownership marker: how many ledger
facts the last pass folded in, and the thing that makes the file a legitimate
curator write target. Removing it makes the file human-owned, and the curator
will refuse to overwrite it from then on. Files predating this format carry a
`<!-- consolidated: facts=N -->` HTML comment instead; that is still honored as
proof of ownership and is replaced with frontmatter the next time the curator
rewrites the file. `scripts/repair-memory-topic-frontmatter.ts` converts a whole
install ahead of that (dry run by default, `--apply` to write).

The curator also maintains the map. After every consolidation pass it rewrites
each topic folder's `index.md` from what is on disk and points the root
`index.md`'s `## Map` section at those three folder indexes.

Two-level, and placed high, because `index.md` is read HEAD-first under a hard
2,500-byte bound (`PRE_TURN_BOUNDS.markdownCoreChars` on the host,
`MAX_INDEX_BYTES` in the container bootstrap). That bound is
`system/definition.md`'s own rule in code — "headlines and pointers here, detail
in linked files" — not a budget memory outgrew: detail belongs in the linked
files recall pulls at 12-16k. So the root Map carries three pointers, each
folder index carries one bullet per concept, and the curator's pointers lead the
Map's bullet list rather than trailing it. On the busiest live workgroup the
`## Map` heading already sat at byte 1,881 but thirteen hand-written bullets
pushed appended links to 4,308, where nothing reads them; leading the list puts
them at 2,107. Where a `## Map` the curator CREATES goes is its choice (after
`## Core Memory`); where an existing one sits is never changed.
`scripts/repair-memory-topic-frontmatter.ts` prints a NOTICE for any index whose
pointers still land past the bound — shortening what sits above them is an
editorial call for a human, not something a background pass does by deletion.

This is a merge, not a regeneration. Headings, frontmatter, other sections,
section ordering, fenced code blocks, HTML comments, non-indented prose, and
hand-written Map links to files the curator does not own survive it. Trailing
whitespace inside and after the managed section is normalized, and CRLF input
becomes LF. Lines immediately indented under a link the curator re-renders move
WITH it, so a hand-written note keeps the entry it was written under.

**Index maintenance has known destructive bugs and is under review.** What
follows says what is actually true today, which is less than earlier versions
of this document claimed. Earlier text here promised that nothing
hand-written is ever lost and that every misread construct merely duplicates a
link; both were wrong, and an overclaim here is worse than a gap, because it
turns a known limitation into an unknown one. Until this notice is removed,
treat any construct not named below as unverified rather than safe.

A link _should_ only be removed on positive evidence its target is gone —
`managedTargets` in `src/modules/memory/memory-index.ts` is that rule, and a
folder whose listing failed, a file that could not be read, and a reserved name
filtered out of a listing all keep their links. Two inputs to the rule are
still wrong. The directory listing is taken _before_ the index file is read, so
a topic file created in between is deleted from the map with a clean
compare-and-swap and no retry; and a symlinked topic file is not counted as
present, so a hand-written link to one is deleted while the file is still on
disk.

The merge is a line-walker, not a Markdown parser. Constructs it reads
imprecisely _without_ losing content: a `> - [X](y.md)` in a blockquote, a
`* [X](y.md)` star-marker bullet, a tab-indented bullet, and a `[X]: y.md` link
reference definition are not recognized as the curator's, so a second link to
the same target appears beside them; a setext `Map` / `---` heading is not
recognized as the managed `## Map`, so a fresh one is appended at end of file (a
setext heading _inside_ the section is a recognized boundary). Constructs where
it **does** lose or move hand-written lines: an HTML block is protected only as
far as the next blank line, so a bullet after a blank line inside a `<script>`
or `<div>` block is deleted; an ATX heading indented one to three spaces is not
treated as a section boundary, so bullets filed under it are hoisted above it;
and a re-rendered bullet carries only its contiguous indented lines, so in a
loose list the child after a blank line is left behind and reparented.

Write map links as ordinary `- [Title](target.md)` bullets under an unindented
ATX `## Map` heading and none of this reaches you.

## Selective background capture

Foreground agents still use `write_memory_file` for explicit "remember this"
requests, corrections, decisions, and other facts that should be durable
immediately. That tool cannot write `generated/memory.md`; this keeps
user-authored, imported, and foreground-agent memory separate from automatic
capture.

When `NANOCLAW_MEMORY_CURATOR_ENABLED=true`, the host also reviews completed
conversation episodes after five minutes of inactivity. This work is
fire-and-forget from the 60-second host sweep: routing and delivery perform only
the archive/queue transaction and never wait for a model call.

The curator uses only `claude-sonnet-5` at medium effort through Claude Code's
subscription-aware, non-interactive runtime, without tools, provider
continuation, prompt suggestions, or fallback. The selected OAuth slot is the
child process's only Anthropic credential; the untrusted episode payload is
sent over stdin, safe mode excludes project and user customizations, and the
Anthropic model endpoint bypasses the OneCLI credential proxy so the gateway
cannot replace the selected identity. The host also recovers the real primary
from `.env` when the OneCLI service wrapper has shadowed it with its
`placeholder` sentinel. Each job is bounded to 80 de-duplicated messages and
24,000 transcript characters, a relevance-ranked generated-memory view capped
at 32,000 characters, and up to three relevant manual-memory excerpts. The
canonical generated store is independently bounded at 1 MiB; automatic
agent recall remains governed by the 12,000-character final context budget.

A fact is never evicted. Nothing ages out, and a decision captured months ago
stays recallable for as long as it is the most relevant answer to a turn. The
1 MiB bound is a runaway rail, not a retention policy, and its real cost is
that the store is re-tokenized on each turn to rank it — roughly 525 ms per
MiB. Crossing 75 percent logs a warning long before the ceiling bites, and a
queue that has retried a write past three attempts is reported by the runtime
verifier as a non-blocking `curator-episodes-stuck` warning instead of being
indistinguishable from a healthy idle queue.
Its default decision is `noop`.
It captures durable decisions, corrections, stable cross-task preferences,
verified outcomes, durable workflows, and durable facts about people,
organizations, and external systems — who they are, what they own, and how to
route work to them. A stated role or ownership counts even when it arrives in
passing rather than as a decision; before this category existed, 134 archived
messages mentioning two named feed liaisons distilled to zero facts about who
they were. It rejects secrets, capability state, transient work, speculation,
third-party uncertainty, and facts recoverable from code.
A worked method that succeeded — a query pattern, an API sequence, a debugging
technique — is a durable workflow, distinct from the raw output around it.
Agents also record methods directly at solve time under `memory/methods/`
(standing instruction in `container/CLAUDE.md`), where recall surfaces them
when a similar problem arrives; the curator complements that from what agents
narrate in chat, since it never sees container tool calls.

The model returns semantic facts plus archive evidence IDs, never Markdown.
The host owns the complete representation: it normalizes fact text, derives
stable IDs and capture timestamps from trusted evidence, preserves every active
fact unless current evidence explicitly supersedes it, and renders the
canonical heading, bullets, and provenance markers. It then validates its own
rendered document, scrubs secrets, and promotes through the same workgroup lock
and SHA compare-and-swap writer used by sibling agents. A model's heading,
bullet, marker, ID, or timestamp spelling therefore cannot block a valid
capture because those fields are not part of the model contract.
If a semantic candidate exceeds the 2,000-character limit, the curator gets
one bounded repair attempt before the durable episode is retained for retry;
content is never silently truncated or discarded. The limit was 1,000, which
rejected more captures than every other failure cause combined against a live
median fact length of 658 characters.
Provider-namespaced archive IDs may be cited by their raw platform ID only when
that shorthand resolves to exactly one allowed row; ambiguous or invented IDs
still fail closed.
Failures leave both the pending episode and existing memory intact.
The host resolves the shared Bun compare-and-swap helper from an explicit
`BUN_BIN`, the service account's standard `~/.bun/bin/bun` install, or `PATH`;
a minimal systemd `PATH` therefore cannot strand an accepted capture.

The host discovers every distinct configured Claude OAuth slot and selects
among them with a persisted round-robin cursor. A 401, 403, or 429 marks only
that slot unavailable and immediately retries the same job once on an
available sibling slot. Cooldowns and call history survive host restarts. If
every slot is unavailable, the episode cursor remains untouched; the sweep
resumes it automatically when the earliest cooldown expires.

Automatic model attempts are guarded at 120 per rolling hour and 3,000 per UTC
day. Those ceilings are above the two-attempt maximum of the one-job-per-minute
worker, so one exhausted OAuth key cannot throttle successful work on the
other; they exist to stop an accidental runaway caller. Saturation, pending and
due episodes, oldest due time, retry count, and per-slot cooldown state are
reported by the runtime verifier, and admission delay or total credential
unavailability emits a throttled warning without deleting work.

After 50 accepted updates or when generated memory exceeds 768 KiB, the host
retires the maintenance threshold without asking a model to rewrite the
document. The deterministic renderer already maintains the one canonical flat
representation, so a second model-authored presentation pass would add failure
surface without adding facts. Before every actual replacement, the previous
generated file is snapshotted under the host-only
`data/memory-curator-history/<workgroup-id>/` tree, outside container mounts and
recall, with the latest 20 versions retained. Operator rollback restores one of
those bounded snapshots through the same compare-and-swap writer, so it cannot
silently overwrite a newer generated version.

The curator defaults off. Setting the environment flag, restarting the
service, and verifying the live queue are an explicit activation boundary.

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
2. up to three generated-memory facts, in their own lane;
3. up to three lexical archive excerpts, preferring the current thread;
4. a separately bounded exact Slack/Discord permalink lane when the input
   contains a supported message link; and
5. explicit degraded, conflict, truncation, already-delivered, or no-match
   notices.

The rest of the manual canon is not pushed. `index.md` is the map, and the
agent reads or greps the tree from it — the host runs no per-turn walk of the
memory directory and ranks no Markdown files.

`generated/memory.md` is a flat list of self-contained one-line facts, so it is
ranked one fact at a time rather than as a single document, and each selected
fact is delivered whole. Scored as one document it could contribute at most one
900-character passage per turn however much it held — against a live 328-fact
store that was one fact, and a larger store could not have improved it. Its own
excerpt lane keeps facts and preference files from crowding each other out.

Ranking uses the fact text only; the provenance marker is excluded, because its
tokens are about a fifth of a line and diluted the density term. The marker
still reaches the agent, so `captured=` remains visible and an agent can tell
how old a fact is. Capture time is a tiebreak between comparably relevant facts,
never a filter: an older exact match still outranks a fresher weak one.

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
