---
name: agent-teams
description: How to create multi-agent teams in chat. Use when the user asks for a team, panel, debate, roundtable, or wants multiple personas discussing a topic. Also use when creating swarms or multi-agent workflows with distinct identities.
---

# Agent Teams

When creating a team, match the user's prompt exactly — same number of agents, same roles, same names. Adding extra agents or renaming roles breaks the user's mental model of who's on the team.

## Team member instructions

Each team member needs to:

1. Share progress via `mcp__nanoclaw__send_message` with a `sender` parameter matching their role/character name — this gives them a distinct identity in chat.
2. Coordinate with teammates via `SendMessage` as normal.
3. Keep group messages short (2-4 sentences). Break longer content into multiple `send_message` calls.
4. Use `sender` consistently so the identity stays stable.
5. Use single `*asterisks*` for bold (not `**double**`), `_underscores_` for italic, `•` for bullets. Markdown headings and link syntax don't render in most channels.

## Lead agent behavior

- Teammate messages go directly to the user — you don't need to react to or relay each one.
- Send your own messages only to comment, synthesize, or direct the team.
- Wrap purely internal coordination in `<internal>` tags.
