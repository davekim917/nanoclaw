---
name: add-tone-profile
description: Create a new tone profile for any content type — marketing copy, video scripts, emails, agent personas, or custom voices. Guides through writing style analysis, profile creation, and integration with the selection guide. Use when the user wants a new tone, voice, writing style, or persona added to the system. Also triggers on "create a tone for X", "add a voice for Y", "new writing style".
---

# Add Tone Profile

Creates a new tone profile by analyzing writing patterns (optional), defining voice characteristics, and wiring it into the tone system.

Tone profiles exist so generated content sounds human, not AI. They ban fingerprint vocabulary, enforce natural structure, and calibrate voice for the audience. They are NOT about impersonating any specific person — the writing samples are training data for human-sounding output.

## Where profiles live

- Profile files: `tone-profiles/*.md` in the repo root
- Selection guide: `tone-profiles/selection-guide.md` (routes agents to the right profile)
- Group persona defaults: set via `containerConfig.tone` in the registered_groups DB (not in CLAUDE.md)

## Phase 1: Understand the Profile

Gather requirements:

1. **What is this profile for?** (e.g., "LinkedIn posts", "video scripts", "formal investor emails", "a pirate voice for laughs")
2. **Who is the audience?** (engineers, investors, social media followers, viewers, etc.)
3. **Agent voice or human voice?** Agent = the bot's personality in a channel. Human = content the bot creates (emails, posts, scripts, deliverables).
4. **Should it be a group default persona or on-demand only?** Group defaults are injected every session. On-demand profiles load via `get_tone_profile`.
5. **Any specific traits or constraints?** (e.g., "punchy and hook-driven", "conversational spoken rhythm", "no corporate jargon")
6. **Analyze existing writing samples?** If yes, ask where to find them.

## Phase 2: Analyze Writing Samples (Optional)

If the user wants the profile based on real writing patterns:

- **Chat history:** Use `mcp__nanoclaw__search_threads` and `mcp__nanoclaw__read_thread` to find 30-50+ messages
- **Email:** Search `in:sent` via Gmail tools for 20-30 substantive sent emails
- **Pasted examples:** User provides 5-10 samples directly

Extract patterns: greeting/sign-off style, sentence structure and length, formality (1-5), punctuation habits, common phrases, and anti-patterns (what they never do).

Summarize findings and confirm accuracy before writing the profile.

## Phase 3: Write the Profile

Create `tone-profiles/{profile-name}.md`. Keep it concise (~30-45 lines). The agent is smart — explain the voice, give structure guidance, show a few examples, and list anti-patterns. No need for exhaustive templates.

Key sections:
- **Voice** — 2-3 sentences describing what the voice sounds like
- **Formality** — 1-5 scale
- **Structure** — how sentences and paragraphs should be organized
- **Personality** — specific traits with brief examples
- **Anti-Patterns** — what to avoid (the most useful section for preventing AI-sounding output)
- **Platform Calibration** — if the profile spans multiple platforms (e.g., LinkedIn vs X), note the differences

For agent-voice profiles (channel personas), include emoji and greeting/sign-off guidance.

For humor/novelty profiles, note that it's override-only.

## Phase 4: Update the Selection Guide

Edit `tone-profiles/selection-guide.md`:

1. Add a row to the selection table mapping recipient/context to the new profile
2. Add per-response override phrases (e.g., "use spark tone" / "make this punchy")
3. Confirm it falls under the correct universal rules section (Human Voice or Agent's Voice)

## Phase 5: Set as Group Default (if applicable)

If the profile should be a channel persona (injected at boot):

Group persona defaults are configured via `containerConfig.tone` in the `registered_groups` SQLite table, not in CLAUDE.md. Use the main agent's `register_group` or `update_group` MCP tool, or edit via `/remote-control`.

## Phase 6: Save

Since tone profiles are git-tracked files in the NanoClaw repo and container agents have read-only access to the project root, use `/remote-control` to commit and push, or use the MCP git tools if available.

## Existing Profiles

| Profile | Voice | Formality | Use Case |
|---------|:-----:|:---------:|----------|
| professional | Human | 3/5 | External, leadership, vendors, formal |
| collaborative | Human | 2/5 | Peers, clients, cross-functional |
| direct | Human | 1/5 | Daily coworkers, personal |
| spark | Human | 2/5 | LinkedIn, X, pitches, marketing, launches |
| reel | Human | 1.5/5 | Video scripts, demos, tutorials, presentations |
| engineering | Agent | 1.5/5 | Slack engineering channels |
| assistant | Agent | 1.5/5 | Discord channels (Jarvis/Friday) |
| medieval | Agent | 5/5 | Humor override only |
