---
name: wiki
description: Maintain the persistent wiki knowledge base for this group. Use when a source is dropped into sources/, when answering questions that should compound into knowledge, when the user says "ingest", "remember this", "add to wiki", or when running periodic lint passes. The wiki holds compounding domain knowledge — Snowflake/dbt patterns, multi-tenant decisions, client/product context, refactor playbooks. Its role depends on whether `mnemon` is enabled for this group (see Layering principle below).
---

> **If `mnemon-companion` is also mounted** (i.e., this group has mnemon enabled), defer to it for memory writes. Wiki becomes derived synthesis surface only; the daily synthesise scheduled task writes wiki pages from mnemon. Do not directly write to wiki/ during conversation in mnemon-enabled groups. The direct-write flow described below still applies for non-mnemon groups.

# Wiki Maintenance

## Layering principle (read first)

The wiki's role depends on this group's setup:

- **If `mnemon-companion/SKILL.md` does NOT exist for this group** (mnemon not yet wired): the wiki *is* the canonical store for compounding domain knowledge. Follow the direct-write flow described below — agent reads sources, writes wiki pages, updates index/log.
- **If `mnemon-companion/SKILL.md` exists for this group** (mnemon is wired): the wiki becomes a *derived synthesis* of mnemon facts, NOT the canonical store. Flow inverts: agent writes atomic facts to mnemon first; wiki pages are compiled from mnemon on a schedule. **In that mode, follow `mnemon-companion/SKILL.md` instead of this skill's direct-write flow.** The page conventions, index/log discipline, and source handling below still apply — only the entry point changes.

Today's flow (direct-write) is described below. Don't preemptively invert it; mnemon-companion will explicitly take over when it ships.

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

> **When mnemon ships for this group:** atomic facts go into mnemon (canonical), wiki pages become a derived synthesis, and the table above narrows to "rules vs facts" (CLAUDE.local.md vs mnemon). Wiki pages stop being a destination for primary writes and become a compiled output. Defer to `mnemon-companion/SKILL.md` at that point.

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
