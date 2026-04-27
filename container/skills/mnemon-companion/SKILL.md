---
name: mnemon-companion
description: Agent's guide to the mnemon-backed memory system for this group. Loaded when mnemon is enabled. Defines source-of-truth matrix; what to remember/recall and what NEVER goes in mnemon (rules, transient session state, secrets); flow: sources → mnemon → wiki (synthesis is one-way, scheduled).
---

# Mnemon Companion (this group)

## Source-of-truth matrix

| Layer | What it holds | Canonical for | Writable by |
|---|---|---|---|
| `mnemon` store | Atomic facts, entity relationships, observed state | All compounding knowledge | Agent (recall + remember) |
| `wiki/` pages | Synthesised long-form write-ups compiled from mnemon | Human-readable reference | Scheduled synthesise task only |
| `CLAUDE.local.md` | Behavioral rules, per-turn references, preferences | Agent instructions | Operator + agent (rules only) |
| `sources/` | Raw input artifacts | Ingest provenance | Agent (drop, never modify) |

**This group is in mnemon mode.** When you write to memory, write to mnemon. Wiki pages are compiled on a schedule — do not write them during conversation.

## When to remember

Remember into mnemon when:
- The user states an atomic fact (a decision, preference, conclusion, architectural judgment)
- You synthesise a durable insight from sources or analysis (e.g. "XZO uses tenant-scoped schemas")
- Observed state about the workspace changes (a repo is added, a tool is wired, a team member joins)

Do NOT remember:
- **Rules or instructions** — those go in `CLAUDE.local.md` (behavioral memory, not factual memory)
- **Transient session state** — what you did this turn, in-flight task status, partial results
- **Secrets** — API keys, OAuth tokens, passwords, connection strings, anything credential-like

## When to recall

- On every substantive new user prompt **only if Phase 2 (live)**. During Phase 1 (shadow), the wrapper script returns empty results regardless — do not waste turns.
- Check `/workspace/agent/.mnemon-rollout.json` if unsure which phase you're in. `phase: "shadow"` means Phase 1.
- Recall by concept, entity name, or keyword. Mnemon returns ranked results.

## How to remember

```bash
# Basic remember
mnemon remember "XZO uses per-tenant Snowflake schemas for data isolation" --store $MNEMON_STORE

# With entity tag
mnemon remember "Apollo client contact is William Grant" --store $MNEMON_STORE --entity "Apollo"

# Check what's stored
mnemon recall "XZO schemas" --store $MNEMON_STORE
```

The wrapper at `/usr/local/bin/mnemon` handles write locking and phase enforcement. During Phase 1, `recall` returns `{"results":[]}` regardless of store contents.

## Synthesis to wiki

- Triggered by the daily synthesise scheduled task (default 03:00 UTC).
- **Do NOT manually synthesise wiki pages from mnemon during regular conversation** — that is the scheduled task's job.
- Operator reviews wiki in Obsidian; edits there are the operator's prerogative. Do not overwrite operator edits.
- If the user explicitly asks you to synthesise now, you may run it once, but note it is out of band.

## Reconciliation

- Weekly `task-mnemon-wiki-reconcile` cross-checks the entity graph in mnemon against wiki pages.
- Flagged orphans (wiki pages whose mnemon entity was deleted) require operator decision before removal.
- Do not delete wiki pages on your own authority — flag for operator review.

## What NEVER goes in mnemon

- API keys, OAuth tokens, passwords, bearer tokens, connection strings — anything that is a secret
- Transient session state (the conversation in front of you is conversation, not memory)
- Rules and instructions about agent behavior — those go in `CLAUDE.local.md`
- Ephemeral task status, in-progress work notes, partial analysis — write those to a scratch file or discuss in chat

## Disambiguation: mnemon vs wiki skill

- **This skill (mnemon-companion)** takes precedence for all memory writes. Per SF12, a more specific instruction supersedes the general wiki skill's direct-write flow.
- **Wiki skill** still applies for page format conventions, source handling, ingest discipline, and lint procedures — but its direct-write flow is suspended in mnemon-enabled groups.
- When in doubt: if it's a fact or knowledge, mnemon first. If it's a behavioral rule, CLAUDE.local.md. Wiki pages are output, not input.
