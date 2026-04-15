---
name: feature-routing
description: When and how to use the team workflow (/team-brief chain) for non-trivial features, and rules for invoking skills correctly. Use when planning a feature, deciding whether to use the team workflow, or when you need to invoke a skill and want to confirm the correct pattern. The global CLAUDE.md has the routing rule — this skill has the full rationale and details.
---

# Feature Work Routing & Skill Invocation

## When to use the team workflow

Non-trivial features go through the team workflow — the global CLAUDE.md has the routing trigger. Here's the rationale and detail:

**Why the workflow exists:** Skills like `/team-brief`, `/team-design`, and `/team-plan` have structured processes, file formats, and approval gates that aren't visible from their descriptions alone. Writing a brief yourself instead of invoking the skill produces artifacts that look similar but miss the methodology — downstream skills then fail or produce low-quality output.

**Complexity signals:** 3+ new files, new database table, new API endpoint, multiple valid interpretations, cross-cutting changes. If you're unsure, it's probably non-trivial.

**Trivial work (skip the workflow):** Single-file bug fixes, config changes, typos, simple queries, research, conversation.

## The chain

`/team-brief` -> `/team-design` -> `/team-review` -> `/team-plan` -> `/team-build` -> `/team-qa` -> `/team-ship`

Each step has an approval gate. Don't skip ahead — the output of each step feeds the next.

## Skill invocation

When running any skill (not just the team workflow):

- Invoke via the `Skill` tool. Spawning an Agent with skill-like instructions is not running the skill — it's a lossy imitation that misses the skill's actual logic.
- Sub-agents can and should invoke skills directly for their portion of the work.
- Self-check: did you call the `Skill` tool? If not, you didn't run the skill.

This applies only to skill invocations. Sub-agents are still the right tool for general work (code, research, building).
