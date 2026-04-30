---
name: wiki
description: Maintain the persistent wiki knowledge base for this group. Use when a source is dropped into sources/, when answering questions that should compound into knowledge, when the user says "ingest", "remember this", "add to wiki", or when running periodic lint passes. The wiki holds compounding domain knowledge — Snowflake/dbt patterns, multi-tenant decisions, client/product context, refactor playbooks. Its role depends on whether the persistent memory layer is enabled for this group (see Layering principle below).
---

> **If the memory layer is enabled** for this group (the operator ran `scripts/enable-memory.ts`), the wiki becomes a derived synthesis surface only. The daily synthesise scheduled task reads mnemon and writes wiki pages from it. Do not directly write to wiki/ during conversation in memory-enabled groups. The direct-write flow described below still applies for groups without the memory layer.

# Wiki Maintenance

## Layering principle (read first)

The wiki's role depends on this group's setup:

- **Memory layer NOT enabled**: the wiki *is* the canonical store for compounding domain knowledge. Follow the direct-write flow described below — agent reads sources, writes wiki pages, updates index/log.
- **Memory layer enabled** (host daemon active for this group, container.json has `memory.enabled: true`): the wiki becomes a *derived synthesis* of mnemon facts, NOT the canonical store. The mnemon daemon extracts atomic facts from chat turn-pairs and curated source files automatically; wiki pages are compiled from mnemon on a schedule by the daily synthesise task. **In that mode, do NOT do direct writes during chat** — defer to the synthesise task. The page conventions, index/log discipline, and source handling below still apply — only the entry point changes.

How to tell which mode you're in: check `/app/container/CLAUDE.md` § Memory — if Recall context arrives as `[Recalled context]` system messages, the memory layer is enabled.

## What this skill maintains

You are the maintainer of `wiki/` — a persistent, compounding markdown knowledge base. This is where domain knowledge accumulates across sessions. The wiki holds long-form synthesised knowledge for this group; `CLAUDE.local.md` is for behavioral rules and high-frequency facts (those are *instructions*, not memory).

## Layout

```
wiki/
  index.md            — catalog of every page; updated on every ingest
  log.md              — append-only activity log; every ingest/lint adds an entry
  entities/           — clients, products, repos, people (apollo.md, xzo.md, ...)
  concepts/           — reusable patterns and playbooks (snowflake-sp-overloads.md, dbt-refactor-grep.md, ...)
  timelines/          — chronological arcs (xzo-multi-tenant-refactor.md, apollo-go-live.md, ...)
sources/
  articles/           — saved web articles
  docs/               — formal docs, PDFs, internal specs
  threads/            — exported Slack/email threads when they're a primary source
```

## Three operations

### 1. Ingest

Triggered when:
- A new file appears in `sources/`
- The user says "ingest this", "add to wiki", "remember this", or hands you a doc/URL/transcript explicitly for the wiki
- A query produces a useful synthesis worth filing

**Discipline rule (critical):** when the user gives you multiple files or points at a folder with many files, process them **one at a time**. For each file:

1. Read the source in full. If it's a URL, fetch the full page (use `agent-browser` or `curl`, not WebFetch which only returns a summary).
2. Discuss the takeaways with the user briefly — what's worth keeping, what isn't.
3. Update or create the relevant entity, concept, and timeline pages. A single source typically touches 5–15 wiki pages.
4. Update `index.md` with any new pages.
5. Append a one-block entry to `log.md`.
6. Only then move on to the next file.

Never batch-read all sources and then write pages from a blended summary — it produces shallow, generic content instead of the deep integration the wiki pattern requires.

### 2. Query

When the user asks a question that's likely covered by accumulated knowledge:

1. Read `wiki/index.md` first to locate relevant pages.
2. Open those pages, plus any cross-referenced pages.
3. Answer with citations: `[apollo.md](wiki/entities/apollo.md#decisions)`, etc.
4. If the answer was non-trivial and worth keeping, file it back as a new wiki page or as a section in an existing one. Explorations should compound, not disappear into chat history.

### 3. Lint

Periodic health check. Triggered manually or by a scheduled task. Walk the wiki and look for:

- **Contradictions** — page A says X, page B says ¬X. Flag with the timestamps.
- **Stale claims** — superseded by newer sources or decisions logged in `log.md`.
- **Orphan pages** — no inbound links from `index.md` or any other page.
- **Missing cross-references** — page mentions an entity that has its own page but doesn't link to it.
- **Concept gaps** — repeated mentions of a topic across multiple pages with no dedicated concept page.
- **Index drift** — pages that exist on disk but aren't in `index.md`, or index entries pointing at deleted files.

Report findings to the user. Offer to fix; don't fix silently.

## Page conventions

- **Filenames**: `kebab-case.md`, lowercase only.
- **Cross-references**: relative markdown links, e.g. `[apollo](../entities/apollo.md)`.
- **Top of page**: 1–2 sentence summary. The index entry should match this summary.
- **Sections**: use `##` for top-level sections within a page. Keep a `## Sources` section at the bottom listing what was ingested for that page (path under `sources/` or URL).
- **Dates**: when a fact is time-sensitive, mark it: `_(as of 2026-04-26)_`.

## What belongs where

| Goes in | Goes in `wiki/concepts/` | Goes in `CLAUDE.local.md` |
|---|---|---|
| Snowflake SP overload behavior | ✅ technical pattern, applies across projects | ❌ — too long for behavioral memory |
| "Don't fabricate numbers the user didn't state" | ❌ | ✅ behavioral rule, every turn |
| Apollo's tenant-isolation strategy | ✅ specific to Apollo entity | ❌ |
| Snowflake connection list | ❌ — frequent reference, not a concept | ✅ infrastructure reference |
| XZO multi-tenant refactor decisions | ✅ in `wiki/timelines/xzo-multi-tenant-refactor.md` | ❌ |

When in doubt: if you'd want it in front of you on every single message, it goes in `CLAUDE.local.md`. If you'd want to look it up when a related question comes up, it goes in the wiki.

> **When the memory layer is enabled for this group:** the wiki becomes a compiled output of the mnemon graph. Wiki pages stop being a destination for primary writes. Defer to the daily synthesise scheduled task at that point — do not write to wiki/ from chat.

## Reading from mnemon (synthesise only)

When this group has the memory layer enabled (i.e. `container.json` has `memory.enabled: true` and the host daemon is active), the wiki's content is produced by the **daily synthesise scheduled task**, not by the agent during chat. The synthesise task reads the mnemon fact graph and compiles wiki pages from it.

**During chat:** you do not read from mnemon directly, and you do not call any mnemon tool. Recalled context from mnemon arrives automatically as `[Recalled context]` system messages before each user turn — that is the only mnemon surface accessible during conversation.

**During the daily synthesise task:** the task queries the mnemon graph and writes or updates wiki pages under `wiki/{entities,concepts,timelines}/`, refreshes `wiki/index.md`, and appends to `wiki/log.md`. This is the only time wiki pages are written in a mnemon-enabled group.

## Source handling

- **URLs**: don't trust `WebFetch` for ingest — it returns a summary. Use `agent-browser` to render the page or `curl -sL > sources/articles/<slug>.md` for HTML/markdown. For PDFs, `curl -sLo sources/docs/<slug>.pdf`.
- **PDFs**: handled natively by Claude — just open them.
- **Slack threads**: paste or export to `sources/threads/<topic>-<date>.md`. Keep the source separate from the synthesised wiki page.

## Indexing budget

Target scale: the index file should stay browsable in one read. If `index.md` exceeds ~500 lines, split into category indexes (`wiki/entities/_index.md`, etc.) and link from the top-level `index.md`.

## Log format

```
## [2026-04-26] ingest | Snowflake stream best practices article
- Source: sources/articles/snowflake-streams-2026.md
- Created: concepts/snowflake-streams.md
- Updated: entities/xzo.md (linked stream patterns), index.md
```

Use `ingest`, `query`, `lint`, `decision`, or `incident` as the op tag.
